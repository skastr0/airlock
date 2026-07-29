import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")

const run = (
  args: ReadonlyArray<string>,
  home: string,
  environment: Readonly<Record<string, string>> = {}
) =>
  spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: repository,
    env: { ...process.env, AIRLOCK_HOME: home, ...environment },
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

  it("inherits the supervisor environment only in compatibility mode", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const executed = run([
      "exec",
      "--executable", "/usr/bin/printenv",
      "--arg", "AIRLOCK_PARITY_SENTINEL",
      "--cwd", "/tmp"
    ], home, { AIRLOCK_PARITY_SENTINEL: "visible-in-compatibility" })

    expect(executed.status).toBe(0)
    expect(json(executed.stdout)).toMatchObject({
      profile: "compatibility",
      stdout: "visible-in-compatibility\n"
    })
  })

  it("runs pure Airlock programs with Schema-decoded JSON bindings", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const program = join(home, "program.air")
    writeFileSync(program, 'return greeting + " world"\n')

    const pure = run(["run", program, "--workspace", home, "--bindings", '{"greeting":"hello"}'], home)
    expect(pure.status).toBe(0)
    expect(json(pure.stdout)).toMatchObject({
      schemaVersion: "airlock/program-run/v1",
      result: { result: "hello world", plans: [] }
    })
  })

  it("loads an immediate project tool definition as an inert namespaced action", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-tools-"))
    const tools = join(home, ".airlock", "tools")
    mkdirSync(join(home, ".airlock"))
    mkdirSync(tools)
    writeFileSync(join(tools, "printf.airlock-tool.json"), JSON.stringify({
      schemaVersion: "airlock/tool-definition/v1",
      id: "printf_json",
      version: "1.0.0",
      executables: [{ realm: "local", selector: "/usr/bin/printf" }],
      actions: [{
        name: "decode",
        inputSchema: {
          type: "object",
          properties: { cwd: { type: "string" }, json: { type: "string" } },
          required: ["cwd", "json"], additionalProperties: false
        },
        outputSchema: {
          type: "object", properties: { ok: { type: "boolean" } },
          required: ["ok"], additionalProperties: false
        },
        args: [{ _tag: "Input", path: ["json"] }],
        cwd: { _tag: "Input", path: ["cwd"] },
        resources: [{ kind: "path", realm: "local", selector: { _tag: "Input", path: ["cwd"] }, rights: ["read"] }],
        lowering: "invoke", effectFootprint: ["invoke"], resultDecoder: "json-stdout"
      }]
    }))
    const program = join(home, "tool.air")
    writeFileSync(program, `return printf_json.decode({ cwd: ${JSON.stringify(home)}, json: "{\\\"ok\\\":true}" })`)

    const executed = run(["run", program, "--workspace", home], home)
    expect(executed.status).toBe(0)
    expect(json(executed.stdout)).toMatchObject({
      result: { result: { ok: true }, plans: [{ actionReference: expect.stringMatching(/^printf_json\.decode@sha256:/) }] }
    })
    const listed = run(["actions"], home)
    expect(listed.status).toBe(0)
    expect(json(listed.stdout)).toMatchObject({ definitions: [expect.objectContaining({ name: "printf_json.decode" })] })
  })

  it("returns a typed partial report when a later program failure aborts after completed actions", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const program = join(home, "partial.air")
    writeFileSync(program, `
      let written = file.write({ path: "partial.txt", content: "first" })
      let staged = http.stage({ endpoint: "https://example.invalid/partial", method: "POST", body: "payload", holdMillis: 60000 })
      assert false, "stop after the partial report is admitted"
      return { written: written, staged: staged }
    `)

    const executed = run(["run", program, "--workspace", home], home)
    expect(executed.status).toBe(1)

    const report = json(executed.stdout) as {
      readonly result: {
        readonly state: string
        readonly result: null
        readonly failure?: {
          readonly action: string
          readonly phase: string
          readonly causeTag?: string
        }
        readonly actions: ReadonlyArray<{
          readonly result: {
            readonly value: Record<string, unknown>
          }
        }>
      }
    }

    expect(report.result.state).toBe("partial")
    expect(report.result.result).toBeNull()
    expect(report.result.failure).toMatchObject({
      action: "program",
      phase: "language",
      causeTag: "AssertionFailed"
    })
    expect(report.result.actions).toHaveLength(2)
    expect(report.result.actions[0]!.result.value).toMatchObject({
      state: "applied",
      act_id: expect.any(String)
    })
    expect(report.result.actions[1]!.result.value).toMatchObject({
      state: "staged",
      emission_id: expect.any(String)
    })
    expect(readFileSync(join(home, "partial.txt"), "utf8")).toBe("first")
  })

  it("runs a real read → process stdin → write → stage program through admission, Runtime, Hold, and Outbox", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const program = join(home, "workflow.air")
    writeFileSync(join(home, "input.txt"), "source bytes\n")
    writeFileSync(program, `
      let observed = file.read({ path: "input.txt" })
      let processed = process.run({ executable: "/bin/cat", args: [], cwd: ${JSON.stringify(home)}, stdin: { kind: "text", value: "source bytes\\n" }, stdout: "capture" })
      let written = file.write({ path: "output.txt", content: "written" })
      let staged = http.stage({ endpoint: "https://example.invalid/jobs", method: "POST", body: "done" })
      return { observed: observed, processed: processed, written: written, staged: staged }
    `)

    const executed = run(["run", program, "--workspace", home], home)
    expect(executed.status).toBe(0)
    expect(readFileSync(join(home, "output.txt"), "utf8")).toBe("written")
    const report = json(executed.stdout)
    expect(report).toMatchObject({
      result: {
        result: {
          observed: "source bytes\n",
          processed: { state: "succeeded", stdout: "source bytes\n" },
          written: { state: "applied", target: expect.stringMatching(/\/output\.txt$/) },
          staged: { state: "staged", endpoint: "https://example.invalid/jobs" }
        },
        plans: expect.any(Array)
      }
    })
    const artifacts = (report.result as { artifacts: Array<Record<string, unknown>> }).artifacts
    expect(artifacts.length).toBeGreaterThan(0)
    expect(artifacts.every((artifact) => !("bytes" in artifact))).toBe(true)
  })

  it("refuses native-contained program execution without independent supervisor policy input", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-"))
    const program = join(home, "program.air")
    writeFileSync(program, "return true\n")
    const refused = run(["run", program, "--workspace", home, "--profile", "native-contained"], home)
    expect(refused.status).toBe(1)
    expect(json(refused.stderr)).toMatchObject({ _tag: "CliInputError", field: "AIRLOCK_POLICY_FILE" })

    const policy = join(home, "native-policy.json")
    writeFileSync(policy, JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:test",
      realm: "local",
      admittedBy: "operator:test",
      pathAllowlist: [`${home}/**`],
      executableAllowlist: [],
      endpointAllowlist: []
    }))
    const downgrade = run(
      ["run", program, "--workspace", home, "--profile", "compatibility"],
      home,
      { AIRLOCK_POLICY_FILE: policy }
    )
    expect(downgrade.status).toBe(1)
    expect(json(downgrade.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "AIRLOCK_POLICY_FILE"
    })
  })
})
