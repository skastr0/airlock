import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const fixture = join(repository, "examples", "parity", "bounded-control.air")
const finiteListFixture = join(
  repository,
  "examples",
  "parity",
  "finite-list-control.air"
)

const run = (
  args: ReadonlyArray<string>,
  home: string
) =>
  spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: repository,
    env: { ...process.env, AIRLOCK_HOME: home },
    encoding: "utf8",
    timeout: 30_000
  })

const runAgent = (
  args: ReadonlyArray<string>,
  home: string
) =>
  spawnSync("bun", ["src/agent-cli.ts", ...args], {
    cwd: repository,
    env: { ...process.env, AIRLOCK_HOME: home },
    encoding: "utf8",
    timeout: 30_000
  })

describe("shell parity — bounded Airlock control", () => {
  it("runs guarded, statically bounded repeated effects without exposing a shell interpreter", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-parity-control-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    mkdirSync(workspace)
    const canonicalWorkspace = realpathSync(workspace)

    const executed = run([
      "run",
      fixture,
      "--workspace",
      workspace,
      "--bindings",
      JSON.stringify({ enabled: true, expected: 3 })
    ], home)

    expect(executed.status, executed.stderr).toBe(0)
    expect(readFileSync(join(workspace, "bounded.txt"), "utf8"))
      .toBe("bounded iteration\n")

    const report = JSON.parse(executed.stdout) as {
      readonly result: {
        readonly result: {
          readonly state: string
          readonly iterations: number
          readonly observed: string
        }
        readonly plans: ReadonlyArray<{
          readonly nodes: ReadonlyArray<{ readonly kind: string }>
        }>
      }
    }
    expect(report.result.result).toEqual({
      state: "complete",
      iterations: 3,
      observed: "bounded iteration\n"
    })
    expect(report.result.plans.flatMap(({ nodes }) => nodes.map(({ kind }) => kind)))
      .toEqual(["Apply", "Apply", "Apply", "Capture"])

    const held = run(["held"], home)
    expect(held.status, held.stderr).toBe(0)
    const recoverable = JSON.parse(held.stdout) as ReadonlyArray<{
      readonly target: string
      readonly previousHeld?: boolean
    }>
    expect(
      recoverable.filter(
        ({ target }) => target === join(canonicalWorkspace, "bounded.txt")
      ),
      JSON.stringify(recoverable)
    )
      .toHaveLength(3)
  })

  it("executes a supervisor-supplied finite list through the agent-only program surface", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-parity-list-control-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    mkdirSync(workspace)

    const executed = runAgent([
      "run",
      finiteListFixture,
      "--workspace",
      workspace,
      "--bindings",
      JSON.stringify({
        enabled: true,
        writes: [
          { path: "first.txt", content: "first\n" },
          { path: "second.txt", content: "second\n" },
          { path: "final.txt", content: "final\n" }
        ],
        observed_path: "final.txt",
        expected: 3
      })
    ], home)

    expect(executed.status, `${executed.stderr}\n${executed.stdout}`).toBe(0)
    expect(readFileSync(join(workspace, "first.txt"), "utf8")).toBe("first\n")
    expect(readFileSync(join(workspace, "second.txt"), "utf8")).toBe("second\n")
    expect(readFileSync(join(workspace, "final.txt"), "utf8")).toBe("final\n")

    const report = JSON.parse(executed.stdout) as {
      readonly result: {
        readonly result: {
          readonly state: string
          readonly iterations: number
          readonly observed: string
        }
        readonly plans: ReadonlyArray<{
          readonly nodes: ReadonlyArray<{ readonly kind: string }>
        }>
      }
    }
    expect(report.result.result).toEqual({
      state: "complete",
      iterations: 3,
      observed: "final\n"
    })
    expect(
      report.result.plans.flatMap(({ nodes }) => nodes.map(({ kind }) => kind))
    ).toEqual(["Apply", "Apply", "Apply", "Capture"])
  })

  it("rejects a loop over the runtime budget before any action is resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-parity-control-limit-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const program = join(root, "over-budget.air")
    mkdirSync(workspace)
    writeFileSync(program, `
      for index in 0..10001 {
        file.write({ path: "must-not-exist.txt", content: "no" })
      }
      return true
    `)

    const refused = run(["run", program, "--workspace", workspace], home)
    expect(refused.status).toBe(1)
    const report = JSON.parse(refused.stdout) as {
      readonly result: {
        readonly state: string
        readonly result: null
        readonly actions: ReadonlyArray<unknown>
        readonly failure?: {
          readonly causeTag?: string
        }
      }
    }
    expect(report.result.state).toBe("failed")
    expect(report.result.result).toBeNull()
    expect(report.result.actions).toHaveLength(0)
    expect(report.result.failure).toMatchObject({ causeTag: "LoopLimitExceeded" })
  })
})
