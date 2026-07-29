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

export class OutboxOutcome extends Schema.Class<OutboxOutcome>("OutboxOutcome")({
  status: Schema.Number,
  responseBytes: Schema.optional(Schema.Number),
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
