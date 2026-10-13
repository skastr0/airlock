import { existsSync } from "node:fs"

const linuxLauncher = process.env["AIRLOCK_LINUX_LAUNCHER"]
const linuxBubblewrap = process.env["AIRLOCK_BWRAP"] ?? (
  existsSync("/usr/local/bin/bwrap")
    ? "/usr/local/bin/bwrap"
    : "/usr/bin/bwrap"
)

/** Cheap fixture admission only. LinuxPlatform's runtime probe remains the
 * authoritative check and each native test fails if that probe cannot enforce
 * the configured mechanism. */
export const nativeContainmentSupported =
  typeof Bun !== "undefined" && (
    (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
    (
      process.platform === "linux" &&
      linuxLauncher !== undefined &&
      existsSync(linuxLauncher) &&
      existsSync(linuxBubblewrap)
    )
  )

export const nativeContainmentPlatform =
  process.platform === "darwin" || process.platform === "linux"
    ? process.platform
    : undefined
