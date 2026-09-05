import { Schema } from "effect"

/** A capability claim always names the mechanism and the boundary of its evidence. */
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

export class VmEnclosureAvailability extends Schema.Class<VmEnclosureAvailability>(
  "VmEnclosureAvailability"
)({
  hardwareVirtualization: CapabilityClaim,
  backend: CapabilityClaim
}) {}
