import { Effect, FileSystem, Layer, Option, Path, PlatformError, Result, Schema } from "effect"
import { AirlockHome } from "../AirlockHome.ts"
import { type ExactJson, exactJsonText } from "@skastr0/airlock"
import { CaptureEntry, CapturedEmission, StoredCaptureResult, validateCaptureEntry } from "@skastr0/airlock"
import { type EmissionState, isTerminal, transitions } from "@skastr0/airlock"
import { OutboxStore } from "@skastr0/airlock"
import {
  acknowledge as markLedgered,
  advance,
  EmissionId,
  EmissionRecord,
  OutboxStateCorrupt,
  OutboxStoreFailed,
  owesReceipt,
  type RecordIn,
  SealedDispatch,
  UnknownEmission
} from "@skastr0/airlock"
import { makeExclusiveFileLock } from "../platform/ExclusiveFileLock.ts"
import { CaptureJournal } from "./FileLedger.ts"

/**
 * The OutboxStore port over one Airlock home.
 *
 *   <outbox>/<id>.<state>/record.<state>.json   the record for that state
 *                        /dispatch.json         sealed dispatch, owner-only
 *                        /response.bin          bounded capture, owner-only
 *   <outbox>/settled/<id>.<state>/...           the same, once settled
 *
 * The directory name is the state, so the compare-and-set is one rename of
 * that directory. Everything a state needs is written and synced inside the
 * directory first; a crash before the rename leaves the emission in its
 * previous state with inert extra files. Nothing here unlinks: superseded
 * record files stay as history until the reaper owns their expiry.
 *
 * An emission is settled when its state is terminal and it owes the Ledger
 * nothing. A settled emission is renamed into `settled/`, so the outbox root
 * holds only what is still in motion (`settled/` is created by the first
 * move, so an outbox that settled nothing holds nothing). Finding one emission by id probes its
 * possible names; nothing lists the root except the operations that ask for
 * unsettled emissions, and nothing lists history unless history is asked for.
 *
 * A capture is not kept here at all. It is one line of the ledger journal
 * that carries the record, the stored result and the receipt together, and
 * that line is the capture: this store reads captures back out of the
 * journal and keeps no second copy that could disagree with it.
 */

const states = Object.keys(transitions) as ReadonlyArray<EmissionState>
const entryPattern = new RegExp(`^(emi_[0-9a-f]{32})\\.(${states.join("|")})$`)

// Written with the exact writer: an outcome or summary holding negative zero
// must be read back as the value it was. `JSON.parse` already reads exactly.
const exactly = <A, I, R>(schema: Schema.Codec<A, I, R>) => (value: A) =>
  Effect.map(Schema.encodeEffect(schema)(value), (encoded) => exactJsonText(encoded as ExactJson))
const encodeRecord = exactly(EmissionRecord)
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(EmissionRecord))
const encodeDispatch = exactly(SealedDispatch)
const decodeDispatch = Schema.decodeUnknownEffect(Schema.fromJsonString(SealedDispatch))

const encoder = new TextEncoder()

/** Names the failure without repeating a path or any stored content. */
const reasonOf = (cause: unknown): string =>
  cause instanceof PlatformError.PlatformError
    ? cause.reason._tag
    : cause instanceof Error
      ? cause.name
      : "platform-error"

const isNotFound = (cause: PlatformError.PlatformError) =>
  cause.reason._tag === "NotFound"

type Located = Readonly<{
  readonly id: EmissionId
  readonly state: EmissionState
  /** The emission's directory, in the outbox root or under `settled/`. */
  readonly directory: string
}>

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* AirlockHome
  const ledger = yield* CaptureJournal

  const failed = (operation: string, id?: string) => (cause: unknown) =>
    new OutboxStoreFailed({
      operation,
      ...(id === undefined ? {} : { id }),
      reason: reasonOf(cause)
    })

  const corrupt = (
    id: string,
    part: OutboxStateCorrupt["part"],
    reason: string
  ) => new OutboxStateCorrupt({ id, part, reason })

  const settledRoot = path.join(home.outboxDir, "settled")
  const terminalStates = states.filter(isTerminal)
  const stateDirectory = (id: EmissionId, state: EmissionState, root = home.outboxDir) =>
    path.join(root, `${id}.${state}`)

  const secureDirectory = (directory: string, operation: string) =>
    fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fs.chmod(directory, 0o700)),
      Effect.mapError(failed(operation))
    )

  const lockRoot = path.join(home.home, "outbox-locks")
  yield* secureDirectory(home.outboxDir, "initialize")
  yield* secureDirectory(lockRoot, "initialize-lock")

  const fileLock = (name: string) =>
    makeExclusiveFileLock({
      root: lockRoot,
      active: path.join(lockRoot, name),
      onError: (operation, _target, cause) => failed(`lock-${operation}`)(cause)
    })
  // `exclusive` is the kernel's section over a whole commit or recovery. The
  // step lock makes one store operation atomic and is always taken inside it,
  // never around it, so the two cannot deadlock.
  const sectionLock = fileLock("active")
  const stepLock = fileLock("step")
  const atomically = <A, E>(step: Effect.Effect<A, E>) =>
    stepLock.withLock(Effect.uninterruptible(step))

  const syncPath = (target: string, operation: string, id: string) =>
    Effect.scoped(
      fs.open(target, { flag: "r" }).pipe(
        Effect.flatMap((file) => file.sync),
        Effect.mapError(failed(operation, id))
      )
    )

  const writeNewDurable = (
    target: string,
    bytes: Uint8Array,
    operation: string,
    id: string
  ) =>
    Effect.scoped(
      fs.open(target, { flag: "wx", mode: 0o600 }).pipe(
        // `writeAll` refuses a zero-length write; an empty response is still a
        // real, durable capture.
        Effect.flatMap((file) =>
          (bytes.byteLength === 0 ? Effect.void : file.writeAll(bytes)).pipe(
            Effect.andThen(file.sync)
          )
        ),
        Effect.mapError(failed(operation, id))
      )
    )

  /** Durable write that replaces a leftover from an attempt that never renamed. */
  const writeDurable = (
    directory: string,
    name: string,
    bytes: Uint8Array,
    operation: string,
    id: string
  ) =>
    Effect.gen(function* () {
      const temporary = path.join(directory, `.${name}.${crypto.randomUUID()}.tmp`)
      yield* writeNewDurable(temporary, bytes, operation, id)
      yield* fs.rename(temporary, path.join(directory, name)).pipe(
        Effect.mapError(failed(operation, id))
      )
    })

  /** Which of `candidates` exist for `id` under `root`: a few name probes. */
  const present = (root: string, id: EmissionId, candidates: ReadonlyArray<EmissionState>) =>
    Effect.forEach(
      candidates,
      (state) => {
        const directory = stateDirectory(id, state, root)
        return Effect.map(fs.exists(directory), (found): Option.Option<Located> =>
          found ? Option.some({ id, state, directory }) : Option.none())
      },
      { concurrency: "unbounded" }
    ).pipe(
      Effect.map((found) => found.flatMap(Option.toArray)),
      Effect.mapError(failed("locate", id))
    )

  const locate = (id: EmissionId) =>
    Effect.all([present(home.outboxDir, id, states), present(settledRoot, id, terminalStates)]).pipe(
      Effect.flatMap(([open, settled]) => {
        const found = [...open, ...settled]
        return found.length > 1
          ? Effect.fail(corrupt(id, "record", "more than one state directory"))
          : Effect.succeed(Option.fromNullishOr(found[0]))
      })
    )

  /** Every emission directly under `root`, by its directory name. */
  const entriesOf = (root: string) =>
    fs.readDirectory(root).pipe(
      // `settled/` does not exist until something settles.
      Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(failed("list")),
      Effect.flatMap((entries) => {
        const found = new Map<EmissionId, Located>()
        for (const entry of entries) {
          const match = entryPattern.exec(entry)
          if (match === null) continue
          const id = EmissionId.make(match[1]!)
          if (found.has(id)) {
            return Effect.fail(corrupt(id, "record", "more than one state directory"))
          }
          found.set(id, { id, state: match[2] as EmissionState, directory: path.join(root, entry) })
        }
        return Effect.succeed([...found.values()])
      })
    )

  const readRecord = ({ id, state, directory }: Located) =>
    fs.readFileString(path.join(directory, `record.${state}.json`)).pipe(
      Effect.mapError((cause): OutboxStoreFailed | OutboxStateCorrupt =>
        isNotFound(cause)
          ? corrupt(id, "record", "state directory has no record")
          : failed("read-record", id)(cause)
      ),
      Effect.flatMap((text) =>
        decodeRecord(text).pipe(
          Effect.mapError(() => corrupt(id, "record", "record does not decode"))
        )
      ),
      Effect.filterOrFail(
        (record) => record.id === id && record.state === state,
        () => corrupt(id, "record", "record contradicts its state directory")
      )
    )

  const isSettled = (record: EmissionRecord) => isTerminal(record.state) && !owesReceipt(record)

  /**
   * Moves a settled emission out of the root. The rename is not flushed: if a
   * crash loses it, the emission is still in the root, where the next listing
   * of unsettled emissions finds it settled and moves it again.
   */
  const settle = (record: EmissionRecord, found: Located) =>
    found.directory.startsWith(settledRoot) || !isSettled(record)
      ? Effect.void
      : fs.makeDirectory(settledRoot, { recursive: true, mode: 0o700 }).pipe(
          Effect.andThen(fs.rename(found.directory, stateDirectory(record.id, record.state, settledRoot))),
          Effect.ignore
        )

  /** What the journal line of a capture carries beside its receipt. */
  const Carried = Schema.Struct({ record: CapturedEmission, result: Schema.optionalKey(StoredCaptureResult) })
  const captureKey = (id: EmissionId) => `${id}:capture`
  const decodeCarried = (id: string) => (carried: Schema.Json) =>
    Schema.decodeUnknownEffect(Carried)(carried).pipe(
      Effect.mapError(() => corrupt(id, "record", "capture journal entry does not decode"))
    )
  const readCarried = (id: EmissionId) =>
    ledger.carried(captureKey(id)).pipe(
      Effect.mapError(failed("read-capture", id)),
      Effect.flatMap(Option.match({
        onNone: () => Effect.succeed(Option.none<typeof Carried.Type>()),
        onSome: (carried) => Effect.asSome(decodeCarried(id)(carried).pipe(
          Effect.filterOrFail(
            (entry) => entry.record.id === id,
            () => corrupt(id, "record", "capture journal entry is filed under another id")
          )
        ))
      }))
    )

  const read = (id: EmissionId): Effect.Effect<Option.Option<EmissionRecord>, OutboxStoreFailed | OutboxStateCorrupt> =>
    Effect.flatMap(locate(id), Option.match({
      onNone: () => Effect.map(readCarried(id), Option.map((entry): EmissionRecord => entry.record)),
      onSome: (found) => Effect.asSome(readRecord(found))
    }))

  const putCapture: OutboxStore["Service"]["putCapture"] = (record, result, receipt) =>
    atomically(Effect.gen(function* () {
      const id = record.id
      const checked = validateCaptureEntry({ record, ...(result === undefined ? {} : { result }), receipt })
      if (Result.isFailure(checked)) {
        return yield* new OutboxStoreFailed({ operation: "put-capture", id, reason: checked.failure.reason })
      }
      // An emission of another kind already has this id.
      const other = yield* locate(id)
      if (Option.isSome(other)) return { created: false, record: yield* readRecord(other.value) }
      const encoded = yield* Schema.encodeEffect(CaptureEntry)(checked.success).pipe(
        Effect.mapError(failed("encode-capture", id))
      )
      // One fsynced append: record, result and receipt exist together or not at all.
      const created = yield* ledger.recordCarrying(
        Object.assign(checked.success.receipt, { key: captureKey(id) }),
        { record: encoded.record, ...(encoded.result === undefined ? {} : { result: encoded.result }) } as Schema.Json
      ).pipe(Effect.mapError(failed("put-capture", id)))
      if (created) return { created: true, record: checked.success.record as EmissionRecord }
      // The journal already holds this key: that capture stands, unchanged.
      const existing = yield* readCarried(id)
      return Option.isSome(existing)
        ? { created: false, record: existing.value.record as EmissionRecord }
        // The key carries no capture: a receipt without its record.
        : yield* corrupt(id, "record", "capture receipt exists without its record")
    }))

  const readCapture: OutboxStore["Service"]["readCapture"] = (id) =>
    Effect.map(readCarried(id), Option.flatMap((entry) => Option.fromNullishOr(entry.result)))

  const require = (id: EmissionId) =>
    Effect.flatMap(locate(id), Option.match({
      onNone: () => Effect.fail(new UnknownEmission({ id })),
      onSome: (found) => Effect.succeed(found)
    }))

  const putIfAbsent: OutboxStore["Service"]["putIfAbsent"] = (record, dispatch) =>
    atomically(Effect.gen(function* () {
      const existing = yield* read(record.id)
      if (Option.isSome(existing)) return { created: false, record: existing.value }

      const id = record.id
      const recordJson = yield* encodeRecord(record).pipe(
        Effect.mapError(failed("encode-record", id))
      )
      const dispatchJson = yield* encodeDispatch(dispatch).pipe(
        Effect.mapError(failed("encode-dispatch", id))
      )
      const creating = path.join(home.outboxDir, `.${id}.${crypto.randomUUID()}.creating`)
      yield* fs.makeDirectory(creating, { mode: 0o700 }).pipe(
        Effect.mapError(failed("create-directory", id))
      )
      yield* writeNewDurable(
        path.join(creating, "record.staged.json"),
        encoder.encode(recordJson),
        "write-record",
        id
      )
      yield* writeNewDurable(
        path.join(creating, "dispatch.json"),
        encoder.encode(dispatchJson),
        "write-dispatch",
        id
      )
      yield* syncPath(creating, "sync-emission", id)
      yield* fs.rename(creating, stateDirectory(id, "staged")).pipe(
        Effect.mapError(failed("publish-stage", id))
      )
      yield* syncPath(home.outboxDir, "sync-root", id)
      return { created: true, record: record as EmissionRecord }
    }))

  const readDispatch: OutboxStore["Service"]["readDispatch"] = (id) =>
    Effect.flatMap(require(id), ({ directory }) =>
      fs.readFileString(path.join(directory, "dispatch.json")).pipe(
        Effect.mapError((cause): OutboxStoreFailed | OutboxStateCorrupt =>
          isNotFound(cause)
            ? corrupt(id, "dispatch", "state directory has no dispatch")
            : failed("read-dispatch", id)(cause)
        ),
        Effect.flatMap((text) =>
          decodeDispatch(text).pipe(
            Effect.mapError(() => corrupt(id, "dispatch", "dispatch does not decode"))
          )
        )
      ))

  const transition: OutboxStore["Service"]["transition"] = (id, from, arrival) =>
    atomically(Effect.gen(function* () {
      const located = yield* locate(id)
      if (Option.isNone(located)) {
        // A capture is complete from the moment it exists: nothing follows it.
        const captured = yield* readCarried(id)
        if (Option.isNone(captured)) return yield* new UnknownEmission({ id })
        const refused = advance(captured.value.record, from, arrival)
        return yield* Result.isFailure(refused)
          ? refused.failure
          : corrupt(id, "record", "a captured record has no next state")
      }
      const found = located.value
      const next = advance(yield* readRecord(found), from, arrival)
      if (Result.isFailure(next)) return yield* next.failure

      const directory = found.directory
      const to = arrival.state
      const recordJson = yield* encodeRecord(next.success).pipe(
        Effect.mapError(failed("encode-record", id))
      )
      yield* writeDurable(
        directory,
        `record.${to}.json`,
        encoder.encode(recordJson),
        "write-record",
        id
      )
      if (arrival.state === "committed") {
        yield* writeDurable(directory, "response.bin", arrival.response, "write-response", id)
      }
      yield* syncPath(directory, "sync-emission", id)
      // The compare-and-set: until this rename the emission is still `from`.
      yield* fs.rename(directory, stateDirectory(id, to)).pipe(
        Effect.mapError(failed(`transition-${from}-to-${to}`, id))
      )
      yield* syncPath(home.outboxDir, "sync-root", id)
      yield* settle(next.success, { id, state: to, directory: stateDirectory(id, to) })
      return next.success
    }))

  const acknowledge: OutboxStore["Service"]["acknowledge"] = (id, phase) =>
    atomically(Effect.gen(function* () {
      const found = yield* require(id)
      const current = yield* readRecord(found)
      const marked = markLedgered(current, phase)
      if (marked === current) return current
      const directory = found.directory
      const recordJson = yield* encodeRecord(marked).pipe(
        Effect.mapError(failed("encode-record", id))
      )
      // Same state, same file name: the rename replaces the record in place.
      yield* writeDurable(
        directory,
        `record.${found.state}.json`,
        encoder.encode(recordJson),
        "write-record",
        id
      )
      yield* syncPath(directory, "sync-emission", id)
      yield* settle(marked, found)
      return marked
    }))

  const readResponse: OutboxStore["Service"]["readResponse"] = (id) =>
    Effect.flatMap(locate(id), (found) =>
      // A response exists only as part of a commit; bytes left by an attempt
      // that never renamed are not a response.
      Option.isNone(found) || found.value.state !== "committed"
        ? Effect.succeed(Option.none<Uint8Array>())
        : fs.readFile(path.join(found.value.directory, "response.bin")).pipe(
            Effect.map(Option.some),
            Effect.mapError((cause): OutboxStoreFailed | OutboxStateCorrupt =>
              isNotFound(cause)
                ? corrupt(id, "response", "committed emission has no response")
                : failed("read-response", id)(cause)
            )
          ))

  const byStagedAt = (left: EmissionRecord, right: EmissionRecord) =>
    (left.state === "captured" ? left.completedAt : left.stagedAt).epochMilliseconds -
      (right.state === "captured" ? right.completedAt : right.stagedAt).epochMilliseconds ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

  /**
   * Records still in the root: everything unsettled, plus any emission whose
   * move to `settled/` was lost, which is moved now.
   */
  const unsettled = Effect.flatMap(entriesOf(home.outboxDir), (entries) =>
    Effect.forEach(
      entries,
      (found) => Effect.tap(readRecord(found), (record) => settle(record, found)),
      { concurrency: 1 }
    ))

  /** History. Read only when a caller asks for terminal or all emissions. */
  const settled = Effect.flatMap(entriesOf(settledRoot), (entries) =>
    Effect.forEach(entries, readRecord, { concurrency: 16 }))

  /** Captures are history from the moment they exist; they are read from the journal. */
  const captures = ledger.allCarried.pipe(
    Effect.mapError(failed("list-captures")),
    Effect.flatMap((all) => Effect.forEach(all, (carried) =>
      Effect.map(decodeCarried("capture")(carried), (entry): EmissionRecord => entry.record)))
  )

  const list: OutboxStore["Service"]["list"] = <State extends EmissionState>(wanted?: State) =>
    Effect.gen(function* () {
      const open = yield* unsettled
      const history = wanted === undefined || isTerminal(wanted) ? yield* settled : []
      const captured = wanted === undefined || wanted === "captured" ? yield* captures : []
      const seen = new Set(open.map((record) => record.id))
      return [...open, ...history.filter((record) => !seen.has(record.id)), ...captured]
        .filter((record): record is RecordIn<State> => wanted === undefined || record.state === wanted)
        .sort(byStagedAt)
    })

  // A settled emission owes nothing by definition, so only the root is read.
  const listOwing = Effect.map(unsettled, (records) => records.filter(owesReceipt).sort(byStagedAt))

  return OutboxStore.of({
    exclusive: (effect) => sectionLock.withLock(effect),
    putIfAbsent,
    putCapture,
    readCapture,
    read,
    readDispatch,
    transition,
    acknowledge,
    readResponse,
    listOwing,
    list
  })
})

export const layer: Layer.Layer<
  OutboxStore,
  OutboxStoreFailed,
  FileSystem.FileSystem | Path.Path | AirlockHome | CaptureJournal
> = Layer.effect(OutboxStore, make)
