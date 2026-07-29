import { Context, Effect, Either, Layer } from "effect"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  statSync
} from "node:fs"
import { dirname, resolve } from "node:path"
import {
  CapabilityClaim,
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

const claim = (
  posture: "enforced" | "available" | "allowed" | "bounded" | "unavailable" | "not-provided",
  mechanism: string,
  scope: string,
  caveats: ReadonlyArray<string>
) => new CapabilityClaim({ posture, mechanism, scope, caveats: [...caveats] })

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
            hardwareVirtualization: claim(
              hardwareVirtualization === "available" ? "available" : "unavailable",
              "sysctl kern.hv_support",
              "host hardware virtualization availability",
              [
                "hardware support alone does not provide an Airlock VM Cell",
                "the active native Cell does not use this as its containment boundary"
              ]
            ),
            backend: claim(
              "not-provided",
              "none",
              "Airlock VM Cell backend",
              ["no VM backend is bundled in this runtime", "a selected vm-enclosed profile must fail closed"]
            )
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
            schemaVersion: "airlock/macos-capabilities/v2",
            platform: "darwin",
            apfsInspection: claim(
              existsSync(diskutil) && existsSync(plutil) ? "available" : "unavailable",
              "diskutil info -plist + plutil JSON conversion",
              "mounted-volume inspection for workspace admission",
              ["inspection does not prove filesystem semantics", "diskutil output is host-provided metadata"]
            ),
            cloneOrCopyWorkspace: claim(
              existsSync(cp) ? "enforced" : "unavailable",
              "/bin/cp -cR with /bin/cp -R fallback",
              "fresh non-live Cell workspace only",
              [
                "clone is attempted only for same-volume APFS workspaces",
                "copy fallback preserves isolation but not copy-on-write performance",
                "this does not itself restrict a process from reading the host"
              ]
            ),
            nativeContainment: new NativeContainment({
              seatbelt: claim(
                existsSync("/usr/bin/sandbox-exec") ? "enforced" : "unavailable",
                "/usr/bin/sandbox-exec",
                "native-contained Cell execution",
                [
                  "this is native Seatbelt containment, not a VM boundary",
                  "the Cell refuses rather than falls back when sandbox-exec is absent"
                ]
              ),
              privateWritableView: claim(
                existsSync(cp) ? "enforced" : "unavailable",
                "APFS clone or recursive copy prepared before execution",
                "all Cell workspace writes target the fresh private workspace",
                ["the resulting delta remains a proposal until Hold applies it"]
              ),
              liveWorkspaceWriteFence: claim(
                existsSync("/usr/bin/sandbox-exec") ? "enforced" : "unavailable",
                "Seatbelt deny-default + file-write grants only for private workspace and explicit temp paths",
                "writes from a native Cell to its live source workspace",
                [
                  "the profile has been construction-tested for a direct live workspace write",
                  "the fence does not make foreign filesystem protocols transactional"
                ]
              ),
              deniedNetworkFence: claim(
                existsSync("/usr/bin/sandbox-exec") ? "enforced" : "unavailable",
                "Seatbelt (deny network*) when Cell network is deny",
                "network access for a native Cell invoked with network: deny",
                [
                  "network: allow is compatibility authority, not brokered endpoint authority",
                  "this is not a protocol broker or an external-effect receipt"
                ]
              ),
              ambientHostReads: claim(
                "allowed",
                "Seatbelt (allow file-read*)",
                "arbitrary host-readable paths visible to the native Cell",
                [
                  "needed for broad existing Unix tool compatibility",
                  "host reads must not be treated as an explicit Capture grant"
                ]
              ),
              confidentiality: claim(
                "not-provided",
                "none; native Cell permits ambient host reads",
                "host secrets and confidential files",
                [
                  "native-contained provides no secret-isolation or confidentiality guarantee",
                  "use a future VM Cell plus explicit brokers for that claim"
                ]
              ),
              processCancellation: claim(
                "bounded",
                "Bun detached process + POSIX process-group SIGTERM/SIGKILL",
                "direct child and descendants that remain in its process group",
                [
                  "a process can call setsid/setpgid or daemonize and escape the owned group",
                  "native Cell must not claim complete descendant ownership"
                ]
              )
            }),
            vmEnclosure
          })
      )
    )
  )
)

const workspaceCommand = (source: string, destination: string, strategy: "clone" | "copy") =>
  command(cp, [strategy === "clone" ? "-cR" : "-R", source, destination]).pipe(
    Effect.mapError(
      (error) =>
        new WorkspacePreparationFailed({
          source,
          destination,
          cause: error.cause
        })
    )
  )

/**
 * APFS clone preparation is an optimization, never a requirement for Cell
 * isolation. When cloning fails before it creates the target, retry a normal
 * recursive copy. A partially-created destination is preserved for diagnosis:
 * this adapter does not delete it behind the caller's back.
 */
const populateWorkspace = (
  source: string,
  destination: string,
  sourceVolume: MacosVolume,
  destinationVolume: MacosVolume,
  same: boolean
): Effect.Effect<"clone" | "copy", WorkspacePreparationFailed> => {
  const cloneEligible = same && sourceVolume.apfs && destinationVolume.apfs
  if (!cloneEligible) return workspaceCommand(source, destination, "copy").pipe(Effect.as("copy" as const))

  return workspaceCommand(source, destination, "clone").pipe(
    Effect.either,
    Effect.flatMap((result) => {
      if (Either.isRight(result)) return Effect.succeed("clone" as const)
      if (existsSync(destination)) return Effect.fail(result.left)
      return workspaceCommand(source, destination, "copy").pipe(Effect.as("copy" as const))
    })
  )
}

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
          populateWorkspace(
            source,
            destination,
            sourceVolume,
            destinationVolume,
            volumeMatch.same
          ).pipe(
            Effect.map((strategy) =>
              new PrivateWorkspaceReceipt({
                source,
                destination,
                sourceVolume,
                destinationVolume,
                sameVolume: volumeMatch.same,
                strategy
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
