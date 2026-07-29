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

const run = (
  args: ReadonlyArray<string>,
  home: string,
  environment: Readonly<Record<string, string>> = {}
) =>
  spawnSync("bun", ["src/agent-cli.ts", ...args], {
    cwd: repository,
    env: { ...process.env, AIRLOCK_HOME: home, ...environment },
    encoding: "utf8"
  })

const json = (value: string) => JSON.parse(value) as Record<string, unknown>

describe("agent-only CLI surface", () => {
  it("accepts source directly and routes effects through admitted program execution", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-cli-"))
    const executed = run([
      "eval",
      "--workspace", home,
      "--source", 'let receipt = file.write({ path: "result.txt", content: "airlocked" })\nreturn receipt'
    ], home)

    expect(executed.status).toBe(0)
    expect(readFileSync(join(home, "result.txt"), "utf8")).toBe("airlocked")
    expect(json(executed.stdout)).toMatchObject({
      schemaVersion: "airlock/program-run/v1",
      profile: "compatibility",
      result: {
        result: {
          state: "applied",
          target: expect.stringMatching(/\/result\.txt$/)
        }
      }
    })
  })

  it("does not expose raw execution, terminal dispatch, mutation, undo, or reaping", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-cli-"))
    const target = join(home, "keep.txt")
    writeFileSync(target, "keep")

    for (const forbidden of ["exec", "rm", "write", "undo", "reap", "send", "commit", "cancel", "flush"]) {
      const attempted = run([forbidden], home)
      expect(attempted.status, `${forbidden} unexpectedly succeeded`).not.toBe(0)
    }
    expect(readFileSync(target, "utf8")).toBe("keep")
  })

  it("still exposes bounded discovery and observation commands", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-cli-"))
    for (const allowed of [
      "doctor",
      "actions",
      "schema",
      "held",
      "pending",
      "ledger",
      "runs"
    ]) {
      const observed = run([allowed], home)
      expect(observed.status, `${allowed}: ${observed.stderr}`).toBe(0)
    }
  })

  it("exposes redacted durable Runtime receipts by Plan id", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-runs-"))
    const executed = run([
      "eval",
      "--workspace", home,
      "--source",
      'return file.write({ path: "journaled.txt", content: "receipt" })'
    ], home)
    expect(executed.status, executed.stderr).toBe(0)
    const report = json(executed.stdout) as {
      readonly result: {
        readonly plans: ReadonlyArray<{ readonly id: string }>
      }
    }
    const planId = report.result.plans[0]?.id
    expect(planId).toBeTypeOf("string")

    const inspected = run([
      "run-receipt",
      "--plan-id", planId!
    ], home)
    expect(inspected.status, inspected.stderr).toBe(0)
    expect(json(inspected.stdout)).toMatchObject({
      schemaVersion: "airlock/runtime-run-snapshot/v1",
      planId,
      state: "succeeded",
      receipts: [
        expect.objectContaining({
          state: "succeeded"
        })
      ]
    })
    const listed = run(["runs"], home)
    expect(listed.status, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ planId })
    ])
  })

  it.skipIf(
    process.platform !== "darwin" ||
    !existsSync("/usr/bin/sandbox-exec") ||
    !existsSync("/usr/bin/touch")
  )(
    "keeps the execution profile outside agent control",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-agent-profile-"))
      const workspace = join(root, "workspace")
      const home = join(root, "home")
      const policy = join(root, "policy.json")
      const outside = join(root, "outside.txt")
      mkdirSync(workspace)
      writeFileSync(policy, JSON.stringify({
        schemaVersion: "airlock/admission-policy/v1",
        profile: "native-contained",
        principal: "agent:profile-test",
        realm: "local",
        admittedBy: "operator:profile-test",
        pathAllowlist: [`${workspace}/**`],
        executableAllowlist: ["/usr/bin/touch"],
        endpointAllowlist: []
      }))
      const environment = {
        AIRLOCK_AGENT_PROFILE: "native-contained",
        AIRLOCK_POLICY_FILE: policy
      }

      const contained = run([
        "eval",
        "--workspace", workspace,
        "--source",
        'return process.run({ executable: "/usr/bin/touch", args: ["inside.txt"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })'
      ], home, environment)
      expect(contained.status, contained.stderr).toBe(0)
      expect(existsSync(join(workspace, "inside.txt"))).toBe(true)

      const optionOverride = run([
        "eval",
        "--workspace", workspace,
        "--profile", "compatibility",
        "--source", "return true"
      ], home, environment)
      expect(optionOverride.status).not.toBe(0)

      const nodeDowngrade = run([
        "eval",
        "--workspace", workspace,
        "--source",
        `return process.run({ executable: "/usr/bin/touch", args: [${JSON.stringify(outside)}], cwd: workspace, cellProfile: "compatibility", stdout: "capture", stderr: "capture" })`
      ], home, environment)
      expect(nodeDowngrade.status, nodeDowngrade.stderr).toBe(1)
      expect(json(nodeDowngrade.stdout)).toMatchObject({
        profile: "native-contained",
        result: {
          state: "failed",
          result: null,
          failure: expect.objectContaining({
            action: "process.run",
            phase: "runtime",
            causeTag: "RuntimePlanInvalid"
          })
        }
      })
      expect(existsSync(outside)).toBe(false)
    }
  )
})
