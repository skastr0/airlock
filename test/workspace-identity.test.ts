import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")

const runAgent = (
  args: ReadonlyArray<string>,
  home: string,
  environment: Readonly<Record<string, string>>
) =>
  spawnSync("bun", ["src/agent-cli.ts", ...args], {
    cwd: repository,
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      NO_COLOR: "1",
      AIRLOCK_HOME: home,
      AIRLOCK_AGENT_PROFILE: "native-contained",
      ...environment
    },
    encoding: "utf8",
    timeout: 30_000
  })

const writePolicy = (
  path: string,
  workspace: string
) =>
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:workspace-identity",
      realm: "local",
      admittedBy: "operator:workspace-identity",
      pathAllowlist: [`${workspace}/**`],
      executableAllowlist: ["/usr/bin/touch"],
      endpointAllowlist: []
    })
  )

describe("native-contained workspace identity", () => {
  it("preserves lexical workspace and caller bindings in compatibility", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-workspace-compat-"))
    const allowed = join(root, "allowed")
    const outside = join(root, "outside")
    const physicalWorkspace = join(outside, "workspace")
    const requestedWorkspace = join(allowed, "redirect", "workspace")
    const home = join(root, "home")
    mkdirSync(allowed)
    mkdirSync(physicalWorkspace, { recursive: true })
    symlinkSync(outside, join(allowed, "redirect"))

    const result = runAgent(
      [
        "eval",
        "--workspace",
        requestedWorkspace,
        "--bindings",
        '{"workspace":"caller-value"}',
        "--source",
        "return workspace"
      ],
      home,
      { AIRLOCK_AGENT_PROFILE: "compatibility" }
    )

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      profile: "compatibility",
      workspace: requestedWorkspace,
      result: { result: "caller-value" }
    })
  })

  it("returns typed input failures for a missing or non-directory workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-workspace-input-"))
    const home = join(root, "home")
    const missing = join(root, "missing")
    const file = join(root, "not-a-directory")
    writeFileSync(file, "not a workspace")

    for (const workspace of [missing, file]) {
      const result = runAgent(
        ["eval", "--workspace", workspace, "--source", "return true"],
        home,
        { AIRLOCK_POLICY_FILE: join(root, "policy-is-not-consulted.json") }
      )
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stderr)).toMatchObject({
        _tag: "CliInputError",
        field: "workspace"
      })
    }
  })

  it.skipIf(
    process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec") ||
      !existsSync("/usr/bin/touch")
  )(
    "binds a symlink-ancestor workspace before admission and execution",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-workspace-identity-"))
      const allowed = join(root, "allowed")
      const outside = join(root, "outside")
      const physicalWorkspace = join(outside, "workspace")
      const aliasRoot = join(allowed, "redirect")
      const requestedWorkspace = join(aliasRoot, "workspace")
      const policy = join(root, "policy.json")
      const deniedHome = join(root, "denied-home")
      const allowedHome = join(root, "allowed-home")
      mkdirSync(allowed)
      mkdirSync(physicalWorkspace, { recursive: true })
      symlinkSync(outside, aliasRoot)

      const canonicalWorkspace = realpathSync(requestedWorkspace)
      const source =
        'return process.run({ executable: "/usr/bin/touch", args: ["result.txt"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })'
      const bindings = JSON.stringify({ workspace: requestedWorkspace })

      // A lexical allowlist entry cannot smuggle the physical target across
      // the trusted workspace boundary.
      writePolicy(policy, allowed)
      const denied = runAgent(
        [
          "eval",
          "--workspace",
          requestedWorkspace,
          "--bindings",
          bindings,
          "--source",
          source
        ],
        deniedHome,
        { AIRLOCK_POLICY_FILE: policy }
      )
      expect(denied.status, `${denied.stderr}\n${denied.stdout}`).toBe(1)
      const deniedReport = JSON.parse(denied.stdout) as {
        readonly workspace: string
        readonly result: {
          readonly failure?: {
            readonly phase: string
            readonly causeTag?: string
          }
        }
      }
      expect(deniedReport.workspace).toBe(canonicalWorkspace)
      expect(deniedReport.result.failure).toMatchObject({
        phase: "admission",
        causeTag: "AdmissionDenied"
      })
      expect(existsSync(join(physicalWorkspace, "result.txt"))).toBe(false)

      // Once the supervisor grants the canonical directory, the same alias
      // and conventional workspace binding resolve to that one admitted name.
      writePolicy(policy, canonicalWorkspace)
      const allowedResult = runAgent(
        [
          "eval",
          "--workspace",
          requestedWorkspace,
          "--bindings",
          bindings,
          "--source",
          source
        ],
        allowedHome,
        { AIRLOCK_POLICY_FILE: policy }
      )
      expect(
        allowedResult.status,
        `${allowedResult.stderr}\n${allowedResult.stdout}`
      ).toBe(0)
      const allowedReport = JSON.parse(allowedResult.stdout) as {
        readonly workspace: string
        readonly result: {
          readonly actions: ReadonlyArray<{
            readonly request: {
              readonly call: {
                readonly input: {
                  readonly cwd?: string
                }
              }
            }
          }>
        }
      }
      expect(allowedReport.workspace).toBe(canonicalWorkspace)
      expect(allowedReport.result.actions[0]?.request.call.input.cwd).toBe(
        canonicalWorkspace
      )
      expect(existsSync(join(physicalWorkspace, "result.txt"))).toBe(true)
    }
  )

  it.skipIf(process.platform !== "darwin")(
    "binds relative and /tmp path selectors before native-contained admission",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync("/tmp/airlock-workspace-paths-")
      const workspace = join(root, "workspace")
      const canonicalWorkspace = realpathSync(root) + "/workspace"
      const policy = join(root, "policy.json")
      mkdirSync(join(workspace, "missing"), { recursive: true })
      writeFileSync(join(workspace, "seed.txt"), "seed")
      writePolicy(policy, workspace)

      const source = [
        'let before = file.stat({ path: "seed.txt" })',
        'let made = file.write({ path: "missing/value.txt", content: "written" })',
        'let after = file.stat({ path: "missing/value.txt" })',
        'let globbed = file.glob({ root: ".", pattern: "**/*.txt" })',
        `let absolute = file.read({ path: ${JSON.stringify(join(workspace, "seed.txt"))}, format: "text" })`,
        'return { before: before, made: made, after: after, globbed: globbed, absolute: absolute }'
      ].join("\n")
      const result = runAgent(
        ["eval", "--workspace", workspace, "--source", source],
        join(root, "home"),
        { AIRLOCK_POLICY_FILE: policy }
      )
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
      const payload = JSON.parse(result.stdout)
      expect(payload.result.result).toMatchObject({
        before: { bytes: 4 },
        after: { bytes: 7 },
        absolute: "seed"
      })
      expect(payload.result.result.globbed).toEqual(expect.arrayContaining([
        join(canonicalWorkspace, "seed.txt"),
        join(canonicalWorkspace, "missing", "value.txt")
      ]))
      for (const action of payload.result.actions) {
        const input = action.request.call.input
        const selector = input.path ?? input.root
        if (selector !== undefined) expect(selector.startsWith(canonicalWorkspace)).toBe(true)
      }

      const outside = join(root, "outside.txt")
      const denied = runAgent(
        [
          "eval", "--workspace", workspace, "--source",
          'return file.write({ path: "../outside.txt", content: "blocked" })'
        ],
        join(root, "denied-home"),
        { AIRLOCK_POLICY_FILE: policy }
      )
      expect(denied.status).toBe(1)
      expect(existsSync(outside)).toBe(false)
    }
  )

  it("keeps compatibility relative-path behavior and caller spelling", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-workspace-relative-compat-"))
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    writeFileSync(join(workspace, "value.txt"), "compat")
    const result = runAgent(
      [
        "eval", "--workspace", workspace, "--source",
        'return file.read({ path: "value.txt", format: "text" })'
      ],
      join(root, "home"),
      { AIRLOCK_AGENT_PROFILE: "compatibility" }
    )
    expect(result.status, result.stderr).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.result.result).toBe("compat")
    expect(payload.result.actions[0].request.call.input.path).toBe("value.txt")
  })

})
