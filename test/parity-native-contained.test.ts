import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const fixture = join(repository, "examples", "parity", "native-rewrite.air")
const supported =
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync("/bin/cp")

const run = (
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

describe.skipIf(!supported)("shell parity — native-contained rewrite and undo", () => {
  it("runs an existing Unix tool in a private Cell, applies its delta through Hold, and restores prior bytes", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-parity-native-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const policy = join(root, "policy.json")
    const live = join(workspace, "live.txt")
    mkdirSync(workspace)
    writeFileSync(live, "before\n")
    writeFileSync(join(workspace, "replacement.txt"), "after\n")
    writeFileSync(policy, JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:parity-corpus",
      realm: "local",
      admittedBy: "operator:parity-corpus",
      pathAllowlist: [`${workspace}/**`],
      executableAllowlist: ["/bin/cp"],
      endpointAllowlist: []
    }))

    const executed = run([
      "run",
      fixture,
      "--workspace",
      workspace,
      "--profile",
      "native-contained",
      "--bindings",
      JSON.stringify({ workspace })
    ], home, policy)

    expect(executed.status, executed.stderr).toBe(0)
    expect(readFileSync(live, "utf8")).toBe("after\n")

    const report = JSON.parse(executed.stdout) as {
      readonly profile: string
      readonly result: {
        readonly result: {
          readonly state: string
          readonly receipts: ReadonlyArray<{
            readonly sequence: number
            readonly state: string
          }>
        }
        readonly plans: ReadonlyArray<{
          readonly nodes: ReadonlyArray<{ readonly kind: string }>
        }>
      }
    }
    expect(report.profile).toBe("native-contained")
    expect(report.result.result.state).toBe("succeeded")
    expect(report.result.result.receipts).toEqual([
      expect.objectContaining({ sequence: 1, state: "succeeded" }),
      expect.objectContaining({ sequence: 2, state: "succeeded" })
    ])
    expect(report.result.plans).toHaveLength(1)
    expect(report.result.plans[0]?.nodes.map(({ kind }) => kind))
      .toEqual(["Invoke", "Apply"])

    const held = run(["held"], home, policy)
    expect(held.status, held.stderr).toBe(0)
    const recoverable = JSON.parse(held.stdout) as ReadonlyArray<{
      readonly id: string
      readonly target: string
      readonly previousHeld?: boolean
      readonly hasPayload: boolean
      readonly status: string
    }>
    const rewrite = recoverable.find(({ target }) => target === live)
    expect(rewrite).toMatchObject({
      hasPayload: true,
      status: "held"
    })
    expect(rewrite?.target).toBe(live)

    const undone = run(["undo", rewrite!.id], home, policy)
    expect(undone.status, undone.stderr).toBe(0)
    expect(readFileSync(live, "utf8")).toBe("before\n")
  })
})
