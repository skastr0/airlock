import { Result, Schema } from "effect"
import { Sha256Digest } from "../Canonical.ts"
import type { ActiveState, EmissionState, Next } from "./Lifecycle.ts"

// ── identifiers ─────────────────────────────────────────────────────────────

/**
 * Derived, never random: `emi_` plus the first 32 hex digits of the SHA-256 of
 * the caller's idempotency key. Staging the same key always names the same
 * emission, on any host.
 */
export const EmissionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^emi_[0-9a-f]{32}$/)),
  Schema.brand("EmissionId")
)
export type EmissionId = typeof EmissionId.Type

/** Chosen by the caller; names one logical external act across replays. */
export const IdempotencyKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  Schema.brand("IdempotencyKey")
)
export type IdempotencyKey = typeof IdempotencyKey.Type

// ── authority evidence ──────────────────────────────────────────────────────

/**
 * Supervisor pre-authorization bound to a staged emission. `target` is the
 * intent kind's canonical target and must equal the staged intent's own.
 */
export class DispatchAuthorization extends Schema.Class<DispatchAuthorization>(
  "DispatchAuthorization"
)({
  sealDigest: Sha256Digest,
  grantId: Schema.String,
  grantSelector: Schema.String,
  dispatchClass: Schema.Literal("read"),
  target: Schema.String
}) {}

export const CommitAuthority = Schema.Literals(["supervisor", "policy-auto"])
export type CommitAuthority = typeof CommitAuthority.Type

/** Recorded, never interpreted: who committed, and under which grant. */
export class DispatchProvenance extends Schema.Class<DispatchProvenance>(
  "DispatchProvenance"
)({
  committedBy: CommitAuthority,
  grantId: Schema.optionalKey(Schema.String),
  grantSelector: Schema.optionalKey(Schema.String),
  dispatchClass: Schema.optionalKey(Schema.Literal("read")),
  target: Schema.optionalKey(Schema.String)
}) {}

/**
 * Why an emission was allowed to be staged at all: the policy it was admitted
 * under, by digest, and the grants in it that fitted. Recorded once, when the
 * emission is first stored, so a receipt can answer "under which policy and
 * which grant".
 */
export class EmissionAdmission extends Schema.Class<EmissionAdmission>("EmissionAdmission")({
  policyDigest: Sha256Digest,
  grantIds: Schema.Array(Schema.String)
}) {}

/** Shape of the bounded response capture; the bytes live in the store's blob. */
export class ResponseCapture extends Schema.Class<ResponseCapture>("ResponseCapture")({
  retainedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
  limitBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * The receipts an emission owes the Ledger. `stage` is owed from the moment it
 * is stored; `commit`, `cancel` or `refuse` once it settles that way. An
 * uncertain emission owes no further receipt: there is no outcome to attest.
 */
export const LedgerPhase = Schema.Literals(["stage", "commit", "cancel", "refuse"])
export type LedgerPhase = typeof LedgerPhase.Type

export const UncertainReason = Schema.Literals([
  "dispatch-failed",
  "dispatch-timed-out",
  "interrupted",
  "persistence-failed-after-dispatch",
  "recovered-after-restart"
])
export type UncertainReason = typeof UncertainReason.Type

// ── the record, one variant per lifecycle state ─────────────────────────────

const identity = {
  id: EmissionId,
  key: IdempotencyKey,
  /** Intent kind tag. */
  kind: Schema.String,
  /** Digest of the sealed dispatch material; commit refuses a substitution. */
  dispatchDigest: Sha256Digest,
  /** Digest of everything staging was asked for; detects key reuse with new content. */
  requestDigest: Sha256Digest,
  /** The kind's redacted summary, encoded. */
  summary: Schema.Json,
  stagedAt: Schema.DateTimeUtcFromString,
  holdUntil: Schema.DateTimeUtcFromString,
  authorization: Schema.optionalKey(DispatchAuthorization),
  /** The policy and grants this emission was admitted under, when it came through one. */
  admission: Schema.optionalKey(EmissionAdmission),
  /**
   * Set only by the kernel: the committed emission this one answers. A
   * compensation is an ordinary emission that carries this link.
   */
  compensates: Schema.optionalKey(EmissionId),
  /**
   * The phases whose Ledger entry is known to be durable. A phase the state
   * owes that is missing here is recorded before the kernel does anything
   * else with the emission.
   */
  ledgered: Schema.Array(LedgerPhase)
}

const committing = {
  ...identity,
  provenance: DispatchProvenance,
  committingAt: Schema.DateTimeUtcFromString
}

export class StagedEmission extends Schema.Class<StagedEmission>("StagedEmission")({
  ...identity,
  state: Schema.tag("staged")
}) {}

export class CommittingEmission extends Schema.Class<CommittingEmission>("CommittingEmission")({
  ...committing,
  state: Schema.tag("committing")
}) {}

export class CommittedEmission extends Schema.Class<CommittedEmission>("CommittedEmission")({
  ...committing,
  state: Schema.tag("committed"),
  /** The kind's outcome, encoded. */
  outcome: Schema.Json,
  capture: ResponseCapture,
  completedAt: Schema.DateTimeUtcFromString
}) {}

export class UncertainEmission extends Schema.Class<UncertainEmission>("UncertainEmission")({
  ...committing,
  state: Schema.tag("uncertain"),
  reason: UncertainReason,
  uncertainAt: Schema.DateTimeUtcFromString
}) {}

/** The handler proved the wire was never reached. Nothing was sent. */
export class RefusedEmission extends Schema.Class<RefusedEmission>("RefusedEmission")({
  ...committing,
  state: Schema.tag("refused"),
  /** The handler's stated reason, safe to keep: it must carry no dispatch values. */
  reason: Schema.String,
  refusedAt: Schema.DateTimeUtcFromString
}) {}

export class CancelledEmission extends Schema.Class<CancelledEmission>("CancelledEmission")({
  ...identity,
  state: Schema.tag("cancelled"),
  cancelledAt: Schema.DateTimeUtcFromString
}) {}

export const EmissionRecord = Schema.Union([
  StagedEmission,
  CommittingEmission,
  CommittedEmission,
  UncertainEmission,
  RefusedEmission,
  CancelledEmission
])
export type EmissionRecord = typeof EmissionRecord.Type

/** The record variant for one lifecycle state. */
export type RecordIn<State extends EmissionState> = Extract<EmissionRecord, { readonly state: State }>

/**
 * What a transition adds on arrival. A store persists `advance(record, arrival)`
 * and nothing else, so no adapter decides what a state contains.
 */
export interface Arrivals {
  readonly committing: Pick<CommittingEmission, "state" | "provenance" | "committingAt">
  readonly cancelled: Pick<CancelledEmission, "state" | "cancelledAt">
  readonly committed:
    & Pick<CommittedEmission, "state" | "outcome" | "capture" | "completedAt">
    & { readonly response: Uint8Array }
  readonly uncertain: Pick<UncertainEmission, "state" | "reason" | "uncertainAt">
  readonly refused: Pick<RefusedEmission, "state" | "reason" | "refusedAt">
}
export type Arrival<State extends Next<ActiveState>> = Arrivals[State]

/** Private dispatch material exactly as the kernel encoded and digested it. */
export class SealedDispatch extends Schema.Class<SealedDispatch>("SealedDispatch")({
  digest: Sha256Digest,
  canonical: Schema.String
}) {}

// ── the one way a record moves ──────────────────────────────────────────────

const identityOf = (record: EmissionRecord) => ({
  id: record.id,
  key: record.key,
  kind: record.kind,
  dispatchDigest: record.dispatchDigest,
  requestDigest: record.requestDigest,
  summary: record.summary,
  stagedAt: record.stagedAt,
  holdUntil: record.holdUntil,
  ...(record.authorization === undefined ? {} : { authorization: record.authorization }),
  ...(record.admission === undefined ? {} : { admission: record.admission }),
  ...(record.compensates === undefined ? {} : { compensates: record.compensates }),
  ledgered: record.ledgered
})

const build = (
  record: StagedEmission | CommittingEmission,
  arrival: Arrivals[keyof Arrivals]
): Result.Result<EmissionRecord, TransitionConflict> => {
  const conflict = (expected: ActiveState) =>
    Result.fail(new TransitionConflict({ id: record.id, expected, actual: record.state }))
  switch (arrival.state) {
    case "committing":
      return record.state !== "staged" ? conflict("staged") : Result.succeed(
        new CommittingEmission({
          ...identityOf(record),
          provenance: arrival.provenance,
          committingAt: arrival.committingAt
        })
      )
    case "cancelled":
      return record.state !== "staged" ? conflict("staged") : Result.succeed(
        new CancelledEmission({ ...identityOf(record), cancelledAt: arrival.cancelledAt })
      )
    case "committed":
      return record.state !== "committing" ? conflict("committing") : Result.succeed(
        new CommittedEmission({
          ...identityOf(record),
          provenance: record.provenance,
          committingAt: record.committingAt,
          outcome: arrival.outcome,
          capture: arrival.capture,
          completedAt: arrival.completedAt
        })
      )
    case "uncertain":
      return record.state !== "committing" ? conflict("committing") : Result.succeed(
        new UncertainEmission({
          ...identityOf(record),
          provenance: record.provenance,
          committingAt: record.committingAt,
          reason: arrival.reason,
          uncertainAt: arrival.uncertainAt
        })
      )
    case "refused":
      return record.state !== "committing" ? conflict("committing") : Result.succeed(
        new RefusedEmission({
          ...identityOf(record),
          provenance: record.provenance,
          committingAt: record.committingAt,
          reason: arrival.reason,
          refusedAt: arrival.refusedAt
        })
      )
  }
}

/**
 * The next record for a compare-and-set, or the conflict to report. Every
 * store adapter persists exactly what this returns: the only thing an adapter
 * decides is how to make "read, advance, write" atomic.
 */
export const advance = <From extends ActiveState, const To extends Arrival<Next<From>>>(
  record: EmissionRecord,
  from: From,
  arrival: To
): Result.Result<RecordIn<To["state"]>, TransitionConflict> => {
  if (record.state !== from || (record.state !== "staged" && record.state !== "committing")) {
    return Result.fail(new TransitionConflict({ id: record.id, expected: from, actual: record.state }))
  }
  // `build` returns the variant named by `arrival.state`; the generic return
  // type restates that correlation, which a switch cannot carry.
  return build(record, arrival) as Result.Result<RecordIn<To["state"]>, TransitionConflict>
}

/** The phases a record's state owes the Ledger, in the order they happened. */
export const owedPhases = (record: EmissionRecord): ReadonlyArray<LedgerPhase> =>
  record.state === "committed"
    ? ["stage", "commit"]
    : record.state === "cancelled"
      ? ["stage", "cancel"]
      : record.state === "refused"
        ? ["stage", "refuse"]
        : ["stage"]

/**
 * A record class instance from anything shaped like one. The kernel's typed
 * view of an emission is a plain object; this is how it becomes a storable,
 * encodable record again, and it validates every field on the way.
 */
export const rebuild = <Record extends EmissionRecord>(record: Record): Record => {
  const identity = identityOf(record)
  switch (record.state) {
    case "staged": return new StagedEmission(identity) as Record
    case "cancelled":
      return new CancelledEmission({ ...identity, cancelledAt: record.cancelledAt }) as Record
    case "committing":
      return new CommittingEmission({
        ...identity,
        provenance: record.provenance,
        committingAt: record.committingAt
      }) as Record
    case "committed":
      return new CommittedEmission({
        ...identity,
        provenance: record.provenance,
        committingAt: record.committingAt,
        outcome: record.outcome,
        capture: record.capture,
        completedAt: record.completedAt
      }) as Record
    case "uncertain":
      return new UncertainEmission({
        ...identity,
        provenance: record.provenance,
        committingAt: record.committingAt,
        reason: record.reason,
        uncertainAt: record.uncertainAt
      }) as Record
    case "refused":
      return new RefusedEmission({
        ...identity,
        provenance: record.provenance,
        committingAt: record.committingAt,
        reason: record.reason,
        refusedAt: record.refusedAt
      }) as Record
  }
}

/**
 * The record with `phase` marked as ledgered. Like `advance`, a store persists
 * exactly this; marking a phase twice changes nothing.
 */
export const acknowledge = <Record extends EmissionRecord>(record: Record, phase: LedgerPhase): Record =>
  record.ledgered.includes(phase)
    ? record
    : rebuild({ ...record, ledgered: [...record.ledgered, phase] })

// ── errors ──────────────────────────────────────────────────────────────────

export class InvalidIntent extends Schema.TaggedError<InvalidIntent>()("InvalidIntent", {
  kind: Schema.String,
  field: Schema.String,
  reason: Schema.String
}) {}

export class OutboxStoreFailed extends Schema.TaggedError<OutboxStoreFailed>()(
  "OutboxStoreFailed",
  {
    operation: Schema.String,
    id: Schema.optionalKey(Schema.String),
    reason: Schema.String
  }
) {}

/** Stored state that does not decode, or contradicts its own digests. Never repaired. */
export class OutboxStateCorrupt extends Schema.TaggedError<OutboxStateCorrupt>()(
  "OutboxStateCorrupt",
  {
    id: Schema.String,
    part: Schema.Literals(["record", "dispatch", "response"]),
    reason: Schema.String
  }
) {}

/** A compare-and-set lost: the emission was not in the state the caller named. */
export class TransitionConflict extends Schema.TaggedError<TransitionConflict>()(
  "TransitionConflict",
  {
    id: EmissionId,
    expected: Schema.Literals(["staged", "committing"]),
    actual: Schema.Literals(["staged", "committing", "committed", "uncertain", "refused", "cancelled"])
  }
) {}

export class UnknownEmission extends Schema.TaggedError<UnknownEmission>()("UnknownEmission", {
  id: Schema.String
}) {}
