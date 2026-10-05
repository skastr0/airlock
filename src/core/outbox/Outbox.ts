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
import type {
  ClosedUnderCompensation,
  CompensableTag,
  Intent,
  IntentKind,
  IntentKinds
} from "./Intent.ts"
import type { EmissionState } from "./Lifecycle.ts"
import { OutboxStore } from "./OutboxStore.ts"
import {
  acknowledge,
  type DispatchAuthorization,
  DispatchProvenance,
  type EmissionAdmission,
  EmissionId,
  type EmissionRecord,
  IdempotencyKey,
  InvalidIntent,
  type LedgerPhase,
  OutboxStateCorrupt,
  owedPhases,
  rebuild,
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
  /**
   * Evidence of why this was allowed, kept on the record. It is not part of
   * what the key names: a replay keeps the admission the emission was first
   * stored with.
   */
  readonly admission?: EmissionAdmission
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
 * Only a committed emission of a kind that declares a compensation can be
 * answered. Anything else has nothing to compensate, or is irreversible.
 */
export class NotCompensable extends Schema.TaggedError<NotCompensable>()(
  "NotCompensable",
  {
    id: EmissionId,
    reason: Schema.Literals(["not-committed", "irreversible"]),
    state: Schema.String
  }
) {}

/** The handler proved nothing was sent. Terminal: stage again under a new key to retry. */
export class EmissionRefused extends Schema.TaggedError<EmissionRefused>()(
  "EmissionRefused",
  { id: EmissionId, reason: Schema.String }
) {}

/**
 * The emission is durably in `status` but a Ledger receipt it owes is not. The
 * state is the truth. The kernel writes the missing receipt the next time
 * anything loads the emission, so the remedy is to restore the Ledger and
 * retry or restart.
 */
export class OutboxRecoveryRequired extends Schema.TaggedError<OutboxRecoveryRequired>()(
  "OutboxRecoveryRequired",
  {
    id: EmissionId,
    status: Schema.Literals(["staged", "committing", "committed", "uncertain", "refused", "cancelled"]),
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
  | EmissionRefused
  | OutboxRecoveryRequired
  | DigestUnavailable
  | Unreadable
export type CancelError = UnknownEmission | EmissionNotPending | OutboxRecoveryRequired | Unreadable
export type CompensateError = UnknownEmission | NotCompensable | StageError
export type PerformError = StageError | CommitError

/** A committed emission of one kind, with the response bytes its dispatch retained. */
export interface Performed<Kinds extends IntentKinds, Tag extends keyof Kinds & string> {
  readonly emission: Emission<Pick<Kinds, Tag>, "committed">
  readonly response: Uint8Array
}

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
  /**
   * Stages and commits in one step, and records the result under the key.
   * The first call dispatches; every later call with the same key, in this
   * process or after a restart, returns the recorded outcome and the same
   * response bytes without dispatching. This is what makes a re-executed
   * caller deterministic. A key whose emission settled any other way fails
   * with that settlement: uncertain, refused, or no longer pending.
   */
  readonly perform: <Tag extends keyof Kinds & string>(
    request: StageRequest<Pick<Kinds, Tag>>,
    provenance: DispatchProvenance
  ) => Effect.Effect<Performed<Kinds, Tag>, PerformError>
  /**
   * Stages the act that answers a committed emission, as its kind declares.
   * The result is an ordinary staged emission linked to the original by
   * `compensates`; it is admitted, held and committed like any other. Its id
   * derives from the original's, so answering twice returns the same emission.
   * A kind without a compensation cannot be passed here at all.
   */
  readonly compensate: (
    committed: Emission<Pick<Kinds, CompensableTag<Kinds>>, "committed">,
    options: { readonly holdMillis: number; readonly authorization?: DispatchAuthorization }
  ) => Effect.Effect<Emission<Kinds>, CompensateError>
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
  /**
   * The typed view of a stored record: its kind's summary and outcome decoded.
   * A record whose kind is unknown or whose parts do not decode is corrupt.
   */
  readonly fromRecord: <State extends EmissionState>(
    record: RecordIn<State>
  ) => Effect.Effect<Emission<Kinds, State>, OutboxStateCorrupt>
  /**
   * The inverse of `fromRecord`: the storable, encodable record for a typed
   * emission, with its summary and outcome encoded by the kind's codecs.
   * `Schema.encode(EmissionRecord)` of the result is the emission's JSON form.
   */
  readonly toRecord: <State extends EmissionState>(
    emission: Emission<Kinds, State>
  ) => Effect.Effect<RecordIn<State>, OutboxStateCorrupt>
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
  authorization: DispatchAuthorization | undefined,
  compensates: EmissionId | undefined
) =>
  sha256Canonical({
    kind,
    dispatchDigest,
    holdMillis,
    authorization: authorization === undefined ? null : { ...authorization },
    compensates: compensates ?? null
  })

/** Compensations are named in their own id space, so no caller-chosen key can claim one. */
const compensationIdFor = (original: EmissionId) =>
  sha256Text(`airlock/compensation-id/v1:${original}`).pipe(
    Effect.map((digest) => EmissionId.make(`emi_${digest.slice("sha256:".length, "sha256:".length + 32)}`))
  )

const corrupt = (id: string, part: OutboxStateCorrupt["part"], reason: string) =>
  new OutboxStateCorrupt({ id, part, reason })

const recovery = (record: EmissionRecord) => (failure: LedgerFailed) =>
  new OutboxRecoveryRequired({
    id: record.id,
    status: record.state,
    reason: `${failure.cause}: ${failure.reason}`
  })

/**
 * Builds one Outbox over a closed set of intent kinds. Adding a kind is
 * declaring it and passing it here; the Dispatcher's handler record then
 * fails to compile until that kind has a handler.
 */
export const defineOutbox = <const Kinds extends IntentKinds>(
  kinds: Kinds & ClosedUnderCompensation<Kinds>
): OutboxDefinition<Kinds> => {
  type Tag = keyof Kinds & string
  // The types already require every compensation to target a registered kind.
  // This also refuses a different kind registered under the expected tag.
  for (const kind of Object.values<IntentKind.Any>(kinds)) {
    const answer = kind.compensate
    if (answer !== undefined && (!Object.hasOwn(kinds, answer.kind) || kinds[answer.kind] !== answer.with)) {
      throw new TypeError(
        `intent kind ${kind.tag} compensates with ${answer.kind}, which is not the kind registered under that tag`
      )
    }
  }
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

  const toRecord = <State extends EmissionState>(
    emission: Emission<Kinds, State>
  ): Effect.Effect<RecordIn<State>, OutboxStateCorrupt> =>
    Effect.gen(function* () {
      // The view differs from a record only in `summary` and `outcome`, which
      // hold the kind's decoded types. As in `view`, the registry-derived type
      // cannot be correlated with a runtime tag, so the shape is asserted once.
      const typed = emission as unknown as EmissionRecord
      const kind = yield* kindOf(typed)
      const reject = (part: string) => (error: Schema.SchemaError) =>
        corrupt(typed.id, "record", `${part}: ${error.message}`)
      const summary = yield* Schema.encodeUnknownEffect(kind.summary)(typed.summary).pipe(
        Effect.mapError(reject("summary"))
      )
      const record = typed.state === "committed"
        ? {
            ...typed,
            summary,
            outcome: yield* Schema.encodeUnknownEffect(kind.outcome)(typed.outcome).pipe(
              Effect.mapError(reject("outcome"))
            )
          }
        : { ...typed, summary }
      return yield* Effect.try({
        try: () => rebuild(record) as RecordIn<State>,
        catch: () => corrupt(typed.id, "record", "emission is not a valid record")
      })
    })

  const make = Effect.gen(function* () {
    const store = yield* OutboxStore
    const ledger = yield* Ledger
    const handlers = yield* Dispatcher
    const crypto = yield* Crypto.Crypto
    const withCrypto = Effect.provideService(Crypto.Crypto, crypto)

    /** The Ledger entry for one phase, derived only from the stored record. */
    const receiptFor = (record: EmissionRecord, phase: LedgerPhase) =>
      Effect.gen(function* () {
        const base = { effect: "emission", ref: record.id, key: `${record.id}:${phase}` } as const
        if (phase === "stage") {
          const kind = yield* kindOf(record)
          const summary = yield* Schema.decodeUnknownEffect(kind.summary)(record.summary).pipe(
            Effect.mapError((error) => corrupt(record.id, "record", `summary: ${error.message}`))
          )
          return new LedgerEntry({
            ...base,
            at: record.stagedAt,
            act: "stage",
            detail: `${record.kind} ${kind.target(summary)}`
          })
        }
        if (phase === "commit" && record.state === "committed") {
          const { provenance } = record
          return new LedgerEntry({
            ...base,
            at: record.completedAt,
            act: "commit",
            detail:
              `${record.kind} [by=${provenance.committedBy}` +
              `${provenance.dispatchClass === undefined ? "" : ` class=${provenance.dispatchClass}`}` +
              `${provenance.grantId === undefined ? "" : ` grant=${provenance.grantId}`}` +
              `${provenance.grantSelector === undefined ? "" : ` selector=${provenance.grantSelector}`}]`
          })
        }
        if (phase === "cancel" && record.state === "cancelled") {
          return new LedgerEntry({ ...base, at: record.cancelledAt, act: "cancel" })
        }
        if (phase === "refuse" && record.state === "refused") {
          return new LedgerEntry({ ...base, at: record.refusedAt, act: "refuse", detail: record.reason })
        }
        return yield* corrupt(record.id, "record", `a ${record.state} emission owes no ${phase} receipt`)
      })

    /**
     * Writes every receipt the record's state owes and has not yet durably
     * recorded, then marks it. The Ledger is idempotent on the entry key, so a
     * crash between the append and the mark costs one repeated, harmless
     * append: the Ledger converges to exactly one entry per phase.
     */
    const settleReceipts = <Record extends EmissionRecord>(
      record: Record
    ): Effect.Effect<Record, OutboxRecoveryRequired | OutboxStoreFailed | OutboxStateCorrupt> =>
      Effect.gen(function* () {
        let settled = record
        for (const phase of owedPhases(record)) {
          if (settled.ledgered.includes(phase)) continue
          yield* ledger.record(yield* receiptFor(settled, phase)).pipe(Effect.mapError(recovery(settled)))
          yield* store.acknowledge(record.id, phase).pipe(
            Effect.catchTag("UnknownEmission", () =>
              Effect.fail(corrupt(record.id, "record", "emission vanished while its receipt was recorded")))
          )
          settled = acknowledge(settled, phase)
        }
        return settled
      })

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
        // Receipts a previous runtime did not get to write. A Ledger that is
        // still down does not stop startup: every later path that loads one
        // of these emissions settles its receipts before acting.
        yield* Effect.forEach(
          yield* store.list(),
          (record) => settleReceipts(record).pipe(Effect.catchTag("OutboxRecoveryRequired", () => Effect.void)),
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
          record.authorization,
          record.compensates
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

    /** The sealed dispatch, verified against the record's digest and decoded. */
    const sealedDispatchOf = (record: EmissionRecord) =>
      Effect.gen(function* () {
        const kind = yield* kindOf(record)
        const sealed = yield* store.readDispatch(record.id)
        const digest = yield* sha256Text(sealed.canonical).pipe(withCrypto)
        if (digest !== record.dispatchDigest || sealed.digest !== record.dispatchDigest) {
          return yield* corrupt(record.id, "dispatch", "sealed dispatch does not match its staged digest")
        }
        const dispatch: IntentKind.DispatchOf<Kinds[Tag]> = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(kind.dispatch)
        )(sealed.canonical).pipe(
          Effect.mapError((error) => corrupt(record.id, "dispatch", error.message))
        )
        return dispatch
      })

    const existing = (id: EmissionId) =>
      store.read(id).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.fail(new UnknownEmission({ id })),
          onSome: (record) => Effect.succeed(record)
        }))
      )

    /**
     * Staging proper. `origin` says which emission this is: a caller's key, or
     * the answer to a committed emission, which only `compensate` may name.
     */
    const stageAs = Effect.fn("Outbox.stage")(function* (
      request: StageRequest<Kinds>,
      compensates: EmissionId | undefined
    ) {
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
        request.authorization,
        compensates
      ).pipe(withCrypto)
      const id = yield* (
        compensates === undefined ? emissionIdFor(request.key) : compensationIdFor(compensates)
      ).pipe(withCrypto)
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
        ...(request.authorization === undefined ? {} : { authorization: request.authorization }),
        ...(request.admission === undefined ? {} : { admission: request.admission }),
        ...(compensates === undefined ? {} : { compensates }),
        ledgered: []
      })
      // Publishing the record and publishing its receipt are one cancellation
      // boundary: an interrupt cannot leave a staged emission the caller was
      // never told about.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          return yield* store.exclusive(
            Effect.gen(function* () {
              const put = yield* store.putIfAbsent(
                record,
                new SealedDispatch({ digest: dispatchDigest, canonical })
              )
              if (put.record.requestDigest !== requestDigest) {
                return yield* new IdempotencyConflict({ id, key: request.key })
              }
              return yield* view(yield* settleReceipts(put.record))
            })
          )
        })
      )
    })

    const stage: OutboxService<Kinds>["stage"] = (request) => stageAs(request, undefined)

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
          const staged = yield* Effect.flatMap(existing(id), settleReceipts)
          if (staged.state !== "staged") {
            return yield* new EmissionNotPending({ id, state: staged.state })
          }
          yield* intact(staged)
          const kind = yield* kindOf(staged)
          const tag = kind.tag as Tag
          // Verify the sealed material before anything becomes irreversible.
          const dispatch = yield* sealedDispatchOf(staged)

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
            const failure = delivered.value.failure
            if (failure._tag !== "DispatchRefused") {
              return yield* settleUncertain(id, "dispatch-failed")
            }
            // Only the handler's explicit proof takes this path. If the
            // refusal cannot be persisted, the record stays `committing` and
            // the next startup settles it as uncertain, the safe direction.
            const refused = yield* store.transition(id, "committing", {
              state: "refused",
              reason: failure.reason,
              refusedAt: yield* DateTime.now
            }).pipe(Effect.catch(() => settleUncertain(id, "persistence-failed-after-dispatch")))
            yield* settleReceipts(refused)
            return yield* new EmissionRefused({ id, reason: failure.reason })
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
          return yield* view(yield* settleReceipts(committed))
        })
      ))
    })

    const cancel: OutboxService<Kinds>["cancel"] = Effect.fn("Outbox.cancel")(function* (id) {
      return yield* store.exclusive(Effect.uninterruptible(
        Effect.gen(function* () {
          const staged = yield* Effect.flatMap(existing(id), settleReceipts)
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
          return yield* view(yield* settleReceipts(cancelled))
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

    const perform: OutboxService<Kinds>["perform"] = Effect.fn("Outbox.perform")(function* (
      request,
      provenance
    ) {
      // A request for some of the kinds is a request for the registry.
      const staged = yield* stageAs(request as unknown as StageRequest<Kinds>, undefined)
      const id = staged.id
      // A racing caller with the same key may commit first; whoever loses
      // reads the settled record instead of dispatching again.
      const settled = staged.state === "staged"
        ? yield* commit(id, provenance).pipe(
            Effect.catchTag("EmissionNotPending", () => inspect(id))
          )
        : staged
      switch (settled.state) {
        case "committed": {
          const bytes = yield* store.readResponse(id)
          if (Option.isNone(bytes)) {
            return yield* corrupt(id, "response", "a committed emission has no response")
          }
          // `settled` is the record of the kind that was asked for; the
          // registry-derived type cannot carry that through the runtime lookup.
          return { emission: settled, response: bytes.value } as unknown as Performed<Kinds, typeof request.intent.kind>
        }
        case "uncertain":
          return yield* new EmissionDispatchUncertain({ id, reason: settled.reason })
        case "refused":
          return yield* new EmissionRefused({ id, reason: settled.reason })
        default:
          return yield* new EmissionNotPending({ id, state: settled.state })
      }
    })

    const compensate: OutboxService<Kinds>["compensate"] = Effect.fn("Outbox.compensate")(function* (
      committed,
      options
    ) {
      // The argument only names the emission. What is answered is the stored
      // record, re-read and re-verified, never the value the caller holds.
      const id: EmissionId = committed.id
      const record = yield* existing(id)
      if (record.state !== "committed") {
        return yield* new NotCompensable({ id, reason: "not-committed", state: record.state })
      }
      const kind = yield* kindOf(record)
      const answer = kind.compensate
      if (answer === undefined) {
        return yield* new NotCompensable({ id, reason: "irreversible", state: record.state })
      }
      const dispatch = yield* sealedDispatchOf(record)
      const outcome: unknown = yield* Schema.decodeUnknownEffect(kind.outcome)(record.outcome).pipe(
        Effect.mapError((error) => corrupt(id, "record", `outcome: ${error.message}`))
      )
      return yield* stageAs(
        {
          key: IdempotencyKey.make(`compensation-of:${id}`),
          // `answer.intent` returns the dispatch of the kind registered under
          // `answer.kind`, which `defineOutbox` checked at construction.
          intent: { kind: answer.kind, dispatch: answer.intent({ dispatch, outcome }) } as Intent<Kinds>,
          holdMillis: options.holdMillis,
          ...(options.authorization === undefined ? {} : { authorization: options.authorization })
        },
        id
      )
    })

    return { stage, inspect, commit, cancel, perform, compensate, response, pending, pendingAuthorized, flush }
  })

  return { kinds, Outbox, Dispatcher, fromRecord: view, toRecord, layer: Layer.effect(Outbox, make) }
}
