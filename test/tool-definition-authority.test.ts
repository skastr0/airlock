import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")

const ProgramFailureReport = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/program-run/v1"),
  profile: Schema.Literal("native-contained"),
  result: Schema.Struct({
    state: Schema.Literal("failed"),
    plans: Schema.Array(
      Schema.Struct({
        actionReference: Schema.String,
        nodes: Schema.Array(
          Schema.Struct({
            kind: Schema.String
          })
        )
      })
    ),
    failure: Schema.Struct({
      action: Schema.String,
      phase: Schema.String,
      causeTag: Schema.optional(Schema.String),
      reason: Schema.String
    })
  })
})

const ActionDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/actions/v1"),
  definitions: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      executable: Schema.Array(Schema.String)
    })
  )
})

const entries = (directory: string) =>
  existsSync(directory) ? readdirSync(directory) : []

describe("tool-definition authority", () => {
  it(
    "loads a project definition as data but denies its ungranted executable before execution",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "airlock-definition-authority-"))
      const workspace = join(root, "workspace")
      const toolDirectory = join(workspace, ".airlock", "tools")
      const home = join(root, "home")
      const policy = join(root, "policy.json")
      const program = join(workspace, "probe.air")
      mkdirSync(toolDirectory, { recursive: true })

      writeFileSync(
        join(toolDirectory, "authority-probe.airlock-tool.json"),
        JSON.stringify({
          schemaVersion: "airlock/tool-definition/v1",
          id: "authority_probe",
          version: "1.0.0",
          executables: [
            { realm: "local", selector: "/usr/bin/printf" }
          ],
          actions: [
            {
              name: "run",
              inputSchema: {
                type: "object",
                properties: { cwd: { type: "string" } },
                required: ["cwd"],
                additionalProperties: false
              },
              args: [
                { _tag: "Literal", value: "definition-executed" }
              ],
              cwd: { _tag: "Input", path: ["cwd"] },
              resources: [
                {
                  kind: "path",
                  realm: "local",
                  selector: { _tag: "Input", path: ["cwd"] },
                  rights: ["read"]
                }
              ],
              lowering: "invoke",
              effectFootprint: ["invoke"],
              resultDecoder: "none"
            }
          ]
        })
      )
      writeFileSync(
        policy,
        JSON.stringify({
          schemaVersion: "airlock/admission-policy/v1",
          profile: "native-contained",
          principal: "agent:definition-authority-test",
          realm: "local",
          admittedBy: "operator:definition-authority-test",
          pathAllowlist: [`${workspace}/**`],
          executableAllowlist: ["/bin/true"],
          endpointAllowlist: []
        })
      )
      writeFileSync(
        program,
        `return authority_probe.run({ cwd: ${JSON.stringify(workspace)} })\n`
      )

      const environment = {
        ...process.env,
        HOME: root,
        AIRLOCK_HOME: home,
        AIRLOCK_AGENT_PROFILE: "native-contained",
        AIRLOCK_POLICY_FILE: policy
      }
      const invoke = (args: ReadonlyArray<string>) =>
        spawnSync("bun", ["src/agent-cli.ts", ...args], {
          cwd: repository,
          env: environment,
          encoding: "utf8",
          timeout: 30_000
        })

      const discovered = invoke(["actions", "--workspace", workspace])
      expect(discovered.status, discovered.stderr).toBe(0)
      const catalog = Schema.decodeUnknownSync(ActionDiscovery)(
        JSON.parse(discovered.stdout)
      )
      expect(catalog.definitions).toContainEqual({
        name: "authority_probe.run",
        executable: ["/usr/bin/printf"]
      })

      const downgrade = invoke([
        "run",
        program,
        "--workspace",
        workspace,
        "--profile=compatibility"
      ])
      expect(downgrade.status).toBe(64)
      expect(downgrade.stderr).toContain(
        "airlock-agent rejects --profile"
      )

      const executed = invoke(["run", program, "--workspace", workspace])
      expect(executed.status, executed.stderr).toBe(1)
      const report = Schema.decodeUnknownSync(ProgramFailureReport)(
        JSON.parse(executed.stdout)
      )
      expect(report.result.failure).toMatchObject({
        action: expect.stringMatching(/^authority_probe\.run@sha256:/),
        phase: "admission",
        causeTag: "AdmissionDenied",
        reason: expect.stringContaining("/usr/bin/printf")
      })
      expect(report.result.plans).toEqual([
        expect.objectContaining({
          actionReference: expect.stringMatching(
            /^authority_probe\.run@sha256:/
          ),
          nodes: [
            expect.objectContaining({ kind: "Invoke" }),
            expect.objectContaining({ kind: "Apply" })
          ]
        })
      ])
      expect(entries(join(home, "hold"))).toEqual([])
      expect(entries(join(home, "outbox"))).toEqual([])
    }
  )
})
