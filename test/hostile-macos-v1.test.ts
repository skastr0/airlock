import { beforeAll, describe, expect, it } from "@effect/vitest"
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"

const repository = resolve(import.meta.dirname, "..")
const helperSource = join(
  repository,
  "test",
  "fixtures",
  "hostile-macos-helper.c"
)
const supported =
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync("/usr/bin/clang")

const FailureReport = Schema.Struct({
  action: Schema.String,
  phase: Schema.String,
  causeTag: Schema.optional(Schema.String),
  reason: Schema.String
})

const ProgramReport = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/program-run/v1"),
  profile: Schema.Literal("compatibility", "native-contained", "vm-enclosed"),
  workspace: Schema.String,
  result: Schema.Struct({
    state: Schema.Literal("succeeded", "failed", "partial"),
    result: Schema.Unknown,
    plans: Schema.Array(
      Schema.Struct({
        nodes: Schema.Array(Schema.Struct({ kind: Schema.String }))
      })
    ),
    failure: Schema.optional(FailureReport)
  })
})

const RuntimeValue = Schema.Struct({
  state: Schema.Literal("succeeded", "failed", "partial"),
  process_outcome: Schema.NullOr(
    Schema.Literal("exited", "timed-out", "output-limit", "cancelled")
  ),
  exit_code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  receipts: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      state: Schema.String,
      error_tag: Schema.NullOr(Schema.String)
    })
  )
})

const StageValue = Schema.Struct({
  state: Schema.Literal("staged"),
  action: Schema.Literal("http.stage"),
  emission_id: Schema.String,
  endpoint: Schema.String
})

type Fixture = Readonly<{
  root: string
  workspace: string
  home: string
  policy: string
  environment: Readonly<Record<string, string>>
}>

let helperExecutable = ""

const makeFixture = (
  executables: ReadonlyArray<string> = [],
  endpoints: ReadonlyArray<string> = [],
  workspaceOverride?: string
): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "airlock-hostile-macos-v1-"))
  const workspace = workspaceOverride ?? join(root, "workspace")
  const home = join(root, "home")
  const policy = join(root, "policy.json")
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true })
  const canonicalWorkspace = realpathSync(workspace)
  writeFileSync(
    policy,
    JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:hostile-macos-v1",
      realm: "local",
      admittedBy: "operator:hostile-macos-v1",
      pathAllowlist: [`${canonicalWorkspace}/**`],
      executableAllowlist: executables,
      endpointAllowlist: endpoints
    })
  )
  return {
    root,
    workspace: canonicalWorkspace,
    home,
    policy,
    environment: {
      AIRLOCK_AGENT_PROFILE: "native-contained",
      AIRLOCK_POLICY_FILE: policy
    }
  }
}

const environmentFor = (
  home: string,
  overrides: Readonly<Record<string, string>>
) => {
  const environment = { ...process.env }
  delete environment["AIRLOCK_POLICY_FILE"]
  environment["AIRLOCK_HOME"] = home
  return { ...environment, ...overrides }
}

const runAgent = (
  args: ReadonlyArray<string>,
  fixture: Fixture
) =>
  spawnSync("bun", ["src/agent-cli.ts", ...args], {
    cwd: repository,
    env: environmentFor(fixture.home, fixture.environment),
    encoding: "utf8",
    timeout: 45_000
  })

const runAgentAsync = (
  args: ReadonlyArray<string>,
  fixture: Fixture
) =>
  new Promise<{
    readonly status: number | null
    readonly signal: NodeJS.Signals | null
    readonly stdout: string
    readonly stderr: string
  }>((resolveRun, rejectRun) => {
    const child = spawn("bun", ["src/agent-cli.ts", ...args], {
      cwd: repository,
      env: environmentFor(fixture.home, fixture.environment),
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000)
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", rejectRun)
    child.once("close", (status, signal) => {
      clearTimeout(timeout)
      resolveRun({ status, signal, stdout, stderr })
    })
  })

const evalAgent = (
  fixture: Fixture,
  source: string,
  workspace = fixture.workspace
) =>
  runAgent(
    ["eval", "--workspace", workspace, "--source", source],
    fixture
  )

const decodeReport = (stdout: string) =>
  Schema.decodeUnknownSync(ProgramReport)(JSON.parse(stdout))

const decodeRuntime = (stdout: string) =>
  Schema.decodeUnknownSync(RuntimeValue)(decodeReport(stdout).result.result)

const processCanStillRun = (pid: number) => {
  const state = spawnSync("/bin/ps", ["-p", String(pid), "-o", "state="], {
    encoding: "utf8"
  })
  if (state.status !== 0) return false
  // A grandchild may remain momentarily as an adopted zombie. It has exited
  // and cannot retain Cell authority or mutate; launchd owns final reaping.
  return !state.stdout.trim().startsWith("Z")
}

const listen = (
  server: ReturnType<typeof createServer>,
  port: number
) =>
  new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(port, "127.0.0.1", () => resolveListen())
  })

const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolveClose) => server.close(() => resolveClose()))

describe.skipIf(!supported)("hostile macOS v1 — actual agent entrypoint", () => {
  beforeAll(() => {
    const build = mkdtempSync(join(tmpdir(), "airlock-hostile-helper-"))
    helperExecutable = join(build, "hostile-macos-helper")
    const compiled = spawnSync(
      "/usr/bin/clang",
      ["-std=c11", "-O2", helperSource, "-o", helperExecutable],
      { encoding: "utf8" }
    )
    expect(compiled.status, compiled.stderr).toBe(0)
  })

  it(
    "rejects profile downgrade and command-string forms without executing payloads",
    { timeout: 60_000 },
    () => {
      const fixture = makeFixture(["/usr/bin/touch"])
      const marker = join(fixture.root, "escaped.txt")

      const option = runAgent(
        [
          "eval",
          "--profile=compatibility",
          "--workspace",
          fixture.workspace,
          "--source",
          "return true"
        ],
        fixture
      )
      expect(option.status).toBe(64)
      expect(option.stderr).toContain("rejects --profile")

      const node = evalAgent(
        fixture,
        `return process.run({ executable: "/usr/bin/touch", args: [${JSON.stringify(marker)}], cwd: workspace, cellProfile: "compatibility", stdout: "capture", stderr: "capture" })`
      )
      expect(node.status, `${node.stderr}\n${node.stdout}`).toBe(1)
      expect(decodeReport(node.stdout).result.failure).toMatchObject({
        phase: "runtime",
        causeTag: "RuntimePlanInvalid"
      })

      const command = evalAgent(
        fixture,
        `return process.run({ command: ${JSON.stringify(`/usr/bin/touch ${marker}`)}, cwd: workspace })`
      )
      expect(command.status, command.stderr).toBe(1)
      expect(decodeReport(command.stdout).result.failure).toMatchObject({
        phase: "contract",
        causeTag: "ProgramActionDecodeFailed"
      })
      expect(existsSync(marker)).toBe(false)
    }
  )

  it(
    "canonicalizes a symlink workspace and refuses a symlink path inside it",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-hostile-alias-"))
      const physical = join(root, "physical")
      const alias = join(root, "alias")
      const outside = join(root, "outside.txt")
      mkdirSync(physical)
      symlinkSync(physical, alias)
      writeFileSync(outside, "outside")
      symlinkSync(outside, join(physical, "redirect.txt"))
      const fixture = makeFixture([], [], alias)

      const read = evalAgent(
        fixture,
        `return file.read({ path: ${JSON.stringify(join(fixture.workspace, "redirect.txt"))}, format: "text" })`,
        alias
      )
      expect(read.status).toBe(1)
      const report = decodeReport(read.stdout)
      expect(report.workspace).toBe(realpathSync(physical))
      expect(report.result.failure).toMatchObject({
        phase: "runtime",
        causeTag: "RuntimeNodeFailure"
      })
      expect(readFileSync(outside, "utf8")).toBe("outside")
    }
  )

  it(
    "lets an opaque executable write only in the private view, never an arbitrary host path",
    { timeout: 60_000 },
    () => {
      const fixture = makeFixture(["/usr/bin/touch"])
      const outside = join(fixture.root, "outside.txt")
      const inside = join(fixture.workspace, "inside.txt")
      const executed = evalAgent(
        fixture,
        `return process.run({ executable: "/usr/bin/touch", args: [${JSON.stringify(outside)}, "inside.txt"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })`
      )

      expect(executed.status, `${executed.stderr}\n${executed.stdout}`).toBe(0)
      expect(decodeRuntime(executed.stdout)).toMatchObject({
        state: "failed",
        process_outcome: "exited",
        receipts: [
          expect.objectContaining({ error_tag: "RuntimeProcessFailure" }),
          expect.objectContaining({
            state: "cancelled",
            error_tag: "RuntimeDependencyFailed"
          })
        ]
      })
      expect(existsSync(outside)).toBe(false)
      expect(existsSync(inside)).toBe(false)
    }
  )

  it(
    "denies loopback TCP and Unix-domain socket access in the native Cell",
    { timeout: 60_000 },
    async () => {
      const fixture = makeFixture([helperExecutable])
      const socketPath = join(fixture.root, "listener.sock")
      let tcpHits = 0
      let unixHits = 0
      const tcp = createServer((socket) => {
        tcpHits += 1
        socket.end()
      })
      const unix = createServer((socket) => {
        unixHits += 1
        socket.end()
      })
      await listen(tcp, 0)
      await new Promise<void>((resolveListen, rejectListen) => {
        unix.once("error", rejectListen)
        unix.listen(socketPath, () => resolveListen())
      })

      try {
        const address = tcp.address()
        if (address === null || typeof address === "string") {
          throw new Error("TCP listener did not expose a port")
        }
        const tcpRun = await runAgentAsync(
          [
            "eval",
            "--workspace",
            fixture.workspace,
            "--source",
            `return process.run({ executable: ${JSON.stringify(helperExecutable)}, args: ["tcp-connect", "127.0.0.1", ${JSON.stringify(String(address.port))}], cwd: workspace, cellProfile: "native-contained", timeoutMs: 2000, stdout: "capture", stderr: "capture" })`
          ],
          fixture
        )
        const unixRun = await runAgentAsync(
          [
            "eval",
            "--workspace",
            fixture.workspace,
            "--source",
            `return process.run({ executable: ${JSON.stringify(helperExecutable)}, args: ["unix-connect", ${JSON.stringify(socketPath)}], cwd: workspace, cellProfile: "native-contained", timeoutMs: 2000, stdout: "capture", stderr: "capture" })`
          ],
          fixture
        )

        expect(tcpRun.status, `${tcpRun.stderr}\n${tcpRun.stdout}`).toBe(0)
        expect(unixRun.status, `${unixRun.stderr}\n${unixRun.stdout}`).toBe(0)
        expect(decodeRuntime(tcpRun.stdout)).toMatchObject({
          state: "failed",
          process_outcome: "exited"
        })
        expect(decodeRuntime(unixRun.stdout)).toMatchObject({
          state: "failed",
          process_outcome: "exited"
        })
        expect(tcpHits).toBe(0)
        expect(unixHits).toBe(0)
      } finally {
        await close(tcp)
        await close(unix)
      }
    }
  )

  it(
    "rejects inherited descriptors before spawning native-contained work",
    { timeout: 60_000 },
    () => {
      const fixture = makeFixture(["/usr/bin/touch"])
      const marker = join(fixture.workspace, "inherit.txt")
      const executed = evalAgent(
        fixture,
        `return process.run({ executable: "/usr/bin/touch", args: ["inherit.txt"], cwd: workspace, cellProfile: "native-contained", stdin: "inherit", stdout: "inherit", stderr: "inherit" })`
      )

      expect(executed.status).toBe(1)
      expect(decodeReport(executed.stdout).result.failure).toMatchObject({
        phase: "runtime",
        causeTag: "RuntimePlanInvalid"
      })
      expect(existsSync(marker)).toBe(false)
    }
  )

  it(
    "bounds output floods and kills a timed-out same-group child",
    { timeout: 60_000 },
    () => {
      const floodFixture = makeFixture(["/usr/bin/yes"])
      const flood = evalAgent(
        floodFixture,
        'return process.run({ executable: "/usr/bin/yes", args: [], cwd: workspace, cellProfile: "native-contained", timeoutMs: 2000, outputLimitBytes: 4096, stdout: "capture", stderr: "capture" })'
      )
      expect(flood.status, `${flood.stderr}\n${flood.stdout}`).toBe(0)
      const flooded = decodeRuntime(flood.stdout)
      expect(flooded).toMatchObject({
        state: "failed",
        process_outcome: "output-limit",
        receipts: [
          expect.objectContaining({ error_tag: "RuntimeProcessFailure" }),
          expect.objectContaining({ state: "cancelled" })
        ]
      })
      expect(flooded.stdout?.length).toBeLessThanOrEqual(4096)

      const groupFixture = makeFixture([helperExecutable])
      const group = evalAgent(
        groupFixture,
        `return process.run({ executable: ${JSON.stringify(helperExecutable)}, args: ["wait-with-child"], cwd: workspace, cellProfile: "native-contained", timeoutMs: 100, outputLimitBytes: 1024, stdout: "capture", stderr: "capture" })`
      )
      expect(group.status, `${group.stderr}\n${group.stdout}`).toBe(0)
      const timedOut = decodeRuntime(group.stdout)
      expect(timedOut).toMatchObject({
        state: "failed",
        process_outcome: "timed-out"
      })
      const childPid = Number(timedOut.stdout?.trim())
      expect(Number.isSafeInteger(childPid)).toBe(true)
      expect(processCanStillRun(childPid)).toBe(false)
    }
  )

  it(
    "refuses FIFO input and stages external intent without touching the wire",
    { timeout: 60_000 },
    async () => {
      const fifoFixture = makeFixture([])
      const fifo = join(fifoFixture.workspace, "input.fifo")
      const made = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" })
      expect(made.status, made.stderr).toBe(0)
      const read = evalAgent(
        fifoFixture,
        `return file.read({ path: ${JSON.stringify(fifo)}, format: "bytes" })`
      )
      expect(read.status).toBe(1)
      expect(decodeReport(read.stdout).result.failure).toMatchObject({
        phase: "runtime",
        causeTag: "RuntimeNodeFailure"
      })

      let hits = 0
      const server = createServer((socket) => {
        hits += 1
        socket.end()
      })
      await listen(server, 0)
      try {
        const address = server.address()
        if (address === null || typeof address === "string") {
          throw new Error("listener did not expose a port")
        }
        const endpoint = `http://127.0.0.1:${address.port}/staged-only`
        const fixture = makeFixture([], [endpoint])
        const staged = evalAgent(
          fixture,
          `return http.stage({ endpoint: ${JSON.stringify(endpoint)}, method: "POST", body: "inert", holdMillis: 60000 })`
        )
        expect(staged.status, `${staged.stderr}\n${staged.stdout}`).toBe(0)
        expect(
          Schema.decodeUnknownSync(StageValue)(
            decodeReport(staged.stdout).result.result
          )
        ).toMatchObject({
          state: "staged",
          endpoint
        })
        expect(hits).toBe(0)

        const pending = runAgent(["pending"], fixture)
        expect(pending.status, pending.stderr).toBe(0)
        expect(JSON.parse(pending.stdout)).toEqual([
          expect.objectContaining({ status: "staged" })
        ])
        const commit = runAgent(["commit", "not-agent-authority"], fixture)
        expect(commit.status).not.toBe(0)
        expect(hits).toBe(0)
      } finally {
        await close(server)
      }
    }
  )

  it(
    "documents that a persisted Git hook executes in a later admitted Cell",
    { timeout: 90_000 },
    () => {
      const fixture = makeFixture(["/bin/chmod", "/usr/bin/git"])
      const git = (...args: ReadonlyArray<string>) =>
        spawnSync("/usr/bin/git", ["-C", fixture.workspace, ...args], {
          encoding: "utf8"
        })
      expect(git("init", "-q").status).toBe(0)
      writeFileSync(join(fixture.workspace, "tracked.txt"), "before\n")
      expect(git("add", "tracked.txt").status).toBe(0)
      expect(
        git(
          "-c",
          "user.name=Airlock Test",
          "-c",
          "user.email=airlock@example.invalid",
          "commit",
          "-qm",
          "initial"
        ).status
      ).toBe(0)

      const hook = join(fixture.workspace, ".git", "hooks", "pre-commit")
      const persisted = evalAgent(
        fixture,
        `return file.write({ path: ${JSON.stringify(hook)}, content: "#!/bin/sh\\nprintf 'executed\\\\n' > hook-fired.txt\\n" })`
      )
      expect(persisted.status, `${persisted.stderr}\n${persisted.stdout}`).toBe(
        0
      )
      const madeExecutable = evalAgent(
        fixture,
        'return process.run({ executable: "/bin/chmod", args: ["700", ".git/hooks/pre-commit"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })'
      )
      expect(
        madeExecutable.status,
        `${madeExecutable.stderr}\n${madeExecutable.stdout}`
      ).toBe(0)
      expect(decodeRuntime(madeExecutable.stdout).state).toBe("succeeded")

      writeFileSync(join(fixture.workspace, "tracked.txt"), "after\n")
      const committed = evalAgent(
        fixture,
        'return process.run({ executable: "/usr/bin/git", args: ["-c", "user.name=Airlock Test", "-c", "user.email=airlock@example.invalid", "commit", "-am", "second"], cwd: workspace, cellProfile: "native-contained", timeoutMs: 30000, stdout: "capture", stderr: "capture" })'
      )
      expect(
        committed.status,
        `${committed.stderr}\n${committed.stdout}`
      ).toBe(0)
      expect(decodeRuntime(committed.stdout).state).toBe("succeeded")
      expect(
        readFileSync(join(fixture.workspace, "hook-fired.txt"), "utf8")
      ).toBe("executed\n")
    }
  )
})
