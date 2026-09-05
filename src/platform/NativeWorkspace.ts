import { Schema } from "effect"

/** Platform-neutral request for a fresh private execution view. */
export class PrivateWorkspaceRequest extends Schema.Class<PrivateWorkspaceRequest>(
  "PrivateWorkspaceRequest"
)({
  source: Schema.String,
  destination: Schema.String
}) {}

/** The Cell only consumes these common facts; host adapters may retain richer evidence. */
export class PreparedPrivateWorkspace extends Schema.Class<PreparedPrivateWorkspace>(
  "PreparedPrivateWorkspace"
)({
  source: Schema.String,
  destination: Schema.String,
  strategy: Schema.String
}) {}

export class WorkspaceSourceMissing extends Schema.TaggedError<WorkspaceSourceMissing>()(
  "WorkspaceSourceMissing",
  { source: Schema.String }
) {}

export class WorkspaceSourceNotDirectory extends Schema.TaggedError<WorkspaceSourceNotDirectory>()(
  "WorkspaceSourceNotDirectory",
  { source: Schema.String }
) {}

export class WorkspaceDestinationExists extends Schema.TaggedError<WorkspaceDestinationExists>()(
  "WorkspaceDestinationExists",
  { destination: Schema.String }
) {}

export class WorkspacePreparationFailed extends Schema.TaggedError<WorkspacePreparationFailed>()(
  "WorkspacePreparationFailed",
  { source: Schema.String, destination: Schema.String, cause: Schema.String }
) {}

export type NativeWorkspaceError =
  | WorkspaceSourceMissing
  | WorkspaceSourceNotDirectory
  | WorkspaceDestinationExists
  | WorkspacePreparationFailed
