import { Context, Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync
} from "node:fs"
import { release } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CapabilityClaim,
  VmEnclosureAvailability
} from "../Capabilities.ts"
import {
  PreparedPrivateWorkspace,
  PrivateWorkspaceRequest,
  WorkspaceDestinationExists,
  WorkspacePreparationFailed,
  WorkspaceSourceMissing,
  WorkspaceSourceNotDirectory,
  type NativeWorkspaceError
} from "../NativeWorkspace.ts"
import { elfInterpreter } from "./Elf.ts"
import {
  LinuxCapabilityReport,
  LinuxNativeContainment,
  LinuxRuntime,
  LinuxUnavailable
} from "./contracts.ts"

const minimumBubblewrap = [0, 12, 0] as const
const launcherName = "airlock-linux-launcher"
const cp = "/bin/cp"
const getcap = [
  "/usr/sbin/getcap",
  "/sbin/getcap",
  "/usr/bin/getcap",
  "/bin/getcap"
].find(existsSync)

export interface LinuxPlatformConfig {
  readonly bubblewrapCandidates?: ReadonlyArray<string>
  readonly launcherCandidates?: ReadonlyArray<string>
}

const claim = (
  posture: "enforced" | "available" | "allowed" | "bounded" | "unavailable" | "not-provided",
  mechanism: string,
  scope: string,
  caveats: ReadonlyArray<string>
) => new CapabilityClaim({ posture, mechanism, scope, caveats: [...caveats] })

const defaultBubblewrapCandidates = () => {
  const configured = process.env["AIRLOCK_BWRAP"]
  return [
    ...(configured === undefined ? [] : [configured]),
    join(dirname(process.execPath), "airlock-bwrap"),
    resolve(dirname(process.execPath), "../libexec/airlock/bwrap"),
    "/usr/local/bin/bwrap",
    "/usr/bin/bwrap"
  ]
}

const defaultLauncherCandidates = () => {
  const configured = process.env["AIRLOCK_LINUX_LAUNCHER"]
  return [
    ...(configured === undefined ? [] : [configured]),
    join(dirname(process.execPath), launcherName),
    resolve(dirname(process.execPath), `../libexec/airlock/${launcherName}`),
    fileURLToPath(new URL(`../../../dist/${launcherName}`, import.meta.url)),
    `/usr/local/libexec/airlock/${launcherName}`,
    `/usr/local/bin/${launcherName}`
  ]
}

const firstExisting = (paths: ReadonlyArray<string>) =>
  paths.find((path) => isAbsolute(path) && existsSync(path))

const parseVersion = (output: string) => {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const
}

const versionAtLeast = (
  actual: readonly [number, number, number],
  expected: readonly [number, number, number]
) => {
  for (let index = 0; index < expected.length; index++) {
    if (actual[index]! > expected[index]!) return true
    if (actual[index]! < expected[index]!) return false
  }
  return true
}

const gnuCopyAvailable = () => {
  if (!existsSync(cp)) return false
  const probe = spawnSync(cp, ["--version"], {
    encoding: "utf8",
    env: {},
    timeout: 5_000
  })
  return probe.status === 0 && /^cp \(GNU coreutils\) /m.test(probe.stdout)
}

const safeExecutable = (path: string, capability: string) => {
  const canonical = realpathSync(path)
  const status = statSync(canonical)
  if (!status.isFile()) {
    throw new LinuxUnavailable({ capability, reason: `${canonical} is not a regular file` })
  }
  if ((status.mode & 0o111) === 0) {
    throw new LinuxUnavailable({ capability, reason: `${canonical} is not executable` })
  }
  if ((status.mode & 0o6000) !== 0) {
    throw new LinuxUnavailable({
      capability,
      reason: `${canonical} has setuid or setgid mode bits`
    })
  }
  if (getcap === undefined) {
    throw new LinuxUnavailable({
      capability,
      reason: "libcap getcap is required to reject file-capability elevation"
    })
  }
  const capabilities = spawnSync(getcap, [canonical], {
    encoding: "utf8",
    env: {},
    timeout: 5_000
  })
  if (capabilities.status !== 0) {
    throw new LinuxUnavailable({
      capability,
      reason: `could not inspect file capabilities on ${canonical}`
    })
  }
  if (capabilities.stdout.trim().length > 0) {
    throw new LinuxUnavailable({
      capability,
      reason: `${canonical} has file capabilities`
    })
  }
  return canonical
}

const strictBubblewrapArgs = () => [
  "--unshare-user",
  "--disable-userns",
  "--assert-userns-disabled",
  "--unshare-ipc",
  "--unshare-pid",
  "--unshare-net",
  "--unshare-uts",
  "--unshare-cgroup",
  "--hostname", "airlock-cell",
  "--die-with-parent",
  "--new-session",
  "--cap-drop", "ALL",
  "--clearenv"
]

const inspectRuntime = (config: LinuxPlatformConfig) => Effect.try({
  try: () => {
    if (process.platform !== "linux") {
      throw new LinuxUnavailable({
        capability: "Linux native containment",
        reason: `platform is ${process.platform}`
      })
    }
    if (!gnuCopyAvailable()) {
      throw new LinuxUnavailable({
        capability: "private Cell workspace",
        reason: "/bin/cp must be GNU coreutils with --archive and --reflink support"
      })
    }
    const bubblewrapPaths =
      config.bubblewrapCandidates ?? defaultBubblewrapCandidates()
    const bubblewrapCandidate = firstExisting(bubblewrapPaths)
    if (bubblewrapCandidate === undefined) {
      throw new LinuxUnavailable({
        capability: "bubblewrap",
        reason: `not found in the audited candidate set: ${bubblewrapPaths.join(", ")}`
      })
    }
    const bubblewrap = safeExecutable(bubblewrapCandidate, "bubblewrap")
    const versionResult = spawnSync(bubblewrap, ["--version"], {
      encoding: "utf8",
      env: {},
      timeout: 5_000
    })
    const parsedVersion = parseVersion(versionResult.stdout)
    if (versionResult.status !== 0 || parsedVersion === undefined) {
      throw new LinuxUnavailable({
        capability: "bubblewrap",
        reason: `could not parse ${bubblewrap} --version`
      })
    }
    if (!versionAtLeast(parsedVersion, minimumBubblewrap)) {
      throw new LinuxUnavailable({
        capability: "bubblewrap >= 0.12.0",
        reason:
          `${parsedVersion.join(".")} is below Airlock's audited setup-race baseline; ` +
          "install upstream 0.12.0 or newer"
      })
    }

    const launcherPaths =
      config.launcherCandidates ?? defaultLauncherCandidates()
    const launcherCandidate = firstExisting(launcherPaths)
    if (launcherCandidate === undefined) {
      throw new LinuxUnavailable({
        capability: "Airlock Linux launcher",
        reason: `could not find ${launcherName} in: ${launcherPaths.join(", ")}`
      })
    }
    const launcher = safeExecutable(launcherCandidate, "Airlock Linux launcher")
    const launcherProbe = spawnSync(launcher, ["--probe"], {
      encoding: "utf8",
      env: {},
      timeout: 5_000
    })
    const probe = /^airlock-linux-launcher-v1 landlock-abi=(\d+) seccomp=1\s*$/.exec(
      launcherProbe.stdout
    )
    if (launcherProbe.status !== 0 || probe === null) {
      throw new LinuxUnavailable({
        capability: "Landlock + seccomp launcher",
        reason: (launcherProbe.stderr || launcherProbe.stdout || "launcher probe failed").trim()
      })
    }
    const landlockAbi = Number(probe[1])
    const targetCandidate = firstExisting(["/usr/bin/true", "/bin/true"])
    if (targetCandidate === undefined) {
      throw new LinuxUnavailable({
        capability: "Linux native containment smoke test",
        reason: "could not find true in /usr/bin or /bin"
      })
    }
    const target = realpathSync(targetCandidate)
    const loader = elfInterpreter(target)
    const allowed = [target, ...(loader === undefined ? [] : [loader])]
    const smoke = spawnSync(
      bubblewrap,
      [
        ...strictBubblewrapArgs(),
        "--ro-bind", "/", "/",
        "--proc", "/proc",
        "--dev", "/dev",
        "--chdir", "/",
        "--",
        launcher,
        ...allowed.flatMap((path) => ["--allow-exec", path]),
        "--",
        target
      ],
      {
        encoding: "utf8",
        env: {},
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    if (smoke.status !== 0) {
      throw new LinuxUnavailable({
        capability: "Linux native containment smoke test",
        reason: (smoke.stderr || smoke.stdout || `exit ${smoke.status}`).trim()
      })
    }
    return new LinuxRuntime({
      bubblewrap,
      bubblewrapVersion: parsedVersion.join("."),
      launcher,
      launcherVersion: "airlock-linux-launcher-v1",
      landlockAbi
    })
  },
  catch: (cause) =>
    cause instanceof LinuxUnavailable
      ? cause
      : new LinuxUnavailable({
          capability: "Linux native containment",
          reason: cause instanceof Error ? cause.message : String(cause)
        })
})

const unavailableReport = (reason: string) => {
  const unavailable = claim("unavailable", "missing Linux native runtime", "native-contained Cell", [reason])
  const copyAvailable = gnuCopyAvailable()
  return new LinuxCapabilityReport({
    schemaVersion: "airlock/linux-capabilities/v1",
    platform: "linux",
    kernelRelease: release(),
    bubblewrap: unavailable,
    landlock: unavailable,
    seccomp: unavailable,
    cloneOrCopyWorkspace: claim(
      copyAvailable ? "enforced" : "unavailable",
      "/bin/cp --archive --reflink=auto",
      "fresh private Cell workspace",
      copyAvailable
        ? ["copy-on-write is an opportunistic optimization; copy isolation is the contract"]
        : ["GNU /bin/cp with --archive and --reflink support is unavailable"]
    ),
    nativeContainment: new LinuxNativeContainment({
      namespaces: unavailable,
      privateWritableView: unavailable,
      liveWorkspaceWriteFence: unavailable,
      deniedNetworkFence: unavailable,
      executableObjectFence: unavailable,
      bootstrapEnvironment: unavailable,
      ambientHostReads: claim("allowed", "read-only host root when available", "host-readable paths", ["no confidentiality claim"]),
      confidentiality: claim("not-provided", "none", "host secrets", ["native-contained permits ambient host reads"]),
      processCancellation: unavailable
    }),
    vmEnclosure: new VmEnclosureAvailability({
      hardwareVirtualization: claim(existsSync("/dev/kvm") ? "available" : "unavailable", "/dev/kvm probe", "host hardware virtualization", ["hardware support does not install an Airlock VM backend"]),
      backend: claim("not-provided", "none", "Airlock VM Cell backend", ["vm-enclosed must fail closed"])
    })
  })
}

const capabilityReport = (runtime: Effect.Effect<LinuxRuntime, LinuxUnavailable>) => runtime.pipe(
  Effect.match({
    onFailure: (error) => unavailableReport(`${error.capability}: ${error.reason}`),
    onSuccess: (runtime) => {
      const bubblewrap = claim(
        "enforced",
        `${runtime.bubblewrap} ${runtime.bubblewrapVersion}`,
        "unprivileged mount and namespace construction",
        ["requires enabled unprivileged user namespaces", "bubblewrap is policy plumbing, not a complete sandbox"]
      )
      const landlock = claim(
        "enforced",
        `Landlock ABI ${runtime.landlockAbi}`,
        "admitted executable filesystem objects",
        ["ELF loaders are runtime-required objects and can interpret other ELF files", "hardlink aliases share object authority", "in-process interpretation remains outside the edge fence"]
      )
      const seccomp = claim(
        "enforced",
        `${runtime.launcherVersion} libseccomp filter`,
        "socket creation/use, anonymous execution, namespace/mount changes, and selected kernel authority syscalls",
        ["architecture-specific syscall mediation is installed by the native launcher", "resource exhaustion is not bounded by seccomp"]
      )
      return new LinuxCapabilityReport({
        schemaVersion: "airlock/linux-capabilities/v1",
        platform: "linux",
        kernelRelease: release(),
        bubblewrap,
        landlock,
        seccomp,
        cloneOrCopyWorkspace: claim(
          "enforced",
          "/bin/cp --archive --reflink=auto",
          "fresh private Cell workspace",
          ["copy-on-write is opportunistic and not part of the isolation contract", "the delta remains inert until Hold applies it"]
        ),
        nativeContainment: new LinuxNativeContainment({
          namespaces: claim("enforced", "strict Bubblewrap user/mount/PID/network/IPC/UTS/cgroup namespaces", "native-contained process tree", ["cgroup namespace changes visibility but sets no resource quota"]),
          privateWritableView: claim("enforced", "host-prepared clone/copy pinned into a read-only host root", "Cell workspace writes", ["private bytes remain host-visible to the supervisor for delta and Hold retention"]),
          liveWorkspaceWriteFence: claim("enforced", "recursive read-only host bind plus pinned private-workspace and declared-temp writable binds", "writes from the Cell to the source workspace and ordinary host paths", ["explicit Cell temp paths are writable grants", "foreign host writers remain possible and are detected as drift"]),
          deniedNetworkFence: claim("enforced", "network namespace plus seccomp socket-family denial", "TCP, UDP, netlink, loopback, pathname/abstract Unix sockets, and new socketpairs", ["Cell rejects inherited stdio; the launcher closes descriptors above stderr", "Bun-owned capture socketpairs remain the explicit stdout/stderr transport"]),
          executableObjectFence: landlock,
          bootstrapEnvironment: claim("enforced", "empty Bubblewrap environment; target env materialized only after Landlock and seccomp", "loader variables such as LD_PRELOAD and LD_AUDIT", ["target variables remain effective inside containment"]),
          ambientHostReads: claim("allowed", "recursive read-only host root", "host-readable regular paths", ["fresh /proc and /dev replace those host pseudo-filesystems", "this is not a confidentiality boundary"]),
          confidentiality: claim("not-provided", "none; host root is readable", "host secrets and confidential files", ["use a future VM Cell for confidentiality"]),
          processCancellation: claim("bounded", "Bubblewrap PID-1 reaper + parent-death signal + ProcessRunner timeout escalation", "contained descendants including daemonized processes", ["SIGTERM may become abrupt PID-namespace teardown", "no CPU, memory, or I/O quotas are installed"])
        }),
        vmEnclosure: new VmEnclosureAvailability({
          hardwareVirtualization: claim(existsSync("/dev/kvm") ? "available" : "unavailable", "/dev/kvm probe", "host hardware virtualization", ["hardware support does not install an Airlock VM backend"]),
          backend: claim("not-provided", "none", "Airlock VM Cell backend", ["vm-enclosed must fail closed"])
        }),
        runtime
      })
    }
  })
)

const copyWorkspace = (source: string, destination: string) => {
  // GNU cp's `auto` mode attempts FICLONE per regular file and falls back to a
  // byte copy before publishing that file. A separate `always` invocation can
  // leave a partial destination on unsupported filesystems, after which the
  // no-unlink construction law correctly prevents an unsafe cleanup/retry.
  const copy = spawnSync(
    cp,
    ["--archive", "--reflink=auto", "--", source, destination],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 120_000 }
  )
  if (copy.status !== 0) {
    throw new WorkspacePreparationFailed({
      source,
      destination,
      cause: (copy.stderr || copy.stdout || `cp exited ${copy.status}`).trim()
    })
  }
  // CoW is deliberately an implementation optimization. The portable receipt
  // promises a private copy and does not infer physical extent sharing.
  return "copy" as const
}

const preparePrivateWorkspace = (request: PrivateWorkspaceRequest): Effect.Effect<
  PreparedPrivateWorkspace,
  LinuxUnavailable | NativeWorkspaceError
> => Effect.try({
  try: () => {
    if (process.platform !== "linux") {
      throw new LinuxUnavailable({
        capability: "Linux workspace preparation",
        reason: `platform is ${process.platform}`
      })
    }
    const source = resolve(request.source)
    const destination = resolve(request.destination)
    if (!existsSync(source)) throw new WorkspaceSourceMissing({ source })
    if (!statSync(source).isDirectory()) throw new WorkspaceSourceNotDirectory({ source })
    if (existsSync(destination)) throw new WorkspaceDestinationExists({ destination })
    mkdirSync(dirname(destination), { recursive: true })
    const canonicalSource = realpathSync(source)
    const strategy = copyWorkspace(canonicalSource, destination)
    return new PreparedPrivateWorkspace({
      source: canonicalSource,
      destination,
      strategy
    })
  },
  catch: (cause) =>
    cause instanceof LinuxUnavailable ||
    cause instanceof WorkspaceSourceMissing ||
    cause instanceof WorkspaceSourceNotDirectory ||
    cause instanceof WorkspaceDestinationExists ||
    cause instanceof WorkspacePreparationFailed
      ? cause
      : new WorkspacePreparationFailed({
          source: request.source,
          destination: request.destination,
          cause: cause instanceof Error ? cause.message : String(cause)
        })
})

export class LinuxPlatform extends Context.Tag("airlock/LinuxPlatform")<
  LinuxPlatform,
  {
    readonly runtime: Effect.Effect<LinuxRuntime, LinuxUnavailable>
    readonly capabilityReport: Effect.Effect<LinuxCapabilityReport>
    readonly preparePrivateWorkspace: (
      request: PrivateWorkspaceRequest
    ) => Effect.Effect<PreparedPrivateWorkspace, LinuxUnavailable | NativeWorkspaceError>
  }
>() {}

export const LinuxPlatformLiveWith = (
  config: LinuxPlatformConfig = {}
) => {
  const runtime = inspectRuntime(config)
  return Layer.succeed(LinuxPlatform, {
    runtime,
    capabilityReport: capabilityReport(runtime),
    preparePrivateWorkspace
  })
}

export const LinuxPlatformLive = LinuxPlatformLiveWith()

export { strictBubblewrapArgs }
