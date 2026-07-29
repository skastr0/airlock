import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const bunAvailable = () => {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8" })
  return result.status === 0
}

const supported = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && bunAvailable()

describe.skipIf(!supported)("macOS Cell Bun construction proof", () => {
  it("runs the real Cell through Bun and reports its boundary evidence", () => {
    const result = spawnSync("bun", ["run", "scripts/prove-cell.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split("\n")
    expect(lines).toHaveLength(1)
    const proof = JSON.parse(lines[0]!) as {
      ok: boolean
      assertions: Record<string, boolean>
      evidence: { delta: ReadonlyArray<{ path: string; kind: string }>; drift: ReadonlyArray<string> }
    }
    expect(proof.ok).toBe(true)
    expect(proof.assertions).toEqual({
      liveWriteDenied: true,
      privateWriteSucceeded: true,
      loopbackDenied: true,
      sourceUnchanged: true,
      deltaObserved: true,
      driftAbsent: true
    })
    expect(proof.evidence.delta).toContainEqual({ path: "created.txt", kind: "created" })
    expect(proof.evidence.drift).toEqual([])
  })
})
