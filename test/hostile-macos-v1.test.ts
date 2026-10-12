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
const helperSource = join(repository, "test", "fixtures", "hostile-macos-helper.c")
const supported =
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync("/usr/bin/clang")

const RunReport = Schema.Struct({
  runId: Schema.String,
  workspace: Schema.String,
  outcome: Schema.Struct({
    ok: Schema.Boolean,
    result: Schema.optionalKey(Schema.Unknown),
    reason: Schema.optionalKey(Schema.String),
    toolCalls: Schema.Number
  })
})

const ProcessResult = Schema.Struct({
  outcome: Schema.Literals(["exited", "timed-out", "output-limit", "cancelled"]),
  exit_code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  merged: Schema.NullOr(Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String })))
})

type Fixture = Readonly<{
  root: string
  workspace: string
  home: string
  policy: string
}>

let helperExecutable = ""
let developerGitExecutable = "/usr/bin/git"

/** Reads and changes in the workspace at once; processes at once, but only inside the native Cell. */
const writePolicy = (
  file: string,
  workspace: string,
  executables: ReadonlyArray<string>,
  edges: ReadonlyArray<{ readonly root: string; readonly descendants: ReadonlyArray<string> }> = [],
  endpoints: ReadonlyArray<string> = []
) =>
  writeFileSync(file, JSON.stringify({
    schemaVersion: "airlock/tool-policy/v1",
    toolGrants: [
      { id: "read", tool: "file.read", when: "now" },
      { id: "write", tool: "file.write", when: "now" },
      ...(executables.length === 0 ? [] : [
        { id: "run", tool: "process.run", when: "now", host: { profile: "native-contained" } }
      ]),
      ...(endpoints.length === 0 ? [] : [{ id: "stage", tool: "http.stage" }])
    ],
    resources: {
      path: [workspace],
      ...(executables.length === 0 ? {} : { executable: { roots: executables, edges } }),
      ...(endpoints.length === 0 ? {} : { endpoint: endpoints })
    },
    budget: { maxCalls: 32, maxInputBytes: 1_000_000 }
  }))

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
  writePolicy(policy, canonicalWorkspace, executables, [], endpoints)
  return { root, workspace: canonicalWorkspace, home, policy }
}

const environmentFor = (fixture: Fixture) => {
  const environment = { ...process.env }
  delete environment["AIRLOCK_SEAL"]
  return { ...environment, AIRLOCK_HOME: fixture.home, AIRLOCK_POLICY_FILE: fixture.policy }
}

const runAgent = (args: ReadonlyArray<string>, fixture: Fixture) =>
  spawnSync("bun", ["src/agent-cli.ts", ...args], {
    cwd: repository,
    env: environmentFor(fixture),
    encoding: "utf8",
    timeout: 45_000
  })

const runAgentAsync = (args: ReadonlyArray<string>, fixture: Fixture) =>
  new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn("bun", ["src/agent-cli.ts", ...args], {
      cwd: repository,
      env: environmentFor(fixture),
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
    child.once("close", (status) => {
      clearTimeout(timeout)
      resolveRun({ status, stdout, stderr })
    })
  })

const evalAgent = (fixture: Fixture, source: string, workspace = fixture.workspace) =>
  runAgent(["eval", "--workspace", workspace, "--source", source], fixture)

const report = (stdout: string) => Schema.decodeUnknownSync(RunReport)(JSON.parse(stdout))

/** The run ended without a result, for this reason, and called nothing. */
const refusedBeforeRunning = (stdout: string, reason: string) =>
  expect(report(stdout).outcome).toMatchObject({ ok: false, reason, toolCalls: 0 })

/** The program returned the process's result, which it reads only once the call is done. */
const ranProcess = (stdout: string) => {
  const { outcome } = report(stdout)
  if (!outcome.ok) throw new Error(`the run failed: ${stdout}`)
  return Schema.decodeUnknownSync(ProcessResult)(outcome.result)
}

/** A program that runs one process and returns what it did. */
const processProgram = (input: string) =>
  `let ran = process.run(${input})\nassert ran.state == "done", "the process did not run"\nreturn ran.result`

const processCanStillRun = (pid: number) => {
  const state = spawnSync("/bin/ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" })
  if (state.status !== 0) return false
  // A grandchild may remain momentarily as an adopted zombie. It has exited
  // and cannot retain Cell authority or mutate; launchd owns final reaping.
  return !state.stdout.trim().startsWith("Z")
}

const listen = (server: ReturnType<typeof createServer>, port: number) =>
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
    const compiled = spawnSync("/usr/bin/clang", ["-std=c11", "-O2", helperSource, "-o", helperExecutable], { encoding: "utf8" })
    expect(compiled.status, compiled.stderr).toBe(0)
    const locatedGit = spawnSync("/usr/bin/xcrun", ["-f", "git"], { encoding: "utf8" })
    expect(locatedGit.status, locatedGit.stderr).toBe(0)
    developerGitExecutable = realpathSync(locatedGit.stdout.trim())
  })

  it("rejects a profile option, a profile field and a command string without executing payloads", { timeout: 60_000 }, () => {
    const fixture = makeFixture(["/usr/bin/touch"])
    const marker = join(fixture.root, "escaped.txt")

    const option = runAgent(["eval", "--profile=compatibility", "--workspace", fixture.workspace, "--source", "return true"], fixture)
    expect(option.status).not.toBe(0)
    expect(option.stdout).toBe("")

    // How a process is confined is the grant's, never the call's.
    const field = evalAgent(fixture, processProgram(
      `{ executable: "/usr/bin/touch", args: [${JSON.stringify(marker)}], cwd: ".", cellProfile: "compatibility" }`
    ))
    expect(field.status).toBe(1)
    refusedBeforeRunning(field.stdout, "invalid_code")

    const command = evalAgent(fixture, processProgram(`{ command: ${JSON.stringify(`/usr/bin/touch ${marker}`)}, cwd: "." }`))
    expect(command.status).toBe(1)
    refusedBeforeRunning(command.stdout, "invalid_code")
    expect(existsSync(marker)).toBe(false)
  })

  it("canonicalizes a symlink workspace and refuses a symlink path inside it", { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-hostile-alias-"))
    const physical = join(root, "physical")
    const alias = join(root, "alias")
    const outside = join(root, "outside.txt")
    mkdirSync(physical)
    symlinkSync(physical, alias)
    writeFileSync(outside, "outside")
    symlinkSync(outside, join(physical, "redirect.txt"))
    const fixture = makeFixture([], [], alias)

    const read = evalAgent(fixture, `return file.read({ path: ${JSON.stringify(join(fixture.workspace, "redirect.txt"))}, format: "text" })`, alias)
    expect(read.status, read.stderr).toBe(0)
    const { workspace, outcome } = report(read.stdout)
    expect(workspace).toBe(realpathSync(physical))
    expect(outcome).toMatchObject({ ok: true, result: { state: "refused", refusal: { code: "not-allowed" } } })
    expect(readFileSync(outside, "utf8")).toBe("outside")
  })

  it("lets an opaque executable write only in the private view, never an arbitrary host path", { timeout: 60_000 }, () => {
    const fixture = makeFixture(["/usr/bin/touch"])
    const outside = join(fixture.root, "outside.txt")
    const inside = join(fixture.workspace, "inside.txt")
    const executed = evalAgent(fixture, processProgram(
      `{ executable: "/usr/bin/touch", args: [${JSON.stringify(outside)}, "inside.txt"], cwd: "." }`
    ))

    expect(executed.status, `${executed.stderr}\n${executed.stdout}`).toBe(0)
    const result = ranProcess(executed.stdout)
    expect(result.outcome).toBe("exited")
    expect(result.exit_code).not.toBe(0)
    // A process that did not exit cleanly has its changes discarded.
    expect(result.merged).toEqual([])
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(inside)).toBe(false)
  })

  it("denies loopback TCP and Unix-domain socket access in the native Cell", { timeout: 60_000 }, async () => {
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
      if (address === null || typeof address === "string") throw new Error("TCP listener did not expose a port")
      const tcpRun = await runAgentAsync(["eval", "--workspace", fixture.workspace, "--source", processProgram(
        `{ executable: ${JSON.stringify(helperExecutable)}, args: ["tcp-connect", "127.0.0.1", ${JSON.stringify(String(address.port))}], cwd: ".", timeoutMs: 2000 }`
      )], fixture)
      const unixRun = await runAgentAsync(["eval", "--workspace", fixture.workspace, "--source", processProgram(
        `{ executable: ${JSON.stringify(helperExecutable)}, args: ["unix-connect", ${JSON.stringify(socketPath)}], cwd: ".", timeoutMs: 2000 }`
      )], fixture)

      expect(tcpRun.status, `${tcpRun.stderr}\n${tcpRun.stdout}`).toBe(0)
      expect(unixRun.status, `${unixRun.stderr}\n${unixRun.stdout}`).toBe(0)
      for (const run of [tcpRun, unixRun]) {
        const result = ranProcess(run.stdout)
        expect(result.outcome).toBe("exited")
        expect(result.exit_code).not.toBe(0)
      }
      expect(tcpHits).toBe(0)
      expect(unixHits).toBe(0)
    } finally {
      await close(tcp)
      await close(unix)
    }
  })

  it("has no way to hand a process the supervisor's descriptors", { timeout: 60_000 }, () => {
    const fixture = makeFixture(["/usr/bin/touch"])
    const marker = join(fixture.workspace, "inherit.txt")
    const executed = evalAgent(fixture, processProgram(
      `{ executable: "/usr/bin/touch", args: ["inherit.txt"], cwd: ".", stdout: "inherit", stderr: "inherit" }`
    ))

    expect(executed.status).toBe(1)
    refusedBeforeRunning(executed.stdout, "invalid_code")
    expect(existsSync(marker)).toBe(false)
  })

  it("bounds output floods and kills a timed-out same-group child", { timeout: 60_000 }, () => {
    const floodFixture = makeFixture(["/usr/bin/yes"])
    const flood = evalAgent(floodFixture, processProgram(
      `{ executable: "/usr/bin/yes", args: [], cwd: ".", timeoutMs: 2000, outputLimitBytes: 4096 }`
    ))
    expect(flood.status, `${flood.stderr}\n${flood.stdout}`).toBe(0)
    const flooded = ranProcess(flood.stdout)
    expect(flooded.outcome).toBe("output-limit")
    expect(flooded.stdout?.length ?? 0).toBeLessThanOrEqual(4096)

    const groupFixture = makeFixture([helperExecutable])
    const group = evalAgent(groupFixture, processProgram(
      `{ executable: ${JSON.stringify(helperExecutable)}, args: ["wait-with-child"], cwd: ".", timeoutMs: 100, outputLimitBytes: 1024 }`
    ))
    expect(group.status, `${group.stderr}\n${group.stdout}`).toBe(0)
    const timedOut = ranProcess(group.stdout)
    expect(timedOut.outcome).toBe("timed-out")
    const childPid = Number(timedOut.stdout?.trim())
    expect(Number.isSafeInteger(childPid)).toBe(true)
    expect(processCanStillRun(childPid)).toBe(false)
  })

  it("refuses FIFO input and stages external intent without touching the wire", { timeout: 60_000 }, async () => {
    const fifoFixture = makeFixture([])
    const fifo = join(fifoFixture.workspace, "input.fifo")
    const made = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" })
    expect(made.status, made.stderr).toBe(0)
    const read = evalAgent(fifoFixture, `return file.read({ path: ${JSON.stringify(fifo)}, format: "bytes" })`)
    expect(read.status, read.stderr).toBe(0)
    expect(report(read.stdout).outcome).toMatchObject({ ok: true, result: { state: "refused", refusal: { code: "not-allowed" } } })

    let hits = 0
    const server = createServer((socket) => {
      hits += 1
      socket.end()
    })
    await listen(server, 0)
    try {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("listener did not expose a port")
      const endpoint = `http://127.0.0.1:${address.port}/staged-only`
      const fixture = makeFixture([], [endpoint])
      const staged = evalAgent(fixture, `return http.stage({ endpoint: ${JSON.stringify(endpoint)}, method: "POST", body: "inert", holdMillis: 60000 })`)
      expect(staged.status, `${staged.stderr}\n${staged.stdout}`).toBe(0)
      expect(report(staged.stdout).outcome).toMatchObject({ ok: true, result: { state: "staged", id: expect.any(String) } })
      expect(hits).toBe(0)

      const pending = runAgent(["pending", "--workspace", fixture.workspace], fixture)
      expect(pending.status, pending.stderr).toBe(0)
      const waiting = JSON.parse(pending.stdout) as ReadonlyArray<{ readonly id: string; readonly state: string }>
      expect(waiting).toEqual([expect.objectContaining({ state: "staged" })])
      // The agent's binary has no command that decides.
      const commit = runAgent(["commit", waiting[0]!.id], fixture)
      expect(commit.status).not.toBe(0)
      expect(commit.stdout).toBe("")
      expect(hits).toBe(0)
    } finally {
      await close(server)
    }
  })

  it("blocks a persisted Git hook from laundering /bin/sh authority into a later Cell", { timeout: 90_000 }, () => {
    const fixture = makeFixture(["/bin/chmod", developerGitExecutable])
    const git = (...args: ReadonlyArray<string>) =>
      spawnSync("/usr/bin/git", ["-C", fixture.workspace, ...args], { encoding: "utf8" })
    expect(git("init", "-q").status).toBe(0)
    writeFileSync(join(fixture.workspace, "tracked.txt"), "before\n")
    expect(git("add", "tracked.txt").status).toBe(0)
    expect(git("-c", "user.name=Airlock Test", "-c", "user.email=airlock@example.invalid", "commit", "-qm", "initial").status).toBe(0)

    const baseline = evalAgent(fixture, processProgram(
      `{ executable: ${JSON.stringify(developerGitExecutable)}, args: ["status", "--short"], cwd: "." }`
    ))
    expect(baseline.status, `${baseline.stderr}\n${baseline.stdout}`).toBe(0)
    expect(ranProcess(baseline.stdout)).toMatchObject({ outcome: "exited", exit_code: 0 })

    const hook = join(fixture.workspace, ".git", "hooks", "pre-commit")
    const persisted = evalAgent(fixture,
      `let w = file.write({ path: ${JSON.stringify(hook)}, content: "#!/bin/sh\\nprintf 'executed\\\\n' > hook-fired.txt\\n" })\nreturn w.state`)
    expect(persisted.status, `${persisted.stderr}\n${persisted.stdout}`).toBe(0)
    expect(report(persisted.stdout).outcome).toMatchObject({ ok: true, result: "done" })
    const madeExecutable = evalAgent(fixture, processProgram(
      `{ executable: "/bin/chmod", args: ["700", ".git/hooks/pre-commit"], cwd: "." }`
    ))
    expect(madeExecutable.status, `${madeExecutable.stderr}\n${madeExecutable.stdout}`).toBe(0)
    expect(ranProcess(madeExecutable.stdout)).toMatchObject({ outcome: "exited", exit_code: 0 })

    writeFileSync(join(fixture.workspace, "tracked.txt"), "after\n")
    const committed = evalAgent(fixture, processProgram(
      `{ executable: ${JSON.stringify(developerGitExecutable)}, args: ["-c", "user.name=Airlock Test", "-c", "user.email=airlock@example.invalid", "commit", "-am", "second"], cwd: ".", timeoutMs: 30000 }`
    ))
    expect(committed.status, `${committed.stderr}\n${committed.stdout}`).toBe(0)
    expect(ranProcess(committed.stdout)).toMatchObject({ outcome: "exited", exit_code: 0 })
    expect(existsSync(join(fixture.workspace, "hook-fired.txt"))).toBe(false)

    writePolicy(fixture.policy, fixture.workspace, ["/bin/chmod", developerGitExecutable], [
      { root: developerGitExecutable, descendants: [hook, "/bin/sh", "/bin/bash"] }
    ])
    // A descendant the policy allows under git is not a root of its own.
    const rootEscalation = evalAgent(fixture,
      `let ran = process.run({ executable: "/bin/sh", args: ["-c", "true"], cwd: "." })\nreturn ran`)
    expect(rootEscalation.status, rootEscalation.stderr).toBe(0)
    expect(report(rootEscalation.stdout).outcome).toMatchObject({ ok: true, result: { state: "refused", refusal: { code: "not-allowed" } } })

    writeFileSync(join(fixture.workspace, "tracked.txt"), "third\n")
    const explicitlyAllowed = evalAgent(fixture, processProgram(
      `{ executable: ${JSON.stringify(developerGitExecutable)}, args: ["-c", "user.name=Airlock Test", "-c", "user.email=airlock@example.invalid", "commit", "-am", "third"], descendantExecutables: [${JSON.stringify(hook)}, "/bin/sh", "/bin/bash"], cwd: ".", timeoutMs: 30000 }`
    ))
    expect(explicitlyAllowed.status, `${explicitlyAllowed.stderr}\n${explicitlyAllowed.stdout}`).toBe(0)
    expect(ranProcess(explicitlyAllowed.stdout)).toMatchObject({ outcome: "exited", exit_code: 0 })
    expect(readFileSync(join(fixture.workspace, "hook-fired.txt"), "utf8")).toBe("executed\n")
  })
})
