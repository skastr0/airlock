import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const fixture = join(repository, "examples", "parity", "process-pipeline.air")

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

describe("shell parity — structured Unix process graphs", () => {
  it("searches content, pipes an artifact, captures output, and keeps hostile-looking argv literal", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-parity-process-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    mkdirSync(workspace)
    writeFileSync(
      join(workspace, "input.txt"),
      "ordinary first\nneedle second\nordinary third\n"
    )

    const executed = run([
      "run",
      fixture,
      "--workspace",
      workspace,
      "--bindings",
      JSON.stringify({ workspace })
    ], home)

    expect(executed.status, executed.stderr).toBe(0)
    expect(existsSync(join(workspace, "should-not-exist"))).toBe(false)

    const report = JSON.parse(executed.stdout) as {
      readonly result: {
        readonly result: {
          readonly selected: string
          readonly transformed: string
          readonly literal: string
          readonly states: ReadonlyArray<string>
        }
        readonly plans: ReadonlyArray<{
          readonly actionReference: string
          readonly nodes: ReadonlyArray<{ readonly kind: string }>
        }>
        readonly artifacts: ReadonlyArray<{
          readonly id: string
          readonly byteLength: number
          readonly provenance: string
          readonly bytes?: unknown
        }>
      }
    }

    expect(report.result.result).toEqual({
      selected: "2:needle second\n",
      transformed: "2:NEEDLE SECOND\n",
      literal: "literal; touch should-not-exist",
      states: ["succeeded", "succeeded", "succeeded"]
    })
    expect(report.result.plans).toHaveLength(3)
    expect(report.result.plans.every(
      ({ nodes }) => nodes.length === 1 && nodes[0]?.kind === "Invoke"
    )).toBe(true)
    expect(report.result.plans.every(
      ({ actionReference }) => actionReference.startsWith("process.run@sha256:")
    )).toBe(true)
    expect(report.result.artifacts.length).toBeGreaterThanOrEqual(6)
    expect(report.result.artifacts.every((artifact) => artifact.bytes === undefined)).toBe(true)
  })
})
