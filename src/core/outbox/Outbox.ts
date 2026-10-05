import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import {
  canonicalJson,
  type DigestUnavailable,
  type Sha256Digest,
  sha256Canonical,
  sha256Text
} from "../Canonical.ts"
import { Ledger, LedgerEntry, type LedgerFailed } from "../ledger/Ledger.ts"
import type { DispatchHandlers } from "./Dispatcher.ts"
import type { Intent, IntentKind, IntentKinds } from "./Intent.ts"
import type { EmissionState } from "./Lifecycle.ts"
import { OutboxStore } from "./OutboxStore.ts"
import {
  type DispatchAuthorization,
  DispatchProvenance,
  EmissionId,
  type EmissionRecord,
  type IdempotencyKey,
  InvalidIntent,
  OutboxStateCorrupt,
  OutboxStoreFailed,
  type RecordIn,
  ResponseCapture,
  SealedDispatch,
  StagedEmission,
  UncertainReason,
  UnknownEmission
} from "./Records.ts"

/** Construction bound on the response bytes any dispatch may retain. */
export const RESPONSE_LIMIT_BYTES = 65_536
/** Construction bound on one dispatch, connection through bounded capture. */
export const DISPATCH_TIMEOUT_MILLIS = 30_000

// ── the wire capability ─────────────────────────────────────────────────────

const PermitTypeId: unique symbol = Symbol("airlock/core/DispatchPermit")

/**
 * The capability to touch the wire for exactly one emission. It is minted only
 * in this module, only after `staged → committing` is durable, and it is
 * revoked as soon as that dispatch settles. No other module can construct one,
 * so no other module can call a handler: wire authority is a value, not a
 * convention.
 */
export interface DispatchPermit<Tag extends string = string> {
  readonly [PermitTypeId]: Tag
  readonly emissionId: EmissionId
  readonly kind: Tag
  readonly dispatchDigest: Sha256Digest
}

const livePermits = new WeakSet<object>()

const mintPermit = <Tag extends string>(
  kind: Tag,
  emissionId: EmissionId,
  dispatchDigest: Sha256Digest
): DispatchPermit<Tag> => {
  const permit: DispatchPermit<Tag> = Object.freeze({
    [PermitTypeId]: kind,
    emissionId,
    kind,
    dispatchDigest
  })
  livePermits.add(permit)
  return permit
}

/**
 * For handlers: true only for a permit this kernel minted and has not revoked.
 * A forged or replayed permit fails here even if a cast got it past the types.
 */
export const isLivePermit = (permit: DispatchPermit): boolean => livePermits.has(permit)

// ── the typed view of an emission ───────────────────────────────────────────

type Typed<Record, Tag, Summary, Outcome> =
  & Omit<Record, "kind" | "summary" | "outcome">
  & { readonly kind: Tag; readonly summary: Summary }
  & (Record extends { readonly outcome: unknown } ? { readonly outcome: Outcome } : unknown)

/**
 * An emission as callers see it: the stored record with its kind's summary and
 * outcome decoded. Narrowing on `kind` and `state` yields exact field types.
 */
export type Emission<Kinds extends IntentKinds, State extends EmissionState = EmissionState> = {
  readonly [Tag in keyof Kinds & string]: RecordIn<State> extends infer Record
    ? Record extends unknown
      ? Typed<Record, Tag, IntentKind.SummaryOf<Kinds[Tag]>, IntentKind.OutcomeOf<Kinds[Tag]>>
      : never
    : never
}[keyof Kinds & string]

export interface StageRequest<Kinds extends IntentKinds> {
  /** Names this logical act. Replaying the same key returns the same emission. */
  readonly key: IdempotencyKey
  readonly intent: Intent<Kinds>
  readonly holdMillis: number
  readonly authorization?: DispatchAuthorization
}

// ── errors ──────────────────────────────────────────────────────────────────

export class InvalidHoldDuration extends Schema.TaggedError<InvalidHoldDuration>()(
  "InvalidHoldDuration",
  { holdMillis: Schema.Number }
) {}

/** The same idempotency key was staged before with different content. */
export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  { id: EmissionId, key: Schema.String }
) {}

export class InvalidDispatchAuthorization extends Schema.TaggedError<InvalidDispatchAuthorization>()(
  "InvalidDispatchAuthorization",
  { field: Schema.String, reason: Schema.String }
) {}

export class EmissionNotPending extends Schema.TaggedError<EmissionNotPending>()(
  "EmissionNotPending",
  { id: EmissionId, state: Schema.String }
) {}

/** The wire may have been reached. Terminal: Airlock never retries it. */
export class EmissionDispatchUncertain extends Schema.TaggedError<EmissionDispatchUncertain>()(
  "EmissionDispatchUncertain",
  { id: EmissionId, reason: UncertainReason }
) {}

/**
 * The emission reached `status` durably but its Ledger entry did not. The
 * state is the truth; the missing receipt is what needs recovery.
 */
export class OutboxRecoveryRequired extends Schema.TaggedError<OutboxRecoveryRequired>()(
  "OutboxRecoveryRequired",
  {
    id: EmissionId,
    status: Schema.Literals(["staged", "committed", "cancelled"]),
    reason: Schema.String
  }
) {}

type Unreadable = OutboxStoreFailed | OutboxStateCorrupt

export type StageError =
  | InvalidHoldDuration
  | InvalidIntent
  | InvalidDispatchAuthorization
  | IdempotencyConflict
  | DigestUnavailable
  | OutboxRecoveryRequired
  | Unreadable
export type ReadError = UnknownEmission | Unreadable
export type CommitError =
  | UnknownEmission
  | EmissionNotPending
  | EmissionDispatchUncertain
  | OutboxRecoveryRequired
  | DigestUnavailable
  | Unreadable
export type CancelError = UnknownEmission | EmissionNotPending | OutboxRecoveryRequired | Unreadable

// ── the service ─────────────────────────────────────────────────────────────

export interface OutboxService<Kinds extends IntentKinds> {
  /**
   * Durably records intent and sends nothing. Replay-idempotent: the same key
   * with the same content returns the existing emission in whatever state it
   * reached; the same key with different content is `IdempotencyConflict`.
   */
  readonly stage: (request: StageRequest<Kinds>) => Effect.Effect<Emission<Kinds>, StageError>
  readonly inspect: (id: EmissionId) => Effect.Effect<Emission<Kinds>, ReadError>
  /**
   * The only operation that reaches the wire. It persists `staged → committing`,
   * mints the one permit for this emission, hands it to the kind's handler, and
   * settles to `committed` or `uncertain`.
   */
  readonly commit: (
    id: EmissionId,
    provenance: DispatchProvenance
  ) => Effect.Effect<Emission<Kinds, "committed">, CommitError>
  readonly cancel: (id: EmissionId) => Effect.Effect<Emission<Kinds, "cancelled">, CancelError>
  /** The bounded response of a committed emission, for the trusted runtime only. */
  readonly response: (id: EmissionId) => Effect.Effect<Option.Option<Uint8Array>, ReadError>
  readonly pending: Effect.Effect<ReadonlyArray<Emission<Kinds, "staged">>, Unreadable>
  /** Staged emissions pre-authorized under this supervisor seal. Reads only. */
  readonly pendingAuthorized: (
    sealDigest: Sha256Digest
  ) => Effect.Effect<ReadonlyArray<Emission<Kinds, "staged">>, Unreadable>
  /** Commits, as the supervisor, every staged emission whose hold has run out by `now`. */
  readonly flush: Effect.Effect<
    {
      readonly committed: ReadonlyArray<Emission<Kinds, "committed">>
      readonly failed: ReadonlyArray<EmissionId>
      readonly waiting: number
    },
    OutboxRecoveryRequired | Unreadable
  >
}

/** Identifier types for the two services one kind registry defines. */
export interface OutboxOf<Kinds extends IntentKinds> {
  readonly _: unique symbol
  readonly kinds: Kinds
}
export interface DispatcherOf<Kinds extends IntentKinds> {
  readonly _: unique symbol
  readonly kinds: Kinds
}

export interface OutboxDefinition<Kinds extends IntentKinds> {
  readonly kinds: Kinds
  readonly Outbox: Context.Service<OutboxOf<Kinds>, OutboxService<Kinds>>
  /** The wire. A host provides this Layer; the kernel is its only caller. */
  readonly Dispatcher: Context.Service<DispatcherOf<Kinds>, DispatchHandlers<Kinds>>
  /** The kernel. Startup settles every interrupted `committing` as `uncertain`. */
  readonly layer: Layer.Layer<
    OutboxOf<Kinds>,
    OutboxStoreFailed | OutboxStateCorrupt,
    OutboxStore | Ledger | Crypto.Crypto | DispatcherOf<Kinds>
  >
}

// ── the kernel ──────────────────────────────────────────────────────────────

const validHold = (holdMillis: number) =>
  Number.isFinite(holdMillis) && Number.isInteger(holdMillis) && holdMillis >= 0

const emissionIdFor = (key: IdempotencyKey) =>
  sha256Text(`airlock/emission-id/v1:${key}`).pipe(
    Effect.map((digest) => EmissionId.make(`emi_${digest.slice("sha256:".length, "sha256:".length + 32)}`))
  )

/** Identifies everything a caller asked `stage` for; a record must keep matching it. */
const requestDigestOf = (
  kind: string,
  dispatchDigest: Sha256Digest,
  holdMillis: number,
  authorization: DispatchAuthorization | undefined
) =>
  sha256Canonical({
    kind,
    dispatchDigest,
    holdMillis,
    authorization: authorization === undefined ? null : { ...authorization }
  })

const corrupt = (id: string, part: OutboxStateCorrupt["part"], reason: string) =>
  new OutboxStateCorrupt({ id, part, reason })

const recovery = (
  id: EmissionId,
  status: OutboxRecoveryRequired["status"]
) => (failure: LedgerFailed) =>
  new OutboxRecoveryRequired({ id, status, reason: `${failure.cause}: ${failure.reason}` })

/**
 * Builds one Outbox over a closed set of intent kinds. Adding a kind is
 * declaring it and passing it here; the Dispatcher's handler record then
 * fails to compile until that kind has a handler.
 */
export const defineOutbox = <const Kinds extends IntentKinds>(
  kinds: Kinds
): OutboxDefinition<Kinds> => {
  type Tag = keyof Kinds & string
  const Outbox = Context.Service<OutboxOf<Kinds>, OutboxService<Kinds>>("airlock/core/Outbox")
  const Dispatcher = Context.Service<DispatcherOf<Kinds>, DispatchHandlers<Kinds>>(
    "airlock/core/Dispatcher"
  )

  const kindFor = (tag: string): Option.Option<Kinds[Tag]> =>
    Object.hasOwn(kinds, tag) ? Option.fromNullishOr(kinds[tag as Tag]) : Option.none()

  const kindOf = (record: EmissionRecord) =>
    Option.match(kindFor(record.kind), {
      onNone: () => Effect.fail(corrupt(record.id, "record", `unknown intent kind ${record.kind}`)),
      onSome: (kind) => Effect.succeed(kind)
    })

  /**
   * Decodes a stored record's kind-specific parts. A record that does not
   * decode is corrupt. The result type is derived from the kind registry, which
   * TypeScript cannot correlate with a runtime tag lookup; this is the one
   * place the kernel asserts that correlation.
   */
  const view = <State extends EmissionState>(
    record: RecordIn<State>
  ): Effect.Effect<Emission<Kinds, State>, OutboxStateCorrupt> =>
    Effect.gen(function* () {
      const stored: EmissionRecord = record
      const kind = yield* kindOf(stored)
      const summary: unknown = yield* Schema.decodeUnknownEffect(kind.summary)(stored.summary).pipe(
        Effect.mapError((error) => corrupt(stored.id, "record", `summary: ${error.message}`))
      )
      if (stored.state !== "committed") return { ...stored, summary }
      const outcome: unknown = yield* Schema.decodeUnknownEffect(kind.outcome)(stored.outcome).pipe(
        Effect.mapError((error) => corrupt(stored.id, "record", `outcome: ${error.message}`))
      )
      return { ...stored, summary, outcome }
    }).pipe(Effect.map((typed) => typed as unknown as Emission<Kinds, State>))

  const make = Effect.gen(function* () {
    const store = yield* OutboxStore
    const ledger = yield* Ledger
    const handlers = yield* Dispatcher
    const crypto = yield* Crypto.Crypto
    const withCrypto = Effect.provideService(Crypto.Crypto, crypto)

    // A durable `committing` means a dispatch may have begun before a previous
    // runtime stopped. The only honest settlement is `uncertain`.
    yield* store.exclusive(
      Effect.gen(function* () {
        const interrupted = yield* store.list("committing")
        const uncertainAt = yield* DateTime.now
        yield* Effect.forEach(
          interrupted,
          (record) =>
            store.transition(record.id, "committing", {
              state: "uncertain",
              reason: "recovered-after-restart",
              uncertainAt
            }).pipe(
              Effect.catchTag(["UnknownEmission", "TransitionConflict"], () => Effect.void)
            ),
          { discard: true }
        )
      })
    )

    /**
     * A staged record is acted on only while it still says what was staged:
     * its request digest must recompute and its authorization must name the
     * intent's own target. Anything else is corrupt, and nothing is sent.
     */
    const intact = (record: StagedEmission) =>
      Effect.gen(function* () {
        const emission = yield* view<"staged">(record)
        const kind = yield* kindOf(record)
        const expected = yield* requestDigestOf(
          record.kind,
          record.dispatchDigest,
          DateTime.toEpochMillis(record.holdUntil) - DateTime.toEpochMillis(record.stagedAt),
          record.authorization
        ).pipe(withCrypto)
        if (expected !== record.requestDigest) {
          return yield* corrupt(record.id, "record", "staged record does not match its request digest")
        }
        if (
          record.authorization !== undefined &&
          record.authorization.target !== kind.target(emission.summary)
        ) {
          return yield* corrupt(record.id, "record", "authorization names a different target")
        }
        return emission
      })

    const existing = (id: EmissionId) =>
      store.read(id).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.fail(new UnknownEmission({ id })),
          onSome: (record) => Effect.succeed(record)
        }))
      )

    const stage: OutboxService<Kinds>["stage"] = Effect.fn("Outbox.stage")(function* (request) {
      if (!validHold(request.holdMillis)) {
        return yield* new InvalidHoldDuration({ holdMillis: request.holdMillis })
      }
      const tag: Tag = request.intent.kind
      const registered = kindFor(tag)
      if (Option.isNone(registered)) {
        return yield* new InvalidIntent({ kind: tag, field: "kind", reason: "is not a registered intent kind" })
      }
      const kind = registered.value
      const summary = kind.summarize(request.intent.dispatch)
      if (Result.isFailure(summary)) return yield* summary.failure
      const target = kind.target(summary.success)
      if (request.authorization !== undefined && request.authorization.target !== target) {
        return yield* new InvalidDispatchAuthorization({
          field: "authorization.target",
          reason: "must equal the staged intent's canonical target"
        })
      }
      const invalid = (field: string) => (error: Schema.SchemaError) =>
        new InvalidIntent({ kind: tag, field, reason: error.message })
      const canonical = canonicalJson(
        yield* Schema.encodeEffect(kind.dispatch)(request.intent.dispatch).pipe(
          Effect.mapError(invalid("dispatch"))
        )
      )
      const encodedSummary = yield* Schema.encodeEffect(kind.summary)(summary.success).pipe(
        Effect.mapError(invalid("summary"))
      )
      const dispatchDigest = yield* sha256Text(canonical).pipe(withCrypto)
      const requestDigest = yield* requestDigestOf(
        tag,
        dispatchDigest,
        request.holdMillis,
        request.authorization
      ).pipe(withCrypto)
      const id = yield* emissionIdFor(request.key).pipe(withCrypto)
      const stagedAt = yield* DateTime.now
      const record = new StagedEmission({
        id,
        key: request.key,
        kind: tag,
        dispatchDigest,
        requestDigest,
        summary: encodedSummary,
        stagedAt,
        holdUntil: DateTime.add(stagedAt, { milliseconds: request.holdMillis }),
        ...(request.authorization === undefined ? {} : { authorization: request.authorization })
      })
      // Publishing the record and publishing its receipt are one cancellation
      // boundary: an interrupt cannot leave a staged emission the caller was
      // never told about.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const put = yield* store.exclusive(
            store.putIfAbsent(record, new SealedDispatch({ digest: dispatchDigest, canonical }))
          )
          if (put.record.requestDigest !== requestDigest) {
            return yield* new IdempotencyConflict({ id, key: request.key })
          }
          if (put.created) {
            yield* ledger.record(new LedgerEntry({
              at: stagedAt,
              effect: "emission",
              act: "stage",
              ref: id,
              detail: `${tag} ${target}`
            })).pipe(Effect.mapError(recovery(id, "staged")))
          }
          return yield* view(put.record)
        })
      )
    })

    const inspect: OutboxService<Kinds>["inspect"] = Effect.fn("Outbox.inspect")(function* (id) {
      return yield* view(yield* existing(id))
    })

    const settleUncertain = (id: EmissionId, reason: UncertainReason) =>
      DateTime.now.pipe(
        Effect.flatMap((uncertainAt) =>
          store.transition(id, "committing", { state: "uncertain", reason, uncertainAt })
        ),
        // If even this fails the record stays `committing`, and the next
        // startup settles it. Either way it is never dispatched again.
        Effect.ignore,
        Effect.andThen(Effect.fail(new EmissionDispatchUncertain({ id, reason })))
      )

    // The point of no return. This body holds the only handler call in the
    // kernel; every other operation manipulates inert durable state.
    const commit: OutboxService<Kinds>["commit"] = Effect.fn("Outbox.commit")(function* (
      id,
      provenance
    ) {
      return yield* store.exclusive(Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const staged = yield* existing(id)
          if (staged.state !== "staged") {
            return yield* new EmissionNotPending({ id, state: staged.state })
          }
          yield* intact(staged)
          const kind = yield* kindOf(staged)
          const tag = kind.tag as Tag
          // Verify the sealed material before anything becomes irreversible.
          const sealed = yield* store.readDispatch(id)
          const digest = yield* sha256Text(sealed.canonical).pipe(withCrypto)
          if (digest !== staged.dispatchDigest || sealed.digest !== staged.dispatchDigest) {
            return yield* corrupt(id, "dispatch", "sealed dispatch does not match its staged digest")
          }
          const dispatch = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(kind.dispatch)
          )(sealed.canonical).pipe(
            Effect.mapError((error) => corrupt(id, "dispatch", error.message))
          )

          const committing = yield* store.transition(id, "staged", {
            state: "committing",
            provenance,
            committingAt: yield* DateTime.now
          }).pipe(
            Effect.catchTag("TransitionConflict", (conflict) =>
              Effect.fail(new EmissionNotPending({ id, state: conflict.actual })))
          )

          // Dispatch is the interruptible portion. Once it has begun,
          // interruption is an honest uncertain outcome, not a bare fiber
          // interruption that erases the caller's receipt.
          const permit = mintPermit(tag, id, committing.dispatchDigest)
          const delivered = yield* restore(
            handlers[tag]({ permit, dispatch, responseLimitBytes: RESPONSE_LIMIT_BYTES }).pipe(
              Effect.timeoutOption(DISPATCH_TIMEOUT_MILLIS),
              Effect.result
            )
          ).pipe(
            Effect.ensuring(Effect.sync(() => livePermits.delete(permit))),
            Effect.exit
          )
          if (Exit.isFailure(delivered)) {
            return yield* Cause.hasInterruptsOnly(delivered.cause)
              ? settleUncertain(id, "interrupted")
              : settleUncertain(id, "dispatch-failed").pipe(
                  Effect.catchTag("EmissionDispatchUncertain", () => Effect.failCause(delivered.cause))
                )
          }
          if (Result.isFailure(delivered.value)) {
            return yield* settleUncertain(id, "dispatch-failed")
          }
          if (Option.isNone(delivered.value.success)) {
            return yield* settleUncertain(id, "dispatch-timed-out")
          }
          const delivery = delivered.value.success.value
          if (delivery.response.byteLength > RESPONSE_LIMIT_BYTES) {
            return yield* settleUncertain(id, "dispatch-failed")
          }

          const completedAt = yield* DateTime.now
          const committed = yield* Schema.encodeEffect(kind.outcome)(delivery.outcome).pipe(
            Effect.flatMap((outcome) =>
              store.transition(id, "committing", {
                state: "committed",
                outcome,
                capture: new ResponseCapture({
                  retainedBytes: delivery.response.byteLength,
                  truncated: delivery.truncated,
                  limitBytes: RESPONSE_LIMIT_BYTES
                }),
                completedAt,
                response: delivery.response
              })
            ),
            Effect.catch(() => settleUncertain(id, "persistence-failed-after-dispatch"))
          )
          yield* ledger.record(new LedgerEntry({
            at: completedAt,
            effect: "emission",
            act: "commit",
            ref: id,
            detail:
              `${tag} [by=${provenance.committedBy}` +
              `${provenance.dispatchClass === undefined ? "" : ` class=${provenance.dispatchClass}`}` +
              `${provenance.grantId === undefined ? "" : ` grant=${provenance.grantId}`}` +
              `${provenance.grantSelector === undefined ? "" : ` selector=${provenance.grantSelector}`}]`
          })).pipe(Effect.mapError(recovery(id, "committed")))
          return yield* view(committed)
        })
      ))
    })

    const cancel: OutboxService<Kinds>["cancel"] = Effect.fn("Outbox.cancel")(function* (id) {
      return yield* store.exclusive(Effect.uninterruptible(
        Effect.gen(function* () {
          const staged = yield* existing(id)
          if (staged.state !== "staged") {
            return yield* new EmissionNotPending({ id, state: staged.state })
          }
          const cancelledAt = yield* DateTime.now
          const cancelled = yield* store.transition(id, "staged", {
            state: "cancelled",
            cancelledAt
          }).pipe(
            Effect.catchTag("TransitionConflict", (conflict) =>
              Effect.fail(new EmissionNotPending({ id, state: conflict.actual })))
          )
          yield* ledger.record(new LedgerEntry({
            at: cancelledAt,
            effect: "emission",
            act: "cancel",
            ref: id
          })).pipe(Effect.mapError(recovery(id, "cancelled")))
          return yield* view(cancelled)
        })
      ))
    })

    const response: OutboxService<Kinds>["response"] = Effect.fn("Outbox.response")(function* (id) {
      yield* existing(id)
      return yield* store.readResponse(id)
    })

    const pending: OutboxService<Kinds>["pending"] = store.list("staged").pipe(
      Effect.map((records) =>
        [...records].sort((a, b) =>
          DateTime.toEpochMillis(a.stagedAt) - DateTime.toEpochMillis(b.stagedAt)
        )
      ),
      Effect.flatMap(Effect.forEach((record) => view(record)))
    )

    const pendingAuthorized: OutboxService<Kinds>["pendingAuthorized"] = (sealDigest) =>
      store.list("staged").pipe(
        Effect.map((records) =>
          records
            .filter((record) => record.authorization?.sealDigest === sealDigest)
            .sort((a, b) => DateTime.toEpochMillis(a.stagedAt) - DateTime.toEpochMillis(b.stagedAt))
        ),
        Effect.flatMap(Effect.forEach(intact)),
        Effect.catchTag("DigestUnavailable", (error) =>
          Effect.fail(new OutboxStoreFailed({ operation: "verify-pending", reason: error.reason })))
      )

    const flush: OutboxService<Kinds>["flush"] = Effect.gen(function* () {
      const now = yield* DateTime.now
      const staged = yield* pending
      const due = staged.filter((emission) => DateTime.isLessThanOrEqualTo(emission.holdUntil, now))
      const committed: Array<Emission<Kinds, "committed">> = []
      const failed: Array<EmissionId> = []
      for (const emission of due) {
        // Flush is the supervisor releasing every hold that has run out.
        const result = yield* commit(
          emission.id,
          new DispatchProvenance({ committedBy: "supervisor" })
        ).pipe(Effect.result)
        if (Result.isSuccess(result)) committed.push(result.success)
        else if (
          result.failure._tag === "OutboxRecoveryRequired" ||
          result.failure._tag === "OutboxStoreFailed" ||
          result.failure._tag === "OutboxStateCorrupt"
        ) return yield* result.failure
        else failed.push(emission.id)
      }
      return { committed, failed, waiting: staged.length - due.length }
    })

    return { stage, inspect, commit, cancel, response, pending, pendingAuthorized, flush }
  })

  return { kinds, Outbox, Dispatcher, layer: Layer.effect(Outbox, make) }
}
