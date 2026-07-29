import { Schema } from "effect"

// The platform seam is deliberately small: these are observed host facts and
// reversible workspace preparation. A capability claim always says what is
// enforced, what merely remains available, and where the claim stops.

/**
 * Capability reports are evidence, not a product check-box. In particular,
 * `enforced` says that the selected native Cell has a concrete mechanism;
 * it does not promote that mechanism to VM-equivalent confinement.
 */
export const CapabilityPosture = Schema.Literal(
  "enforced",
  "available",
  "allowed",
  "bounded",
  "unavailable",
  "not-provided"
)
export type CapabilityPosture = typeof CapabilityPosture.Type

export class CapabilityClaim extends Schema.Class<CapabilityClaim>("CapabilityClaim")({
  posture: CapabilityPosture,
  mechanism: Schema.String,
  scope: Schema.String,
  caveats: Schema.Array(Schema.String)
}) {}

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
  /** `/usr/bin/sandbox-exec` availability for the native Cell. */
  seatbelt: CapabilityClaim,
  /** A fresh clone/copy workspace receives Cell writes before any Apply. */
  privateWritableView: CapabilityClaim,
  /** The source workspace is denied `file-write*` by the Seatbelt profile. */
  liveWorkspaceWriteFence: CapabilityClaim,
  /** `network: deny` emits `(deny network*)` in the Seatbelt profile. */
  deniedNetworkFence: CapabilityClaim,
  /** Native Cell intentionally permits `file-read*` for Unix compatibility. */
  ambientHostReads: CapabilityClaim,
  /** No confidentiality claim follows from ambient host reads. */
  confidentiality: CapabilityClaim,
  /** Cancellation terminates the owned POSIX process group, not escaped daemons. */
  processCancellation: CapabilityClaim
}) {}

export class VmEnclosureAvailability extends Schema.Class<VmEnclosureAvailability>(
  "VmEnclosureAvailability"
)({
  hardwareVirtualization: CapabilityClaim,
  backend: CapabilityClaim
}) {}

export class MacosCapabilityReport extends Schema.Class<MacosCapabilityReport>(
  "MacosCapabilityReport"
)({
  schemaVersion: Schema.Literal("airlock/macos-capabilities/v2"),
  platform: Schema.Literal("darwin"),
  apfsInspection: CapabilityClaim,
  cloneOrCopyWorkspace: CapabilityClaim,
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
  /** The actual preparation strategy, never a vague "clone-or-copy" claim. */
  strategy: Schema.Literal("clone", "copy")
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
