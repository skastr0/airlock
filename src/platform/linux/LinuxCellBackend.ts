import { Context, Effect, Layer } from "effect"
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  realpathSync
} from "node:fs"
import {
  CellUnavailable,
  NativeCellBackend,
  type NativeCellLaunchRequest
} from "../../cell/NativeCellBackend.ts"
import {
  ProcessRequest,
  ProcessRunner,
  type ProcessRunOptions
} from "../../process/Process.ts"
import { elfInterpreter } from "./Elf.ts"
import { LinuxPlatform } from "./LinuxPlatform.ts"
import { LinuxUnavailable } from "./contracts.ts"

// Linux O_PATH is intentionally not exposed by Node's portable constants.
const O_PATH = 0o10000000
const O_CLOEXEC = 0o2000000

type MountBinding = Readonly<{
  source: string
  destination: string
  writable: boolean
  directory: boolean
}>

type OpenMountBinding = MountBinding & Readonly<{ fd: number; childFd: number }>

const unavailable = (error: LinuxUnavailable) =>
  new CellUnavailable({ capability: error.capability, reason: error.reason })

const runtimeExecutableObjects = (
  request: NativeCellLaunchRequest
): ReadonlyArray<string> => {
  const explicit = request.executableBindings.map((binding) =>
    realpathSync(binding.launch)
  )
  const loaders = explicit.flatMap((executable) => {
    const interpreter = elfInterpreter(executable)
    return interpreter === undefined ? [] : [interpreter]
  })
  return [...new Set([...explicit, ...loaders])]
}

const mountBindings = (
  request: NativeCellLaunchRequest,
  launcher: string,
  executableObjects: ReadonlyArray<string>
): ReadonlyArray<MountBinding> => {
  const bindings: MountBinding[] = [
    {
      source: realpathSync(request.sourceWorkspace),
      destination: request.sourceWorkspace,
      writable: false,
      directory: true
    },
    {
      source: realpathSync(request.privateWorkspace),
      destination: request.privateWorkspace,
      writable: true,
      directory: true
    },
    ...request.tempPaths.map((path) => ({
      source: realpathSync(path),
      destination: path,
      writable: true,
      directory: true
    })),
    {
      source: realpathSync(launcher),
      destination: realpathSync(launcher),
      writable: false,
      directory: false
    },
    ...executableObjects.map((path) => ({
      source: path,
      destination: path,
      writable: false,
      directory: false
    }))
  ]
  const byDestination = new Map<string, MountBinding>()
  for (const binding of bindings) {
    const prior = byDestination.get(binding.destination)
    if (prior !== undefined) {
      if (
        prior.source !== binding.source ||
        prior.writable !== binding.writable ||
        prior.directory !== binding.directory
      ) {
        throw new Error(`conflicting mount identity for ${binding.destination}`)
      }
      continue
    }
    byDestination.set(binding.destination, binding)
  }
  return [...byDestination.values()]
}

const openMountBindings = (
  bindings: ReadonlyArray<MountBinding>
): ReadonlyArray<OpenMountBinding> => {
  const opened: OpenMountBinding[] = []
  try {
    for (const [index, binding] of bindings.entries()) {
      const flags = O_PATH |
        O_CLOEXEC |
        constants.O_NOFOLLOW |
        (binding.directory ? constants.O_DIRECTORY : 0)
      const fd = openSync(binding.source, flags)
      const status = fstatSync(fd)
      if (binding.directory ? !status.isDirectory() : !status.isFile()) {
        closeSync(fd)
        throw new Error(`${binding.source} changed to an unsupported file type`)
      }
      opened.push({ ...binding, fd, childFd: 3 + index })
    }
    return opened
  } catch (cause) {
    for (const binding of opened) closeSync(binding.fd)
    throw cause
  }
}

const launcherArguments = (
  request: NativeCellLaunchRequest,
  executableObjects: ReadonlyArray<string>
) => [
  ...(request.process.stdin === "discard" || request.process.stdin === "inherit"
    ? []
    : ["--allow-memfd-stdin"]),
  ...executableObjects.flatMap((path) => ["--allow-exec", path]),
  ...Object.entries({
    ...request.process.env,
    TMPDIR: request.privateTempDirectory,
    TMP: request.privateTempDirectory,
    TEMP: request.privateTempDirectory
  }).flatMap(([key, value]) => ["--env", key, value]),
  "--",
  request.rootExecutable.launch,
  ...request.process.args
]

const launchContained = (
  platform: Context.Tag.Service<typeof LinuxPlatform>,
  runner: Context.Tag.Service<typeof ProcessRunner>,
  request: NativeCellLaunchRequest,
  options: ProcessRunOptions = {}
) => Effect.gen(function* () {
  if (request.network !== "deny") {
    return yield* new CellUnavailable({
      capability: "Linux contained networking",
      reason: "native-contained supports network: deny only; no endpoint broker is installed"
    })
  }
  const runtime = yield* platform.runtime.pipe(Effect.mapError(unavailable))
  const executableObjects = yield* Effect.try({
    try: () => runtimeExecutableObjects(request),
    catch: (cause) => new CellUnavailable({
      capability: "Linux executable-object binding",
      reason: cause instanceof Error ? cause.message : String(cause)
    })
  })
  const bindings = yield* Effect.try({
    try: () => mountBindings(request, runtime.launcher, executableObjects),
    catch: (cause) => new CellUnavailable({
      capability: "Linux mount binding",
      reason: cause instanceof Error ? cause.message : String(cause)
    })
  })

  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => openMountBindings(bindings),
      catch: (cause) => new CellUnavailable({
        capability: "Linux pinned mount binding",
        reason: cause instanceof Error ? cause.message : String(cause)
      })
    }),
    (opened) => {
      const mountArgs = opened.flatMap((binding) => [
        binding.writable ? "--bind-fd" : "--ro-bind-fd",
        String(binding.childFd),
        binding.destination
      ])
      return runner.run(
        new ProcessRequest({
          ...request.process,
          executable: runtime.bubblewrap,
          args: [
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
            "--clearenv",
            "--ro-bind", "/", "/",
            "--proc", "/proc",
            "--dev", "/dev",
            ...mountArgs,
            "--chdir", request.privateWorkspace,
            "--",
            runtime.launcher,
            ...launcherArguments(request, executableObjects)
          ],
          cwd: "/",
          // The target environment is data in launcher argv until both policy
          // layers are installed; Bubblewrap and the launcher start empty.
          env: {}
        }),
        {
          ...options,
          extraFileDescriptors: opened.map((binding) => binding.fd)
        }
      )
    },
    (opened) => Effect.sync(() => {
      for (const binding of opened) closeSync(binding.fd)
    })
  )
}).pipe(Effect.withSpan("LinuxCellBackend.launchContained"))

export const LinuxCellBackendLive = Layer.effect(
  NativeCellBackend,
  Effect.gen(function* () {
    const platform = yield* LinuxPlatform
    const runner = yield* ProcessRunner
    return NativeCellBackend.of({
      preparePrivateWorkspace: (request) =>
        platform.preparePrivateWorkspace(request).pipe(
          Effect.mapError((error) =>
            error instanceof LinuxUnavailable ? unavailable(error) : error
          )
        ),
      launchContained: (request, options) =>
        launchContained(platform, runner, request, options)
    })
  })
)
