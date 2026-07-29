import { Layer } from "effect"
import { HoldLayer } from "./Hold.ts"
import { MacosExclusiveRenameLive } from "./platform/macos/MacosExclusiveRename.ts"

/**
 * macOS v1 composition. Hold owns recovery semantics; the adapter owns the
 * platform-specific atomic primitive. Unsupported platforms fail through the
 * typed capability and never fall back to an overwriting rename.
 */
export const HoldLive = HoldLayer.pipe(
  Layer.provide(MacosExclusiveRenameLive)
)
