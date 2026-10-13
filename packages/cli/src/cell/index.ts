import { Layer } from "effect"
import { CellLayer } from "./Cell.ts"
import { LinuxCellBackendLive } from "../platform/linux/LinuxCellBackend.ts"
import { LinuxPlatformLive } from "../platform/linux/LinuxPlatform.ts"
import { MacosCellBackendLive } from "../platform/macos/MacosCellBackend.ts"
import { MacosPlatformLive } from "../platform/macos/MacosPlatform.ts"

export * from "./Cell.ts"
export * from "./NativeCellBackend.ts"
export { renderSeatbeltProfile } from "../platform/macos/MacosCellBackend.ts"

/** Selection is host-owned; a Plan cannot choose or weaken the backend. */
const HostNativeCellBackendLive = process.platform === "linux"
  ? LinuxCellBackendLive.pipe(Layer.provide(LinuxPlatformLive))
  : MacosCellBackendLive.pipe(Layer.provide(MacosPlatformLive))

export const CellLive = CellLayer.pipe(Layer.provide(HostNativeCellBackendLive))
