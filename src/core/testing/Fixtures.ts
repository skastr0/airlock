import { DateTime, Schema } from "effect"
import { Sha256Digest } from "../Canonical.ts"
import {
  EmissionId,
  EmissionRecord,
  IdempotencyKey,
  SealedDispatch,
  StagedEmission
} from "../outbox/Records.ts"

export const digestOf = (hexDigit: string) => Sha256Digest.make(`sha256:${hexDigit.repeat(64)}`)

export const instant = (millis: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1) + millis)

export const emissionId = (n: number) => EmissionId.make(`emi_${n.toString(16).padStart(32, "0")}`)

export const stagedRecord = (n: number, summary: Schema.Json = { n }) =>
  new StagedEmission({
    id: emissionId(n),
    key: IdempotencyKey.make(`key-${n}`),
    kind: "probe",
    dispatchDigest: digestOf("a"),
    requestDigest: digestOf("b"),
    summary,
    stagedAt: instant(n),
    holdUntil: instant(n + 1_000)
  })

export const sealedDispatch = (canonical = "{\"n\":1}") =>
  new SealedDispatch({ digest: digestOf("a"), canonical })

/** Records compare by their encoded form; class identity is not part of the contract. */
export const encoded = Schema.encodeSync(EmissionRecord)
