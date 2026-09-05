import { Schema } from "effect"
import {
  CapabilityClaim,
  VmEnclosureAvailability
} from "../Capabilities.ts"

export class LinuxRuntime extends Schema.Class<LinuxRuntime>("LinuxRuntime")({
  bubblewrap: Schema.String,
  bubblewrapVersion: Schema.String,
  launcher: Schema.String,
  launcherVersion: Schema.String,
  landlockAbi: Schema.Number
}) {}

export class LinuxNativeContainment extends Schema.Class<LinuxNativeContainment>(
  "LinuxNativeContainment"
)({
  namespaces: CapabilityClaim,
  privateWritableView: CapabilityClaim,
  liveWorkspaceWriteFence: CapabilityClaim,
  deniedNetworkFence: CapabilityClaim,
  executableObjectFence: CapabilityClaim,
  bootstrapEnvironment: CapabilityClaim,
  ambientHostReads: CapabilityClaim,
  confidentiality: CapabilityClaim,
  processCancellation: CapabilityClaim
}) {}

export class LinuxCapabilityReport extends Schema.Class<LinuxCapabilityReport>(
  "LinuxCapabilityReport"
)({
  schemaVersion: Schema.Literal("airlock/linux-capabilities/v1"),
  platform: Schema.Literal("linux"),
  kernelRelease: Schema.String,
  bubblewrap: CapabilityClaim,
  landlock: CapabilityClaim,
  seccomp: CapabilityClaim,
  cloneOrCopyWorkspace: CapabilityClaim,
  nativeContainment: LinuxNativeContainment,
  vmEnclosure: VmEnclosureAvailability,
  runtime: Schema.optional(LinuxRuntime)
}) {}

export class LinuxUnavailable extends Schema.TaggedError<LinuxUnavailable>()(
  "LinuxUnavailable",
  { capability: Schema.String, reason: Schema.String }
) {}
