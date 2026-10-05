import { Schema } from "effect"
import { CheckedOutcome, ClaimObservation, ProposalDigest } from "./Checked.ts"
import { BoundTree, Entry, Parent, Tree } from "./Tree.ts"

export const ProposalId = Schema.String.pipe(Schema.check(Schema.isPattern(/^change_[a-f0-9-]{36}$/)))
export const Proposal = Schema.Struct({
  version: Schema.Literal("change-proposal/v1"), id: ProposalId, storeId: Schema.String,
  createdAt: Schema.String, target: Schema.String, parent: Parent,
  expected: Schema.NullOr(BoundTree), candidate: Tree, baseline: Schema.NullOr(Tree),
  metadataPolicy: Schema.Literal("ordinary-posix-mode/v1"),
  assumptions: Schema.Literal("quiescent-external-writers; private-unencrypted-store; no-filesystem-CAS")
})
export type Proposal = typeof Proposal.Type
export const Staged = Schema.Struct({
  version: Schema.Literal("change/v1"), id: ProposalId, proposalDigest: ProposalDigest, proposal: Proposal
})
export type Staged = typeof Staged.Type
const TextPreview = Schema.Struct({ text: Schema.optional(Schema.String), binary: Schema.Boolean, truncated: Schema.Boolean })
export const Difference = Schema.Struct({
  path: Schema.String, change: Schema.Literals(["added", "deleted", "modified"]),
  before: Schema.optional(Entry), after: Schema.optional(Entry),
  beforeText: Schema.optional(TextPreview), afterText: Schema.optional(TextPreview)
})
export const Review = Schema.Struct({ ...Staged.fields, diff: Schema.Array(Difference) })
export type Review = typeof Review.Type
export const WorkflowState = Schema.Literals(["staged", "claimed", "cancelled", "installed", "undone", "rolled-back", "rejected", "recovery-required"])
export const Status = Schema.Struct({
  version: Schema.Literal("change/v1"), id: ProposalId,
  state: WorkflowState, claim: Schema.optional(ClaimObservation),
  receipt: Schema.optional(CheckedOutcome), undoReceipt: Schema.optional(CheckedOutcome)
})
export type Status = typeof Status.Type
export const SnapshotState = Schema.Literals(["active", "retiring", "retired", "collecting", "collected", "recovery-required"])
const OperationState = Schema.Union([CheckedOutcome.fields.state, Schema.Literals(["unclaimed", "claimed", "unknown"])])
export const InventoryRow = Schema.Struct({
  id: Schema.String, target: Schema.optional(Schema.String), proposalDigest: Schema.optional(ProposalDigest),
  retirementDigest: Schema.optional(ProposalDigest),
  workflowState: Schema.Union([WorkflowState, Schema.Literals(["incomplete", "corrupt"])]),
  applyState: OperationState, undoState: OperationState,
  snapshots: Schema.Struct({ state: SnapshotState, bytes: Schema.Finite, holdActIds: Schema.Array(Schema.String) }),
  reservationBytes: Schema.Finite, active: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ operation: Schema.String, reason: Schema.String }))
})
export type InventoryRow = typeof InventoryRow.Type
export const Inventory = Schema.Struct({
  version: Schema.Literal("change-inventory/v1"), rows: Schema.Array(InventoryRow),
  totals: Schema.Struct({ rows: Schema.Finite, active: Schema.Finite, reservedBytes: Schema.Finite,
    snapshotBytes: Schema.Finite, collected: Schema.Finite, errors: Schema.Finite }),
  limits: Schema.Struct({ proposals: Schema.Finite, storage: Schema.Finite })
})
export type Inventory = typeof Inventory.Type
/** The final inventory row of a collected proposal, written once. */
export const SettledBody = Schema.Struct({
  version: Schema.Literal("change-settled/v1"), storeId: Schema.String, row: InventoryRow
})
export const Settled = Schema.Struct({ ...SettledBody.fields, digest: ProposalDigest })
export const SnapshotReceipt = Schema.Struct({
  version: Schema.Literal("change-snapshots/v1"), id: ProposalId, retirementDigest: ProposalDigest,
  state: Schema.Literals(["retired", "collected", "recovery-required"]), holdActIds: Schema.Array(Schema.String),
  retiredBytes: Schema.Finite, releasedReservationBytes: Schema.Finite, reason: Schema.optional(Schema.String)
})
export type SnapshotReceipt = typeof SnapshotReceipt.Type
export const ContentRequest = Schema.Struct({
  id: ProposalId, side: Schema.Literals(["before", "after"]), path: Schema.String,
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65536 })))
})
export type ContentRequest = typeof ContentRequest.Type
export const ContentPage = Schema.Struct({
  version: Schema.Literal("change-content/v1"), id: ProposalId, proposalDigest: ProposalDigest,
  side: Schema.Literals(["before", "after"]), path: Schema.String, fileDigest: Schema.String,
  offset: Schema.Finite, limit: Schema.Finite, bytes: Schema.Finite, totalBytes: Schema.Finite,
  encoding: Schema.Literal("base64"), dataBase64: Schema.String,
  nextOffset: Schema.NullOr(Schema.Finite), eof: Schema.Boolean
})
export type ContentPage = typeof ContentPage.Type
