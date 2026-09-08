import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-review-cli-")))
  const source = join(root, "candidate"), target = join(root, "live"), home = join(root, "home")
  writeFileSync(source, "new\n"); writeFileSync(target, "old\n")
  return { root, source, target, home }
}
const environment = (home: string) => ({ ...process.env, AIRLOCK_HOME: home, AIRLOCK_SEAL: undefined, AIRLOCK_AGENT_SURFACE: undefined })
const run = (home: string, args: string[], agent = false) => spawnSync("bun", [agent ? "src/agent-cli.ts" : "src/cli.ts", "change", ...args], {
  cwd: repository, env: environment(home), encoding: "utf8", timeout: 30_000
})
const json = (result: ReturnType<typeof run>) => {
  expect(result.status, result.stderr || result.stdout).toBe(0)
  return JSON.parse(result.stdout)
}
const stage = (f: ReturnType<typeof fixture>) => json(run(f.home, ["stage", "--source", f.source, "--target", f.target]))

// A real Unix PTY exercises isTTY and readline, not a mocked approval function.
const approve = (home: string, id: string, answer: string, mutation?: { path: string, text: string }) => {
  const driver = String.raw`
import errno, json, os, pty, select, signal, sys, time
data = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bun", ["bun", "src/cli.ts", "change", "approve", data["id"]])
output = bytearray()
sent = False
deadline = time.monotonic() + 25
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                part = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
            if not part: break
            output.extend(part)
        if not sent and b"Type APPLY," in output:
            if data.get("mutation"):
                with open(data["mutation"]["path"], "w") as file:
                    file.write(data["mutation"]["text"])
            os.write(fd, data["answer"].encode())
            sent = True
    else:
        os.kill(pid, signal.SIGKILL)
        raise RuntimeError("terminal approval timed out")
finally:
    os.close(fd)
_, status = os.waitpid(pid, 0)
print(json.dumps({"code": os.waitstatus_to_exitcode(status), "output": output.decode("utf8", "replace"), "prompted": sent}))
`
  const result = spawnSync("python3", ["-c", driver, JSON.stringify({ id, answer, mutation })], {
    cwd: repository, env: environment(home), encoding: "utf8", timeout: 30_000
  })
  expect(result.status, result.stderr).toBe(0)
  const value = JSON.parse(result.stdout)
  expect(value.prompted, value.output).toBe(true)
  return value as { code: number, output: string, prompted: boolean }
}

describe("repeated-use review CLI", () => {
  it("refuses redirected read leases without truncating an outside lock file", () => {
    const f = fixture(), outside = join(f.root, "outside")
    mkdirSync(f.home)
    mkdirSync(outside, { mode: 0o700 })
    const sentinel = join(outside, "lock")
    writeFileSync(sentinel, "not an Airlock lock")
    symlinkSync(outside, join(f.home, "changes"))
    const result = run(f.home, ["inbox"])
    expect(readFileSync(sentinel, "utf8")).toBe("not an Airlock lock")
    expect(result.status, result.stdout).toBe(1)
  })

  it("shows empty inventory without allocating a change store", () => {
    const f = fixture()
    expect(json(run(f.home, ["inbox"])).rows).toEqual([])
    expect(existsSync(join(f.home, "changes"))).toBe(false)
    const human = run(f.home, ["inbox", "--human"])
    expect(human.status, human.stderr).toBe(0)
    expect(human.stdout).toContain("No proposals")
  })

  it("renders safe previews and reads frozen changes beyond the preview limit", () => {
    const f = fixture()
    writeFileSync(f.source, "x".repeat(9000) + "\nLATE-CHANGE\u001b[2J\n")
    const proposal = stage(f)
    writeFileSync(f.source, "mutable source must not be read")
    const human = run(f.home, ["review", proposal.id, "--human"])
    expect(human.status, human.stderr).toBe(0)
    expect(human.stdout).toContain("TRUNCATED")
    const content = json(run(f.home, ["content", proposal.id, "--side", "after", "--path", "", "--offset", "9000"], true))
    expect(Buffer.from(content.dataBase64, "base64").toString()).toContain("LATE-CHANGE\u001b[2J")
    const page = run(f.home, ["content", proposal.id, "--side", "after", "--path", "", "--offset", "9000", "--human"])
    expect(page.status, page.stderr).toBe(0)
    expect(page.stdout).toContain("LATE-CHANGE\\u001b[2J")
    expect(page.stdout).not.toContain("\u001b")
    expect(run(f.home, ["content", proposal.id, "--side", "after", "--path", "../candidate"]).status).toBe(1)
  })

  it("binds real terminal approval to the displayed snapshot and refuses piped approval", () => {
    const f = fixture(), proposal = stage(f)
    expect(run(f.home, ["approve", proposal.id]).status).toBe(1)
    const approved = approve(f.home, proposal.id, "APPLY\n", { path: f.source, text: "later source" })
    expect(approved.code, approved.output).toBe(0)
    expect(approved.output).toContain(proposal.proposalDigest)
    expect(approved.output).toContain('"state": "installed"')
    expect(readFileSync(f.target, "utf8")).toBe("new\n")
  })

  it("decline and terminal EOF leave the proposal staged; drift at confirmation refuses", () => {
    const f = fixture(), proposal = stage(f)
    for (const answer of ["no\n", "\u0004"]) {
      const declined = approve(f.home, proposal.id, answer)
      expect(declined.code, declined.output).toBe(0)
      expect(declined.output).toContain("not-approved")
      expect(json(run(f.home, ["status", proposal.id])).state).toBe("staged")
    }
    const drift = approve(f.home, proposal.id, "APPLY\n", { path: f.target, text: "operator edit" })
    expect(drift.code, drift.output).toBe(1)
    expect(readFileSync(f.target, "utf8")).toBe("operator edit")
  })

  it("discovers separate outcomes and collects only retired snapshots while preserving undo", () => {
    const f = fixture(), proposal = stage(f)
    const applied = json(run(f.home, ["apply", proposal.id, "--expect-digest", proposal.proposalDigest]))
    const row = json(run(f.home, ["inbox"])).rows[0]
    expect(row.applyState).toBe("installed")
    expect(row.undoState).toBe("unclaimed")
    expect(run(f.home, ["retire", proposal.id, "--expect-digest", proposal.proposalDigest]).status).toBe(1)
    expect(json(run(f.home, ["retire", proposal.id, "--expect-digest", row.retirementDigest])).state).toBe("retired")
    expect(json(run(f.home, ["collect", proposal.id])).state).toBe("collected")
    expect(json(run(f.home, ["inbox"])).rows[0].snapshots.state).toBe("collected")
    expect(run(f.home, ["content", proposal.id, "--side", "after", "--path", ""]).status).toBe(1)
    expect(json(run(f.home, ["undo", applied.receiptId])).state).toBe("undone")
    expect(readFileSync(f.target, "utf8")).toBe("old\n")
  })

  it("renders binary content and hostile target names as data", () => {
    const f = fixture()
    f.target = join(f.root, "live\u001b[2J\u202econfig")
    writeFileSync(f.target, "old\n")
    writeFileSync(f.source, Buffer.from([0, 255, 27, 10]))
    const proposal = stage(f)
    const reviewed = run(f.home, ["review", proposal.id, "--human"])
    expect(reviewed.status, reviewed.stderr).toBe(0)
    expect(reviewed.stdout).toContain("BINARY")
    expect(reviewed.stdout).toContain("\\u001b[2J\\u202econfig")
    expect(reviewed.stdout).not.toMatch(/[\u001b\u202e]/)
    const content = run(f.home, ["content", proposal.id, "--side", "after", "--path", "", "--human"])
    expect(content.status, content.stderr).toBe(0)
    expect(content.stdout).toContain("AP8bCg==")
  })

  it("keeps successful apply distinct from rejected undo and exposes corrupt rows", () => {
    const f = fixture(), proposal = stage(f)
    const applied = json(run(f.home, ["apply", proposal.id, "--expect-digest", proposal.proposalDigest]))
    writeFileSync(f.target, "operator edit")
    expect(run(f.home, ["undo", applied.receiptId]).status).toBe(1)
    const view = run(f.home, ["inbox", "--human"])
    expect(view.status, view.stderr).toBe(0)
    expect(view.stdout).toContain("apply=installed  undo=rejected")
    expect(view.stdout).toContain("live target NOT CHECKED")
    writeFileSync(join(f.home, "changes", proposal.id, "proposal.json"), "corrupt")
    const broken = json(run(f.home, ["inbox"]))
    expect(broken.rows).toHaveLength(1)
    expect(broken.rows[0].errors.length).toBeGreaterThan(0)
    expect(run(f.home, ["inbox", "--human"]).stdout).toContain("ERROR")
  })

  it("does not expose approval or lifecycle authority to the agent", () => {
    const f = fixture(), proposal = stage(f)
    for (const args of [["approve", proposal.id], ["retire", proposal.id, "--expect-digest", proposal.proposalDigest], ["collect", proposal.id]]) {
      expect(run(f.home, args, true).status).not.toBe(0)
    }
    const help = run(f.home, ["--help"], true)
    expect(help.stdout).not.toMatch(/change (approve|retire|collect)\b/)
    expect(readFileSync(f.target, "utf8")).toBe("old\n")
  })
})
