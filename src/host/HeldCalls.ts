import { Context, Effect, Layer, Path, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdir, open, readFile, readdir } from "node:fs/promises"
import { AirlockHome } from "../AirlockHome.ts"
import { ActId } from "../core/domain.ts"
import { reasonOf } from "../FailureText.ts"
import { HeldCall, Hold } from "../Hold.ts"
import { makeExclusiveFileLock } from "../platform/ExclusiveFileLock.ts"

/**
 * One tool call that changes local state, as something that can be put back.
 *
 * A call is claimed durably before it does anything, under an id derived from
 * the call id. Each Hold act the call performs is claimed for it, in order,
 * before that act's first rename. So for any call, at any moment and after any
 * crash, this component can name exactly the acts that may have happened, ask
 * Hold which of them did, and reverse them newest first.
 *
 *   <home>/held-calls/<recoveryId>/call.json           what was claimed
 *                                 /acts/<n>.<actId>    one empty file per act
 *                                 /done.json           the call finished
 *                                 /refused.json        the call is not in effect
 *                                 /restore/<n>.<actId>.<status>
 *                                 /restored.json       a finished call was put back
 *
 * Files are only ever created, never rewritten or removed: the state of a
 * call is which files exist. Forward work is never retried. The before-images
 * stay in Hold, and Hold's reaper remains the only thing that discards them.
 */

export const HeldCallClaim = Schema.Struct({
  callId: Schema.String,
  runId: Schema.String,
  tool: Schema.String,
  version: Schema.String,
  inputDigest: Schema.String,
  /** The bound resources the call was admitted with. Evidence, not capability. */
  resources: Schema.Json
})
export type HeldCallClaim = typeof HeldCallClaim.Type

export const HeldCallReference = Schema.Struct({ callId: Schema.String, recoveryId: Schema.String })
export type HeldCallReference = typeof HeldCallReference.Type

const ActStatus = Schema.Literals(["held", "restored", "conflict", "no-longer-held", "failed"])
const ActReport = Schema.Struct({ id: ActId, status: ActStatus })
export type HeldActReport = typeof ActReport.Type

/**
 * - `prepared`: claimed, and no act began.
 * - `done`: the call finished and can be put back until `heldUntil`.
 * - `refused`: the call is not in effect. `partial-application-restored`
 *   says acts did happen and every one was reversed.
 * - `restored`: a finished call was put back.
 * - `uncertain`: acts happened and not all could be proven reversed; `acts`
 *   says which.
 */
export const HeldCallState = Schema.Struct({
  state: Schema.Literals(["prepared", "done", "refused", "restored", "uncertain"]),
  reason: Schema.optionalKey(Schema.String),
  acts: Schema.Array(ActReport),
  heldUntil: Schema.optionalKey(Schema.String)
})
export type HeldCallState = typeof HeldCallState.Type

/**
 * What asking to put a call back did.
 * - `restored`: every act was reversed.
 * - `conflict`, `no-longer-held`, `not-done`: nothing was changed.
 * - `partial`: some acts were reversed and some could not be; `acts` says which.
 */
export const HeldCallRestore = Schema.Struct({
  state: Schema.Literals(["restored", "conflict", "no-longer-held", "not-done", "partial"]),
  acts: Schema.Array(ActReport)
})
export type HeldCallRestore = typeof HeldCallRestore.Type

/** The same call id was claimed before with different content. */
export class HeldCallMismatch extends Schema.TaggedError<HeldCallMismatch>()("HeldCallMismatch", {
  callId: Schema.String
}) {}

/** Forward work was asked for on a call that has already begun or ended. */
export class HeldCallNotFresh extends Schema.TaggedError<HeldCallNotFresh>()("HeldCallNotFresh", {
  callId: Schema.String,
  state: Schema.String
}) {}

/** Acts happened and could not all be proven reversed. */
export class HeldCallUncertain extends Schema.TaggedError<HeldCallUncertain>()("HeldCallUncertain", {
  callId: Schema.String,
  acts: Schema.Array(ActReport)
}) {}

export class HeldCallFailed extends Schema.TaggedError<HeldCallFailed>()("HeldCallFailed", {
  operation: Schema.String,
  reason: Schema.String
}) {}

/** How forward work ended when it did not fail the call into uncertainty. */
export type HeldCallOutcome<A> =
  | { readonly _tag: "done"; readonly value: A; readonly heldUntil: string }
  | { readonly _tag: "refused"; readonly reason: "nothing-applied" | "partial-application-restored" }

export class HeldCalls extends Context.Service<
  HeldCalls,
  {
    /** Claims the call before any forward work. The same claim again returns the same reference. */
    readonly prepare: (
      claim: HeldCallClaim
    ) => Effect.Effect<HeldCallReference, HeldCallMismatch | HeldCallFailed>
    /**
     * Runs the call's forward work once, with every Hold act inside it claimed
     * for the call. If the work fails, the acts that happened are reversed and
     * the call is refused; if that cannot be proven, the call is uncertain.
     */
    readonly run: <A, E, R>(
      reference: HeldCallReference,
      forward: Effect.Effect<A, E, R>
    ) => Effect.Effect<HeldCallOutcome<A>, HeldCallNotFresh | HeldCallUncertain | HeldCallFailed, R>
    /** Says where a call stands. An interrupted call is settled first, by reversing it, never by continuing it. */
    readonly inspect: (reference: HeldCallReference) => Effect.Effect<HeldCallState, HeldCallFailed>
    /** Puts a finished call back, after checking that every act can be reversed. */
    readonly restore: (reference: HeldCallReference) => Effect.Effect<HeldCallRestore, HeldCallFailed>
  }
>()("airlock/HeldCalls") {}

export class HeldCallsConfig extends Schema.Class<HeldCallsConfig>("HeldCallsConfig")({
  /** How long Hold keeps a before-image before its reaper may discard it. */
  retentionMillis: Schema.Finite.check(Schema.isGreaterThan(0))
}) {}

const StoredClaim = Schema.fromJsonString(Schema.Struct({ ...HeldCallClaim.fields, preparedAt: Schema.String }))
const StoredDone = Schema.fromJsonString(Schema.Struct({ acts: Schema.Array(ActId), at: Schema.String }))
const StoredRefused = Schema.fromJsonString(Schema.Struct({ reason: Schema.String, acts: Schema.Array(ActReport) }))
const StoredRestored = Schema.fromJsonString(Schema.Struct({ acts: Schema.Array(ActReport), at: Schema.String }))

const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

const make = (config: HeldCallsConfig) =>
  Effect.gen(function* () {
    const home = yield* AirlockHome
    const hold = yield* Hold
    const path = yield* Path.Path
    const root = path.join(home.home, "held-calls")
    const lockRoot = path.join(home.home, "held-call-locks")

    const failed = (operation: string) => (cause: unknown) =>
      new HeldCallFailed({ operation, reason: reasonOf(cause) })
    const io = <A>(operation: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: failed(operation) })

    yield* io("create held call directories", async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await mkdir(lockRoot, { recursive: true, mode: 0o700 })
    })
    const lock = makeExclusiveFileLock({
      root: lockRoot,
      active: path.join(lockRoot, "active"),
      onError: (operation, _target, cause) => failed(`held call lock ${operation}`)(cause)
    })

    const sync = async (directory: string) => {
      const handle = await open(directory, "r")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    /** Durable and exclusive: the file did not exist, and after this it always will. */
    const create = async (file: string, content: string) => {
      const handle = await open(file, "wx", 0o600)
      try {
        await handle.writeFile(content, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await sync(path.dirname(file))
    }
    const read = async (file: string) => {
      try {
        return await readFile(file, "utf8")
      } catch (cause) {
        if (missing(cause)) return undefined
        throw cause
      }
    }
    const names = async (directory: string) => {
      try {
        return (await readdir(directory)).sort()
      } catch (cause) {
        if (missing(cause)) return []
        throw cause
      }
    }

    const directory = (reference: HeldCallReference) => path.join(root, reference.recoveryId)
    const recoveryIdOf = (callId: string) => createHash("sha256").update(callId).digest("hex")
    const order = (index: number) => String(index).padStart(6, "0")
    const actOf = (name: string) => ActId.make(name.slice(name.indexOf(".") + 1))

    /** The acts claimed for a call, oldest first. */
    const claimed = (reference: HeldCallReference) =>
      io("list claimed acts", () => names(path.join(directory(reference), "acts"))).pipe(
        Effect.map((files) => files.map(actOf))
      )

    const stored = <A>(reference: HeldCallReference, file: string, schema: Schema.Codec<A, string>) =>
      io(`read ${file}`, () => read(path.join(directory(reference), file))).pipe(
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.succeed(undefined)
            : Schema.decodeUnknownEffect(schema)(text).pipe(Effect.mapError(failed(`decode ${file}`)))
        )
      )
    const record = <A>(reference: HeldCallReference, file: string, schema: Schema.Codec<A, string>, value: A) =>
      Schema.encodeEffect(schema)(value).pipe(
        Effect.mapError(failed(`encode ${file}`)),
        Effect.flatMap((text) => io(`record ${file}`, () => create(path.join(directory(reference), file), text)))
      )

    const heldUntil = (at: string) => new Date(Date.parse(at) + config.retentionMillis).toISOString()

    /**
     * Reverses the given acts, newest first, and says what became of each.
     * Every act is checked before the first is reversed: a conflict or a
     * reaped before-image found then leaves the call exactly as it was. Each
     * act is checked again, under Hold's lease, as it is reversed. `progress`
     * records each ending durably before the next act is touched, so an
     * interruption is resumed from what Hold reports, never guessed.
     */
    const reverse = Effect.fnUntraced(function* (
      acts: ReadonlyArray<ActId>,
      progress: (index: number, report: HeldActReport) => Effect.Effect<void, HeldCallFailed>
    ) {
      const checks = yield* Effect.forEach(acts, (id) =>
        hold.undoCheck(id).pipe(Effect.mapError(failed("check held act"))))
      const before = acts.map((id, index): HeldActReport => ({
        id,
        status: checks[index] === "undoable" ? "held" : checks[index]!
      }))
      if (checks.some((check) => check === "conflict" || check === "no-longer-held")) {
        return { changed: false, acts: before }
      }
      const reports = [...before]
      for (let index = acts.length - 1; index >= 0; index--) {
        if (reports[index]!.status === "restored") continue
        const undone = yield* hold.undoIfUnchanged(acts[index]!).pipe(Effect.result)
        const status = undone._tag === "Success"
          ? ("restored" as const)
          : undone.failure._tag === "UndoConflict"
            ? ("conflict" as const)
            : undone.failure._tag === "UnknownAct"
              ? ("no-longer-held" as const)
              : ("failed" as const)
        reports[index] = { id: acts[index]!, status }
        yield* progress(index, reports[index]!)
        // Stop at the first act that would not go back: reversing older acts
        // past it would leave a state no call ever produced.
        if (status !== "restored") return { changed: true, acts: reports }
      }
      return { changed: true, acts: reports }
    })

    const allRestored = (acts: ReadonlyArray<HeldActReport>) => acts.every((act) => act.status === "restored")

    /** Ends a call that began and did not finish: reversed and refused, or uncertain. */
    const settle = Effect.fnUntraced(function* (reference: HeldCallReference, acts: ReadonlyArray<ActId>) {
      if (acts.length === 0) {
        yield* record(reference, "refused.json", StoredRefused, { reason: "nothing-applied", acts: [] })
        return { state: "refused", reason: "nothing-applied", acts: [] } satisfies HeldCallState
      }
      const reversed = yield* reverse(acts, () => Effect.void)
      if (!allRestored(reversed.acts)) {
        return { state: "uncertain", reason: "partial-application", acts: reversed.acts } satisfies HeldCallState
      }
      yield* record(reference, "refused.json", StoredRefused, {
        reason: "partial-application-restored",
        acts: reversed.acts
      })
      return { state: "refused", reason: "partial-application-restored", acts: reversed.acts } satisfies HeldCallState
    })

    const inspect = Effect.fnUntraced(function* (reference: HeldCallReference) {
      const restored = yield* stored(reference, "restored.json", StoredRestored)
      if (restored !== undefined) return { state: "restored", acts: restored.acts } satisfies HeldCallState
      const done = yield* stored(reference, "done.json", StoredDone)
      if (done !== undefined) {
        return {
          state: "done",
          acts: done.acts.map((id) => ({ id, status: "held" as const })),
          heldUntil: heldUntil(done.at)
        } satisfies HeldCallState
      }
      const refused = yield* stored(reference, "refused.json", StoredRefused)
      if (refused !== undefined) {
        return { state: "refused", reason: refused.reason, acts: refused.acts } satisfies HeldCallState
      }
      const acts = yield* claimed(reference)
      if (acts.length === 0) return { state: "prepared", acts: [] } satisfies HeldCallState
      return yield* settle(reference, acts)
    })

    return HeldCalls.of({
      prepare: (claim) =>
        lock.withLock(Effect.gen(function* () {
          const reference = { callId: claim.callId, recoveryId: recoveryIdOf(claim.callId) }
          const existing = yield* stored(reference, "call.json", StoredClaim)
          if (existing === undefined) {
            yield* io("create held call", () => mkdir(path.join(directory(reference), "acts"), { recursive: true, mode: 0o700 }))
            yield* io("create held call restore log", () => mkdir(path.join(directory(reference), "restore"), { recursive: true, mode: 0o700 }))
            yield* record(reference, "call.json", StoredClaim, { ...claim, preparedAt: new Date().toISOString() })
            return reference
          }
          const { preparedAt: _preparedAt, ...before } = existing
          const same = yield* Effect.all([
            Schema.encodeEffect(Schema.fromJsonString(HeldCallClaim))(before),
            Schema.encodeEffect(Schema.fromJsonString(HeldCallClaim))(claim)
          ]).pipe(Effect.mapError(failed("compare held call")))
          if (same[0] !== same[1]) return yield* new HeldCallMismatch({ callId: claim.callId })
          return reference
        })),

      run: (reference, forward) =>
        lock.withLock(Effect.gen(function* () {
          const state = yield* inspect(reference)
          if (state.state !== "prepared") {
            return yield* new HeldCallNotFresh({ callId: reference.callId, state: state.state })
          }
          const acts: Array<ActId> = []
          const result = yield* forward.pipe(
            Effect.provideService(HeldCall, {
              claim: (id) =>
                Effect.tryPromise({
                  try: () => create(path.join(directory(reference), "acts", `${order(acts.length)}.${id}`), ""),
                  catch: (cause) => cause
                }).pipe(
                  // Hold's own error type is not constructible here; a claim
                  // that cannot be recorded must stop the act before it renames.
                  Effect.orDie,
                  Effect.tap(() => Effect.sync(() => acts.push(id)))
                )
            }),
            Effect.result
          )
          if (result._tag === "Success") {
            const at = new Date().toISOString()
            yield* record(reference, "done.json", StoredDone, { acts, at })
            return { _tag: "done", value: result.success, heldUntil: heldUntil(at) } satisfies HeldCallOutcome<unknown> as HeldCallOutcome<typeof result.success>
          }
          const settled = yield* settle(reference, acts)
          if (settled.state === "uncertain") {
            return yield* new HeldCallUncertain({ callId: reference.callId, acts: settled.acts })
          }
          return {
            _tag: "refused",
            reason: acts.length === 0 ? "nothing-applied" : "partial-application-restored"
          } satisfies HeldCallOutcome<never>
        })),

      inspect: (reference) => lock.withLock(inspect(reference)),

      restore: (reference) =>
        lock.withLock(Effect.gen(function* () {
          const restored = yield* stored(reference, "restored.json", StoredRestored)
          if (restored !== undefined) return { state: "restored", acts: restored.acts } satisfies HeldCallRestore
          const done = yield* stored(reference, "done.json", StoredDone)
          if (done === undefined) return { state: "not-done", acts: [] } satisfies HeldCallRestore
          const begun = (yield* io("list restore progress", () => names(path.join(directory(reference), "restore")))).length > 0
          const reversed = yield* reverse(done.acts, (index, report) =>
            io("record restore progress", () =>
              create(path.join(directory(reference), "restore", `${order(index)}.${report.id}.${report.status}`), "")))
          if (allRestored(reversed.acts)) {
            yield* record(reference, "restored.json", StoredRestored, { acts: reversed.acts, at: new Date().toISOString() })
            return { state: "restored", acts: reversed.acts } satisfies HeldCallRestore
          }
          // Reversal that had begun, now or in an earlier attempt, is partial
          // whatever stopped it; only an untouched call may say nothing changed.
          if (reversed.changed || begun || reversed.acts.some((act) => act.status === "restored")) {
            return { state: "partial", acts: reversed.acts } satisfies HeldCallRestore
          }
          return {
            state: reversed.acts.some((act) => act.status === "no-longer-held") ? "no-longer-held" : "conflict",
            acts: reversed.acts
          } satisfies HeldCallRestore
        }))
    })
  })

export const HeldCallsLive = (config: HeldCallsConfig) => Layer.effect(HeldCalls, make(config))
