import { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"
import { AirlockHome } from "../AirlockHome.ts"
import { EmissionId } from "../domain.ts"
import { makeExclusiveFileLock } from "../platform/ExclusiveFileLock.ts"
import {
  OutboxState,
  OutboxStateCorrupt,
  OutboxStorageFailed
} from "./Contract.ts"

const encoder = new TextEncoder()

const states: ReadonlyArray<OutboxState> = [
  "staged",
  "committing",
  "committed",
  "uncertain",
  "cancelled"
]

const safeIdPattern = /^emi_[A-Za-z0-9_-]{8,80}$/

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.name : "platform-error"

export interface StoredEmission {
  readonly id: EmissionId
  readonly state: OutboxState
  readonly manifestJson: string
  readonly outcomeJson?: string
}

export interface FileOutboxStore {
  /**
   * Serializes dispatch/recovery across Airlock processes. The lock is global
   * to one Airlock home because startup recovery must not race any live commit.
   */
  readonly withExclusive: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | OutboxStorageFailed, R>
  readonly create: (
    id: EmissionId,
    manifestJson: string,
    dispatchJson: string
  ) => Effect.Effect<void, OutboxStorageFailed>
  readonly findState: (
    id: EmissionId
  ) => Effect.Effect<
    OutboxState | undefined,
    OutboxStorageFailed | OutboxStateCorrupt
  >
  readonly read: (
    id: EmissionId,
    expectedState?: OutboxState
  ) => Effect.Effect<
    StoredEmission,
    OutboxStorageFailed | OutboxStateCorrupt
  >
  readonly readDispatch: (
    id: EmissionId,
    state: OutboxState
  ) => Effect.Effect<string, OutboxStorageFailed>
  readonly transition: (
    id: EmissionId,
    from: OutboxState,
    to: OutboxState
  ) => Effect.Effect<void, OutboxStorageFailed>
  readonly writeOutcome: (
    id: EmissionId,
    state: OutboxState,
    outcomeJson: string
  ) => Effect.Effect<void, OutboxStorageFailed>
  /**
   * The bounded response capture. It shares the owner-only emission directory
   * with dispatch.json because a response body is attacker-controlled content
   * that no listing, manifest, or receipt may serialize.
   */
  readonly writeResponse: (
    id: EmissionId,
    state: OutboxState,
    bytes: Uint8Array
  ) => Effect.Effect<void, OutboxStorageFailed>
  readonly readResponse: (
    id: EmissionId,
    state: OutboxState
  ) => Effect.Effect<Uint8Array | undefined, OutboxStorageFailed>
  readonly list: (
    state?: OutboxState
  ) => Effect.Effect<
    ReadonlyArray<StoredEmission>,
    OutboxStorageFailed | OutboxStateCorrupt
  >
  readonly recoverCommitting: Effect.Effect<
    ReadonlyArray<EmissionId>,
    OutboxStorageFailed | OutboxStateCorrupt
  >
}

export const makeFileOutboxStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* AirlockHome

  const fail = (
    operation: string,
    cause: unknown,
    id?: string
  ): OutboxStorageFailed =>
    new OutboxStorageFailed({
      operation,
      ...(id === undefined ? {} : { id }),
      reason: reasonOf(cause)
    })

  const statePath = (id: EmissionId, state: OutboxState) =>
    path.join(home.outboxDir, `${id}.${state}`)
  const lockRoot = path.join(home.home, "outbox-locks")
  const activeLock = path.join(lockRoot, "active")
  const releasedLock = path.join(lockRoot, "released")
  const abandonedLock = path.join(lockRoot, "abandoned")

  const validateId = (id: EmissionId) =>
    safeIdPattern.test(id)
      ? Effect.void
      : Effect.fail(fail("validate-id", "invalid-id", id))

  const syncPath = (target: string, operation: string, id?: string) =>
    Effect.scoped(
      fs.open(target, { flag: "r" }).pipe(
        Effect.flatMap((file) => file.sync),
        Effect.mapError((cause) => fail(operation, cause, id))
      )
    )

  const writeNewDurable = (
    target: string,
    content: string | Uint8Array,
    operation: string,
    id?: string
  ) =>
    Effect.scoped(
      fs.open(target, { flag: "wx", mode: 0o600 }).pipe(
        Effect.flatMap((file) => {
          const bytes =
            typeof content === "string" ? encoder.encode(content) : content
          // An empty capture is a real outcome (a 204, a bodiless redirect).
          // `writeAll` refuses a zero-length write, so the durable empty file
          // is created and synced without one.
          return (bytes.byteLength === 0
            ? Effect.void
            : file.writeAll(bytes)).pipe(Effect.zipRight(file.sync))
        }),
        Effect.mapError((cause) => fail(operation, cause, id))
      )
    )

  const writeReplaceDurable = (
    directory: string,
    targetName: string,
    content: string | Uint8Array,
    operation: string,
    id: EmissionId
  ) =>
    Effect.gen(function* () {
      const temporary = path.join(
        directory,
        `.${targetName}.${crypto.randomUUID()}.tmp`
      )
      yield* writeNewDurable(temporary, content, operation, id)
      yield* fs
        .rename(temporary, path.join(directory, targetName))
        .pipe(Effect.mapError((cause) => fail(operation, cause, id)))
      yield* syncPath(directory, `${operation}-sync-directory`, id)
    })

  yield* fs
    .makeDirectory(home.outboxDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => fail("initialize", cause)))
  yield* fs
    .chmod(home.outboxDir, 0o700)
    .pipe(Effect.mapError((cause) => fail("secure-root", cause)))
  yield* fs
    .makeDirectory(lockRoot, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => fail("initialize-lock", cause)))
  yield* fs
    .chmod(lockRoot, 0o700)
    .pipe(Effect.mapError((cause) => fail("secure-lock-root", cause)))

  const lock = makeExclusiveFileLock({
    root: lockRoot,
    active: activeLock,
    released: releasedLock,
    abandoned: abandonedLock,
    onError: (operation, _target, cause) =>
      fail(`lock-${operation}`, cause)
  })

  const withExclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withLock(effect)

  const entries = fs
    .readDirectory(home.outboxDir)
    .pipe(Effect.mapError((cause) => fail("list", cause)))

  const parseEntry = (
    entry: string
  ): { readonly id: EmissionId; readonly state: OutboxState } | undefined => {
    const separator = entry.lastIndexOf(".")
    if (separator < 1) return undefined
    const rawId = entry.slice(0, separator)
    const rawState = entry.slice(separator + 1)
    if (
      !safeIdPattern.test(rawId) ||
      !states.includes(rawState as OutboxState)
    ) {
      return undefined
    }
    return {
      id: EmissionId.make(rawId),
      state: rawState as OutboxState
    }
  }

  const findState = (id: EmissionId) =>
    validateId(id).pipe(
      Effect.zipRight(entries),
      Effect.flatMap((items) => {
        const matches = items
          .map(parseEntry)
          .filter(
            (
              entry
            ): entry is {
              readonly id: EmissionId
              readonly state: OutboxState
            } => entry?.id === id
          )
        return matches.length > 1
          ? Effect.fail(
              new OutboxStateCorrupt({
                id,
                document: "multiple-state-directories"
              })
            )
          : Effect.succeed(matches[0]?.state)
      })
    )

  const read = (id: EmissionId, expectedState?: OutboxState) =>
    Effect.gen(function* () {
      yield* validateId(id)
      const state = expectedState ?? (yield* findState(id))
      if (state === undefined) {
        return yield* Effect.fail(fail("read-missing", "not-found", id))
      }
      const directory = statePath(id, state)
      const manifestJson = yield* fs
        .readFileString(path.join(directory, "manifest.json"))
        .pipe(Effect.mapError((cause) => fail("read-manifest", cause, id)))
      const outcomePath = path.join(directory, "outcome.json")
      const hasOutcome = yield* fs
        .exists(outcomePath)
        .pipe(Effect.mapError((cause) => fail("inspect-outcome", cause, id)))
      const outcomeJson = hasOutcome
        ? yield* fs
            .readFileString(outcomePath)
            .pipe(Effect.mapError((cause) => fail("read-outcome", cause, id)))
        : undefined
      return {
        id,
        state,
        manifestJson,
        ...(outcomeJson === undefined ? {} : { outcomeJson })
      }
    })

  const create = (
    id: EmissionId,
    manifestJson: string,
    dispatchJson: string
  ) =>
    Effect.gen(function* () {
      yield* validateId(id)
      const temporary = path.join(
        home.outboxDir,
        `.${id}.${crypto.randomUUID()}.creating`
      )
      yield* fs
        .makeDirectory(temporary, { mode: 0o700 })
        .pipe(Effect.mapError((cause) => fail("create-directory", cause, id)))
      yield* writeNewDurable(
        path.join(temporary, "manifest.json"),
        manifestJson,
        "write-manifest",
        id
      )
      yield* writeNewDurable(
        path.join(temporary, "dispatch.json"),
        dispatchJson,
        "write-dispatch",
        id
      )
      yield* syncPath(temporary, "sync-emission", id)
      yield* fs
        .rename(temporary, statePath(id, "staged"))
        .pipe(Effect.mapError((cause) => fail("publish-stage", cause, id)))
      yield* syncPath(home.outboxDir, "sync-root", id)
    })

  const transition = (
    id: EmissionId,
    from: OutboxState,
    to: OutboxState
  ) =>
    validateId(id).pipe(
      Effect.zipRight(
        fs
          .rename(statePath(id, from), statePath(id, to))
          .pipe(
            Effect.mapError((cause) =>
              fail(`transition-${from}-to-${to}`, cause, id)
            )
          )
      ),
      Effect.zipRight(syncPath(home.outboxDir, "sync-transition", id))
    )

  const readDispatch = (id: EmissionId, state: OutboxState) =>
    validateId(id).pipe(
      Effect.zipRight(
        fs
          .readFileString(path.join(statePath(id, state), "dispatch.json"))
          .pipe(
            Effect.mapError((cause) => fail("read-dispatch", cause, id))
          )
      )
    )

  const writeOutcome = (
    id: EmissionId,
    state: OutboxState,
    outcomeJson: string
  ) =>
    validateId(id).pipe(
      Effect.zipRight(
        writeReplaceDurable(
          statePath(id, state),
          "outcome.json",
          outcomeJson,
          "write-outcome",
          id
        )
      )
    )

  const writeResponse = (
    id: EmissionId,
    state: OutboxState,
    bytes: Uint8Array
  ) =>
    validateId(id).pipe(
      Effect.zipRight(
        writeReplaceDurable(
          statePath(id, state),
          "response.bin",
          bytes,
          "write-response",
          id
        )
      )
    )

  const readResponse = (id: EmissionId, state: OutboxState) =>
    Effect.gen(function* () {
      yield* validateId(id)
      const target = path.join(statePath(id, state), "response.bin")
      const present = yield* fs
        .exists(target)
        .pipe(Effect.mapError((cause) => fail("inspect-response", cause, id)))
      if (!present) return undefined
      return yield* fs
        .readFile(target)
        .pipe(Effect.mapError((cause) => fail("read-response", cause, id)))
    })

  const list = (wanted?: OutboxState) =>
    entries.pipe(
      Effect.flatMap((items) => {
        const parsed = items
          .map(parseEntry)
          .filter(
            (
              entry
            ): entry is {
              readonly id: EmissionId
              readonly state: OutboxState
            } => entry !== undefined
          )
        const seen = new Set<string>()
        const duplicate = parsed.find(({ id }) => {
          if (seen.has(id)) return true
          seen.add(id)
          return false
        })
        return duplicate === undefined
          ? Effect.succeed(
              parsed.filter(
                ({ state }) => wanted === undefined || state === wanted
              )
            )
          : Effect.fail(
              new OutboxStateCorrupt({
                id: duplicate.id,
                document: "multiple-state-directories"
              })
            )
      }),
      Effect.flatMap((found) =>
        Effect.forEach(found, ({ id, state }) => read(id, state), {
          concurrency: 1
        })
      )
    )

  const recoverCommitting = list("committing").pipe(
    Effect.flatMap((committing) =>
      Effect.forEach(
        committing,
        ({ id }) =>
          transition(id, "committing", "uncertain").pipe(Effect.as(id)),
        { concurrency: 1 }
      )
    )
  )

  // V1 retains owner-only dispatch.json and response.bin in terminal state
  // directories. Their expiry must be implemented by the single authorized
  // reaper, not by adding an Outbox-local unlink path.
  return {
    withExclusive,
    create,
    findState,
    read,
    readDispatch,
    transition,
    writeOutcome,
    writeResponse,
    readResponse,
    list,
    recoverCommitting
  } satisfies FileOutboxStore
})
