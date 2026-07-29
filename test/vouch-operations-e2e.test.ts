import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { VouchOperationsProofReport } from "../scripts/prove-vouch-operations.ts"

const projectRoot = fileURLToPath(new URL("../", import.meta.url))
const bunPath = (() => {
  try {
    return execFileSync("/usr/bin/which", ["bun"], {
      encoding: "utf8"
    }).trim()
  } catch {
    return ""
  }
})()
const supported =
  process.platform === "darwin" &&
  bunPath.length > 0 &&
  [
    "/bin/sleep",
    "/usr/bin/printf",
    "/usr/bin/sandbox-exec",
    "/usr/bin/tar",
    "/usr/bin/wc",
    "/usr/bin/yes"
  ].every(existsSync)

describe.skipIf(!supported)("Vouch-derived operation acceptance", () => {
  it("executes the high-frequency Unix patterns through Airlock physics", () => {
    const output = execFileSync(
      bunPath,
      [
        fileURLToPath(
          new URL("../scripts/prove-vouch-operations.ts", import.meta.url)
        )
      ],
      { cwd: projectRoot, encoding: "utf8", timeout: 60_000 }
    )
    const report = Schema.decodeUnknownSync(VouchOperationsProofReport)(
      JSON.parse(output)
    )

    expect(report.platform).toBe("darwin")
    expect(report.sourcePatterns).toHaveLength(5)
    expect(report.workflow.planCount).toBe(12)
    expect(report.workflow.nodeKinds).toEqual([
      "Capture",
      "Capture",
      "Apply",
      "Invoke",
      "Apply",
      "Capture",
      "Invoke",
      "Apply",
      "Invoke",
      "Apply",
      "Invoke",
      "Apply",
      "Apply",
      "Apply",
      "Apply",
      "RequestExternal"
    ])
    expect(report.workflow.treeEntries).toEqual(["SOUL.md", "sessions"])
    expect(report.workflow.matchedStateEntries).toBe(3)
    expect(report.workflow.snapshotBytes).toBeGreaterThan(20)
    expect(report.workflow.members).toEqual(
      expect.arrayContaining([
        "state/",
        "state/SOUL.md",
        "state/sessions/",
        "state/sessions/session.json"
      ])
    )
    expect(report.workflow.memberCount).toBe(report.workflow.members.length)
    expect(report.workflow.argv).toEqual([
      "--gateway",
      "local",
      "--gateway-endpoint",
      "unix:///tmp/gateway.sock",
      "sandbox",
      "exec",
      "--name",
      "alice",
      "--no-tty",
      "--timeout",
      "180",
      "--",
      "/usr/bin/python3",
      "-I",
      "-S"
    ])
    expect(report.workflow.finalBackupBytes).toBe(
      report.workflow.snapshotBytes
    )
    expect(report.workflow.staleRemoved).toBe(true)

    expect(report.processBoundaries.timeout).toMatchObject({
      tag: "ProcessTimedOut",
      pid: expect.any(Number)
    })
    expect(report.processBoundaries.cancellation).toMatchObject({
      tag: "ProcessCancelled",
      pid: expect.any(Number)
    })
    expect(report.processBoundaries.outputBound).toMatchObject({
      tag: "ProcessOutputLimitExceeded",
      pid: expect.any(Number),
      capturedBytes: 128
    })

    expect(report.holdUndo).toMatchObject({
      hadPayload: true,
      restoredLegacyBytes: "legacy snapshot bytes\n"
    })
    expect(report.outbox).toEqual({
      state: "staged",
      pendingCount: 1,
      endpoint: "https://realm.example.invalid/v1/runtime-events?sensitive=%5Bredacted%5D",
      headerNames: ["content-type", "x-airlock-corpus"],
      bodyBytes: 30
    })
  }, 60_000)
})
