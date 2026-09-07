import { Schema } from "effect"
import { BoundTree, Parent, Tree } from "./Tree.ts"

export const OperationKey = Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{1,100}$/))
export const ProposalDigest = Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/))
/** Local diagnostics only: neither a signature nor authenticated human identity. */
export const ClaimObservation = Schema.Struct({ observedAt: Schema.String, localUid: Schema.NullOr(Schema.Number) })
export const observeClaim = () => ({ observedAt: new Date().toISOString(), localUid: process.getuid?.() ?? null })
export const CheckedRequest = Schema.Struct({
  operationKey: OperationKey,
  target: Schema.String,
  parent: Parent,
  expected: Schema.NullOr(BoundTree),
  candidate: Schema.Struct({ path: Schema.String, tree: Tree }),
  proposalDigest: ProposalDigest
})
export type CheckedRequest = typeof CheckedRequest.Type
export const CheckedOutcome = Schema.Struct({
  version: Schema.Literal("checked-hold/v1"),
  receiptId: OperationKey,
  operationKey: OperationKey,
  target: Schema.String,
  proposalDigest: ProposalDigest,
  claim: Schema.optional(ClaimObservation),
  state: Schema.Literal("installed", "undone", "rolled-back", "rejected", "recovery-required"),
  actId: Schema.optional(Schema.String),
  displacedActId: Schema.optional(Schema.String),
  installed: Schema.optional(BoundTree),
  reason: Schema.optional(Schema.String)
})
export type CheckedOutcome = typeof CheckedOutcome.Type
export const CheckedRecord = Schema.Struct({
  request: CheckedRequest,
  claim: ClaimObservation,
  undoOf: Schema.optional(OperationKey),
  phase: Schema.Literal("claimed", "retaining", "installing", "restoring", "finished"),
  actId: Schema.optional(Schema.String),
  displacedActId: Schema.optional(Schema.String),
  installed: Schema.optional(BoundTree),
  rollback: Schema.optional(Schema.Struct({ sourceActId: Schema.String, restored: BoundTree })),
  outcome: Schema.optional(CheckedOutcome),
  acknowledged: Schema.optional(Schema.Boolean)
})
export type CheckedRecord = typeof CheckedRecord.Type
