import { Layer } from "effect"
import { HoldLayer } from "./Hold.ts"
import { LinuxExclusiveRenameLive } from "./platform/linux/LinuxExclusiveRename.ts"
import { MacosExclusiveRenameLive } from "./platform/macos/MacosExclusiveRename.ts"

/**
 * Platform selection for the atomic no-replace primitive. Hold owns recovery
 * semantics; the adapter owns the platform-specific call. Selection is by host
 * platform only — no program, profile, or definition reaches it — and each
 * adapter independently refuses when it is not on its own platform, so a
 * mis-selection fails through the typed capability instead of degrading to an
 * overwriting rename. Unsupported platforms keep the macOS adapter's typed
 * `ExclusiveRenameUnavailable` refusal.
 */
const ExclusiveRenamePlatformLive = process.platform === "linux"
  ? LinuxExclusiveRenameLive
  : MacosExclusiveRenameLive

export const HoldLive = HoldLayer.pipe(
  Layer.provide(ExclusiveRenamePlatformLive)
)
