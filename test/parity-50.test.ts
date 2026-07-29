import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  Parity50Evidence,
  ParityCaseId
} from "../scripts/prove-parity-50.ts"

const repository = resolve(import.meta.dirname, "..")

describe.skipIf(process.platform !== "darwin")(
  "50-execution agent-only parity evidence",
  () => {
    it(
      "runs ten scripted cases five times through real airlock-agent subprocesses",
      { timeout: 300_000 },
      () => {
        const executed = spawnSync(
          "bun",
          ["scripts/prove-parity-50.ts"],
          {
            cwd: repository,
            env: { ...process.env, NO_COLOR: "1" },
            encoding: "utf8",
            timeout: 290_000,
            maxBuffer: 8 * 1024 * 1024
          }
        )

        expect(
          executed.status,
          `STDERR:\n${executed.stderr}\nSTDOUT:\n${executed.stdout}`
        ).toBe(0)

        const evidence = Schema.decodeUnknownSync(Parity50Evidence)(
          JSON.parse(executed.stdout)
        )
        expect(evidence.schemaVersion).toBe("airlock/parity-50-proof/v2")
        if (evidence.source.kind === "git-checkout") {
          expect(evidence.source).toMatchObject({
            root: repository,
            headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
            workingTreeDirty: expect.any(Boolean)
          })
        } else {
          expect(evidence.source).toEqual({
            kind: "unversioned-source-tree",
            root: repository,
            commitIdentity: "unavailable",
            workingTreeState: "unavailable",
            reason:
              "repository-local .git metadata is absent; no commit identity or worktree state is claimed"
          })
        }
        expect(evidence.environment).toMatchObject({
          platform: "darwin",
          architecture: process.arch,
          agentEntrypoint: expect.stringMatching(/\/src\/agent-cli\.ts$/)
        })
        expect(evidence.matrix).toMatchObject({
          uniqueCaseCount: 10,
          repetitionsPerCase: 5,
          executionCount: 50,
          successCount: 50,
          compatibilityExecutions: 40,
          nativeContainedExecutions: 10
        })
        expect(evidence.outcomes).toHaveLength(50)
        expect(evidence.outcomes.every(({ success }) => success)).toBe(true)
        expect(evidence.outcomes.every(({ cliExitCode }) => cliExitCode === 0))
          .toBe(true)
        expect(evidence.outcomes.every(({ reportState }) => reportState === "succeeded"))
          .toBe(true)

        const expectedCaseIds = new Set(
          Schema.Literal(
            "capture-observe",
            "managed-files",
            "structured-argv",
            "environment",
            "text-stdin",
            "artifact-pipeline",
            "failure-branch",
            "bounded-control",
            "native-rewrite",
            "native-create"
          ).literals
        )
        const observedCaseIds = new Set(
          evidence.outcomes.map(({ caseId }) =>
            Schema.decodeUnknownSync(ParityCaseId)(caseId)
          )
        )
        expect(observedCaseIds).toEqual(expectedCaseIds)

        for (const caseId of observedCaseIds) {
          const outcomes = evidence.outcomes.filter(
            (outcome) => outcome.caseId === caseId
          )
          expect(outcomes).toHaveLength(5)
          expect(outcomes.map(({ repetition }) => repetition))
            .toEqual([1, 2, 3, 4, 5])
          expect(outcomes.every(({ assertions }) => assertions.length > 0))
            .toBe(true)
        }

        expect(
          evidence.matrix.cases.filter(
            ({ profile }) => profile === "native-contained"
          )
        ).toHaveLength(2)
        expect(evidence.latency.wallClockMillis).toBeLessThan(300_000)
        expect(evidence.limitations).toContain(
          "50 means ten deterministic scripted cases repeated five times, not fifty unique tasks."
        )
        expect(evidence.limitations).toContain(
          "There is no direct-shell A/B baseline, latency comparison, or task-quality comparison."
        )
      }
    )
  }
)
