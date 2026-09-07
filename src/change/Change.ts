import { Context, Effect, Layer, Schema } from "effect"
import { lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises"
import * as path from "node:path"
import { AirlockHome } from "../AirlockHome.ts"
import { Hold } from "../Hold.ts"
import { makeExclusiveFileLock } from "../platform/ExclusiveFileLock.ts"
import { CheckedOutcome, ClaimObservation, observeClaim, OperationKey, ProposalDigest } from "./Checked.ts"
import { attempt, bindTarget, BoundTree, canonical, ChangeError, checkParent, checkTree, Entry, exists, hash, limits, metadataPolicy, overlaps, Parent, scan, snapshot, sync, Tree, writeNew } from "./Tree.ts"

export { ChangeError } from "./Tree.ts"
export const ProposalId = Schema.String.pipe(Schema.pattern(/^change_[a-f0-9-]{36}$/))
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
  path: Schema.String, change: Schema.Literal("added", "deleted", "modified"),
  before: Schema.optional(Entry), after: Schema.optional(Entry),
  beforeText: Schema.optional(TextPreview), afterText: Schema.optional(TextPreview)
})
export const Review = Schema.Struct({ ...Staged.fields, diff: Schema.Array(Difference) })
export type Review = typeof Review.Type
export const Status = Schema.Struct({
  version: Schema.Literal("change/v1"), id: ProposalId,
  state: Schema.Literal("staged", "claimed", "cancelled", "installed", "undone", "rolled-back", "rejected", "recovery-required"),
  claim: Schema.optional(ClaimObservation),
  receipt: Schema.optional(CheckedOutcome), undoReceipt: Schema.optional(CheckedOutcome)
})
export type Status = typeof Status.Type

export class Change extends Context.Tag("airlock/Change")<Change, {
  readonly stage: (input: { source: string, target: string }) => Effect.Effect<Staged, ChangeError>
  readonly review: (id: string, options?: { diff: boolean }) => Effect.Effect<Review, ChangeError>
  readonly status: (id: string) => Effect.Effect<Status, ChangeError>
  readonly apply: (input: { id: string, expectedDigest: string }) => Effect.Effect<CheckedOutcome, ChangeError>
  readonly cancel: (id: string) => Effect.Effect<Status, ChangeError>
  readonly undo: (receiptId: string) => Effect.Effect<CheckedOutcome, ChangeError>
  readonly recover: (id: string, options?: { restore: boolean }) => Effect.Effect<Status, ChangeError>
}>() {}

const make = Effect.gen(function* () {
  const home = yield* AirlockHome
  const hold = yield* Hold
  const root = path.join(home.home, "changes")
  const error = (cause: unknown) => new ChangeError({ operation: "change workflow", reason: String(cause) })
  // Construction has no store reads/writes; corrupt proposals cannot disable
  // unrelated commands. The lease serializes stage budgets, claim and cancel.
  const lock = makeExclusiveFileLock({ root, active: path.join(root, "lock"), released: path.join(root, "released"), abandoned: path.join(root, "abandoned"), onError: (_op, _p, cause) => error(cause) })
  const locked = <A, E>(effect: Effect.Effect<A, E>) =>
    attempt("open private change store", async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const stat = await lstat(root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("change store must be a private directory")
      await canonical(root)
      await sync(home.home)
    }).pipe(Effect.zipRight(lock.withLock(Effect.uninterruptible(effect))), Effect.mapError(error))
  const directory = (id: string) => path.join(root, id)
  const candidatePath = (id: string) => path.join(directory(id), "candidate")
  const baselinePath = (id: string) => path.join(directory(id), "baseline")
  const validateId = (id: string) => Schema.decodeUnknown(ProposalId)(id).pipe(Effect.mapError(error))
  const proposalJson = Schema.encodeSync(Schema.parseJson(Proposal))
  const proposalDigest = (proposal: Proposal) => `sha256:${hash(proposalJson(proposal))}`
  const readProposal = Effect.fnUntraced(function* (id: string) {
    yield* validateId(id)
    const raw = yield* attempt("read proposal", () => readFile(path.join(directory(id), "proposal.json"), "utf8"))
    const stored = yield* Schema.decode(Schema.parseJson(Staged))(raw).pipe(Effect.mapError(error))
    const storeId = yield* attempt("read store binding", () => readFile(path.join(root, "store-id"), "utf8"))
    if (stored.id !== id || stored.proposal.id !== id || stored.proposal.storeId !== storeId || proposalDigest(stored.proposal) !== stored.proposalDigest) return yield* error("proposal digest/store binding mismatch")
    return stored
  })
  const validateSnapshots = (stored: Staged) => attempt("verify immutable proposal snapshots", async () => {
    const p = stored.proposal
    if ((await scan(candidatePath(p.id))).tree.digest !== p.candidate.digest) throw new Error("candidate snapshot tampered")
    if (p.baseline !== null && (await scan(baselinePath(p.id))).tree.digest !== p.baseline.digest) throw new Error("baseline snapshot tampered")
  })
  const readStatus = Effect.fnUntraced(function* (id: string) {
    yield* validateId(id)
    const file = path.join(directory(id), "status.json")
    const raw = yield* attempt("read workflow status", () => readFile(file, "utf8"))
    const value = yield* Schema.decode(Schema.parseJson(Status))(raw).pipe(Effect.mapError(error))
    if (value.id !== id) return yield* error("status binding mismatch")
    return value
  })
  const writeStatus = (status: Status) => attempt("publish workflow status", async () => {
    const file = path.join(directory(status.id), "status.json")
    const next = `${file}.next`
    await writeNew(next, Schema.encodeSync(Schema.parseJson(Status))(status), true)
    await rename(next, file)
    await sync(directory(status.id))
  })
  const persistReceipt = (id: string, receipt: CheckedOutcome, undo = false) => Effect.gen(function* () {
    const status = yield* readStatus(id)
    if (JSON.stringify(undo ? status.undoReceipt : status.receipt) === JSON.stringify(receipt)) {
      if (receipt.state !== "recovery-required") yield* hold.acknowledgeChecked(receipt.operationKey)
      return receipt
    }
    const file = path.join(directory(id), `${undo ? "undo-" : ""}receipt.json`)
    // A recovery-required observation can later be replaced by a proven final
    // outcome. Only final durable receipts release Hold's pins.
    yield* attempt("publish exact workflow receipt", async () => {
      const next = `${file}.next`
      await writeNew(next, Schema.encodeSync(Schema.parseJson(CheckedOutcome))(receipt), true)
      await rename(next, file)
      await sync(directory(id))
    })
    yield* writeStatus({ ...status, state: receipt.state, ...(undo ? { undoReceipt: receipt } : { receipt }) })
    if (receipt.state !== "recovery-required") yield* hold.acknowledgeChecked(receipt.operationKey)
    return receipt
  }).pipe(Effect.catchAll(cause => Effect.succeed({
    ...receipt, state: "recovery-required" as const,
    reason: `workflow receipt/acknowledgement publication failed: ${String(cause)}; durable Hold claim retained`
  })))

  const stage = (input: { source: string, target: string }) => locked(attempt("stage immutable proposal", async () => {
    const source = await canonical(input.source)
    const binding = await bindTarget(input.target, home.home)
    if (overlaps(source, await canonical(home.home)) || overlaps(source, binding.target)) throw new Error("source overlaps target or AIRLOCK_HOME")
    const candidate = await scan(source)
    const baseline = await exists(binding.target) ? await scan(binding.target) : null
    if (baseline !== null && baseline.tree.kind !== candidate.tree.kind) throw new Error("same-kind target required")
    if ((await lstat(home.holdDir)).dev !== binding.parent.identity.device || (baseline !== null && baseline.identity.device !== binding.parent.identity.device)) throw new Error("unsupported cross-volume target")
    const entries = (await readdir(root)).filter(n => n.startsWith("change_"))
    if (entries.length >= limits.proposals) throw new Error("proposal count limit; private failures retained, no GC")
    let reserved = 0
    for (const name of entries) {
      // An interrupted allocation remains charged conservatively, but does
      // not disable all future proposals while capacity remains. This is an
      // application budget, not a hard filesystem quota against outside writes.
      let amount = NaN
      try { amount = Number(await readFile(path.join(root, name, "reservation"), "utf8")) } catch { /* incomplete allocation */ }
      reserved += Number.isSafeInteger(amount) && amount > 0 ? amount : 4 * limits.bytes + 32 * 1024 * 1024
    }
    // Reserve worst-case retained private copies before writing. Baseline live
    // bytes are moved, not copied into Hold. Failed stages keep their charge.
    const charge = 2 * (candidate.tree.bytes + (baseline?.tree.bytes ?? 0)) + 32 * 1024 * 1024
    if (reserved + charge > limits.storage) throw new Error("private storage limit; no GC in v1")
    const storeFile = path.join(root, "store-id")
    if (!(await exists(storeFile))) await writeNew(storeFile, crypto.randomUUID())
    const storeId = await readFile(storeFile, "utf8")
    const id = `change_${crypto.randomUUID()}`
    await mkdir(directory(id), { mode: 0o700 })
    await sync(root)
    await writeNew(path.join(directory(id), "reservation"), String(charge))
    const copied = await snapshot(source, candidatePath(id), candidate.tree.bytes)
    if (copied.tree.digest !== candidate.tree.digest) throw new Error("source changed before snapshot")
    if (baseline !== null) {
      const old = await snapshot(binding.target, baselinePath(id), baseline.tree.bytes)
      if (old.tree.digest !== baseline.tree.digest) throw new Error("baseline changed before snapshot")
    }
    await checkParent(binding.target, binding.parent, home.home)
    await checkTree(binding.target, baseline)
    const proposal: Proposal = { version: "change-proposal/v1", id, storeId, createdAt: new Date().toISOString(), ...binding,
      expected: baseline, candidate: candidate.tree, baseline: baseline?.tree ?? null, metadataPolicy,
      assumptions: "quiescent-external-writers; private-unencrypted-store; no-filesystem-CAS" }
    const staged: Staged = { version: "change/v1", id, proposalDigest: proposalDigest(proposal), proposal }
    await writeNew(path.join(directory(id), "status.json"), JSON.stringify({ version: "change/v1", id, state: "staged" }))
    // Publication is last, after independent snapshots and directory syncs.
    const prepared = path.join(directory(id), "proposal.prepared")
    await writeNew(prepared, Schema.encodeSync(Schema.parseJson(Staged))(staged))
    await rename(prepared, path.join(directory(id), "proposal.json"))
    await sync(directory(id))
    return staged
  }))

  const review = Effect.fnUntraced(function* (id: string, options?: { diff: boolean }) {
    const stored = yield* readProposal(id)
    yield* validateSnapshots(stored)
    const diff: Array<typeof Difference.Type> = []
    if (options?.diff) {
      const before = new Map((stored.proposal.baseline?.entries ?? []).map(e => [e.path, e]))
      const after = new Map(stored.proposal.candidate.entries.map(e => [e.path, e]))
      // At most 256KiB text total and 8KiB per side. Binary and truncation are
      // explicit; exact per-file content hashes remain present regardless.
      let remaining = 256 * 1024
      const preview = async (rootPath: string, entry: typeof Entry.Type | undefined) => {
        if (entry?.kind !== "file") return undefined
        const size = Math.min(entry.bytes, 8192, remaining)
        remaining -= size
        const h = await open(path.join(rootPath, entry.path), "r")
        const buffer = Buffer.alloc(size)
        try { await h.read(buffer, 0, size, 0) } finally { await h.close() }
        let text: string | undefined
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer) } catch { /* explicit binary below */ }
        const binary = text === undefined || buffer.includes(0)
        return { ...(binary ? {} : { text }), binary, truncated: size < entry.bytes }
      }
      for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const a = before.get(name), b = after.get(name)
        if (JSON.stringify(a) === JSON.stringify(b)) continue
        diff.push({ path: name, change: a === undefined ? "added" : b === undefined ? "deleted" : "modified", before: a, after: b,
          beforeText: yield* attempt("baseline text preview", () => preview(baselinePath(id), a)),
          afterText: yield* attempt("candidate text preview", () => preview(candidatePath(id), b)) })
      }
    }
    return { ...stored, diff }
  })
  const apply = (input: { id: string, expectedDigest: string }) => locked(Effect.gen(function* () {
    const stored = yield* readProposal(input.id)
    if (input.expectedDigest !== stored.proposalDigest) return yield* error("full expected proposal digest mismatch; not claimed")
    const status = yield* readStatus(input.id)
    if (status.state === "cancelled") return yield* error("proposal cancelled")
    if (status.state !== "staged") {
      if (status.receipt !== undefined) return status.receipt
      const prior = yield* hold.checkedStatus(input.id)
      if (prior !== undefined) return prior
      return { version: "checked-hold/v1" as const, receiptId: input.id, operationKey: input.id, target: stored.proposal.target,
        proposalDigest: stored.proposalDigest, claim: status.claim,
        state: "recovery-required" as const, reason: "workflow claim exists; no Hold outcome; never retried" }
    }
    const claim = observeClaim()
    yield* writeStatus({ version: "change/v1", id: input.id, state: "claimed", claim })
    // Tampering after claim consumes the attempt too. Hold revalidates its
    // independent install stage and the live baseline inside its own lease.
    const valid = yield* validateSnapshots(stored).pipe(Effect.either)
    if (valid._tag === "Left") {
      const receipt: CheckedOutcome = { version: "checked-hold/v1", receiptId: input.id, operationKey: input.id, target: stored.proposal.target,
        proposalDigest: stored.proposalDigest, claim, state: "rejected", reason: valid.left.reason }
      yield* writeStatus({ version: "change/v1", id: input.id, state: "rejected", receipt, claim })
      return receipt
    }
    const receipt = yield* hold.replaceChecked({ operationKey: input.id, target: stored.proposal.target,
      parent: stored.proposal.parent, expected: stored.proposal.expected,
      candidate: { path: candidatePath(input.id), tree: stored.proposal.candidate }, proposalDigest: stored.proposalDigest })
    return yield* persistReceipt(input.id, receipt)
  }))
  const cancel = (id: string) => locked(Effect.gen(function* () {
    yield* readProposal(id)
    const status = yield* readStatus(id)
    if (status.state !== "staged") return yield* error("cancel requires unclaimed proposal")
    const cancelled: Status = { ...status, state: "cancelled" }
    yield* writeStatus(cancelled)
    return cancelled
  }))
  const undo = (receiptId: string) => locked(Effect.gen(function* () {
    yield* Schema.decodeUnknown(OperationKey)(receiptId)
    // Apply receipt IDs are proposal IDs, never an implicit latest pointer.
    const status = yield* readStatus(receiptId)
    if (status.receipt?.receiptId !== receiptId || status.receipt.state !== "installed") return yield* error("exact apply receipt required")
    if (status.undoReceipt !== undefined) return status.undoReceipt
    const receipt = yield* hold.undoChecked(receiptId)
    return yield* persistReceipt(receiptId, receipt, true)
  }))
  const recover = (id: string, options?: { restore: boolean }) => locked(Effect.gen(function* () {
    const status = yield* readStatus(id)
    if (status.state === "staged" || status.state === "cancelled") return status
    const undone = yield* hold.recoverChecked(`undo_${id}`, options?.restore)
    const receipt = undone ?? (yield* hold.recoverChecked(id, options?.restore))
    if (receipt !== undefined) {
      const published = yield* persistReceipt(id, receipt, undone !== undefined)
      if (published.state === "recovery-required") return { ...status, state: published.state,
        ...(undone === undefined ? { receipt: published } : { undoReceipt: published }) }
    }
    else if (status.state === "claimed") {
      const staged = yield* readProposal(id)
      yield* writeStatus({ ...status, state: "rejected", receipt: {
        version: "checked-hold/v1", receiptId: id, operationKey: id, target: staged.proposal.target,
        proposalDigest: staged.proposalDigest, claim: status.claim,
        state: "rejected", reason: "interrupted workflow claim; no Hold claim, so no world effect; attempt consumed"
      } })
    }
    return yield* readStatus(id)
  }))
  return Change.of({ stage, review, status: readStatus, apply, cancel, undo, recover })
})

export const ChangeLayer = Layer.effect(Change, make)
export const ChangeLive = ChangeLayer
