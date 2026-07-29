import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
  it("accepts source directly and routes effects through admitted program execution", () => {
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

  it("does not expose raw execution, terminal dispatch, mutation, undo, or reaping", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-cli-"))
    const target = join(home, "keep.txt")
    writeFileSync(target, "keep")

    for (const forbidden of ["exec", "rm", "write", "undo", "reap", "send", "commit", "cancel", "flush"]) {
      const attempted = run([forbidden], home)
      expect(attempted.status, `${forbidden} unexpectedly succeeded`).not.toBe(0)
    }
    expect(readFileSync(target, "utf8")).toBe("keep")
  })

  it("still exposes bounded discovery and observation commands", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-cli-"))
    for (const allowed of ["doctor", "actions", "schema", "held", "pending", "ledger"]) {
      const observed = run([allowed], home)
      expect(observed.status, `${allowed}: ${observed.stderr}`).toBe(0)
    }
  })
})
