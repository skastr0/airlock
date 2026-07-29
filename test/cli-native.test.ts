import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const supported =
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync("/usr/bin/touch")

const invoke = (
  args: ReadonlyArray<string>,
  home: string,
  policy: string
) =>
  spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: repository,
    env: {
      ...process.env,
      AIRLOCK_HOME: home,
      AIRLOCK_POLICY_FILE: policy
    },
    encoding: "utf8",
    timeout: 30_000
  })

describe.skipIf(!supported)("native-contained agent CLI", () => {
  it("admits a program, merges its private delta through Hold, and undoes it", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-cli-native-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const program = join(root, "create.air")
    const policy = join(root, "policy.json")
    const created = join(workspace, "created.txt")
    mkdirSync(workspace)
    const canonicalCreated = join(realpathSync(workspace), "created.txt")
    writeFileSync(
      program,
      'return process.run({ executable: "/usr/bin/touch", args: ["created.txt"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })\n'
    )
    writeFileSync(policy, JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:cli-native-test",
      realm: "local",
      admittedBy: "operator:cli-native-test",
      pathAllowlist: [`${workspace}/**`],
      executableAllowlist: ["/usr/bin/touch"],
      endpointAllowlist: []
    }))

    const run = invoke([
      "run",
      program,
      "--workspace",
      workspace,
      "--profile",
      "native-contained"
    ], home, policy)
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(created)).toBe(true)

    const report = JSON.parse(run.stdout) as {
      readonly profile: string
      readonly result: {
        readonly result: {
          readonly state: string
          readonly receipts: ReadonlyArray<{ readonly state: string }>
        }
        readonly plans: ReadonlyArray<{
          readonly nodes: ReadonlyArray<{ readonly kind: string }>
        }>
      }
    }
    expect(report.profile).toBe("native-contained")
    expect(report.result.result.state).toBe("succeeded")
    expect(report.result.result.receipts.map(({ state }) => state)).toEqual([
      "succeeded",
      "succeeded"
    ])
    expect(report.result.plans[0]?.nodes.map(({ kind }) => kind)).toEqual([
      "Invoke",
      "Apply"
    ])

    const held = invoke(["held"], home, policy)
    expect(held.status, held.stderr).toBe(0)
    expect(JSON.parse(held.stdout)).toEqual([
      expect.objectContaining({
        target: canonicalCreated,
        act: "overwrite",
        hasPayload: false,
        status: "held"
      }),
      expect.objectContaining({
        purpose: "runtime-private",
        status: "held"
      })
    ])

    const undone = invoke(["undo"], home, policy)
    expect(undone.status, undone.stderr).toBe(0)
    expect(existsSync(created)).toBe(false)
  }, 20_000)
})
