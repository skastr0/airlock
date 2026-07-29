import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")

const run = (args: ReadonlyArray<string>, home: string) =>
  spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: repository,
    env: { ...process.env, AIRLOCK_HOME: home },
    encoding: "utf8"
  })

const json = (value: string) => JSON.parse(value) as Record<string, unknown>

describe("agent-facing CLI", () => {
  it("discovers the explicit macOS profile envelope and closed action vocabulary", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const doctor = run(["doctor"], home)
    const actions = run(["actions"], home)
    const schema = run(["schema", "plan"], home)

    expect(doctor.status).toBe(0)
    expect(json(doctor.stdout)).toMatchObject({
      platform: "darwin",
      profiles: { compatibility: { available: true } }
    })
    expect(actions.status).toBe(0)
    expect(json(actions.stdout)).toMatchObject({ schemaVersion: "airlock/actions/v1" })
    expect(schema.status).toBe(0)
    expect(json(schema.stdout)).toMatchObject({
      plan: { nodes: ["Capture", "Invoke", "Apply", "RequestExternal"] }
    })
  })

  it("executes argv atoms in compatibility or an explicit native Cell and refuses VM fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const executed = run([
      "exec", "--executable", "/bin/echo", "--arg", "hello world", "--cwd", "/tmp", "--timeout", "1s"
    ], home)
    expect(executed.status).toBe(0)
    expect(json(executed.stdout)).toMatchObject({
      profile: "compatibility",
      executable: "/bin/echo",
      args: ["hello world"],
      stdout: "hello world\n"
    })

    const sourceWorkspace = join(home, "source")
    const privateWorkspace = join(home, "private")
    mkdirSync(sourceWorkspace)
    const native = run([
      "exec", "--executable", "/bin/echo", "--arg", "private", "--cwd", sourceWorkspace,
      "--profile", "native-contained", "--private-workspace", privateWorkspace
    ], home)
    expect(native.status).toBe(0)
    expect(json(native.stdout)).toMatchObject({
      schemaVersion: "airlock/cell-receipt/v1",
      profile: "native-contained",
      network: "deny",
      processReceipt: { stdout: "private\n" }
    })

    const refused = run([
      "exec", "--executable", "/bin/echo", "--cwd", "/tmp", "--profile", "vm-enclosed"
    ], home)
    expect(refused.status).toBe(1)
    expect(json(refused.stderr)).toMatchObject({ _tag: "CliInputError", field: "profile" })
  })

  it("runs pure Airlock programs with JSON bindings and rejects action calls until ProgramRunner exists", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const program = join(home, "program.air")
    const effectful = join(home, "effectful.air")
    writeFileSync(program, 'return greeting + " world"\n')
    writeFileSync(effectful, "file_read(\"private.txt\")\n")

    const pure = run(["run", program, "--bindings", '{"greeting":"hello"}'], home)
    expect(pure.status).toBe(0)
    expect(json(pure.stdout)).toMatchObject({
      schemaVersion: "airlock/program-run/v1",
      result: { returned: true, value: "hello world" }
    })

    const refused = run(["run", effectful], home)
    expect(refused.status).toBe(1)
    expect(json(refused.stderr)).toMatchObject({ _tag: "CliInputError", field: "program" })
  })
})
