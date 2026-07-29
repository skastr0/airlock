import { Context, Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  statSync
} from "node:fs"
import { dirname, resolve } from "node:path"
import {
  MacosCapabilityReport,
  MacosCommandFailed,
  MacosUnavailable,
  MacosVolume,
  NativeContainment,
  PrivateWorkspaceReceipt,
  PrivateWorkspaceRequest,
  SameVolumeReport,
  VmEnclosureAvailability,
  VolumeInspectionFailed,
  WorkspaceDestinationExists,
  WorkspacePreparationFailed,
  WorkspaceSourceMissing,
  WorkspaceSourceNotDirectory
} from "./contracts.ts"

const diskutil = "/usr/sbin/diskutil"
const plutil = "/usr/bin/plutil"
const cp = "/bin/cp"
const sysctl = "/usr/sbin/sysctl"

type DiskInfo = Record<string, unknown>

const command = (binary: string, args: ReadonlyArray<string>, input?: string) =>
  Effect.try({
    try: () =>
      execFileSync(binary, [...args], {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"]
      }),
    catch: (cause) =>
      new MacosCommandFailed({ command: `${binary} ${args.join(" ")}`, cause: String(cause) })
  })

const requireMacos = Effect.suspend(() =>
  process.platform === "darwin"
    ? Effect.void
    : Effect.fail(new MacosUnavailable({ platform: process.platform }))
)

const stringAt = (value: DiskInfo, key: string) =>
  typeof value[key] === "string" ? value[key] : ""

const booleanAt = (value: DiskInfo, key: string) => value[key] === true

// diskutil accepts a device or mount point, not an arbitrary descendant path.
// df gives the mounted device without guessing from a pathname.
const mountedDevice = (path: string) =>
  command("/bin/df", ["-P", path]).pipe(
    Effect.flatMap((output) =>
      Effect.try({
        try: () => {
          const row = output.trim().split("\n").at(-1)
          const device = row?.trim().split(/\s+/)[0]
          if (device === undefined || !device.startsWith("/dev/")) {
            throw new Error(`no mounted device in df output: ${row ?? ""}`)
          }
          return device
        },
        catch: (cause) =>
          new VolumeInspectionFailed({ path, cause: String(cause) })
      })
    )
  )

const inspectVolume = (rawPath: string) =>
  requireMacos.pipe(
    Effect.zipRight(
      mountedDevice(rawPath).pipe(
        Effect.flatMap((device) => command(diskutil, ["info", "-plist", device])),
        Effect.flatMap((plist) => command(plutil, ["-convert", "json", "-o", "-", "-"], plist)),
        Effect.flatMap((json) =>
          Effect.try({
            try: () => JSON.parse(json) as DiskInfo,
            catch: (cause) => new VolumeInspectionFailed({ path: rawPath, cause: String(cause) })
          })
        ),
        Effect.map((info) => {
          const filesystem = stringAt(info, "FilesystemType").toLowerCase()
          const uuid = stringAt(info, "VolumeUUID")
          return new MacosVolume({
            path: rawPath,
            device: stringAt(info, "DeviceIdentifier"),
            filesystem,
            name: stringAt(info, "VolumeName"),
            ...(uuid === "" ? {} : { uuid }),
            apfs: filesystem === "apfs",
            writable: booleanAt(info, "WritableVolume") || booleanAt(info, "Writable"),
            local: !booleanAt(info, "Removable") && !booleanAt(info, "RemovableMedia" )
          })
        }),
        Effect.mapError((error) =>
          error._tag === "MacosCommandFailed"
            ? new VolumeInspectionFailed({ path: rawPath, cause: error.cause })
            : error
        )
      )
    )
  )

const sameVolume = (left: string, right: string) =>
  requireMacos.pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () =>
          new SameVolumeReport({
            left,
            right,
            same: statSync(left).dev === statSync(right).dev
          }),
        catch: (cause) =>
          new VolumeInspectionFailed({ path: `${left}, ${right}`, cause: String(cause) })
      })
    )
  )

const vmEnclosureAvailability = requireMacos.pipe(
  Effect.zipRight(
    command(sysctl, ["-n", "kern.hv_support"]).pipe(
      Effect.match({
        onFailure: () => "unavailable" as const,
        onSuccess: (value) =>
          value.trim() === "1" ? ("available" as const) : ("unavailable" as const)
      }),
      Effect.map(
        (hardwareVirtualization) =>
          new VmEnclosureAvailability({
            hardwareVirtualization,
            backend: "unavailable",
            available: "unavailable",
            reason: "no VM cell backend is bundled"
          })
      )
    )
  )
)

const capabilityReport = requireMacos.pipe(
  Effect.zipRight(
    vmEnclosureAvailability.pipe(
      Effect.map(
        (vmEnclosure) =>
          new MacosCapabilityReport({
            platform: "darwin",
            apfsInspection: existsSync(diskutil) && existsSync(plutil) ? "available" : "unavailable",
            cloneOrCopyWorkspace: existsSync(cp) ? "available" : "unavailable",
            nativeContainment: new NativeContainment({
              privateWritableView: "clone-or-copy",
              filesystemFence: "unavailable",
              networkFence: "unavailable",
              processTreeFence: "unavailable",
              guarantee: "workspace-isolation-only"
            }),
            vmEnclosure
          })
      )
    )
  )
)

const preparePrivateWorkspace = (request: PrivateWorkspaceRequest) =>
  requireMacos.pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => {
          const source = resolve(request.source)
          const destination = resolve(request.destination)
          if (!existsSync(source)) throw new WorkspaceSourceMissing({ source })
          if (!statSync(source).isDirectory()) {
            throw new WorkspaceSourceNotDirectory({ source })
          }
          if (existsSync(destination)) {
            throw new WorkspaceDestinationExists({ destination })
          }
          mkdirSync(dirname(destination), { recursive: true })
          return { source, destination }
        },
        catch: (cause) =>
          cause instanceof WorkspaceSourceMissing ||
          cause instanceof WorkspaceSourceNotDirectory ||
          cause instanceof WorkspaceDestinationExists
            ? cause
            : new WorkspacePreparationFailed({
                source: request.source,
                destination: request.destination,
                cause: String(cause)
              })
      })
    ),
    Effect.flatMap(({ source, destination }) =>
      Effect.all({
        sourceVolume: inspectVolume(source),
        destinationVolume: inspectVolume(dirname(destination)),
        sameVolume: sameVolume(source, dirname(destination))
      }).pipe(
        Effect.flatMap(({ sourceVolume, destinationVolume, sameVolume: volumeMatch }) =>
          command(cp, ["-cR", source, destination]).pipe(
            Effect.mapError(
              (error) =>
                new WorkspacePreparationFailed({
                  source,
                  destination,
                  cause: error.cause
                })
            ),
            Effect.as(
              new PrivateWorkspaceReceipt({
                source,
                destination,
                sourceVolume,
                destinationVolume,
                sameVolume: volumeMatch.same,
                strategy: "clone-or-copy"
              })
            )
          )
        )
      )
    )
  )

export class MacosPlatform extends Context.Tag("airlock/MacosPlatform")<
  MacosPlatform,
  {
    readonly capabilityReport: Effect.Effect<MacosCapabilityReport, MacosUnavailable>
    readonly inspectVolume: (path: string) => Effect.Effect<MacosVolume, MacosUnavailable | VolumeInspectionFailed>
    readonly sameVolume: (left: string, right: string) => Effect.Effect<SameVolumeReport, MacosUnavailable | VolumeInspectionFailed>
    readonly preparePrivateWorkspace: (
      request: PrivateWorkspaceRequest
    ) => Effect.Effect<
      PrivateWorkspaceReceipt,
      | MacosUnavailable
      | VolumeInspectionFailed
      | WorkspaceSourceMissing
      | WorkspaceSourceNotDirectory
      | WorkspaceDestinationExists
      | WorkspacePreparationFailed
    >
  }
>() {}

export const MacosPlatformLive = Layer.succeed(MacosPlatform, {
  capabilityReport,
  inspectVolume,
  sameVolume,
  preparePrivateWorkspace
})
