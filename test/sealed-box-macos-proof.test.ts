import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const script = resolve(import.meta.dirname, "..", "scripts", "prove-sealed-box-macos.sh")

describe("privileged sealed-box proof gate", () => {
  it("is executable and inert unless explicitly opted in", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0)
    const refused = spawnSync(script, [], {
      encoding: "utf8",
      env: { ...process.env, AIRLOCK_RUN_PRIVILEGED_PROOF: undefined }
    })
    expect(refused.status).toBe(77)
    expect(refused.stdout).toBe("")
    expect(refused.stderr).toContain("opt-in")
  })
})
