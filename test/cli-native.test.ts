import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { nativeContainmentSupported } from "../packages/cli/test/support/NativeContainmentTest.ts"

const repository = resolve(import.meta.dirname, "..")
const supported = nativeContainmentSupported && existsSync("/usr/bin/touch") && existsSync("/bin/rm")

type Fixture = Readonly<{ workspace: string; home: string; policy: string }>

/** Processes run at once, but only inside the native Cell, and only these executables. */
const fixture = (executables: ReadonlyArray<string>): Fixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-cli-native-")))
  const workspace = join(root, "workspace")
  const policy = join(root, "policy.json")
  mkdirSync(workspace)
  writeFileSync(policy, JSON.stringify({
    schemaVersion: "airlock/tool-policy/v1",
    toolGrants: [{ id: "run", tool: "process.run", when: "now", host: { profile: "native-contained" } }],
    resources: { path: [workspace], executable: { roots: executables, edges: [] } },
    budget: { maxCalls: 4, maxInputBytes: 100_000 }
  }))
  return { workspace, home: join(root, "home"), policy }
}

const invoke = (entry: "cli" | "agent-cli", args: ReadonlyArray<string>, at: Fixture) => {
  const environment: Record<string, string | undefined> = { ...process.env, AIRLOCK_HOME: at.home, AIRLOCK_POLICY_FILE: at.policy }
  delete environment["AIRLOCK_SEAL"]
  return spawnSync("bun", [`packages/cli/src/${entry}.ts`, ...args], { cwd: repository, env: environment, encoding: "utf8", timeout: 30_000 })
}

/** Runs one process from the agent's binary and returns its done receipt. */
const runProcess = (at: Fixture, executable: string, args: ReadonlyArray<string>) => {
  const source =
    `let ran = process.run({ executable: ${JSON.stringify(executable)}, args: ${JSON.stringify(args)}, cwd: "." })\n` +
    `assert ran.state == "done", "the process did not run"\nreturn ran`
  const ran = invoke("agent-cli", ["eval", "--workspace", at.workspace, "--source", source], at)
  expect(ran.status, `${ran.stderr}\n${ran.stdout}`).toBe(0)
  const { outcome } = JSON.parse(ran.stdout) as {
    readonly outcome: { readonly result: { readonly id: string; readonly result: { readonly outcome: string; readonly merged: unknown } } }
  }
  return outcome.result
}

describe.skipIf(!supported)("native-contained processes through the CLI", () => {
  it("merges what a contained process created through Hold, and undo removes it", { timeout: 30_000 }, () => {
    const at = fixture(["/usr/bin/touch"])
    const receipt = runProcess(at, "/usr/bin/touch", ["created.txt"])
    expect(receipt.result).toMatchObject({ outcome: "exited", merged: [{ path: "created.txt", kind: "created" }] })
    expect(existsSync(join(at.workspace, "created.txt"))).toBe(true)

    const undone = invoke("cli", ["undo", receipt.id, "--workspace", at.workspace], at)
    expect(undone.status, undone.stderr).toBe(0)
    expect(existsSync(join(at.workspace, "created.txt"))).toBe(false)
  })

  it("lets rm -rf delete only through Hold; the agent cannot undo it, the supervisor restores exact bytes", { timeout: 30_000 }, () => {
    const at = fixture(["/bin/rm"])
    const target = join(at.workspace, "protected", "nested", "unique.txt")
    mkdirSync(join(at.workspace, "protected", "nested"), { recursive: true })
    writeFileSync(target, "exact bytes that must survive\n")

    const receipt = runProcess(at, "/bin/rm", ["-rf", "protected"])
    expect(receipt.result).toMatchObject({ outcome: "exited" })
    expect(existsSync(join(at.workspace, "protected"))).toBe(false)

    const deniedUndo = invoke("agent-cli", ["undo", receipt.id, "--workspace", at.workspace], at)
    expect(deniedUndo.status).not.toBe(0)
    expect(existsSync(join(at.workspace, "protected"))).toBe(false)

    const undone = invoke("cli", ["undo", receipt.id, "--workspace", at.workspace], at)
    expect(undone.status, undone.stderr).toBe(0)
    expect(readFileSync(target, "utf8")).toBe("exact bytes that must survive\n")
  })
})
