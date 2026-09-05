import { beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  Cell,
  CellLive,
  CellRequest,
  CellUnavailable
} from "../src/cell/index.ts"
import {
  elfInterpreter,
  LinuxPlatform,
  LinuxPlatformLive,
  LinuxPlatformLiveWith
} from "../src/platform/linux/index.ts"
import {
  PrivateWorkspaceRequest,
  WorkspaceDestinationExists
} from "../src/platform/NativeWorkspace.ts"
import {
  ProcessInputBytes,
  ProcessRequest,
  ProcessRunnerLive,
  ProcessTimedOut
} from "../src/process/Process.ts"

const repository = resolve(import.meta.dirname, "..")
const launcher = process.env["AIRLOCK_LINUX_LAUNCHER"]
const bubblewrap = existsSync("/usr/local/bin/bwrap")
  ? "/usr/local/bin/bwrap"
  : "/usr/bin/bwrap"
const supported =
  process.platform === "linux" &&
  launcher !== undefined &&
  existsSync(launcher) &&
  existsSync(bubblewrap) &&
  typeof Bun !== "undefined"

const LinuxCellTestLive = CellLive.pipe(
  Layer.provide(Layer.merge(ProcessRunnerLive, LinuxPlatformLive))
)
const decoder = new TextDecoder()
let hostileHelper = ""
let preloadLibrary = ""

const compile = (
  output: string,
  extra: ReadonlyArray<string> = []
) => {
  const result = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Wconversion",
      "-Wformat=2",
      ...extra,
      join(repository, "test", "fixtures", "hostile-linux-helper.c"),
      "-o",
      output
    ],
    { cwd: repository, encoding: "utf8" }
  )
  expect(result.status, result.stderr).toBe(0)
}

const fixture = (prefix = "airlock-linux-cell-") => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const source = join(root, "source")
  const privateWorkspace = join(root, "private")
  mkdirSync(source)
  return { root, source, privateWorkspace }
}

const processRequest = (
  source: string,
  executable: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
  timeoutMs = 5_000
) => new ProcessRequest({
  executable,
  args: [...args],
  cwd: source,
  env: { ...env },
  stdout: "capture",
  stderr: "capture",
  outputLimitBytes: 64 * 1024,
  timeoutMs
})

const runHostile = (
  source: string,
  privateWorkspace: string,
  args: ReadonlyArray<string>,
  options: Readonly<{
    env?: Readonly<Record<string, string>>
    descendants?: ReadonlyArray<string>
    timeoutMs?: number
  }> = {}
) => Effect.flatMap(Cell, (cell) =>
  cell.run(new CellRequest({
    sourceWorkspace: source,
    privateWorkspace,
    descendantExecutables: [...(options.descendants ?? [])],
    process: processRequest(
      source,
      hostileHelper,
      args,
      options.env,
      options.timeoutMs
    )
  }))
)

describe.skipIf(!supported)("Linux native-contained Cell", () => {
  beforeAll(() => {
    const build = mkdtempSync(join(tmpdir(), "airlock-hostile-linux-"))
    hostileHelper = join(build, "hostile-linux-helper")
    preloadLibrary = join(build, "airlock-preload.so")
    compile(hostileHelper, ["-fPIE", "-pie"])
    compile(preloadLibrary, ["-fPIC", "-shared", "-DAIRLOCK_PRELOAD_LIBRARY"])
  })

  it.effect("reports the audited runtime and prepares a fresh clone or copy", () =>
    Effect.gen(function* () {
      const platform = yield* LinuxPlatform
      const runtime = yield* platform.runtime
      const report = yield* platform.capabilityReport
      const [bwrapMajor, bwrapMinor] = runtime.bubblewrapVersion
        .split(".")
        .map(Number)
      expect(
        bwrapMajor! > 0 || bwrapMinor! >= 12,
        `Bubblewrap ${runtime.bubblewrapVersion} is below 0.12.0`
      ).toBe(true)
      expect(runtime.launcher).toBe(realpathSync(launcher!))
      expect(runtime.landlockAbi).toBeGreaterThanOrEqual(2)
      expect(report.nativeContainment.namespaces.posture).toBe("enforced")
      expect(report.nativeContainment.executableObjectFence.caveats).toEqual(
        expect.arrayContaining([expect.stringContaining("ELF loaders")])
      )
      expect(report.nativeContainment.confidentiality.posture).toBe("not-provided")

      const { root, source } = fixture("airlock-linux-workspace-")
      writeFileSync(join(source, "input.txt"), "original")
      const destination = join(root, "copy")
      const prepared = yield* platform.preparePrivateWorkspace(
        new PrivateWorkspaceRequest({ source, destination })
      )
      expect(["reflink", "copy"]).toContain(prepared.strategy)
      expect(readFileSync(join(destination, "input.txt"), "utf8")).toBe("original")
      const collision = yield* platform.preparePrivateWorkspace(
        new PrivateWorkspaceRequest({ source, destination })
      ).pipe(Effect.flip)
      expect(collision).toBeInstanceOf(WorkspaceDestinationExists)
    }).pipe(Effect.provide(LinuxPlatformLive))
  )

  it.effect("fails closed for old bubblewrap and a missing launcher", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "airlock-linux-runtime-refusal-"))
      const oldBubblewrap = join(root, "bwrap")
      writeFileSync(oldBubblewrap, "#!/bin/sh\necho 'bubblewrap 0.8.0'\n")
      chmodSync(oldBubblewrap, 0o755)

      const oldPlatform = yield* LinuxPlatform.pipe(
        Effect.provide(
          LinuxPlatformLiveWith({
            bubblewrapCandidates: [oldBubblewrap],
            launcherCandidates: [launcher!]
          })
        )
      )
      const old = yield* oldPlatform.runtime.pipe(Effect.flip)
      expect(old.capability).toBe("bubblewrap >= 0.12.0")
      expect(old.reason).toContain("below Airlock's audited setup-race baseline")
      const oldReport = yield* oldPlatform.capabilityReport
      expect(oldReport.nativeContainment.namespaces.posture).toBe("unavailable")

      const missingPlatform = yield* LinuxPlatform.pipe(
        Effect.provide(
          LinuxPlatformLiveWith({
            bubblewrapCandidates: [bubblewrap],
            launcherCandidates: [join(root, "missing-launcher")]
          })
        )
      )
      const missing = yield* missingPlatform.runtime.pipe(Effect.flip)
      expect(missing.capability).toBe("Airlock Linux launcher")
    })
  )

  it.effect("allows private openat2 writes while denying source and outside O_TRUNC", () =>
    Effect.gen(function* () {
      const first = fixture()
      const privateMarker = join(first.privateWorkspace, "openat2.txt")
      const privateWrite = yield* runHostile(
        first.source,
        first.privateWorkspace,
        ["openat2", privateMarker]
      )
      expect(privateWrite.processReceipt.exitCode).toBe(0)
      expect(readFileSync(privateMarker, "utf8")).toBe("openat2 allowed\n")
      expect(privateWrite.delta).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "openat2.txt", kind: "created" })
        ])
      )

      const second = fixture()
      const sourceFile = join(second.source, "live.txt")
      writeFileSync(sourceFile, "live bytes")
      const sourceAttempt = yield* runHostile(
        second.source,
        second.privateWorkspace,
        ["truncate-denied", sourceFile]
      )
      expect(sourceAttempt.processReceipt.exitCode).toBe(0)
      expect(readFileSync(sourceFile, "utf8")).toBe("live bytes")

      const third = fixture()
      const outside = join(third.root, "outside.txt")
      writeFileSync(outside, "outside bytes")
      const outsideAttempt = yield* runHostile(
        third.source,
        third.privateWorkspace,
        ["truncate-denied", outside]
      )
      expect(outsideAttempt.processReceipt.exitCode).toBe(0)
      expect(readFileSync(outside, "utf8")).toBe("outside bytes")
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("denies TCP, Unix sockets, socketpairs, memfd, and namespace creation", () =>
    Effect.gen(function* () {
      const probes = [
        ["socket", "inet"],
        ["socket", "unix"],
        ["socketpair"],
        ["memfd"],
        ["clone3"],
        ["unshare"]
      ] as const
      for (const [index, args] of probes.entries()) {
        const current = fixture(`airlock-linux-syscall-${index}-`)
        const receipt = yield* runHostile(
          current.source,
          current.privateWorkspace,
          args
        )
        expect(
          receipt.processReceipt.exitCode,
          `${args.join(" ")}: ${decoder.decode(receipt.processReceipt.stderr)}`
        ).toBe(0)
      }
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("accepts runtime-owned byte stdin but rejects inherited regular files", () =>
    Effect.gen(function* () {
      const current = fixture("airlock-linux-stdin-")
      const input = new Uint8Array([0, 255, 17, 128, 64, 10])
      const cell = yield* Cell
      const receipt = yield* cell.run(new CellRequest({
        sourceWorkspace: current.source,
        privateWorkspace: current.privateWorkspace,
        process: new ProcessRequest({
          ...processRequest(current.source, "/bin/cat", []),
          stdin: new ProcessInputBytes({ _tag: "bytes", bytes: input })
        })
      }))
      expect(receipt.processReceipt.exitCode).toBe(0)
      expect(receipt.processReceipt.stdout).toEqual(input)

      const ambient = join(current.root, "ambient-stdin")
      writeFileSync(ambient, "ambient authority")
      const descriptor = openSync(ambient, "r")
      try {
        for (const args of [
          ["--allow-exec", realpathSync("/bin/cat"), "--", "/bin/cat"],
          [
            "--allow-memfd-stdin",
            "--allow-exec", realpathSync("/bin/cat"),
            "--", "/bin/cat"
          ]
        ]) {
          const rejected = spawnSync(launcher!, args, {
            env: {},
            encoding: "utf8",
            stdio: [descriptor, "pipe", "pipe"]
          })
          expect(rejected.status).toBe(125)
          expect(rejected.stderr).toContain("contained stdio fd 0 has unsafe type")
        }
      } finally {
        closeSync(descriptor)
      }
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("denies an undeclared direct exec and permits a declared descendant", () =>
    Effect.gen(function* () {
      const deniedFixture = fixture()
      const deniedMarker = join(deniedFixture.privateWorkspace, "denied")
      const denied = yield* runHostile(
        deniedFixture.source,
        deniedFixture.privateWorkspace,
        ["direct-exec-denied", "/usr/bin/touch", deniedMarker]
      )
      expect(denied.processReceipt.exitCode).toBe(0)
      expect(existsSync(deniedMarker)).toBe(false)

      const allowedFixture = fixture()
      const allowedMarker = join(allowedFixture.privateWorkspace, "allowed")
      const allowed = yield* runHostile(
        allowedFixture.source,
        allowedFixture.privateWorkspace,
        ["direct-exec-denied", "/usr/bin/touch", allowedMarker],
        { descendants: ["/usr/bin/touch"] }
      )
      expect(allowed.processReceipt.exitCode).toBe(0)
      expect(existsSync(allowedMarker)).toBe(true)
      expect(allowed.executableBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requested: "/usr/bin/touch",
            role: "descendant"
          })
        ])
      )
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("requires an admitted shebang interpreter object", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "airlock-linux-shebang-"))
      const source = join(root, "source")
      mkdirSync(source)
      const script = join(source, "agent-script")
      writeFileSync(
        script,
        '#!/bin/sh\nprintf "shebang ran\\n" > "$AIRLOCK_PRIVATE/shebang.txt"\n'
      )
      chmodSync(script, 0o700)

      const cell = yield* Cell
      const deniedPrivate = join(root, "denied-private")
      const denied = yield* cell.run(new CellRequest({
        sourceWorkspace: source,
        privateWorkspace: deniedPrivate,
        process: processRequest(source, script, [], {
          AIRLOCK_PRIVATE: deniedPrivate
        })
      }))
      expect(denied.processReceipt.exitCode).not.toBe(0)
      expect(existsSync(join(deniedPrivate, "shebang.txt"))).toBe(false)

      const allowedPrivate = join(root, "allowed-private")
      const allowed = yield* cell.run(new CellRequest({
        sourceWorkspace: source,
        privateWorkspace: allowedPrivate,
        descendantExecutables: ["/bin/sh"],
        process: processRequest(source, script, [], {
          AIRLOCK_PRIVATE: allowedPrivate
        })
      }))
      expect(allowed.processReceipt.exitCode).toBe(0)
      expect(readFileSync(join(allowedPrivate, "shebang.txt"), "utf8")).toBe(
        "shebang ran\n"
      )
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("keeps target loader variables inert until both policy layers are installed", () =>
    Effect.gen(function* () {
      const current = fixture("airlock-linux-preload-")
      const outsideMarker = join(current.root, "outside-preload.txt")
      const privateMarker = join(current.privateWorkspace, "private-preload.txt")
      const receipt = yield* runHostile(
        current.source,
        current.privateWorkspace,
        ["preload-target"],
        {
          env: {
            LD_PRELOAD: preloadLibrary,
            AIRLOCK_PRELOAD_OUTSIDE: outsideMarker,
            AIRLOCK_PRELOAD_PRIVATE: privateMarker
          }
        }
      )
      expect(receipt.processReceipt.exitCode).toBe(0)
      expect(existsSync(outsideMarker)).toBe(false)
      expect(readFileSync(privateMarker, "utf8")).toBe("preload contained\n")
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("closes every backend descriptor before target execution", () =>
    Effect.gen(function* () {
      const current = fixture("airlock-linux-fds-")
      const receipt = yield* runHostile(
        current.source,
        current.privateWorkspace,
        ["fd-check"]
      )
      expect(
        receipt.processReceipt.exitCode,
        decoder.decode(receipt.processReceipt.stderr)
      ).toBe(0)
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("tears down a double-forked session when the owned Cell times out", () =>
    Effect.gen(function* () {
      const current = fixture("airlock-linux-daemon-")
      const marker = join(current.privateWorkspace, "daemon-survived.txt")
      const error = yield* runHostile(
        current.source,
        current.privateWorkspace,
        ["daemonize-marker", marker],
        { timeoutMs: 100 }
      ).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ProcessTimedOut)
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 1_800))
      )
      expect(existsSync(marker)).toBe(false)
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("refuses network allow rather than silently weakening containment", () =>
    Effect.gen(function* () {
      const current = fixture("airlock-linux-network-ratchet-")
      const cell = yield* Cell
      const error = yield* cell.run(new CellRequest({
        sourceWorkspace: current.source,
        privateWorkspace: current.privateWorkspace,
        network: "allow",
        process: processRequest(current.source, hostileHelper, ["fd-check"])
      })).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CellUnavailable)
      if (!(error instanceof CellUnavailable)) return
      expect(error.reason).toContain("network: deny only")
    }).pipe(Effect.provide(LinuxCellTestLive))
  )

  it.effect("documents the admitted ELF loader's in-process interpretation caveat", () =>
    Effect.gen(function* () {
      const loader = elfInterpreter(hostileHelper)
      expect(loader).toBeDefined()
      const current = fixture("airlock-linux-loader-caveat-")
      const marker = join(current.privateWorkspace, "loader-ran-unlisted-elf")
      const receipt = yield* runHostile(
        current.source,
        current.privateWorkspace,
        ["loader-invocation", loader!, "/usr/bin/touch", marker]
      )
      expect(receipt.processReceipt.exitCode).toBe(0)
      expect(existsSync(marker)).toBe(true)
      expect(
        receipt.executableBindings.some(
          ({ requested }) => requested === "/usr/bin/touch"
        )
      ).toBe(false)
    }).pipe(Effect.provide(LinuxCellTestLive))
  )
})

describe.skipIf(process.platform !== "linux")("Linux ELF interpreter parser", () => {
  it("returns the physical PT_INTERP object and rejects malformed ELF input", () => {
    if (!existsSync("/bin/true")) return
    const interpreter = elfInterpreter("/bin/true")
    expect(interpreter).toBeDefined()
    expect(interpreter).toBe(realpathSync(interpreter!))

    const root = mkdtempSync(join(tmpdir(), "airlock-linux-elf-"))
    const text = join(root, "text")
    writeFileSync(text, "#!")
    expect(elfInterpreter(text)).toBeUndefined()

    const malformed = join(root, "malformed")
    const header = Buffer.alloc(64)
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    header.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER), 32)
    header.writeUInt16LE(56, 54)
    header.writeUInt16LE(1, 56)
    writeFileSync(malformed, header)
    expect(() => elfInterpreter(malformed)).toThrow("unexpected end of ELF file")

    const alias = join(root, "alias")
    symlinkSync("/bin/true", alias)
    expect(() => elfInterpreter(alias)).toThrow()
  })
})
