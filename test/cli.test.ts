import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")

type Fixture = Readonly<{ root: string; workspace: string; home: string }>

const fixture = (): Fixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-cli-")))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  return { root, workspace, home: join(root, "home") }
}

const cli = (
  at: Fixture,
  args: ReadonlyArray<string>,
  options: { readonly policy?: unknown; readonly entry?: "cli" | "agent-cli" } = {}
) => {
  const environment: Record<string, string | undefined> = { ...process.env, AIRLOCK_HOME: at.home }
  delete environment["AIRLOCK_SEAL"]
  delete environment["AIRLOCK_POLICY_FILE"]
  if (options.policy !== undefined) {
    const file = join(at.root, "policy.json")
    writeFileSync(file, typeof options.policy === "string" ? options.policy : JSON.stringify(options.policy))
    environment["AIRLOCK_POLICY_FILE"] = file
  }
  return spawnSync("bun", [join(repository, "src", `${options.entry ?? "cli"}.ts`), ...args], {
    cwd: at.workspace,
    env: environment,
    encoding: "utf8",
    timeout: 45_000
  })
}

type Outcome = {
  readonly ok: boolean
  readonly result?: unknown
  readonly reason?: string
  readonly toolCalls: number
}

const evaluate = (at: Fixture, source: string, extra: ReadonlyArray<string> = [], policy?: unknown) => {
  const ran = cli(at, ["eval", "--workspace", at.workspace, "--source", source, ...extra], { policy })
  const report = JSON.parse(ran.stdout) as { readonly runId: string; readonly workspace: string; readonly outcome: Outcome }
  return { ...report, status: ran.status }
}

const json = (stdout: string) => JSON.parse(stdout) as unknown

/** A policy over `workspace` that grants these file tools, each when it says. */
const filePolicy = (workspace: string, grants: ReadonlyArray<readonly [tool: string, when: "now" | "approved"]>) => ({
  schemaVersion: "airlock/tool-policy/v1",
  toolGrants: grants.map(([tool, when]) => ({ id: tool, tool, when })),
  resources: { path: [workspace] },
  budget: { maxCalls: 16, maxInputBytes: 100_000 }
})

const write = (path: string, content: string) =>
  `let w = file.write({ path: ${JSON.stringify(path)}, content: ${JSON.stringify(content)} })\nreturn w`

describe("airlock CLI", () => {
  it("describes the file tools of the default policy and nothing else", () => {
    const at = fixture()
    const described = cli(at, ["describe", "--workspace", at.workspace])
    expect(described.status, described.stderr).toBe(0)
    const { actions, description } = json(described.stdout) as {
      readonly actions: ReadonlyArray<{ readonly name: string }>
      readonly description: string
    }
    expect(actions.map((action) => action.name)).toEqual([
      "file.copy", "file.glob", "file.inspect", "file.list", "file.mkdir",
      "file.move", "file.read", "file.remove", "file.stat", "file.write"
    ])
    expect(description).toContain("file.write(")
  })

  it("refuses a program that calls an ungranted tool before anything runs", () => {
    const at = fixture()
    const marker = join(at.workspace, "ran.txt")
    const run = evaluate(at, `return process.run({ executable: "/usr/bin/touch", args: [${JSON.stringify(marker)}], cwd: "." })`)
    expect(run.status).toBe(1)
    expect(run.outcome).toMatchObject({ ok: false, reason: "invalid_code", toolCalls: 0 })
    expect(existsSync(marker)).toBe(false)
  })

  it("runs a program file with bindings and binds the workspace itself", () => {
    const at = fixture()
    const program = join(at.root, "greet.air")
    writeFileSync(program, `return { greeting: "hello " + name, workspace: workspace }\n`)
    const ran = cli(at, ["run", program, "--workspace", at.workspace, "--bindings", JSON.stringify({ name: "ada" })])
    expect(ran.status, ran.stderr).toBe(0)
    expect(json(ran.stdout)).toMatchObject({
      workspace: at.workspace,
      outcome: { ok: true, result: { greeting: "hello ada", workspace: at.workspace }, toolCalls: 0 }
    })

    const reserved = cli(at, ["run", program, "--workspace", at.workspace, "--bindings", JSON.stringify({ workspace: "/" })])
    expect(reserved.status).toBe(1)
    expect(reserved.stdout).toBe("")
    expect(json(reserved.stderr)).toMatchObject({ _tag: "CliInputError", field: "bindings" })
  })

  it("changes a file at once through Hold, and undo puts the old content back", () => {
    const at = fixture()
    const target = join(at.workspace, "note.txt")
    writeFileSync(target, "old")
    const run = evaluate(at, write("note.txt", "new"))
    expect(run.status).toBe(0)
    const receipt = run.outcome.result as { readonly state: string; readonly id: string }
    expect(receipt).toMatchObject({ state: "done", result: { previous_held: true, bytes: 3 } })
    expect(readFileSync(target, "utf8")).toBe("new")

    const undone = cli(at, ["undo", receipt.id, "--workspace", at.workspace])
    expect(undone.status, undone.stderr).toBe(0)
    expect(readFileSync(target, "utf8")).toBe("old")

    const ledger = cli(at, ["ledger"])
    expect(ledger.status, ledger.stderr).toBe(0)
    expect(ledger.stdout).toContain(receipt.id)
  })

  it("returns the recorded call when the same run id runs again, and never changes a file twice", () => {
    const at = fixture()
    const target = join(at.workspace, "note.txt")
    writeFileSync(target, "hello")
    const read = `let r = file.read({ path: "note.txt", format: "text" })\nreturn r`
    const first = evaluate(at, read, ["--run-id", "read-once"])
    const again = evaluate(at, read, ["--run-id", "read-once"])
    expect(first.outcome).toMatchObject({ ok: true, result: { state: "done", result: "hello" } })
    expect(again.outcome.result).toEqual(first.outcome.result)

    // A change is bound to the file as it was; once the file is not, the
    // recorded call cannot be the one this run would make.
    expect(evaluate(at, write("note.txt", "airlock"), ["--run-id", "write-once"]).status).toBe(0)
    writeFileSync(target, "edited by a person")
    const replayed = evaluate(at, write("note.txt", "airlock"), ["--run-id", "write-once"])
    expect(replayed.status).toBe(1)
    expect(replayed.outcome).toMatchObject({ ok: false, reason: "tool_failed", failure: { code: "conflict" } })
    expect(readFileSync(target, "utf8")).toBe("edited by a person")
  })

  it("refuses paths that leave the workspace: dot-dot, absolute and through a symlink", () => {
    const at = fixture()
    const outside = join(at.root, "outside.txt")
    writeFileSync(outside, "outside")
    symlinkSync(outside, join(at.workspace, "link.txt"))

    for (const path of ["../outside.txt", outside, "link.txt"]) {
      const run = evaluate(at, write(path, "escaped"))
      expect(run.status, path).toBe(0)
      expect(run.outcome.result, path).toMatchObject({ state: "refused", refusal: { code: "not-allowed" } })
    }
    expect(readFileSync(outside, "utf8")).toBe("outside")
  })

  it("stages a change the policy holds for approval; a person commits or cancels it", () => {
    const at = fixture()
    const policy = filePolicy(at.workspace, [["file.write", "approved"]])
    const staged = evaluate(at, write("kept.txt", "kept"), [], policy)
    const dropped = evaluate(at, write("dropped.txt", "dropped"), [], policy)
    for (const run of [staged, dropped]) {
      expect(run.status).toBe(0)
      expect(run.outcome.result).toMatchObject({ state: "staged", id: expect.any(String) })
    }
    const keptId = (staged.outcome.result as { readonly id: string }).id
    const droppedId = (dropped.outcome.result as { readonly id: string }).id
    expect(existsSync(join(at.workspace, "kept.txt"))).toBe(false)

    const pending = cli(at, ["pending", "--workspace", at.workspace], { policy })
    expect(pending.status, pending.stderr).toBe(0)
    expect((json(pending.stdout) as ReadonlyArray<{ readonly id: string }>).map((call) => call.id).sort())
      .toEqual([keptId, droppedId].sort())

    expect(cli(at, ["commit", keptId, "--workspace", at.workspace], { policy }).status).toBe(0)
    expect(cli(at, ["cancel", droppedId, "--workspace", at.workspace], { policy }).status).toBe(0)
    expect(readFileSync(join(at.workspace, "kept.txt"), "utf8")).toBe("kept")
    expect(existsSync(join(at.workspace, "dropped.txt"))).toBe(false)
    expect(json(cli(at, ["pending", "--workspace", at.workspace], { policy }).stdout)).toEqual([])
  })

  it("runs a reviewed program under its approved plan, and refuses a different program under it", () => {
    const at = fixture()
    writeFileSync(join(at.workspace, "note.txt"), "hello")
    const policy = filePolicy(at.workspace, [["file.read", "approved"]])
    const read = (path: string) =>
      `let r = file.read({ path: ${JSON.stringify(path)}, format: "text" })\nreturn r.state`

    expect(evaluate(at, read("note.txt"), [], policy).outcome).toMatchObject({ ok: true, result: "staged" })

    const reviewed = cli(at, ["review", "--source", read("note.txt"), "--workspace", at.workspace], { policy })
    expect(reviewed.status, reviewed.stderr).toBe(0)
    const { review, approved } = json(reviewed.stdout) as { readonly review: { readonly plan: { readonly id: string } }; readonly approved: boolean }
    expect(approved).toBe(false)

    const approve = cli(at, ["approve-plan", review.plan.id, "--workspace", at.workspace], { policy })
    expect(approve.status, approve.stderr).toBe(0)
    expect(json(cli(at, ["review", "--source", read("note.txt"), "--workspace", at.workspace], { policy }).stdout))
      .toMatchObject({ approved: true })

    const planned = evaluate(at, read("note.txt"), ["--plan", review.plan.id], policy)
    expect(planned.outcome).toMatchObject({ ok: true, result: "done" })

    const other = evaluate(at, read("other.txt"), ["--plan", review.plan.id], policy)
    expect(other.status).toBe(1)
    expect(other.outcome).toMatchObject({ ok: false, reason: "plan_mismatch", toolCalls: 0 })
  })

  it("runs in the workspace the directory really is, and refuses one that is not a directory", () => {
    const at = fixture()
    const alias = join(at.root, "alias")
    symlinkSync(at.workspace, alias)
    const viaAlias = cli(at, ["eval", "--workspace", alias, "--source", "return workspace"])
    expect(viaAlias.status, viaAlias.stderr).toBe(0)
    expect(json(viaAlias.stdout)).toMatchObject({ workspace: at.workspace, outcome: { result: at.workspace } })

    const file = join(at.root, "file.txt")
    writeFileSync(file, "")
    for (const workspace of [join(at.root, "missing"), file]) {
      const ran = cli(at, ["eval", "--workspace", workspace, "--source", "return 1"])
      expect(ran.status, workspace).toBe(1)
      expect(ran.stdout, workspace).toBe("")
      expect(json(ran.stderr), workspace).toMatchObject({ _tag: "CliInputError", field: "workspace" })
    }
  })

  it("rejects a policy file that is not exactly a tool policy", () => {
    const at = fixture()
    for (const policy of ["not json", { ...filePolicy(at.workspace, []), extra: true }]) {
      const ran = cli(at, ["eval", "--workspace", at.workspace, "--source", "return 1"], { policy })
      expect(ran.status).toBe(1)
      expect(ran.stdout).toBe("")
      expect(json(ran.stderr)).toMatchObject({ _tag: "CliInputError", field: "AIRLOCK_POLICY_FILE" })
    }
  })

  it("gives the agent's binary no command that decides", () => {
    const at = fixture()
    const help = cli(at, ["--help"], { entry: "agent-cli" })
    expect(help.status).toBe(0)
    for (const command of ["approve-plan", "commit", "cancel", "undo"]) {
      const ran = cli(at, [command, "emi_0", "--workspace", at.workspace], { entry: "agent-cli" })
      expect(ran.status, command).not.toBe(0)
      expect(ran.stdout, command).toBe("")
    }
    const described = cli(at, ["describe", "--workspace", at.workspace], { entry: "agent-cli" })
    expect(described.status, described.stderr).toBe(0)
  })
})
