import { Schema } from "effect"

// ── identifiers ─────────────────────────────────────────────────────────────

/**
 * Act ids are persisted as direct children of Airlock's Hold directory.
 * Keep their wire representation to one bounded POSIX-safe path component so
 * decoding an externally supplied id cannot turn journal lookup into path
 * traversal.
 */
export const ActId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  Schema.brand("ActId")
)
export type ActId = typeof ActId.Type

// ── held mutations ──────────────────────────────────────────────────────────

export const HoldPurpose = Schema.Literals(["managed", "runtime-private"])
export type HoldPurpose = typeof HoldPurpose.Type

export class HeldManifest extends Schema.Class<HeldManifest>("HeldManifest")({
  id: ActId,
  // remove: target renamed into the hold
  // overwrite: previous version renamed into the hold before the new write
  // displaced: current version renamed into the hold to make room for an undo
  act: Schema.Literals(["remove", "overwrite", "displaced"]),
  target: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  // a manifest with no payload marks a creation: undoing it displaces the
  // created file rather than renaming a payload back
  hasPayload: Schema.Boolean,
  // Runtime-private retention is explicit and non-undoable.
  purpose: HoldPurpose,
  status: Schema.Literals(["held", "restored"]),
  at: Schema.DateTimeUtcFromString
}) {}

export class RemoveReceipt extends Schema.Class<RemoveReceipt>("RemoveReceipt")({
  id: ActId,
  target: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  at: Schema.DateTimeUtcFromString
}) {}

export class RuntimePrivateRetentionReceipt extends Schema.Class<RuntimePrivateRetentionReceipt>(
  "RuntimePrivateRetentionReceipt"
)({
  id: ActId,
  target: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  at: Schema.DateTimeUtcFromString
}) {}

export class OverwriteReceipt extends Schema.Class<OverwriteReceipt>("OverwriteReceipt")({
  id: ActId,
  target: Schema.String,
  previousHeld: Schema.Boolean,
  at: Schema.DateTimeUtcFromString
}) {}

export class UndoReceipt extends Schema.Class<UndoReceipt>("UndoReceipt")({
  id: ActId,
  target: Schema.String,
  displaced: Schema.optional(ActId),
  at: Schema.DateTimeUtcFromString
}) {}

export class ReapReport extends Schema.Class<ReapReport>("ReapReport")({
  reaped: Schema.Array(ActId),
  at: Schema.DateTimeUtcFromString
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
