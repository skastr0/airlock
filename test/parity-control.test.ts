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
    expect(refused.stderr).toContain("LoopLimitExceeded")
    expect(refused.stderr).not.toContain("ProgramActionExecutionFailed")
  })
})
