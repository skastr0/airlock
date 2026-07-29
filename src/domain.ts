import { Schema } from "effect"

// ── identifiers ─────────────────────────────────────────────────────────────

export const ActId = Schema.String.pipe(Schema.brand("ActId"))
export type ActId = typeof ActId.Type

export const EmissionId = Schema.String.pipe(Schema.brand("EmissionId"))
export type EmissionId = typeof EmissionId.Type

// ── the four effect classes (see DESIGN.md) ─────────────────────────────────

export const EffectClass = Schema.Literal(
  "observation",
  "mutation",
  "emission",
  "computation"
)
export type EffectClass = typeof EffectClass.Type

// ── held mutations ──────────────────────────────────────────────────────────

export const HoldPurpose = Schema.Literal("runtime-private")
export type HoldPurpose = typeof HoldPurpose.Type

export class HeldManifest extends Schema.Class<HeldManifest>("HeldManifest")({
  id: ActId,
  // remove: target renamed into the hold
  // overwrite: previous version renamed into the hold before the new write
  // displaced: current version renamed into the hold to make room for an undo
  act: Schema.Literal("remove", "overwrite", "displaced"),
  target: Schema.String,
  kind: Schema.Literal("file", "directory"),
  // a manifest with no payload marks a creation: undoing it displaces the
  // created file rather than renaming a payload back
  hasPayload: Schema.Boolean,
  // Missing means managed state. Persisting only the exceptional purpose keeps
  // every pre-purpose journal backward compatible while making runtime-private
  // retention explicit and non-undoable.
  purpose: Schema.optional(HoldPurpose),
  status: Schema.Literal("held", "restored"),
  at: Schema.DateTimeUtc
}) {}

export class RemoveReceipt extends Schema.Class<RemoveReceipt>("RemoveReceipt")({
  id: ActId,
  target: Schema.String,
  kind: Schema.Literal("file", "directory"),
  at: Schema.DateTimeUtc
}) {}

export class RuntimePrivateRetentionReceipt extends Schema.Class<RuntimePrivateRetentionReceipt>(
  "RuntimePrivateRetentionReceipt"
)({
  id: ActId,
  target: Schema.String,
  kind: Schema.Literal("file", "directory"),
  at: Schema.DateTimeUtc
}) {}

export class OverwriteReceipt extends Schema.Class<OverwriteReceipt>("OverwriteReceipt")({
  id: ActId,
  target: Schema.String,
  previousHeld: Schema.Boolean,
  at: Schema.DateTimeUtc
}) {}

export class UndoReceipt extends Schema.Class<UndoReceipt>("UndoReceipt")({
  id: ActId,
  target: Schema.String,
  displaced: Schema.optional(ActId),
  at: Schema.DateTimeUtc
}) {}

export class ReapReport extends Schema.Class<ReapReport>("ReapReport")({
  reaped: Schema.Array(ActId),
  at: Schema.DateTimeUtc
}) {}

// ── staged emissions ────────────────────────────────────────────────────────

export class EmissionRequest extends Schema.Class<EmissionRequest>("EmissionRequest")({
  url: Schema.String,
  method: Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE"),
  body: Schema.optional(Schema.String),
  headers: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { default: () => ({}) }
  )
}) {}

export class StagedEmission extends Schema.Class<StagedEmission>("StagedEmission")({
  id: EmissionId,
  request: EmissionRequest,
  status: Schema.Literal("staged", "committed", "cancelled"),
  stagedAt: Schema.DateTimeUtc,
  holdUntil: Schema.DateTimeUtc,
  outcome: Schema.optional(
    Schema.Struct({ status: Schema.Number, body: Schema.String })
  )
}) {}

// ── ledger ──────────────────────────────────────────────────────────────────

export class LedgerEntry extends Schema.Class<LedgerEntry>("LedgerEntry")({
  at: Schema.DateTimeUtc,
  effect: EffectClass,
  act: Schema.Literal(
    "remove",
    "overwrite",
    "undo",
    "reap",
    "retire-runtime-private",
    "stage",
    "commit",
    "cancel"
  ),
  ref: Schema.String,
  detail: Schema.optional(Schema.String)
}) {}

// ── errors ──────────────────────────────────────────────────────────────────

export class TargetNotFound extends Schema.TaggedError<TargetNotFound>()(
  "TargetNotFound",
  { target: Schema.String }
) {}

export class ProtectedPath extends Schema.TaggedError<ProtectedPath>()(
  "ProtectedPath",
  { target: Schema.String, reason: Schema.String }
) {}

export class ScopeEscape extends Schema.TaggedError<ScopeEscape>()(
  "ScopeEscape",
  { requested: Schema.String, scope: Schema.String }
) {}

export class UnknownAct extends Schema.TaggedError<UnknownAct>()("UnknownAct", {
  id: Schema.String
}) {}

export class NotHeld extends Schema.TaggedError<NotHeld>()("NotHeld", {
  id: Schema.String,
  status: Schema.String
}) {}

export class UndoConflict extends Schema.TaggedError<UndoConflict>()(
  "UndoConflict",
  { target: Schema.String }
) {}

export class NothingToUndo extends Schema.TaggedError<NothingToUndo>()(
  "NothingToUndo",
  {}
) {}

export class RuntimePrivateNotUndoable extends Schema.TaggedError<RuntimePrivateNotUndoable>()(
  "RuntimePrivateNotUndoable",
  {
    id: ActId,
    target: Schema.String
  }
) {}

export class UnknownEmission extends Schema.TaggedError<UnknownEmission>()(
  "UnknownEmission",
  { id: Schema.String }
) {}

export class EmissionNotPending extends Schema.TaggedError<EmissionNotPending>()(
  "EmissionNotPending",
  { id: Schema.String, status: Schema.String }
) {}

export class EmissionFailed extends Schema.TaggedError<EmissionFailed>()(
  "EmissionFailed",
  { id: Schema.String, cause: Schema.String }
) {}
