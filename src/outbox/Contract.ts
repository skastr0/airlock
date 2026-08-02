import { Schema } from "effect"
import { EmissionId } from "../domain.ts"

export const OutboxState = Schema.Literal(
  "staged",
  "committing",
  "committed",
  "uncertain",
  "cancelled"
)
export type OutboxState = typeof OutboxState.Type

export const HttpMethod = Schema.Literal(
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
)
export type HttpMethod = typeof HttpMethod.Type

export class HttpExternalIntent extends Schema.TaggedClass<HttpExternalIntent>()(
  "HttpExternalIntent",
  {
    url: Schema.String,
    method: HttpMethod,
    headers: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.String }),
      { default: () => ({}) }
    ),
    body: Schema.optional(Schema.String)
  }
) {}

// This is a typed request shape, not an executable escape hatch. Outbox
// refuses to stage it until Cell can supply an admitted execution closure.
export class ExternalCommandIntent extends Schema.TaggedClass<ExternalCommandIntent>()(
  "ExternalCommandIntent",
  {
    executable: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    env: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.String }),
      { default: () => ({}) }
    )
  }
) {}

export const ExternalIntent = Schema.Union(
  HttpExternalIntent,
  ExternalCommandIntent
)
export type ExternalIntent = typeof ExternalIntent.Type

export class HttpIntentSummary extends Schema.Class<HttpIntentSummary>(
  "HttpIntentSummary"
)({
  kind: Schema.Literal("http"),
  method: HttpMethod,
  endpoint: Schema.String,
  headerNames: Schema.Array(Schema.String),
  bodyBytes: Schema.Number
}) {}

export class RedactedEmissionRequest extends Schema.Class<RedactedEmissionRequest>(
  "RedactedEmissionRequest"
)({
  method: HttpMethod,
  url: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  body: Schema.optional(Schema.String)
}) {}

/**
 * Who turned a durably staged intent into a dispatch. `policy-auto` is not a
 * second dispatcher: it records that the trusted supervisor plane, not a human
 * act, called the ordinary `Outbox.commit`.
 */
export const CommitAuthority = Schema.Literal("supervisor", "policy-auto")
export type CommitAuthority = typeof CommitAuthority.Type

/**
 * The provenance a commit is asked to record. Outbox never computes a dispatch
 * class and never reads a policy: the caller that already holds the supervisor
 * grant supplies these facts, and Outbox writes them into the durable outcome
 * and the Ledger so the receipt names the grant that authorized the wire.
 *
 * `endpoint` is the canonical `scheme://host/path` the grant matched — the
 * endpoint actually dispatched to, with query and fragment excluded rather
 * than redacted, because they never participate in a grant match.
 */
export class DispatchProvenance extends Schema.Class<DispatchProvenance>(
  "DispatchProvenance"
)({
  committedBy: CommitAuthority,
  /** Grant identity from the admitted authority; absent for a bare manual commit. */
  grantId: Schema.optional(Schema.String),
  /** The policy selector that matched, as written in the supervisor policy file. */
  grantSelector: Schema.optional(Schema.String),
  /**
   * The supervisor's effective class, recorded and never decided here. The
   * type is deliberately the single class a pre-authorized commit can carry:
   * the whole class vocabulary lives in the supervisor policy module, and an
   * Outbox receipt that could spell a wider class would be a second place to
   * read one from. A manual supervisor commit records none.
   */
  dispatchClass: Schema.optional(Schema.Literal("read")),
  endpoint: Schema.optional(Schema.String)
}) {}

/**
 * Response metadata that is safe to keep in a receipt. The bytes themselves
 * live in the owner-only emission directory and reach a program only as a
 * bounded artifact; this record carries shape, never content.
 */
export class RedactedDispatchResponse extends Schema.Class<RedactedDispatchResponse>(
  "RedactedDispatchResponse"
)({
  status: Schema.Number,
  contentType: Schema.optional(Schema.String),
  /** Bytes actually retained; never larger than `limitBytes`. */
  retainedBytes: Schema.Number,
  /** True when the endpoint sent more than the bound allowed. */
  truncated: Schema.Boolean,
  limitBytes: Schema.Number
}) {}

export class OutboxOutcome extends Schema.Class<OutboxOutcome>("OutboxOutcome")({
  status: Schema.Number,
  responseBytes: Schema.optional(Schema.Number),
  /** Present once a dispatch completed; describes the bounded capture. */
  response: Schema.optional(RedactedDispatchResponse),
  /** Present once a dispatch completed; names the authority that committed. */
  provenance: Schema.optional(DispatchProvenance),
  completedAt: Schema.DateTimeUtc
}) {}

export class OutboxEmission extends Schema.Class<OutboxEmission>(
  "OutboxEmission"
)({
  id: EmissionId,
  status: OutboxState,
  intent: HttpIntentSummary,
  // Compatibility view for existing callers. Values are deliberately
  // redacted; dispatch material is never returned by pending/inspect.
  request: RedactedEmissionRequest,
  stagedAt: Schema.DateTimeUtc,
  holdUntil: Schema.DateTimeUtc,
  outcome: Schema.optional(OutboxOutcome)
}) {}

export class PersistedOutboxManifest extends Schema.Class<PersistedOutboxManifest>(
  "PersistedOutboxManifest"
)({
  schemaVersion: Schema.Literal("airlock/outbox-manifest/v1"),
  id: EmissionId,
  intent: HttpIntentSummary,
  request: RedactedEmissionRequest,
  stagedAt: Schema.DateTimeUtc,
  holdUntil: Schema.DateTimeUtc
}) {}

// Dispatch material is stored separately from the redacted manifest with
// owner-only permissions. Metadata, listings, receipts, and errors never
// serialize these values.
export class PrivateHttpDispatch extends Schema.Class<PrivateHttpDispatch>(
  "PrivateHttpDispatch"
)({
  schemaVersion: Schema.Literal("airlock/http-dispatch/v1"),
  url: Schema.String,
  method: HttpMethod,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  body: Schema.optional(Schema.String)
}) {}

export class PersistedOutboxOutcome extends Schema.Class<PersistedOutboxOutcome>(
  "PersistedOutboxOutcome"
)({
  schemaVersion: Schema.Literal("airlock/outbox-outcome/v1"),
  outcome: OutboxOutcome
}) {}

export class InvalidOutboxIntent extends Schema.TaggedError<InvalidOutboxIntent>()(
  "InvalidOutboxIntent",
  {
    field: Schema.String,
    reason: Schema.String
  }
) {}

export class UnsupportedExternalIntent extends Schema.TaggedError<UnsupportedExternalIntent>()(
  "UnsupportedExternalIntent",
  {
    kind: Schema.String,
    reason: Schema.String
  }
) {}

export class InvalidHoldDuration extends Schema.TaggedError<InvalidHoldDuration>()(
  "InvalidHoldDuration",
  {
    holdMillis: Schema.Number
  }
) {}

export class OutboxStorageFailed extends Schema.TaggedError<OutboxStorageFailed>()(
  "OutboxStorageFailed",
  {
    operation: Schema.String,
    id: Schema.optional(Schema.String),
    reason: Schema.String
  }
) {}

export class OutboxStateCorrupt extends Schema.TaggedError<OutboxStateCorrupt>()(
  "OutboxStateCorrupt",
  {
    id: Schema.String,
    document: Schema.String
  }
) {}

export const DispatchUncertaintyReason = Schema.Literal(
  "transport-failed",
  "interrupted",
  "persistence-failed-after-dispatch",
  "recovered-after-crash"
)
export type DispatchUncertaintyReason =
  typeof DispatchUncertaintyReason.Type

export class EmissionDispatchUncertain extends Schema.TaggedError<EmissionDispatchUncertain>()(
  "EmissionDispatchUncertain",
  {
    id: Schema.String,
    reason: DispatchUncertaintyReason
  }
) {}
