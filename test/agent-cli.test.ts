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
import { nativeContainmentSupported } from "./support/NativeContainmentTest.ts"

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

const isolatedWorkspace = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = join(root, "home")
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  return { home, workspace } as const
}

describe("agent-only CLI surface", () => {
  it("accepts source directly and routes effects through admitted program execution", { timeout: 30_000 }, () => {
    const { home, workspace } = isolatedWorkspace("airlock-agent-cli-")
    const executed = run([
      "eval",
      "--workspace", workspace,
      "--source", 'let receipt = file.write({ path: "result.txt", content: "airlocked" })\nreturn receipt'
    ], home)

    expect(executed.status).toBe(0)
    expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("airlocked")
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

  it("binds file.stat bytes exactly and does not invent a size alias", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-stat-result-"))
    writeFileSync(join(home, "f"), "three")

    const bytes = run([
      "eval", "--workspace", home, "--source",
      'let s = file.stat({ path: "f" })\nreturn s.bytes'
    ], home)
    expect(bytes.status, bytes.stderr).toBe(0)
    expect(json(bytes.stdout)).toMatchObject({ result: { result: 5 } })

    const size = run([
      "eval", "--workspace", home, "--source",
      'let s = file.stat({ path: "f" })\nreturn s.size'
    ], home)
    expect(size.status).toBe(1)
    expect(json(size.stdout)).toMatchObject({
      result: {
        failure: {
          phase: "language",
          causeTag: "MissingRecordField"
        }
      }
    })
  })

  it("normalizes Duration sugar for namespaced actions without weakening strict decoding", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-duration-"))
    const processRun = run([
      "eval",
      "--workspace", home,
      "--source",
      `return process.run({ executable: "/usr/bin/true", args: [], cwd: ${JSON.stringify(home)}, timeout: 2s })`
    ], home)

    expect(processRun.status, processRun.stderr).toBe(0)
    expect(json(processRun.stdout)).toMatchObject({
      result: {
        actions: [{
          request: {
            call: {
              input: {
                action: "process.run",
                timeoutMs: 2_000
              }
            }
          }
        }]
      }
    })

    const body = "plain staged body"
    const staged = run([
      "eval",
      "--workspace", home,
      "--source",
      `return http.stage({ endpoint: "https://example.test/body", method: "POST", body: ${JSON.stringify(body)}, hold: 3s })`
    ], home)
    expect(staged.status, staged.stderr).toBe(0)
    expect(json(staged.stdout)).toMatchObject({
      result: {
        result: {
          state: "staged",
          hold_millis: 3_000
        },
        actions: [{
          request: {
            call: {
              input: {
                action: "http.stage",
                body,
                holdMillis: 3_000
              }
            }
          }
        }]
      }
    })

    const pending = run(["pending"], home)
    expect(pending.status, pending.stderr).toBe(0)
    expect(JSON.parse(pending.stdout)).toEqual([
      expect.objectContaining({
        intent: expect.objectContaining({
          bodyBytes: new TextEncoder().encode(body).byteLength
        })
      })
    ])

    for (const source of [
      `return process.run({ executable: "/usr/bin/true", args: [], cwd: ${JSON.stringify(home)}, timeout: 2s, unexpected: true })`,
      'return http.stage({ endpoint: "https://example.test/body", method: "POST", hold: 3s, unexpected: true })'
    ]) {
      const rejected = run(["eval", "--workspace", home, "--source", source], home)
      expect(rejected.status).toBe(1)
      expect(json(rejected.stdout)).toMatchObject({
        result: {
          state: "failed",
          failure: {
            phase: "contract",
            causeTag: "ProgramActionDecodeFailed",
            reason: expect.stringContaining("unexpected")
          }
        }
      })
    }
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

  it("advertises the implemented finite control surface", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-schema-"))
    const discovered = run(["schema", "language"], home)

    expect(discovered.status, discovered.stderr).toBe(0)
    expect(json(discovered.stdout)).toMatchObject({
      schemaVersion: "airlock/discovery/v1",
      language: {
        syntax: "airlock",
        effects: "identifier ActionResolver calls only",
        control: [
          "let",
          "if",
          "for finite range",
          "for captured list",
          "return",
          "assert"
        ]
      }
    })
  })

  it("publishes native input and exact evaluator result Schemas on every schema surface", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-agent-action-schema-"))
    const discovered = run(["schema", "process.run"], home)

    expect(discovered.status, discovered.stderr).toBe(0)
    const contract = json(discovered.stdout)
    expect(contract).toMatchObject({
      schemaVersion: "airlock/discovery/v1",
      action: {
        name: "process.run",
        node: "Invoke",
        inputSchema: {
          type: "object",
          required: ["executable", "args", "cwd"],
          properties: {
            executable: { type: "string" },
            args: {
              type: "array",
              items: { type: "string" }
            },
            timeoutMs: { type: "number" }
          },
          additionalProperties: false
        },
        resultSchema: {
          type: "object",
          required: [
            "state",
            "plan_id",
            "process_outcome",
            "exit_code",
            "signal",
            "stdout",
            "stderr",
            "stdout_artifact",
            "stderr_artifact",
            "delta_artifact",
            "recovery",
            "receipts"
          ],
          properties: {
            state: { enum: ["succeeded", "failed", "partial"] },
            stdout: { anyOf: [{ type: "string" }, { type: "null" }] },
            stdout_artifact: { $ref: "#/$defs/NativeProcessArtifactResult" },
            receipts: {
              type: "array",
              items: {
                required: ["node_id", "sequence", "state", "error_tag", "output_artifacts"]
              }
            }
          },
          additionalProperties: false
        }
      }
    })
    const inputSchema = (contract.action as {
      readonly inputSchema: {
        readonly properties: Readonly<Record<string, unknown>>
      }
    }).inputSchema
    expect(inputSchema.properties).not.toHaveProperty("action")

    const write = run(["schema", "file.write"], home)
    expect(write.status, write.stderr).toBe(0)
    const writeAction = json(write.stdout).action as {
      readonly inputSchema: {
        readonly required: ReadonlyArray<string>
        readonly properties: Readonly<Record<string, unknown>>
      }
      readonly resultSchema: {
        readonly properties: Readonly<Record<string, unknown>>
      }
    }
    expect(writeAction.inputSchema.required).toEqual(expect.arrayContaining(["path"]))
    expect(writeAction.inputSchema.properties).toHaveProperty("path")
    expect(writeAction.inputSchema.properties).not.toHaveProperty("target")
    expect(writeAction.resultSchema.properties).toHaveProperty("target")

    const stat = run(["schema", "file.stat"], home)
    expect(stat.status, stat.stderr).toBe(0)
    const statAction = json(stat.stdout).action as {
      readonly resultSchema: {
        readonly required: ReadonlyArray<string>
        readonly properties: Readonly<Record<string, unknown>>
      }
    }
    expect(statAction.resultSchema).toMatchObject({
      required: ["path", "kind", "bytes", "mode", "device", "inode"],
      properties: { bytes: { type: "number" } }
    })
    expect(statAction.resultSchema.properties).not.toHaveProperty("size")

    const read = run(["schema", "file.read"], home)
    expect(read.status, read.stderr).toBe(0)
    const readSchema = (json(read.stdout).action as {
      readonly resultSchema: {
        readonly anyOf: ReadonlyArray<unknown>
        readonly $defs: Readonly<Record<string, { readonly anyOf: ReadonlyArray<unknown> }>>
      }
    }).resultSchema
    expect(readSchema.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "string", title: "text" }),
      expect.objectContaining({
        type: "array",
        title: "bytes",
        items: { type: "number" }
      }),
      { $ref: "#/$defs/AirlockLanguageValue" }
    ]))
    expect(readSchema.$defs.AirlockLanguageValue?.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "number" }),
      expect.objectContaining({ type: "boolean" }),
      expect.objectContaining({ type: "null" }),
      expect.objectContaining({ type: "array" }),
      expect.objectContaining({ type: "object" })
    ]))

    for (const subject of ["actions", "all"]) {
      const aggregate = run(["schema", subject], home)
      expect(aggregate.status, aggregate.stderr).toBe(0)
      const actions = json(aggregate.stdout).actions as ReadonlyArray<{
        readonly name: string
        readonly resultSchema?: unknown
      }>
      expect(actions).toHaveLength(12)
      expect(actions.every((action) => action.resultSchema !== undefined)).toBe(true)
      expect(actions.find((action) => action.name === "file.stat")).toMatchObject({
        resultSchema: {
          properties: { bytes: { type: "number" } }
        }
      })
    }

    const rejected = run(["schema", "not.an.action"], home)
    expect(rejected.status).toBe(1)
    expect(json(rejected.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "subject",
      reason: expect.stringContaining("native action name")
    })
  })

  it("offers compact agent run and eval projections without changing the full default", { timeout: 30_000 }, () => {
    const { home, workspace } = isolatedWorkspace("airlock-agent-compact-")
    const source = [
      'let first = file.write({ path: "first.txt", content: "one" })',
      'let second = file.write({ path: "second.txt", content: "two" })',
      'let observed = file.read({ path: "second.txt", format: "text" })',
      "return { first: first, second: second, observed: observed }"
    ].join("\n")
    const full = run([
      "eval",
      "--workspace", workspace,
      "--source", source
    ], home)
    const compact = run([
      "eval",
      "--compact",
      "--workspace", workspace,
      "--source", source
    ], home)

    expect(full.status, full.stderr).toBe(0)
    expect(compact.status, compact.stderr).toBe(0)
    const fullReport = json(full.stdout) as {
      readonly result: Readonly<Record<string, unknown>>
    }
    const compactReport = json(compact.stdout) as {
      readonly result: Readonly<Record<string, unknown>>
    }
    expect(fullReport.result).toHaveProperty("actions")
    expect(compactReport.result).not.toHaveProperty("actions")
    expect(compactReport).toMatchObject({
      schemaVersion: "airlock/program-run/v1",
      profile: "compatibility",
      workspace: resolve(workspace),
      result: {
        state: "succeeded",
        result: {
          observed: "two"
        },
        counts: {
          plans: 3,
          actions: 3,
          artifacts: 2
        }
      }
    })
    const compactResult = compactReport.result as {
      readonly plans: ReadonlyArray<unknown>
      readonly artifacts: ReadonlyArray<unknown>
    }
    expect(compactResult.plans).toHaveLength(3)
    expect(compactResult.plans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.any(String),
        actionReference: expect.any(String),
        nodeCount: 1
      })
    ]))
    expect(compactResult.artifacts).toHaveLength(2)
    expect(compactResult.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.any(String),
        mediaType: "text/plain; charset=utf-8",
        byteLength: 3,
        provenance: "program:inline-content"
      })
    ]))
    expect(compact.stdout.length).toBeLessThan(full.stdout.length)
    expect(full.stdout.length - compact.stdout.length).toBeGreaterThan(1_000)

    const program = join(workspace, "compact.air")
    writeFileSync(program, source)
    const compactRun = run([
      "run",
      "--compact",
      "--workspace", workspace,
      program
    ], home)
    expect(compactRun.status, compactRun.stderr).toBe(0)
    expect(json(compactRun.stdout)).toMatchObject({
      result: {
        state: "succeeded",
        counts: {
          plans: 3,
          actions: 3
        }
      }
    })
  })

  it("exposes redacted durable Runtime receipts by Plan id", { timeout: 30_000 }, () => {
    const { home, workspace } = isolatedWorkspace("airlock-agent-runs-")
    const executed = run([
      "eval",
      "--workspace", workspace,
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
    const second = run([
      "eval",
      "--workspace", workspace,
      "--source",
      'return file.read({ path: "journaled.txt", format: "text" })'
    ], home)
    expect(second.status, second.stderr).toBe(0)

    const listed = run(["runs", "--limit", "1"], home)
    expect(listed.status, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ state: "succeeded" })
    ])

    const invalid = run(["runs", "--limit", "0"], home)
    expect(invalid.status).toBe(1)
    expect(json(invalid.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "limit",
      reason: "must be an integer from 1 through 100"
    })
  })

  it.skipIf(
    !nativeContainmentSupported ||
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
