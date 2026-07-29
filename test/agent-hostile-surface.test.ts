import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const terminalCommands = [
  "exec",
  "rm",
  "write",
  "undo",
  "reap",
  "send",
  "commit",
  "cancel",
  "flush"
]

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

const RuntimeResult = Schema.Struct({
  state: Schema.String,
  receipts: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      state: Schema.String,
      error_tag: Schema.NullOr(Schema.String)
    })
  )
})

const environmentFor = (
  home: string,
  overrides: Readonly<Record<string, string>> = {}
) => {
  const environment = { ...process.env }
  delete environment["AIRLOCK_POLICY_FILE"]
  environment["AIRLOCK_HOME"] = home
  environment["AIRLOCK_AGENT_PROFILE"] = "compatibility"
  return { ...environment, ...overrides }
}

const runAgent = (
  args: ReadonlyArray<string>,
  home: string,
  overrides: Readonly<Record<string, string>> = {}
) =>
  spawnSync("bun", ["src/agent-cli.ts", ...args], {
    cwd: repository,
    env: environmentFor(home, overrides),
    encoding: "utf8",
    timeout: 30_000
  })

const runAgentAsync = (
  args: ReadonlyArray<string>,
  home: string,
  overrides: Readonly<Record<string, string>>
) =>
  new Promise<{
    readonly status: number | null
    readonly signal: NodeJS.Signals | null
    readonly stdout: string
    readonly stderr: string
  }>((resolveRun, rejectRun) => {
    const child = spawn("bun", ["src/agent-cli.ts", ...args], {
      cwd: repository,
      env: environmentFor(home, overrides),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", rejectRun)
    child.once("close", (status, signal) => {
      resolveRun({ status, signal, stdout, stderr })
    })
  })

const decodeProgramReport = (stdout: string) =>
  Schema.decodeUnknownSync(ProgramReport)(JSON.parse(stdout))

const entries = (directory: string) =>
  existsSync(directory) ? readdirSync(directory) : []

const nativeFixture = (executables: ReadonlyArray<string>) => {
  const root = mkdtempSync(join(tmpdir(), "airlock-agent-hostile-"))
  const workspace = join(root, "workspace")
  const home = join(root, "home")
  const policy = join(root, "policy.json")
  mkdirSync(workspace)
  writeFileSync(
    policy,
    JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:hostile-surface",
      realm: "local",
      admittedBy: "operator:hostile-surface",
      pathAllowlist: [`${workspace}/**`],
      executableAllowlist: executables,
      endpointAllowlist: []
    })
  )
  return {
    root,
    workspace,
    home,
    environment: {
      AIRLOCK_AGENT_PROFILE: "native-contained",
      AIRLOCK_POLICY_FILE: policy
    }
  }
}

describe("agent-hostile command surface", () => {
  it(
    "rejects command-string and shell-call forms without performing either payload",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-command-string-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      const marker = join(root, "escaped.txt")
      mkdirSync(workspace)

      const schema = runAgent(["schema", "plan"], home)
      expect(schema.status, schema.stderr).toBe(0)
      expect(JSON.parse(schema.stdout)).toMatchObject({
        plan: { invoke: { commandString: false } }
      })

      const commandString = runAgent(
        [
          "eval",
          "--workspace",
          workspace,
          "--source",
          `return process.run({ command: ${JSON.stringify(`/usr/bin/touch ${marker}`)}, cwd: ${JSON.stringify(workspace)} })`
        ],
        home
      )
      expect(commandString.status, commandString.stderr).toBe(1)
      expect(decodeProgramReport(commandString.stdout).result.failure).toMatchObject({
        phase: "contract",
        causeTag: "ProgramActionDecodeFailed"
      })

      const shellCall = runAgent(
        [
          "eval",
          "--workspace",
          workspace,
          "--source",
          `return shell.eval({ command: ${JSON.stringify(`/usr/bin/touch ${marker}`)} })`
        ],
        home
      )
      expect(shellCall.status, shellCall.stderr).toBe(1)
      expect(decodeProgramReport(shellCall.stdout).result.failure).toMatchObject({
        phase: "language",
        causeTag: "InvalidCallTarget"
      })
      expect(existsSync(marker)).toBe(false)
      expect(entries(join(home, "hold"))).toEqual([])
      expect(entries(join(home, "outbox"))).toEqual([])
    }
  )

  it(
    "omits terminal-authority commands from discovery and rejects direct attempts",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-terminal-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      const sentinel = join(workspace, "keep.txt")
      const marker = join(root, "raw-exec.txt")
      mkdirSync(workspace)
      writeFileSync(sentinel, "keep")

      const help = runAgent(["--help"], home)
      expect(help.status, help.stderr).toBe(0)
      const discovered = [...help.stdout.matchAll(/^  - ([a-z-]+)/gm)].map(
        (match) => match[1]!
      )
      expect(discovered).toEqual([
        "doctor",
        "capabilities",
        "actions",
        "schema",
        "run",
        "eval",
        "held",
        "pending",
        "ledger"
      ])
      expect(discovered.some((command) => terminalCommands.includes(command))).toBe(
        false
      )

      const attempts = [
        ["rm", sentinel],
        ["write", sentinel, "compromised"],
        [
          "exec",
          "--executable",
          "/usr/bin/touch",
          "--arg",
          marker,
          "--cwd",
          workspace
        ]
      ] as const
      for (const attempted of attempts) {
        const result = runAgent(attempted, home)
        expect(result.status, `${attempted[0]} unexpectedly succeeded`).not.toBe(0)
      }

      expect(readFileSync(sentinel, "utf8")).toBe("keep")
      expect(existsSync(marker)).toBe(false)
      expect(entries(join(home, "hold"))).toEqual([])
      expect(entries(join(home, "outbox"))).toEqual([])
    }
  )
})

describe("agent-hostile admission and containment", () => {
  it(
    "rejects CLI and structured profile downgrades with a failed receipt and no effect",
    { timeout: 30_000 },
    () => {
      const fixture = nativeFixture(["/usr/bin/touch"])
      const marker = join(fixture.root, "downgraded.txt")

      const optionDowngrade = runAgent(
        [
          "eval",
          "--workspace",
          fixture.workspace,
          "--profile=compatibility",
          "--source",
          "return true"
        ],
        fixture.home,
        fixture.environment
      )
      expect(optionDowngrade.status).toBe(64)
      expect(optionDowngrade.stderr).toContain(
        "airlock-agent rejects --profile"
      )

      const nodeDowngrade = runAgent(
        [
          "eval",
          "--workspace",
          fixture.workspace,
          "--source",
          `return process.run({ executable: "/usr/bin/touch", args: [${JSON.stringify(marker)}], cwd: ${JSON.stringify(fixture.workspace)}, cellProfile: "compatibility", stdout: "capture", stderr: "capture" })`
        ],
        fixture.home,
        fixture.environment
      )
      expect(nodeDowngrade.status, nodeDowngrade.stderr).toBe(0)
      const report = decodeProgramReport(nodeDowngrade.stdout)
      const result = Schema.decodeUnknownSync(RuntimeResult)(report.result.result)
      expect(report.profile).toBe("native-contained")
      expect(result.state).toBe("failed")
      expect(result.receipts).toEqual([
        expect.objectContaining({
          sequence: 1,
          state: "failed",
          error_tag: "RuntimeCapabilityDenied"
        })
      ])
      expect(existsSync(marker)).toBe(false)
      expect(entries(join(fixture.home, "hold"))).toEqual([])
      expect(entries(join(fixture.home, "outbox"))).toEqual([])
    }
  )

  it(
    "denies out-of-policy paths and executables before either can change the world",
    { timeout: 30_000 },
    () => {
      const fixture = nativeFixture(["/usr/bin/touch"])
      const outside = join(fixture.root, "outside.txt")
      const shellMarker = join(fixture.root, "shell.txt")

      const pathEscape = runAgent(
        [
          "eval",
          "--workspace",
          fixture.workspace,
          "--source",
          `return file.write({ path: ${JSON.stringify(outside)}, content: "escaped" })`
        ],
        fixture.home,
        fixture.environment
      )
      expect(pathEscape.status, pathEscape.stderr).toBe(1)
      const pathReport = decodeProgramReport(pathEscape.stdout)
      expect(pathReport.result.failure).toMatchObject({
        phase: "admission",
        causeTag: "AdmissionDenied"
      })
      expect(pathReport.result.plans[0]?.nodes.map(({ kind }) => kind)).toEqual([
        "Apply"
      ])

      const executableEscape = runAgent(
        [
          "eval",
          "--workspace",
          fixture.workspace,
          "--source",
          `return process.run({ executable: "/bin/sh", args: ["-c", ${JSON.stringify(`/usr/bin/touch ${shellMarker}`)}], cwd: ${JSON.stringify(fixture.workspace)}, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })`
        ],
        fixture.home,
        fixture.environment
      )
      expect(executableEscape.status, executableEscape.stderr).toBe(1)
      const executableReport = decodeProgramReport(executableEscape.stdout)
      expect(executableReport.result.failure).toMatchObject({
        phase: "admission",
        causeTag: "AdmissionDenied"
      })
      expect(
        executableReport.result.plans[0]?.nodes.map(({ kind }) => kind)
      ).toEqual(["Invoke", "Apply"])

      expect(existsSync(outside)).toBe(false)
      expect(existsSync(shellMarker)).toBe(false)
      expect(entries(join(fixture.home, "hold"))).toEqual([])
      expect(entries(join(fixture.home, "outbox"))).toEqual([])
    }
  )

  it.skipIf(
    process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec") ||
      !existsSync("/usr/bin/curl")
  )(
    "denies native-contained network access and receipts the failed Invoke",
    { timeout: 30_000 },
    async () => {
      const fixture = nativeFixture(["/usr/bin/curl"])
      const sentinel = join(fixture.workspace, "keep.txt")
      writeFileSync(sentinel, "keep")
      let hits = 0
      const server = createServer((_request, response) => {
        hits += 1
        response.end("reachable")
      })
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(0, "127.0.0.1", () => resolveListen())
      })

      try {
        const address = server.address()
        if (address === null || typeof address === "string") {
          throw new Error("test server did not expose a TCP port")
        }
        const endpoint = `http://127.0.0.1:${address.port}/hostile`
        const baseline = await fetch(endpoint)
        expect(await baseline.text()).toBe("reachable")
        expect(hits).toBe(1)
        hits = 0

        const executed = await runAgentAsync(
          [
            "eval",
            "--workspace",
            fixture.workspace,
            "--source",
            `return process.run({ executable: "/usr/bin/curl", args: ["--connect-timeout", "1", "--max-time", "2", "-fsS", ${JSON.stringify(endpoint)}], cwd: ${JSON.stringify(fixture.workspace)}, cellProfile: "native-contained", stdout: "capture", stderr: "capture", timeout: 5s })`
          ],
          fixture.home,
          fixture.environment
        )
        expect(
          executed.status,
          `${executed.stderr}\n${executed.stdout}`
        ).toBe(0)
        const report = decodeProgramReport(executed.stdout)
        const result = Schema.decodeUnknownSync(RuntimeResult)(
          report.result.result
        )
        expect(report.profile).toBe("native-contained")
        expect(result.state).toBe("failed")
        expect(result.receipts).toEqual([
          expect.objectContaining({
            sequence: 1,
            state: "failed",
            error_tag: "RuntimeNodeFailure"
          }),
          expect.objectContaining({
            sequence: 2,
            state: "cancelled",
            error_tag: "RuntimeDependencyFailed"
          })
        ])
        expect(report.result.plans[0]?.nodes.map(({ kind }) => kind)).toEqual([
          "Invoke",
          "Apply"
        ])
        expect(hits).toBe(0)
        expect(readFileSync(sentinel, "utf8")).toBe("keep")
        expect(entries(join(fixture.home, "hold"))).toEqual([])
        expect(entries(join(fixture.home, "outbox"))).toEqual([])
      } finally {
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose())
        })
      }
    }
  )
})
