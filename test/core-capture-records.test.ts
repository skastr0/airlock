import { describe, expect, it } from "vitest"
import { DateTime, Result, Schema } from "effect"
import { Sha256Digest } from "../src/core/Canonical.ts"
import { LedgerEntry } from "../src/core/ledger/Ledger.ts"
import { CapturedEmission, type CaptureEntry, validateCaptureEntry } from "../src/core/outbox/Capture.ts"
import { EmissionId, IdempotencyKey } from "../src/core/outbox/Records.ts"

const digest = Sha256Digest.make(`sha256:${"a".repeat(64)}`)
const id = EmissionId.make(`emi_${"a".repeat(32)}`)
const now = DateTime.makeUnsafe("2026-10-09T00:00:00Z")
const record = new CapturedEmission({ id, key: IdempotencyKey.make("capture-one"), kind: "read", dispatchDigest: digest,
  requestDigest: digest, summary: { tool: "read" }, admission: { policyDigest: digest, grantIds: ["read"], execution: {
    runId: "run", tool: "read", version: "1", effect: "capture", when: "now", retention: "digest", resources: [] } },
  outcome: { state: "done", digest }, completedAt: now, ledgered: ["capture"] })
const entry: CaptureEntry = { record, result: { digest }, receipt: new LedgerEntry({ at: now,
  effect: "observation", act: "capture", ref: id, key: `${id}:capture` }) }

describe("core: capture journal entry contract", () => {
  it("has no staged, hold or committing history, and accepts exactly one observation receipt", () => {
    expect(Result.isSuccess(validateCaptureEntry(entry))).toBe(true)
    const decode = Schema.decodeUnknownResult(Schema.toType(CapturedEmission), { onExcessProperty: "error" })
    for (const field of ["stagedAt", "holdUntil", "committingAt", "provenance"]) {
      expect(Result.isFailure(decode({ ...record, [field]: now }))).toBe(true)
    }
    for (const receipt of [{ ...entry.receipt, act: "commit" }, { ...entry.receipt, effect: "mutation" },
      { ...entry.receipt, ref: "another-call" }, { ...entry.receipt, key: "another-receipt" }]) {
      expect(Result.isFailure(validateCaptureEntry({ ...entry, receipt }))).toBe(true)
    }
  })

  it("cannot represent apply, invoke, request or approved authority", () => {
    for (const effect of ["apply", "invoke", "request"]) {
      const forged = { ...entry, record: { ...record, admission: { ...record.admission,
        execution: { ...record.admission.execution, effect } } } }
      expect(Result.isFailure(validateCaptureEntry(forged))).toBe(true)
    }
    expect(Result.isFailure(validateCaptureEntry({ ...entry, record: { ...record, admission: { ...record.admission,
      execution: { ...record.admission.execution, when: "approved" } } } }))).toBe(true)
    if (false) {
      // @ts-expect-error only capture may use this durable record
      const effect: CapturedEmission["admission"]["execution"]["effect"] = "apply"
      // @ts-expect-error an approved call cannot use this durable record
      const when: CapturedEmission["admission"]["execution"]["when"] = "approved"
      void [effect, when]
    }
  })

  it("requires result retention to follow the explicit grant and match the public digest", () => {
    const kept = { ...entry, record: new CapturedEmission({ ...record, admission: { ...record.admission,
      execution: { ...record.admission.execution, retention: "keep" as const } } }),
      result: { digest, value: "private-result-canary", response: new Uint8Array([1, 2]) } }
    expect(Result.isSuccess(validateCaptureEntry(kept))).toBe(true)
    expect(JSON.stringify(kept.record)).not.toContain("private-result-canary")
    expect(JSON.stringify(kept.receipt)).not.toContain("private-result-canary")
    for (const malformed of [{ ...entry, result: kept.result }, { ...kept, result: { digest } },
      { ...entry, result: undefined }, { ...entry, result: { digest: `sha256:${"b".repeat(64)}` } }]) {
      expect(Result.isFailure(validateCaptureEntry(malformed))).toBe(true)
    }
  })

  it("records redacted failed or refused reads without retaining a result", () => {
    for (const state of ["refused", "failed"] as const) {
      const failed = { record: new CapturedEmission({ ...record, outcome: { state, code: "capture-failed", message: "read did not complete" } }), receipt: entry.receipt }
      expect(Result.isSuccess(validateCaptureEntry(failed))).toBe(true)
      expect(Result.isFailure(validateCaptureEntry({ ...failed, result: { digest } }))).toBe(true)
    }
  })
})
