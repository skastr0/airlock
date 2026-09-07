import { Schema } from "effect"
import { BoundTree, Digest, Parent, Tree } from "./Tree.ts"

export const OperationKey = Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{1,100}$/))
export const CheckedRequest = Schema.Struct({
  operationKey: OperationKey,
  target: Schema.String,
  parent: Parent,
  expected: Schema.NullOr(BoundTree),
  candidate: Schema.Struct({ path: Schema.String, tree: Tree }),
  proposalDigest: Digest
})
export type CheckedRequest = typeof CheckedRequest.Type
export const CheckedOutcome = Schema.Struct({
  version: Schema.Literal("checked-hold/v1"),
  receiptId: OperationKey,
  operationKey: OperationKey,
  target: Schema.String,
  state: Schema.Literal("installed", "undone", "rejected", "recovery-required"),
  actId: Schema.optional(Schema.String),
  displacedActId: Schema.optional(Schema.String),
  installed: Schema.optional(BoundTree),
  reason: Schema.optional(Schema.String)
})
export type CheckedOutcome = typeof CheckedOutcome.Type
export const CheckedRecord = Schema.Struct({
  request: CheckedRequest,
  undoOf: Schema.optional(OperationKey),
  phase: Schema.Literal("claimed", "retaining", "installing", "finished"),
  actId: Schema.optional(Schema.String),
  displacedActId: Schema.optional(Schema.String),
  installed: Schema.optional(BoundTree),
  outcome: Schema.optional(CheckedOutcome),
  acknowledged: Schema.optional(Schema.Boolean)
})
export type CheckedRecord = typeof CheckedRecord.Type
