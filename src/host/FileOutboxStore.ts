import { Effect, FileSystem, Layer, Option, Path, PlatformError, Result, Schema } from "effect"
import { AirlockHome } from "../AirlockHome.ts"
import { type EmissionState, transitions } from "../core/outbox/Lifecycle.ts"
import { OutboxStore } from "../core/outbox/OutboxStore.ts"
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
} from "../core/outbox/Records.ts"
import { makeExclusiveFileLock } from "../platform/ExclusiveFileLock.ts"

/**
 * The OutboxStore port over one Airlock home.
 *
 *   <outbox>/<id>.<state>/record.<state>.json   the record for that state
 *                        /dispatch.json         sealed dispatch, owner-only
 *                        /response.bin          bounded capture, owner-only
 *
 * The directory name is the state, so the compare-and-set is one rename of
 * that directory. Everything a state needs is written and synced inside the
 * directory first; a crash before the rename leaves the emission in its
 * previous state with inert extra files. Nothing here unlinks: superseded
 * record files stay as history until the reaper owns their expiry.
 */

const states = Object.keys(transitions) as ReadonlyArray<EmissionState>
const entryPattern = new RegExp(`^(emi_[0-9a-f]{32})\\.(${states.join("|")})$`)

const recordCodec = Schema.fromJsonString(EmissionRecord)
const encodeRecord = Schema.encodeEffect(recordCodec)
const decodeRecord = Schema.decodeUnknownEffect(recordCodec)
const dispatchCodec = Schema.fromJsonString(SealedDispatch)
const encodeDispatch = Schema.encodeEffect(dispatchCodec)
const decodeDispatch = Schema.decodeUnknownEffect(dispatchCodec)

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

type Located = Readonly<{ readonly id: EmissionId; readonly state: EmissionState }>

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* AirlockHome

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

  const stateDirectory = (id: EmissionId, state: EmissionState) =>
    path.join(home.outboxDir, `${id}.${state}`)
  const recordFile = (id: EmissionId, state: EmissionState) =>
    path.join(stateDirectory(id, state), `record.${state}.json`)

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

  const located = fs.readDirectory(home.outboxDir).pipe(
    Effect.mapError(failed("list")),
    Effect.flatMap((entries) => {
      const found = new Map<EmissionId, EmissionState>()
      for (const entry of entries) {
        const match = entryPattern.exec(entry)
        if (match === null) continue
        const id = EmissionId.make(match[1]!)
        if (found.has(id)) {
          return Effect.fail(corrupt(id, "record", "more than one state directory"))
        }
        found.set(id, match[2] as EmissionState)
      }
      return Effect.succeed(found)
    })
  )

  const locate = (id: EmissionId) =>
    Effect.map(located, (found): Option.Option<Located> => {
      const state = found.get(id)
      return state === undefined ? Option.none() : Option.some({ id, state })
    })

  const readRecord = ({ id, state }: Located) =>
    fs.readFileString(recordFile(id, state)).pipe(
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

  const read = (id: EmissionId) =>
    Effect.flatMap(locate(id), Option.match({
      onNone: () => Effect.succeed(Option.none<EmissionRecord>()),
      onSome: (found) => Effect.asSome(readRecord(found))
    }))

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
    Effect.flatMap(require(id), ({ state }) =>
      fs.readFileString(path.join(stateDirectory(id, state), "dispatch.json")).pipe(
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
      const found = yield* require(id)
      const next = advance(yield* readRecord(found), from, arrival)
      if (Result.isFailure(next)) return yield* next.failure

      const directory = stateDirectory(id, from)
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
      return next.success
    }))

  const acknowledge: OutboxStore["Service"]["acknowledge"] = (id, phase) =>
    atomically(Effect.gen(function* () {
      const found = yield* require(id)
      const current = yield* readRecord(found)
      const marked = markLedgered(current, phase)
      if (marked === current) return current
      const directory = stateDirectory(id, found.state)
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
      return marked
    }))

  const readResponse: OutboxStore["Service"]["readResponse"] = (id) =>
    Effect.flatMap(locate(id), (found) =>
      // A response exists only as part of a commit; bytes left by an attempt
      // that never renamed are not a response.
      Option.isNone(found) || found.value.state !== "committed"
        ? Effect.succeed(Option.none<Uint8Array>())
        : fs.readFile(path.join(stateDirectory(id, "committed"), "response.bin")).pipe(
            Effect.map(Option.some),
            Effect.mapError((cause): OutboxStoreFailed | OutboxStateCorrupt =>
              isNotFound(cause)
                ? corrupt(id, "response", "committed emission has no response")
                : failed("read-response", id)(cause)
            )
          ))

  const list: OutboxStore["Service"]["list"] = <State extends EmissionState>(wanted?: State) =>
    Effect.flatMap(located, (found) =>
      Effect.forEach(
        [...found].filter(([, state]) => wanted === undefined || state === wanted),
        ([id, state]) => readRecord({ id, state }),
        { concurrency: 1 }
      )).pipe(
        Effect.map((records) =>
          records
            .filter((record): record is RecordIn<State> =>
              wanted === undefined || record.state === wanted
            )
            .sort((left, right) =>
              left.stagedAt.epochMilliseconds - right.stagedAt.epochMilliseconds ||
              (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
            )
        )
      )

  return OutboxStore.of({
    exclusive: (effect) => sectionLock.withLock(effect),
    putIfAbsent,
    read,
    readDispatch,
    transition,
    acknowledge,
    readResponse,
    listOwing: Effect.map(list(), (records) => records.filter(owesReceipt)),
    list
  })
})

export const layer: Layer.Layer<
  OutboxStore,
  OutboxStoreFailed,
  FileSystem.FileSystem | Path.Path | AirlockHome
> = Layer.effect(OutboxStore, make)
