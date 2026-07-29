import { spawnSync } from "node:child_process"
import {
  existsSync,
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
const fixture = join(
  repository,
  "examples",
  "parity",
  "native-destructive.air"
)
const supported =
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync("/bin/rm")

const invoke = (
  entrypoint: "agent" | "supervisor",
  args: ReadonlyArray<string>,
  home: string,
  environment: Readonly<Record<string, string>>
) =>
  spawnSync(
    "bun",
    [entrypoint === "agent" ? "src/agent-cli.ts" : "src/cli.ts", ...args],
    {
      cwd: repository,
      env: {
        ...process.env,
        AIRLOCK_HOME: home,
        ...environment
      },
      encoding: "utf8",
      timeout: 30_000
    }
  )

describe.skipIf(!supported)(
  "agent-only native destructive execution",
  () => {
    it(
      "contains rm -rf, commits its delta through Hold, denies agent undo, and lets the supervisor restore exact bytes",
      { timeout: 30_000 },
      () => {
        const root = mkdtempSync(join(tmpdir(), "airlock-agent-rm-"))
        const workspace = join(root, "workspace")
        const protectedDirectory = join(workspace, "protected")
        const nested = join(protectedDirectory, "nested")
        const target = join(nested, "unique.txt")
        const home = join(root, "home")
        const policy = join(root, "policy.json")

        mkdirSync(nested, { recursive: true })
        const canonicalProtectedDirectory = join(
          realpathSync(workspace),
          "protected"
        )
        writeFileSync(target, "exact bytes that must survive\n")
        writeFileSync(
          policy,
          JSON.stringify({
            schemaVersion: "airlock/admission-policy/v1",
            profile: "native-contained",
            principal: "agent:destructive-parity",
            realm: "local",
            admittedBy: "operator:destructive-parity",
            pathAllowlist: [`${workspace}/**`],
            executableAllowlist: ["/bin/rm"],
            endpointAllowlist: []
          })
        )

        const environment = {
          AIRLOCK_AGENT_PROFILE: "native-contained",
          AIRLOCK_POLICY_FILE: policy
        }
        const executed = invoke(
          "agent",
          [
            "run",
            fixture,
            "--workspace",
            workspace,
            "--bindings",
            JSON.stringify({ workspace })
          ],
          home,
          environment
        )

        expect(
          executed.status,
          `${executed.stderr}\n${executed.stdout}`
        ).toBe(0)
        expect(existsSync(protectedDirectory)).toBe(false)

        const report = JSON.parse(executed.stdout) as {
          readonly profile: string
          readonly result: {
            readonly result: {
              readonly state: string
              readonly receipts: ReadonlyArray<{
                readonly sequence: number
                readonly state: string
              }>
            }
            readonly plans: ReadonlyArray<{
              readonly nodes: ReadonlyArray<{ readonly kind: string }>
            }>
          }
        }
        expect(report.profile).toBe("native-contained")
        expect(report.result.result.state).toBe("succeeded")
        expect(report.result.result.receipts).toEqual([
          expect.objectContaining({ sequence: 1, state: "succeeded" }),
          expect.objectContaining({ sequence: 2, state: "succeeded" })
        ])
        expect(report.result.plans).toHaveLength(1)
        expect(
          report.result.plans[0]?.nodes.map(({ kind }) => kind)
        ).toEqual(["Invoke", "Apply"])

        const held = invoke("agent", ["held"], home, environment)
        expect(held.status, held.stderr).toBe(0)
        const recoverable = JSON.parse(held.stdout) as ReadonlyArray<{
          readonly id: string
          readonly target: string
          readonly hasPayload: boolean
          readonly status: string
          readonly purpose?: string
        }>
        const removal = recoverable.find(
          ({ target: heldTarget }) =>
            heldTarget === canonicalProtectedDirectory
        )
        expect(removal).toMatchObject({
          target: canonicalProtectedDirectory,
          hasPayload: true,
          status: "held"
        })
        expect(
          recoverable.filter(({ purpose }) => purpose === "runtime-private")
        ).toHaveLength(1)

        const deniedUndo = invoke(
          "agent",
          ["undo", removal!.id],
          home,
          environment
        )
        expect(deniedUndo.status).not.toBe(0)
        expect(existsSync(protectedDirectory)).toBe(false)

        const undone = invoke(
          "supervisor",
          ["undo", removal!.id],
          home,
          environment
        )
        expect(undone.status, undone.stderr).toBe(0)
        expect(readFileSync(target, "utf8")).toBe(
          "exact bytes that must survive\n"
        )
      }
    )
  }
)
