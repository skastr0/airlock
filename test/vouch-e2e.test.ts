import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { VouchProofReport } from "../scripts/prove-vouch.ts"

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
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync("/usr/bin/tar")

describe.skipIf(!supported)("Vouch-derived macOS end-to-end proof", () => {
  it("admits, contains, applies, stages, receipts, and undoes real Unix work", async () => {
    const output = execFileSync(
      bunPath,
      [fileURLToPath(new URL("../scripts/prove-vouch.ts", import.meta.url))],
      { cwd: projectRoot, encoding: "utf8", timeout: 30_000 }
    )
    const report = Schema.decodeUnknownSync(VouchProofReport)(
      JSON.parse(output)
    )

    expect(report.profile).toBe("native-contained")
    expect(report.grantCount).toBe(5)
    expect(report.handleCount).toBe(5)
    expect(report.receipts.map((receipt) => receipt.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded"
    ])
    expect(report.receipts.map((receipt) => receipt.sequence)).toEqual([
      1, 2, 3, 4, 5
    ])
    expect(
      report.receipts.every(
        (receipt) => receipt.resourceIdentities.length === 1
      )
    ).toBe(true)
    expect(report.receipts[1]?.inputDigests).toHaveLength(1)

    expect(report.cell).toMatchObject({
      executable: "/usr/bin/tar",
      args: ["-xzf", "-", "-C", "hermes"],
      exitCode: 0,
      network: "deny",
      readAuthority: "ambient-host-read",
      delta: [{ path: "hermes", kind: "modified" }]
    })
    expect(report.liveState).toEqual({
      observedBeforeApply: "live soul\n",
      afterApply: "restored soul\n",
      restoredSessionPresent: true
    })

    expect(report.outbox).toMatchObject({
      status: "staged",
      dispatchCalls: 0,
      endpoint:
        "https://realm.example.invalid/v1/machines/alice/replace",
      method: "POST",
      headerNames: ["content-type", "x-airlock-proof"],
      privateDispatchPreserved: true,
      privateDispatchMode: 0o600
    })
    expect(report.outbox.bodyBytes).toBeGreaterThan(0)

    expect(report.undo.target).toBe(`${report.workspace}/hermes`)
    expect(report.undo.soulAfterUndo).toBe("live soul\n")
    expect(report.undo.restoredSessionPresentAfterUndo).toBe(false)
    expect(report.ledger.map(({ effect, act }) => `${effect}:${act}`)).toEqual(
      expect.arrayContaining([
        "mutation:overwrite",
        "emission:stage",
        "mutation:undo"
      ])
    )
  })
})
