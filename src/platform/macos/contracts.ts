import { Schema } from "effect"

// The platform seam is deliberately small: these are observed host facts and
// reversible workspace preparation, never an assertion that a Cell is fenced.

export const CapabilityAvailability = Schema.Literal(
  "available",
  "unavailable"
)
export type CapabilityAvailability = typeof CapabilityAvailability.Type

export class MacosVolume extends Schema.Class<MacosVolume>("MacosVolume")({
  path: Schema.String,
  device: Schema.String,
  filesystem: Schema.String,
  name: Schema.String,
  uuid: Schema.optional(Schema.String),
  apfs: Schema.Boolean,
  writable: Schema.Boolean,
  local: Schema.Boolean
}) {}

export class SameVolumeReport extends Schema.Class<SameVolumeReport>(
  "SameVolumeReport"
)({
  left: Schema.String,
  right: Schema.String,
  same: Schema.Boolean
}) {}

export class NativeContainment extends Schema.Class<NativeContainment>(
  "NativeContainment"
)({
  privateWritableView: Schema.Literal("clone-or-copy"),
  filesystemFence: CapabilityAvailability,
  networkFence: CapabilityAvailability,
  processTreeFence: CapabilityAvailability,
  guarantee: Schema.Literal("workspace-isolation-only")
}) {}

export class VmEnclosureAvailability extends Schema.Class<VmEnclosureAvailability>(
  "VmEnclosureAvailability"
)({
  hardwareVirtualization: CapabilityAvailability,
  backend: CapabilityAvailability,
  available: CapabilityAvailability,
  reason: Schema.String
}) {}

export class MacosCapabilityReport extends Schema.Class<MacosCapabilityReport>(
  "MacosCapabilityReport"
)({
  platform: Schema.Literal("darwin"),
  apfsInspection: CapabilityAvailability,
  cloneOrCopyWorkspace: CapabilityAvailability,
  nativeContainment: NativeContainment,
  vmEnclosure: VmEnclosureAvailability
}) {}

export class PrivateWorkspaceRequest extends Schema.Class<PrivateWorkspaceRequest>(
  "PrivateWorkspaceRequest"
)({
  source: Schema.String,
  destination: Schema.String
}) {}

export class PrivateWorkspaceReceipt extends Schema.Class<PrivateWorkspaceReceipt>(
  "PrivateWorkspaceReceipt"
)({
  source: Schema.String,
  destination: Schema.String,
  sourceVolume: MacosVolume,
  destinationVolume: MacosVolume,
  sameVolume: Schema.Boolean,
  strategy: Schema.Literal("clone-or-copy")
}) {}

export class MacosUnavailable extends Schema.TaggedError<MacosUnavailable>()(
  "MacosUnavailable",
  { platform: Schema.String }
) {}

export class MacosCommandFailed extends Schema.TaggedError<MacosCommandFailed>()(
  "MacosCommandFailed",
  { command: Schema.String, cause: Schema.String }
) {}

export class VolumeInspectionFailed extends Schema.TaggedError<VolumeInspectionFailed>()(
  "VolumeInspectionFailed",
  { path: Schema.String, cause: Schema.String }
) {}

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
