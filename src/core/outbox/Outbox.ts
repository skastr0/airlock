import { canonicalExactJson } from "../ExactJson.ts"
import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import {
  canonicalJson,
  type DigestUnavailable,
  type Sha256Digest,
  sha256Canonical,
  sha256Text
} from "../Canonical.ts"
import { Ledger, LedgerEntry, type LedgerFailed } from "../ledger/Ledger.ts"
import { describeWire, type WireMaterial, type WireRequest } from "../contract/Wire.ts"
import type { ToolContract } from "../contract/ToolContract.ts"
import { type BoundResource, HeldReference } from "../contract/ToolHost.ts"
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
import { CaptureAdmission, CapturedEmission, CAPTURE_RESULT_LIMIT_BYTES } from "./Capture.ts"
import { ownJson } from "../contract/Decoder.ts"
import type { Done, Refused } from "../contract/Receipt.ts"
import {
  acknowledge,
  DispatchAuthorization,
  DispatchProvenance,
  EmissionAdmission,
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
 * in this module, after durable `staged → committing` or exact capture-now
 * admission. It is revoked as soon as that dispatch settles. No other module
 * can construct one or call a handler: wire authority is a value, not a
 * convention.
 */
export interface DispatchPermit<Tag extends string = string> {
  readonly [PermitTypeId]: Tag
  readonly emissionId: EmissionId
  readonly kind: Tag
  readonly dispatchDigest: Sha256Digest
}

const livePermits = new WeakSet<object>()
const permitDispatches = new WeakMap<object, string>()
const permitAdmissions = new WeakMap<object, EmissionAdmission>()
const permitWires = new WeakMap<object, WireMaterial>()
const WireTypeId: unique symbol = Symbol("airlock/core/WireToken")

/** One host network operation inside an admitted implementation's live call. */
export interface WireToken {
  readonly [WireTypeId]: true
  readonly callId: EmissionId
}

const wireTokens = new WeakMap<object, { readonly permit: DispatchPermit; readonly signal?: AbortSignal; readonly request?: WireRequest; available: boolean }>()

const mintPermit = <Tag extends string>(
  kind: Tag,
  emissionId: EmissionId,
  dispatchDigest: Sha256Digest,
  canonical: string,
  admission?: EmissionAdmission,
  wire?: WireMaterial
): DispatchPermit<Tag> => {
  const permit: DispatchPermit<Tag> = Object.freeze({
    [PermitTypeId]: kind,
    emissionId,
    kind,
    dispatchDigest
  })
  livePermits.add(permit)
  permitDispatches.set(permit, canonical)
  if (wire !== undefined) permitWires.set(permit, wire)
  if (admission !== undefined) {
    const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(EmissionAdmission))(
      Schema.encodeSync(Schema.fromJsonString(EmissionAdmission))(admission)
    )
    const freeze = (value: unknown): void => {
      if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
    }
    freeze(snapshot)
    permitAdmissions.set(permit, snapshot)
  }
  return permit
}

/**
 * True only for a permit this kernel minted and has not revoked. Wire
 * handlers must also call `consumePermit` to bind and consume its one use.
 */
export const isLivePermit = (permit: DispatchPermit): boolean => livePermits.has(permit)

/** Inert checks before host preparation; consuming the exact call is still required to act. */
export const permitAuthorizes = (permit: DispatchPermit, kind: string, canonical: string): boolean =>
  isLivePermit(permit) && permit.kind === kind && permitDispatches.get(permit) === canonical

/** Execution authority comes from the minted permit, never substituted handler arguments. */
export const permitAdmission = (permit: DispatchPermit): EmissionAdmission | undefined =>
  isLivePermit(permit) ? permitAdmissions.get(permit) : undefined

/**
 * For wire handlers, at execution time: consume one live permit for exactly
 * its staged kind and canonical encoded dispatch. Checking and consuming are
 * synchronous, so racing uses cannot both pass. A mismatched request consumes
 * nothing; a consumed or revoked permit never authorizes another request.
 */
export const consumePermit = (permit: DispatchPermit, kind: string, canonical: string): boolean => {
  if (!permitAuthorizes(permit, kind, canonical)) return false
  permitDispatches.delete(permit)
  return true
}

/**
 * Implementation entry: consumes the exact call permit before deriving its
 * one-use wire authority. A substituted call cannot get a token.
 */
export const enterImplementation = (permit: DispatchPermit, kind: string, canonical: string, signal?: AbortSignal,
  resources: ReadonlyArray<BoundResource> = []
): WireToken | undefined => {
  const wire = permitWires.get(permit)
  const endpoint = wire === undefined ? undefined : resources.find((resource) => canonicalJson(resource.binding) === canonicalJson(wire.endpoint))
  if (wire !== undefined && endpoint === undefined) return undefined
  if (signal?.aborted === true || !consumePermit(permit, kind, canonical)) return undefined
  const token: WireToken = Object.freeze({ [WireTypeId]: true as const, callId: permit.emissionId })
  const request: WireRequest | undefined = wire === undefined ? undefined : Object.freeze({ ...wire, endpoint: endpoint! })
  wireTokens.set(token, { permit, ...(signal === undefined ? {} : { signal }), ...(request === undefined ? {} : { request }), available: true })
  return token
}

/** Checking does not consume; the host wire function must consume before I/O. */
export const isLiveWireToken = (token: WireToken): boolean => {
  const entry = wireTokens.get(token)
  return entry !== undefined && entry.request !== undefined && entry.available && entry.signal?.aborted !== true && isLivePermit(entry.permit)
}

/** Atomic, single use. Copies, forged tokens, aborted and settled calls refuse. */
export const takeWireRequest = (token: WireToken): WireRequest | undefined => {
  const entry = wireTokens.get(token)
  if (entry === undefined || !isLiveWireToken(token)) return undefined
  entry.available = false
  return entry.request
}

// ── the typed view of an emission ───────────────────────────────────────────

type Typed<Record, Tag, Summary, Outcome> =
  & Omit<Record, "kind" | "summary" | "outcome">
  & { readonly kind: Tag; readonly summary: Summary }
  & (Record extends { readonly state: "captured" } ? Pick<Record, "outcome" & keyof Record>
    : Record extends { readonly outcome: unknown } ? { readonly outcome: Outcome } : unknown)

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
    status: Schema.Literals(["staged", "committing", "committed", "uncertain", "refused", "cancelled", "captured"]),
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
  | InvalidDispatchAuthorization
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

/** A read can fail or change on replay, but never become an uncertain write. */
export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()("CaptureFailed", {
  id: EmissionId,
  code: Schema.Literals(["failed", "timeout", "interrupted", "expired", "result-changed", "invalid-result"])
}) {}
export type CaptureError = StageError | CaptureFailed
export type CaptureTag<Kinds extends IntentKinds> = {
  [Tag in keyof Kinds & string]: Kinds[Tag] extends { readonly effect: "capture" } ? Tag : never
}[keyof Kinds & string]
export interface CaptureRequest<Kinds extends IntentKinds> {
  readonly key: IdempotencyKey
  readonly intent: Intent<Kinds>
  readonly admission: typeof CaptureAdmission.Type
}


/** A committed emission of one kind, with the response bytes its dispatch retained. */
export interface Performed<Kinds extends IntentKinds, Tag extends keyof Kinds & string> {
  readonly emission: Emission<Pick<Kinds, Tag>, "committed">
  readonly response: Uint8Array
}

// ── the service ─────────────────────────────────────────────────────────────

export interface OutboxService<Kinds extends IntentKinds> {
  /** Only capture-now: one terminal journal entry; kept replay never reads again. */
  readonly capture: <Tag extends CaptureTag<Kinds>>(
    request: CaptureRequest<Pick<Kinds, Tag>>
  ) => Effect.Effect<Done<IntentKind.OutcomeOf<Kinds[Tag]>> | Refused, CaptureError>

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
  compensates: EmissionId | undefined,
  admission: EmissionAdmission | undefined
) =>
  sha256Canonical({
    kind,
    dispatchDigest,
    holdMillis,
    authorization: authorization === undefined ? null : { ...authorization },
    compensates: compensates ?? null,
    admission: admission === undefined ? null : Schema.encodeSync(EmissionAdmission)(admission)
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
        if (phase === "stage" && record.state !== "captured") {
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
          if ((settled.ledgered as ReadonlyArray<LedgerPhase>).includes(phase)) continue
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
          yield* store.listOwing,
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
          record.compensates,
          record.admission
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
        return { dispatch, canonical: sealed.canonical }
      })

    const existing = (id: EmissionId) =>
      store.read(id).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.fail(new UnknownEmission({ id })),
          onSome: (record) => Effect.succeed(record)
        }))
      )

    /**
     * The caller's request as values the kernel owns: validated, encoded once,
     * and copied. Synchronous on purpose.
     */
    const own = (request: StageRequest<Kinds>): Result.Result<
      {
        readonly tag: Tag
        readonly canonical: string
        readonly encodedSummary: Schema.Json
        readonly holdMillis: number
        readonly key: IdempotencyKey
        readonly authorization: DispatchAuthorization | undefined
        readonly admission: EmissionAdmission | undefined
      },
      InvalidHoldDuration | InvalidIntent | InvalidDispatchAuthorization
    > => {
      const holdMillis = request.holdMillis
      if (!validHold(holdMillis)) return Result.fail(new InvalidHoldDuration({ holdMillis }))
      const tag: Tag = request.intent.kind
      const registered = kindFor(tag)
      if (Option.isNone(registered)) {
        return Result.fail(new InvalidIntent({ kind: tag, field: "kind", reason: "is not a registered intent kind" }))
      }
      const kind = registered.value
      const invalid = (field: string) => (error: Schema.SchemaError) =>
        new InvalidIntent({ kind: tag, field, reason: error.message })
      const encoded = Schema.encodeResult(kind.dispatch)(request.intent.dispatch)
      if (Result.isFailure(encoded)) return Result.fail(invalid("dispatch")(encoded.failure))
      const canonical = canonicalJson(encoded.success)
      // The kernel's own copy, decoded from the bytes that will be stored.
      const dispatch = Schema.decodeUnknownResult(Schema.fromJsonString(kind.dispatch))(canonical)
      if (Result.isFailure(dispatch)) return Result.fail(invalid("dispatch")(dispatch.failure))
      const summary = kind.summarize(dispatch.success)
      if (Result.isFailure(summary)) return Result.fail(summary.failure)
      const encodedSummary = Schema.encodeResult(kind.summary)(summary.success)
      if (Result.isFailure(encodedSummary)) return Result.fail(invalid("summary")(encodedSummary.failure))
      const given = request.authorization
      const authorization = given === undefined ? undefined : new DispatchAuthorization({
        sealDigest: given.sealDigest,
        grantId: given.grantId,
        grantSelector: given.grantSelector,
        dispatchClass: given.dispatchClass,
        target: given.target
      })
      if (authorization !== undefined && authorization.target !== kind.target(summary.success)) {
        return Result.fail(new InvalidDispatchAuthorization({
          field: "authorization.target",
          reason: "must equal the staged intent's canonical target"
        }))
      }
      const admitted = request.admission
      const decodedAdmission = admitted === undefined ? undefined : Schema.decodeUnknownResult(
        Schema.toType(EmissionAdmission), { onExcessProperty: "error" }
      )(admitted)
      if (decodedAdmission !== undefined && Result.isFailure(decodedAdmission)) {
        return Result.fail(new InvalidDispatchAuthorization({ field: "admission", reason: "must contain valid execution authority" }))
      }
      const admission = decodedAdmission === undefined ? undefined : Schema.decodeUnknownSync(
        Schema.fromJsonString(EmissionAdmission), { onExcessProperty: "error" }
      )(Schema.encodeSync(Schema.fromJsonString(EmissionAdmission))(decodedAdmission.success))
      return Result.succeed({
        tag,
        canonical,
        encodedSummary: encodedSummary.success,
        holdMillis,
        key: request.key,
        authorization,
        admission
      })
    }

    /**
     * Staging proper. `origin` says which emission this is: a caller's key, or
     * the answer to a committed emission, which only `compensate` may name.
     */
    const stageAs = Effect.fn("Outbox.stage")(function* (
      request: StageRequest<Kinds>,
      compensates: EmissionId | undefined
    ) {
      // Everything staging uses is taken from the caller's request here, in one
      // synchronous step, before the first suspension. The dispatch is encoded
      // once; its summary, its target and its digest all derive from that one
      // encoded form, so nothing the caller does to its object afterwards (or a
      // property that answers differently on a second read) can make the
      // stored request and its description disagree.
      const owned = own(request)
      if (Result.isFailure(owned)) return yield* owned.failure
      const { tag, canonical, encodedSummary, holdMillis, key, authorization, admission } = owned.success
      const dispatchDigest = yield* sha256Text(canonical).pipe(withCrypto)
      const requestDigest = yield* requestDigestOf(
        tag,
        dispatchDigest,
        holdMillis,
        authorization,
        compensates,
        admission
      ).pipe(withCrypto)
      const id = yield* (
        compensates === undefined ? emissionIdFor(key) : compensationIdFor(compensates)
      ).pipe(withCrypto)
      const stagedAt = yield* DateTime.now
      const record = new StagedEmission({
        id,
        key,
        kind: tag,
        dispatchDigest,
        requestDigest,
        summary: encodedSummary,
        stagedAt,
        holdUntil: DateTime.add(stagedAt, { milliseconds: holdMillis }),
        ...(authorization === undefined ? {} : { authorization }),
        ...(admission === undefined ? {} : { admission }),
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
                return yield* new IdempotencyConflict({ id, key })
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

    /** The sole permit mint and handler entry; callers establish their authority first. */
    const dispatchOnce = <Selected extends Tag>(
      tag: Selected,
      id: EmissionId,
      dispatchDigest: Sha256Digest,
      canonical: string,
      dispatch: IntentKind.DispatchOf<Kinds[Selected]>,
      admission: EmissionAdmission | undefined,
      wire: WireMaterial | undefined
    ) => Effect.suspend(() => {
      const permit = mintPermit(tag, id, dispatchDigest, canonical, admission, wire)
      return Effect.suspend(() => handlers[tag]({ permit, dispatch, responseLimitBytes: RESPONSE_LIMIT_BYTES,
        ...(admission === undefined ? {} : { admission }), inputDigest: dispatchDigest })).pipe(
        Effect.timeoutOption(DISPATCH_TIMEOUT_MILLIS),
        Effect.result,
        Effect.ensuring(Effect.sync(() => {
          livePermits.delete(permit)
          permitDispatches.delete(permit)
          permitAdmissions.delete(permit)
          permitWires.delete(permit)
        }))
      )
    })

    // Writes become dispatchable only after the committing transition is durable.
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
          const execution = staged.admission?.execution
          if (execution?.validUntil !== undefined && DateTime.toEpochMillis(execution.validUntil) <= DateTime.toEpochMillis(yield* DateTime.now)) {
            return yield* new InvalidDispatchAuthorization({ field: "admission.execution.validUntil", reason: "grant has expired" })
          }
          if (provenance.committedBy === "policy-auto" && "effect" in kind &&
            (execution === undefined || execution.when !== "now" || execution.effect === "request" || kind.effect !== execution.effect)) {
            return yield* new InvalidDispatchAuthorization({ field: "admission.execution.when", reason: "tool policy-auto requires admitted non-request now authority" })
          }
          // Verify the sealed material before anything becomes irreversible.
          const sealed = yield* sealedDispatchOf(staged)
          const dispatch = sealed.dispatch
          let wire: WireMaterial | undefined
          if ("wire" in kind && typeof kind.wire === "function") {
            if (execution?.wire === undefined) return yield* new InvalidDispatchAuthorization({ field: "admission.execution.wire", reason: "wire contract lacks exact staged request authority" })
            const described = describeWire(kind as unknown as ToolContract.Any, dispatch, execution.resources, execution.wire.bodyArtifactDigest)
            if (Result.isFailure(described) || described.success === undefined) {
              return yield* new InvalidDispatchAuthorization({ field: "admission.execution.wire", reason: "wire declaration no longer matches the admitted request" })
            }
            wire = described.success
            if ((yield* sha256Canonical(wire).pipe(withCrypto)) !== execution.wire.digest) {
              return yield* new InvalidDispatchAuthorization({ field: "admission.execution.wire", reason: "wire request changed after staging" })
            }
          } else if (execution?.wire !== undefined) {
            return yield* new InvalidDispatchAuthorization({ field: "admission.execution.wire", reason: "wire authority has no registered declaration" })
          }

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
          const delivered = yield* restore(dispatchOnce(tag, id, committing.dispatchDigest,
            sealed.canonical, dispatch, committing.admission, wire)).pipe(Effect.exit)
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
          const captured = Schema.encodeUnknownResult(kind.outcome)(delivery.outcome)
          if (Result.isFailure(captured)) return yield* settleUncertain(id, "dispatch-failed")
          const outcome = ownJson(captured.success)
          const response = delivery.response.slice()
          const truncated = delivery.truncated
          const held = delivery.held === undefined ? undefined : yield* Schema.encodeEffect(Schema.fromJsonString(HeldReference))(delivery.held).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HeldReference))),
            Effect.catch(() => settleUncertain(id, "dispatch-failed")))
          if ((held !== undefined && held.callId !== id) || (staged.admission?.execution?.when === "now" &&
            (staged.admission.execution.effect === "apply" || staged.admission.execution.effect === "invoke") && held === undefined)) {
            return yield* settleUncertain(id, "dispatch-failed")
          }

          const completedAt = yield* DateTime.now
          const committed = yield* store.transition(id, "committing", {
            state: "committed", outcome,
            capture: new ResponseCapture({ retainedBytes: response.byteLength, truncated, limitBytes: RESPONSE_LIMIT_BYTES }),
            completedAt, response, ...(held === undefined ? {} : { held })
          }).pipe(Effect.catch(() => settleUncertain(id, "persistence-failed-after-dispatch")))
          return yield* view(yield* settleReceipts(committed))
        })
      ))
    })

    const capture: OutboxService<Kinds>["capture"] = (request) => Effect.gen(function* () {
      const checked = Schema.decodeUnknownResult(Schema.toType(CaptureAdmission), { onExcessProperty: "error" })(request.admission)
      if (Result.isFailure(checked)) return yield* new InvalidDispatchAuthorization({ field: "admission", reason: "short path requires capture-now authority" })
      const registered = kindFor(request.intent.kind)
      if (Option.isNone(registered) || !("effect" in registered.value) || registered.value.effect !== "capture") {
        return yield* new InvalidDispatchAuthorization({ field: "effect", reason: "short path requires a capture contract" })
      }
      const kind = registered.value
      if (checked.success.execution.tool !== kind.tag || !("version" in kind) || checked.success.execution.version !== kind.version) {
        return yield* new InvalidDispatchAuthorization({ field: "admission.execution", reason: "must name the exact capture contract" })
      }
      const owned = own({ ...request, holdMillis: 0, admission: new EmissionAdmission(checked.success) } as StageRequest<Kinds>)
      if (Result.isFailure(owned)) return yield* owned.failure
      const { tag, canonical, encodedSummary, key } = owned.success
      const admission = Schema.decodeUnknownSync(Schema.fromJsonString(CaptureAdmission))(
        Schema.encodeSync(Schema.fromJsonString(CaptureAdmission))(checked.success))
      const execution = admission.execution
      const dispatchDigest = yield* sha256Text(canonical).pipe(withCrypto)
      const requestDigest = yield* sha256Canonical({ path: "capture", kind: tag, dispatchDigest,
        admission: Schema.encodeSync(CaptureAdmission)(admission) }).pipe(withCrypto)
      const id = yield* emissionIdFor(key).pipe(withCrypto)
      return yield* store.exclusive(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const previous = yield* store.read(id)
        const prior = Option.isSome(previous) ? previous.value : undefined
        if (prior !== undefined && (prior.state !== "captured" || prior.requestDigest !== requestDigest)) {
          return yield* new IdempotencyConflict({ id, key })
        }
        if (prior?.state === "captured" && prior.outcome.state === "refused") {
          return { state: "refused" as const, refusal: { code: prior.outcome.code, message: prior.outcome.message } }
        }
        if (prior?.state === "captured" && prior.outcome.state === "failed") {
          const code = Schema.decodeUnknownResult(CaptureFailed.fields.code)(prior.outcome.code)
          return yield* new CaptureFailed({ id, code: Result.isSuccess(code) ? code.success : "failed" })
        }
        if (execution.validUntil !== undefined && DateTime.toEpochMillis(execution.validUntil) <= DateTime.toEpochMillis(yield* DateTime.now)) {
          return yield* new CaptureFailed({ id, code: "expired" })
        }
        if (prior?.state === "captured" && execution.retention === "keep") {
          const held = yield* store.readCapture(id)
          if (Option.isNone(held) || held.value.value === undefined || prior.outcome.state !== "done" ||
            held.value.digest !== prior.outcome.digest || (yield* sha256Text(canonicalExactJson(held.value.value)).pipe(withCrypto)) !== prior.outcome.digest) {
            return yield* corrupt(id, "response", "kept capture result does not match its digest")
          }
          const result = yield* Schema.decodeUnknownEffect(kind.outcome)(held.value.value).pipe(
            Effect.mapError(() => corrupt(id, "response", "kept capture result no longer matches its contract")))
          return { state: "done" as const, id, result }
        }
        const dispatch = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(kind.dispatch))(canonical).pipe(
          Effect.mapError(() => new InvalidIntent({ kind: tag, field: "dispatch", reason: "must match the capture contract" })))
        let wire: WireMaterial | undefined
        if ("wire" in kind && typeof kind.wire === "function") {
          if (execution.wire === undefined) return yield* new InvalidDispatchAuthorization({ field: "wire", reason: "capture lacks exact request authority" })
          const described = describeWire(kind as unknown as ToolContract.Any, dispatch, execution.resources, execution.wire.bodyArtifactDigest)
          if (Result.isFailure(described) || described.success === undefined ||
            (yield* sha256Canonical(described.success).pipe(withCrypto)) !== execution.wire.digest) {
            return yield* new InvalidDispatchAuthorization({ field: "wire", reason: "capture request does not match its authority" })
          }
          wire = described.success
        } else if (execution.wire !== undefined) {
          return yield* new InvalidDispatchAuthorization({ field: "wire", reason: "capture contract has no wire declaration" })
        }
        const admitted = new EmissionAdmission(admission)
        const delivered = yield* restore(dispatchOnce(tag, id, dispatchDigest, canonical,
          dispatch, admitted, wire)).pipe(Effect.exit)
        const publishFailure = (code: CaptureFailed["code"], refused: boolean) => Effect.gen(function* () {
          if (prior === undefined) {
            const completedAt = yield* DateTime.now
            const record = new CapturedEmission({ id, key, kind: tag, dispatchDigest, requestDigest, summary: encodedSummary,
              admission, completedAt, ledgered: ["capture"], outcome: { state: refused ? "refused" : "failed",
                code: refused ? "refused" : code, message: refused ? "read was refused" : "read did not complete" } })
            yield* store.putCapture(record, undefined, new LedgerEntry({ at: completedAt, effect: "observation", act: "capture", ref: id, key: `${id}:capture` }))
          }
          if (refused) return { state: "refused" as const, refusal: { code: "refused", message: "read was refused" } }
          return yield* new CaptureFailed({ id, code })
        })
        if (execution.validUntil !== undefined && DateTime.toEpochMillis(execution.validUntil) <= DateTime.toEpochMillis(yield* DateTime.now)) {
          return yield* publishFailure("expired", false)
        }
        if (Exit.isFailure(delivered)) return yield* publishFailure(Cause.hasInterruptsOnly(delivered.cause) ? "interrupted" : "failed", false)
        if (Result.isFailure(delivered.value)) return yield* publishFailure("failed", delivered.value.failure._tag === "DispatchRefused")
        if (Option.isNone(delivered.value.success)) return yield* publishFailure("timeout", false)
        const delivery = delivered.value.success.value
        const encoded = Schema.encodeUnknownResult(kind.outcome)(delivery.outcome)
        if (Result.isFailure(encoded) || delivery.held !== undefined || delivery.response.byteLength > RESPONSE_LIMIT_BYTES) {
          return yield* publishFailure("invalid-result", false)
        }
        const json = Schema.decodeUnknownResult(Schema.Json)(encoded.success)
        if (Result.isFailure(json)) return yield* publishFailure("invalid-result", false)
        const value = ownJson(json.success)
        const response = delivery.response.slice()
        if (execution.retention === "keep" && new TextEncoder().encode(canonicalJson(value)).byteLength > CAPTURE_RESULT_LIMIT_BYTES) {
          return yield* publishFailure("invalid-result", false)
        }
        const decodedSnapshot = Schema.decodeUnknownResult(kind.outcome)(value)
        if (Result.isFailure(decodedSnapshot)) return yield* publishFailure("invalid-result", false)
        const snapshot = decodedSnapshot.success
        const digest = yield* sha256Text(canonicalExactJson(value)).pipe(withCrypto)
        if (prior?.state === "captured") {
          if (prior.outcome.state !== "done" || prior.outcome.digest !== digest) return yield* new CaptureFailed({ id, code: "result-changed" })
        } else {
          const metadata: Record<string, Schema.Json> = Object.create(null)
          if ("flow" in kind) {
            const contract = kind as unknown as ToolContract.Any
            const root = contract.flow.sources["$"]
            if (root === undefined || root.confidentiality === "public") {
              for (const [field, label] of Object.entries<import("../labels/Labels.ts").InformationLabel>(contract.flow.sources)) {
                if (field === "$" || label.confidentiality !== "public" || typeof snapshot !== "object" || snapshot === null || !Object.hasOwn(snapshot, field)) continue
                const fieldValue = Schema.decodeUnknownResult(Schema.Json)((snapshot as Record<string, unknown>)[field])
                if (Result.isSuccess(fieldValue)) Object.defineProperty(metadata, field, { value: ownJson(fieldValue.success), enumerable: true })
              }
            }
          }
          const completedAt = yield* DateTime.now
          const record = new CapturedEmission({ id, key, kind: tag, dispatchDigest, requestDigest, summary: encodedSummary,
            admission, completedAt, ledgered: ["capture"], outcome: { state: "done", digest,
              ...(Object.keys(metadata).length === 0 ? {} : { metadata }) } })
          const result = execution.retention === "keep" ? { digest, value, response } : { digest }
          const put = yield* store.putCapture(record, result, new LedgerEntry({ at: completedAt, effect: "observation", act: "capture", ref: id, key: `${id}:capture` }))
          if (!put.created && (put.record.state !== "captured" || put.record.requestDigest !== requestDigest ||
            put.record.outcome.state !== "done" || put.record.outcome.digest !== digest)) return yield* new IdempotencyConflict({ id, key })
        }
        return { state: "done" as const, id, result: snapshot }
      })))
    // The runtime tag selected the matching outcome codec; this assertion carries
    // that registry correlation into the caller's generic result type.
    }) as ReturnType<OutboxService<Kinds>["capture"]>

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
      const { dispatch } = yield* sealedDispatchOf(record)
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

    return { stage, inspect, commit, cancel, perform, capture, compensate, response, pending, pendingAuthorized, flush }
  })

  return { kinds, Outbox, Dispatcher, fromRecord: view, toRecord, layer: Layer.effect(Outbox, make) }
}
