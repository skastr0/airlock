import { Result, Schema } from "effect"
import { Sha256Digest } from "../Canonical.ts"
import { HostParameters, ResourceBinding } from "../contract/ToolHost.ts"
import { WireAuthority } from "../contract/Wire.ts"
import { LedgerEntry } from "../ledger/Ledger.ts"
import { EmissionId, IdempotencyKey } from "./Identifiers.ts"

export const CaptureRetention = Schema.Literals(["digest", "keep"])
export type CaptureRetention = typeof CaptureRetention.Type

/** The short path cannot represent authority for any other effect or timing. */
export const CaptureAdmission = Schema.Struct({
  policyDigest: Sha256Digest,
  grantIds: Schema.Array(Schema.String),
  execution: Schema.Struct({
    runId: Schema.String,
    tool: Schema.String,
    version: Schema.String,
    effect: Schema.Literal("capture"),
    when: Schema.Literal("now"),
    retention: CaptureRetention,
    host: Schema.optionalKey(HostParameters),
    resources: Schema.Array(ResourceBinding),
    wire: Schema.optionalKey(WireAuthority),
    validUntil: Schema.optionalKey(Schema.DateTimeUtcFromString)
  })
})

export const CaptureOutcome = Schema.Union([
  Schema.Struct({ state: Schema.Literal("done"), digest: Sha256Digest,
    /** Only contract-declared public result fields; otherwise absent. */
    metadata: Schema.optionalKey(Schema.Json) }),
  Schema.Struct({ state: Schema.Literals(["refused", "failed"]), code: Schema.String, message: Schema.String })
])
export type CaptureOutcome = typeof CaptureOutcome.Type

/** Completed in one authoritative journal entry, with no staged/committing history. */
export class CapturedEmission extends Schema.Class<CapturedEmission>("CapturedEmission")({
  state: Schema.tag("captured"),
  id: EmissionId,
  key: IdempotencyKey,
  kind: Schema.String,
  dispatchDigest: Sha256Digest,
  requestDigest: Sha256Digest,
  summary: Schema.Json,
  admission: CaptureAdmission,
  outcome: CaptureOutcome,
  completedAt: Schema.DateTimeUtcFromString,
  ledgered: Schema.Tuple([Schema.Literal("capture")])
}) {}

/** Kept values are private journal payload; public records contain their digest. */
export const StoredCaptureResult = Schema.Struct({
  digest: Sha256Digest,
  value: Schema.optionalKey(Schema.Json),
  response: Schema.optionalKey(Schema.Uint8Array)
})
export type StoredCaptureResult = typeof StoredCaptureResult.Type

/** One store write publishes all three, or publishes none of them. */
export const CaptureEntry = Schema.Struct({
  record: CapturedEmission,
  result: Schema.optionalKey(StoredCaptureResult),
  receipt: LedgerEntry
})
export type CaptureEntry = typeof CaptureEntry.Type

export class InvalidCapture extends Schema.TaggedError<InvalidCapture>()("InvalidCapture", {
  field: Schema.String, reason: Schema.String
}) {}

/** A store rejects forged entry material before its atomic publication. */
export const validateCaptureEntry = (entry: unknown): Result.Result<CaptureEntry, InvalidCapture> => {
  const decoded = Schema.decodeUnknownResult(Schema.toType(CaptureEntry), { onExcessProperty: "error" })(entry)
  const invalid = (field: string, reason: string) => Result.fail(new InvalidCapture({ field, reason }))
  if (Result.isFailure(decoded)) return invalid("entry", "must contain only current capture journal fields")
  const { record, result, receipt } = decoded.success
  if (record.kind !== record.admission.execution.tool) return invalid("record.kind", "must match the admitted capture tool")
  if (receipt.act !== "capture" || receipt.effect !== "observation" || receipt.ref !== record.id || receipt.key !== `${record.id}:capture`) {
    return invalid("receipt", "must attest exactly this completed capture")
  }
  if (record.outcome.state !== "done") {
    return result === undefined ? Result.succeed(decoded.success) : invalid("result", "failed and refused reads retain no result bytes")
  }
  if (result === undefined || result.digest !== record.outcome.digest) return invalid("result.digest", "must match the completed capture digest")
  if (record.admission.execution.retention === "digest" && (result.value !== undefined || result.response !== undefined)) {
    return invalid("result", "digest retention must not store result bytes")
  }
  if (record.admission.execution.retention === "keep" && result.value === undefined) {
    return invalid("result.value", "keep retention requires the private encoded result")
  }
  return Result.succeed(decoded.success)
}
