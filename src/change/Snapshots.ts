import { Schema } from "effect"
import { lstat, readFile } from "node:fs/promises"
import * as path from "node:path"
import { CheckedRecord, ProposalDigest } from "./Checked.ts"
import { InventoryRow, Proposal, ProposalId, SnapshotReceipt, Staged, Status } from "./Contracts.ts"
import { BoundTree, canonical, Digest, exists, hash, Identity, limits, scan } from "./Tree.ts"

export const SnapshotBinding = Schema.Struct({
  side: Schema.Literal("candidate", "baseline", "apply-stage"), expected: BoundTree,
  sourceActId: Schema.optional(Schema.String)
})
export type SnapshotBinding = typeof SnapshotBinding.Type
const PlanData = Schema.Struct({
  version: Schema.Literal("snapshot-retirement-plan/v1"), id: ProposalId,
  bindings: Schema.Array(SnapshotBinding), reservationBytes: Schema.Number,
  metadata: Schema.Array(Schema.Struct({ name: Schema.String, digest: Schema.NullOr(Digest) }))
})
export const SnapshotPlan = Schema.Struct({ ...PlanData.fields, retirementDigest: ProposalDigest })
export type SnapshotPlan = typeof SnapshotPlan.Type
export const SnapshotRecord = Schema.Struct({
  plan: SnapshotPlan, phase: Schema.Literal("prepared", "retired", "collecting", "collected"),
  actId: Schema.optional(Schema.String), bundle: Schema.optional(Identity)
})
export type SnapshotRecord = typeof SnapshotRecord.Type
export type SnapshotInspection = { row: InventoryRow, plan?: SnapshotPlan, record?: SnapshotRecord }
export const maximumReservation = 4 * limits.bytes + 32 * 1024 * 1024
export const snapshotRecordPath = (home: string, id: string) => path.join(home, "hold", "snapshot-retirements", `${id}.json`)
const safeAct = (id: string) => {
  if (!/^act_[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("invalid correlated Hold act id")
  return id
}
/** Only these three private names are admissible; no caller-supplied path. */
export const snapshotSource = (home: string, id: string, binding: SnapshotBinding) => binding.side === "apply-stage"
  ? path.join(home, "hold", safeAct(binding.sourceActId ?? ""), "stage")
  : path.join(home, "changes", Schema.decodeUnknownSync(ProposalId)(id), binding.side)
export const planDigest = (plan: typeof PlanData.Type) => `sha256:${hash(Schema.encodeSync(Schema.parseJson(PlanData))(plan))}`
export const readSnapshotRecord = async (home: string, id: string): Promise<SnapshotRecord | undefined> => {
  Schema.decodeUnknownSync(ProposalId)(id)
  const file = snapshotRecordPath(home, id)
  if (!(await exists(file))) return undefined
  await canonical(file)
  const record = Schema.decodeUnknownSync(Schema.parseJson(SnapshotRecord))(await readFile(file, "utf8"))
  if (record.plan.id !== id || planDigest(record.plan) !== record.plan.retirementDigest) throw new Error("snapshot retirement record binding/digest mismatch")
  if (record.actId !== undefined) safeAct(record.actId)
  return record
}
export const snapshotReceipt = (record: SnapshotRecord, reason?: string): SnapshotReceipt => ({
  version: "change-snapshots/v1", id: record.plan.id, retirementDigest: record.plan.retirementDigest,
  state: reason !== undefined || record.phase === "prepared" || record.phase === "collecting" ? "recovery-required" : record.phase,
  holdActIds: record.actId === undefined ? [] : [record.actId],
  retiredBytes: record.plan.bindings.reduce((n, b) => n + b.expected.tree.bytes, 0),
  releasedReservationBytes: record.phase === "collected" && reason === undefined ? record.plan.reservationBytes : 0,
  reason
})

/** Called under the Hold lease. Inspection never writes or repairs metadata. */
export const inspectSnapshots = async (home: string, id: string): Promise<SnapshotInspection> => {
  Schema.decodeUnknownSync(ProposalId)(id)
  const directory = path.join(home, "changes", id)
  await canonical(directory)
  const errors: Array<{ operation: string, reason: string }> = []
  const metadata: Array<{ name: string, digest: string | null }> = []
  const read = async (name: string, file: string) => {
    if (!(await exists(file))) { metadata.push({ name, digest: null }); return undefined }
    await canonical(file)
    const raw = await readFile(file, "utf8")
    metadata.push({ name, digest: hash(raw) })
    return raw
  }
  const decode = <A, I>(name: string, raw: string | undefined, schema: Schema.Schema<A, I>) => {
    if (raw === undefined) return undefined
    try { return Schema.decodeUnknownSync(Schema.parseJson(schema))(raw) }
    catch (cause) { errors.push({ operation: name, reason: String(cause) }); return undefined }
  }
  const proposalRaw = await read("proposal", path.join(directory, "proposal.json"))
  const statusRaw = await read("workflow", path.join(directory, "status.json"))
  const reservationRaw = await read("reservation", path.join(directory, "reservation"))
  const storeId = await read("store-id", path.join(home, "changes", "store-id"))
  let proposal = decode("proposal", proposalRaw, Staged)
  const status = decode("workflow", statusRaw, Status)
  let safe = true
  if (proposal !== undefined && (proposal.id !== id || proposal.proposal.id !== id || proposal.proposal.storeId !== storeId ||
    proposal.proposalDigest !== `sha256:${hash(Schema.encodeSync(Schema.parseJson(Proposal))(proposal.proposal))}`)) {
    errors.push({ operation: "proposal", reason: "proposal/store digest binding mismatch" }); proposal = undefined
  }
  if (status !== undefined && status.id !== id) { errors.push({ operation: "workflow", reason: "workflow id mismatch" }); safe = false }
  if (statusRaw !== undefined && status === undefined) safe = false
  const operations: Array<CheckedRecord | undefined> = []
  for (const key of [id, `undo_${id}`]) {
    const raw = await read(key, path.join(home, "hold", "checked", `${key}.json`))
    const record = decode(key, raw, CheckedRecord)
    if (raw !== undefined && record === undefined) safe = false
    if (record !== undefined && (record.request.operationKey !== key || record.phase !== "finished" || record.acknowledged !== true)) {
      errors.push({ operation: key, reason: "unresolved or unacknowledged checked operation" }); safe = false
    }
    operations.push(record)
  }
  const [apply, undo] = operations
  const stateOf = (record: CheckedRecord | undefined, fallback: InventoryRow["applyState"]): InventoryRow["applyState"] =>
    record === undefined ? fallback : record.outcome?.state ?? (record.phase === "claimed" ? "claimed" : "recovery-required")
  const amount = Number(reservationRaw)
  let reservationBytes = Number.isSafeInteger(amount) && amount > 0 ? amount : maximumReservation
  if (reservationBytes === maximumReservation && reservationRaw === undefined) errors.push({ operation: "reservation", reason: "incomplete allocation conservatively reserved" })
  const workflowState: InventoryRow["workflowState"] = status?.state ?? (statusRaw === undefined && proposalRaw === undefined ? "incomplete" : "corrupt")
  if (proposalRaw === undefined) errors.push({ operation: "proposal", reason: "unpublished/incomplete allocation" })
  // A published staged proposal needs cancellation. An unpublished allocation
  // cannot be applied and is explicitly abandonable via its inventory digest.
  if ((proposalRaw !== undefined && status?.state === "staged") || status?.state === "claimed" || status?.state === "recovery-required") safe = false
  if (proposalRaw !== undefined && status === undefined) safe = false
  const bindings: SnapshotBinding[] = []
  for (const side of ["candidate", "baseline"] as const) {
    const source = path.join(directory, side)
    if (await exists(source)) {
      try { bindings.push({ side, expected: await scan(source) }) }
      catch (cause) { errors.push({ operation: side, reason: String(cause) }); safe = false }
    }
  }
  if (apply?.actId !== undefined) {
    const actId = safeAct(apply.actId)
    const stage = path.join(home, "hold", actId, "stage")
    if (await exists(stage)) {
      const journalRaw = await read("apply-stage-journal", path.join(home, "hold", actId, "manifest.json"))
      const journal = journalRaw === undefined ? undefined : JSON.parse(journalRaw)
      if (journal?.checkedKey !== id || journal?.manifest?.id !== actId) { errors.push({ operation: "apply-stage", reason: "stage lacks correlated Hold authority" }); safe = false }
      else {
        try { bindings.push({ side: "apply-stage", sourceActId: actId, expected: await scan(stage) }) }
        catch (cause) { errors.push({ operation: "apply-stage", reason: String(cause) }); safe = false }
      }
    }
  }
  const record = await readSnapshotRecord(home, id)
  let snapshotState: InventoryRow["snapshots"]["state"] = "active"
  let bytes = bindings.reduce((n, b) => n + b.expected.tree.bytes, 0)
  if (record !== undefined) {
    snapshotState = record.phase === "prepared" ? "retiring" : record.phase
    bytes = record.phase === "collected" ? 0 : record.plan.bindings.reduce((n, b) => n + b.expected.tree.bytes, 0)
    if (record.phase === "collected") {
      if (bindings.length !== 0 || (record.actId !== undefined && await exists(path.join(home, "hold", record.actId, "payload")))) {
        snapshotState = "recovery-required"
        errors.push({ operation: "collected", reason: "private bytes remain despite collection tombstone" })
      } else reservationBytes = 0
    }
  }
  const data: typeof PlanData.Type = { version: "snapshot-retirement-plan/v1", id, bindings, reservationBytes, metadata }
  const plan = record?.plan ?? (safe ? { ...data, retirementDigest: planDigest(data) } : undefined)
  return { record, plan, row: {
    id, target: proposal?.proposal.target ?? status?.receipt?.target,
    proposalDigest: proposal?.proposalDigest ?? status?.receipt?.proposalDigest,
    retirementDigest: plan?.retirementDigest, workflowState,
    applyState: stateOf(apply, status?.receipt?.state ?? (status?.state === "claimed" ? "claimed" : "unclaimed")),
    undoState: stateOf(undo, status?.undoReceipt?.state ?? "unclaimed"),
    snapshots: { state: snapshotState, bytes, holdActIds: record?.actId === undefined ? [] : [record.actId] },
    reservationBytes, active: snapshotState !== "collected", errors
  } }
}
