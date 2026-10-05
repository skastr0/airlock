import { describe, expect, it } from "vitest"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Change, ChangeLive } from "../src/change/Change.ts"
import { exists } from "../src/change/Tree.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { FileLedgerLive } from "../src/host/FileLedger.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const run = Effect.runPromise
type ChangeService = Change["Service"]
const world = async (body: (w: { root: string, home: string, change: ChangeService, hold: Hold["Service"] }) => Promise<void>) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "change-lifecycle-"))), home = path.join(root, "home")
  const runtime = ManagedRuntime.make(ChangeLive.pipe(Layer.provideMerge(HoldLayer), Layer.provideMerge(ExclusiveRenameTestLive),
    Layer.provideMerge(FileLedgerLive), Layer.provideMerge(AirlockHome.layer(home)), Layer.provideMerge(BunServices.layer)))
  try { await body({ root, home, ...await runtime.runPromise(Effect.all({ change: Change, hold: Hold })) }) }
  finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}
const proposal = async (root: string, change: ChangeService) => {
  const source = path.join(root, "source"), target = path.join(root, "target")
  await writeFile(source, "new"); await writeFile(target, "old")
  return { source, target, ...await run(change.stage({ source, target })) }
}
const retire = async (change: ChangeService, id: string) => {
  const row = (await run(change.inventory())).rows.find(r => r.id === id)!
  expect(row.retirementDigest, JSON.stringify(row)).toMatch(/^sha256:/)
  return run(change.retire({ id, expectedDigest: row.retirementDigest! }))
}

describe("explicit snapshot lifecycle", () => {
  it("200 mixed cycles in one home reclaim active slots and snapshot/private-stage reservations", () => world(async ({ root, change, home }) => {
    for (let cycle = 0; cycle < 200; cycle++) {
      const p = await proposal(root, change)
      if (cycle % 3 === 0) await run(change.cancel(p.id))
      else {
        const receipt = await run(change.apply({ id: p.id, expectedDigest: p.proposalDigest }))
        expect(receipt.state).toBe("installed")
        if (cycle % 3 === 2) expect((await run(change.undo(receipt.receiptId))).state).toBe("undone")
      }
      expect((await retire(change, p.id)).state).toBe("retired")
      expect((await run(change.collect(p.id))).state).toBe("collected")
      expect(await exists(path.join(home, "changes", p.id, "candidate"))).toBe(false)
    }
    const inbox = await run(change.inventory())
    expect(inbox.totals).toEqual({ rows: 200, active: 0, reservedBytes: 0, snapshotBytes: 0, collected: 200, errors: 0 })
  }), 600000)
  it("retirement artifacts cannot shadow ordinary held acts or undoLast", () => world(async ({ root, change, hold }) => {
    const ordinary = path.join(root, "ordinary")
    await writeFile(ordinary, "recover me")
    const removed = await run(hold.remove(ordinary))
    const p = await proposal(root, change)
    await run(change.cancel(p.id)); await retire(change, p.id); await run(change.collect(p.id))
    expect((await run(hold.held)).map(m => m.id)).toEqual([removed.id])
    expect((await run(hold.undoLast)).id).toBe(removed.id)
    expect(await readFile(ordinary, "utf8")).toBe("recover me")
  }))
  it("stale retirement digest and retained-content drift refuse without releasing budget", () => world(async ({ root, home, change }) => {
    const p = await proposal(root, change)
    await run(change.cancel(p.id))
    const digest = (await run(change.inventory())).rows[0]!.retirementDigest!
    await writeFile(path.join(home, "changes", p.id, "candidate"), "changed")
    await expect(run(change.retire({ id: p.id, expectedDigest: digest }))).rejects.toMatchObject({ _tag: "ChangeError", reason: expect.stringContaining("digest") })
    const retired = await retire(change, p.id)
    await writeFile(path.join(home, "hold", retired.holdActIds[0]!, "payload", "candidate"), "tampered")
    expect((await run(change.collect(p.id))).state).toBe("recovery-required")
    expect((await run(change.inventory())).totals.reservedBytes).toBeGreaterThan(0)
  }))
  const finish = async (change: ChangeService, id: string) => {
    await run(change.cancel(id)); await retire(change, id)
    expect((await run(change.collect(id))).state).toBe("collected")
  }
  const refusedForBudget = (root: string, change: ChangeService) =>
    expect(run(change.stage({ source: path.join(root, "source"), target: path.join(root, "target") })))
      .rejects.toMatchObject({ _tag: "ChangeError", reason: expect.stringContaining("budget exceeded") })

  it("a finished proposal leaves the scanned root and later stages never look at it", () => world(async ({ root, home, change }) => {
    const finished = await proposal(root, change)
    await finish(change, finished.id)
    expect(await exists(path.join(home, "changes", finished.id))).toBe(false)
    expect(await exists(path.join(home, "changes", "settled", finished.id, "status.json"))).toBe(true)
    // History still answers by id.
    expect((await run(change.status(finished.id))).state).toBe("cancelled")
    expect((await run(change.review(finished.id))).proposalDigest).toBe(finished.proposalDigest)
    // Take away what a full inspection of the settled proposal would need.
    // Staging must not ask for it: it does not read the settled directory.
    await rename(path.join(home, "hold", "snapshot-retirements", `${finished.id}.json`), path.join(root, "moved-away.json"))
    const next = await proposal(root, change)
    expect((await run(change.status(next.id))).state).toBe("staged")
  }))
  it("the limit is enforced by open proposals alone, with thousands settled beside them", () => world(async ({ root, home, change }) => {
    // History the budget must not walk: three thousand settled directories.
    const settled = path.join(home, "changes", "settled")
    const first = await proposal(root, change)
    await finish(change, first.id)
    for (let n = 0; n < 3000; n++) await mkdir(path.join(settled, `change_${crypto.randomUUID()}`))
    // Each open proposal reserves a little over 32 MiB, so fifteen fill the
    // 512 MiB store and a sixteenth is refused.
    const open: Array<Awaited<ReturnType<typeof proposal>>> = []
    for (let n = 0; n < 15; n++) open.push(await proposal(root, change))
    await refusedForBudget(root, change)
    // Finishing one is what frees budget.
    await finish(change, open[0]!.id)
    await proposal(root, change)
    await refusedForBudget(root, change)
  }), 120000)
  it("whatever is in the root is inspected in full and counted", () => world(async ({ root, home, change }) => {
    // A directory planted in the root is an allocation nobody finished: it is
    // charged the maximum reservation (288 MiB), not skipped.
    await proposal(root, change).then(p => finish(change, p.id))
    await mkdir(path.join(home, "changes", `change_${crypto.randomUUID()}`))
    for (let n = 0; n < 6; n++) await proposal(root, change)
    await refusedForBudget(root, change)
  }), 120000)
  it("a settled proposal moved back into the root is inspected again and moved out again", () => world(async ({ root, home, change }) => {
    const p = await proposal(root, change)
    await finish(change, p.id)
    const open = path.join(home, "changes", p.id), settled = path.join(home, "changes", "settled", p.id)
    await rename(settled, open)
    await proposal(root, change)
    expect(await exists(open)).toBe(false)
    expect(await exists(settled)).toBe(true)
    // Moved back with private bytes inside, it is not finished: it stays in
    // the root and holds budget until someone deals with it.
    await rename(settled, open)
    await writeFile(path.join(open, "candidate"), "back again")
    await proposal(root, change)
    expect(await exists(open)).toBe(true)
    const row = (await run(change.inventory())).rows.find(r => r.id === p.id)!
    expect(row.snapshots.state).toBe("recovery-required")
    expect(row.reservationBytes).toBeGreaterThan(0)
  }))
  it("a collection that was never followed by the move is healed by the next stage", () => world(async ({ root, home, change, hold }) => {
    const p = await proposal(root, change)
    await run(change.cancel(p.id)); await retire(change, p.id)
    // Collect through Hold alone: the state a crash leaves between the durable
    // collection and the move.
    expect((await run(hold.collectChangeSnapshots(p.id))).state).toBe("collected")
    expect(await exists(path.join(home, "changes", p.id))).toBe(true)
    await proposal(root, change)
    expect(await exists(path.join(home, "changes", p.id))).toBe(false)
    expect(await exists(path.join(home, "changes", "settled", p.id))).toBe(true)
  }))
  it("the listing keeps history, and a settled proposal can still be undone", () => world(async ({ root, home, change }) => {
    const p = await proposal(root, change)
    const receipt = await run(change.apply({ id: p.id, expectedDigest: p.proposalDigest }))
    await retire(change, p.id)
    expect((await run(change.collect(p.id))).state).toBe("collected")
    expect(await exists(path.join(home, "changes", "settled", p.id))).toBe(true)
    const listed = async () => (await run(change.inventory())).rows.find(r => r.id === p.id)!
    expect(await listed()).toMatchObject({ applyState: "installed", undoState: "unclaimed", active: false })
    // The cached row is a convenience: damage it and the listing still tells
    // the truth, then repairs it.
    const cache = path.join(home, "changes", "settled", p.id, "inventory-row.json")
    const original = await readFile(cache, "utf8")
    await writeFile(cache, "{ torn")
    expect(await listed()).toMatchObject({ applyState: "installed", undoState: "unclaimed" })
    expect(await readFile(cache, "utf8")).toBe(original)
    // Undo works from the settled location and the listing follows it.
    expect((await run(change.undo(receipt.receiptId))).state).toBe("undone")
    expect(await readFile(path.join(root, "target"), "utf8")).toBe("old")
    expect(await listed()).toMatchObject({ applyState: "installed", undoState: "undone" })
  }))
  it("concurrent read/retire/collect is serialized and never falls back to source", () => world(async ({ root, change }) => {
    const p = await proposal(root, change); await run(change.cancel(p.id))
    const digest = (await run(change.inventory())).rows[0]!.retirementDigest!
    const [page, a, b] = await Promise.all([
      run(change.content({ id: p.id, side: "after", path: "" }).pipe(Effect.result)),
      run(change.retire({ id: p.id, expectedDigest: digest })), run(change.retire({ id: p.id, expectedDigest: digest }))
    ])
    if (page._tag === "Success") expect(Buffer.from(page.success.dataBase64, "base64").toString()).toBe("new")
    else expect(page.failure.reason).toContain("retired")
    expect(a.holdActIds).toEqual(b.holdActIds)
    const collected = await Promise.all([run(change.collect(p.id)), run(change.collect(p.id))])
    expect(collected.every(r => r.state === "collected")).toBe(true)
  }))
  it("empty inventory does not allocate changes store", () => world(async ({ change, home }) => {
    expect((await run(change.inventory())).totals.rows).toBe(0)
    expect(await exists(path.join(home, "changes"))).toBe(false)
  }))
  it("cancel, digest-bound retire, targeted collect release only snapshot/private-stage budget", () => world(async ({ root, change, home, hold }) => {
    const p = await proposal(root, change)
    expect((await run(change.inventory())).rows[0]!.retirementDigest).toBeUndefined()
    await run(change.cancel(p.id))
    const r = await retire(change, p.id)
    expect(r.state, r.reason).toBe("retired")
    expect((await run(hold.reap(0))).reaped).toEqual([])
    expect((await run(change.inventory())).totals.active).toBe(1)
    expect((await run(change.collect(p.id))).state).toBe("collected")
    expect((await run(change.collect(p.id))).state).toBe("collected")
    const inbox = await run(change.inventory())
    expect(inbox.totals.active).toBe(0); expect(inbox.totals.reservedBytes).toBe(0)
    expect(await exists(path.join(home, "changes", "settled", p.id, "proposal.json"))).toBe(true)
    expect((await run(change.review(p.id))).proposalDigest).toBe(p.proposalDigest)
    await expect(run(change.content({ id: p.id, side: "after", path: "" }))).rejects.toMatchObject({ _tag: "ChangeError", reason: expect.stringContaining("retired") })
  }))
  it("collection preserves original apply payload and exact checked undo; rejected undo stays consumed", () => world(async ({ root, home, change }) => {
    const p = await proposal(root, change)
    const applied = await run(change.apply({ id: p.id, expectedDigest: p.proposalDigest }))
    expect((await retire(change, p.id)).state).toBe("retired")
    expect((await run(change.collect(p.id))).state).toBe("collected")
    expect(await readFile(path.join(home, "hold", applied.actId!, "payload"), "utf8")).toBe("old")
    expect((await run(change.undo(applied.receiptId))).state).toBe("undone")
    const q = await proposal(root, change)
    const a = await run(change.apply({ id: q.id, expectedDigest: q.proposalDigest }))
    await writeFile(q.target, "foreign")
    const rejected = await run(change.undo(a.receiptId))
    expect(rejected.state).toBe("rejected")
    await writeFile(q.target, "new")
    expect(await run(change.undo(a.receiptId))).toEqual(rejected)
    const row = (await run(change.inventory())).rows.find(r => r.id === q.id)!
    expect(row.applyState).toBe("installed"); expect(row.undoState).toBe("rejected")
  }))
  it("incomplete allocations are visible, digest-bound abandonable and reclaimable", () => world(async ({ home, change }) => {
    const id = `change_${crypto.randomUUID()}`
    await mkdir(path.join(home, "changes", id), { recursive: true, mode: 0o700 })
    await writeFile(path.join(home, "changes", id, "candidate"), "partial")
    const row = (await run(change.inventory())).rows[0]!
    expect(row.workflowState).toBe("incomplete"); expect(row.reservationBytes).toBeGreaterThan(0)
    expect((await retire(change, id)).state).toBe("retired")
    expect((await run(change.collect(id))).state).toBe("collected")
    expect((await run(change.inventory())).totals.active).toBe(0)
  }))
  it("truncated unpublished status can be abandoned; published corrupt and unresolved records cannot", () => world(async ({ home, root, change }) => {
    const id = `change_${crypto.randomUUID()}`, directory = path.join(home, "changes", id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path.join(directory, "status.json"), '{"version":')
    await writeFile(path.join(directory, "candidate"), "partial")
    expect((await retire(change, id)).state).toBe("retired")
    expect((await run(change.collect(id))).state).toBe("collected")
    const p = await proposal(root, change)
    await writeFile(path.join(home, "changes", p.id, "status.json"), '{"version":')
    const row = (await run(change.inventory())).rows.find(r => r.id === p.id)!
    expect(row.retirementDigest).toBeUndefined(); expect(row.errors.length).toBeGreaterThan(0)
  }))
  it("a collected tombstone never releases reservation for reappeared unsupported private bytes", () => world(async ({ root, home, change }) => {
    const p = await proposal(root, change); await run(change.cancel(p.id)); await retire(change, p.id); await run(change.collect(p.id))
    await symlink(p.source, path.join(home, "changes", "settled", p.id, "candidate"))
    const row = (await run(change.inventory())).rows[0]!
    expect(row.snapshots.state).toBe("recovery-required"); expect(row.active).toBe(true)
    const receipt = await run(change.collect(p.id))
    expect(receipt.state).toBe("recovery-required"); expect(receipt.releasedReservationBytes).toBe(0)
  }))
  it("pages exact binary frozen content beyond 8KiB and rejects arbitrary paths/bounds", () => world(async ({ root, change }) => {
    const source = path.join(root, "source"), target = path.join(root, "target")
    const bytes = Buffer.alloc(20000, 255); bytes.write("late change", 12000)
    await writeFile(source, bytes)
    const p = await run(change.stage({ source, target }))
    await writeFile(source, "unrelated")
    const page = await run(change.content({ id: p.id, side: "after", path: "", offset: 12000, limit: 11 }))
    expect(Buffer.from(page.dataBase64, "base64").toString()).toBe("late change")
    expect(page.nextOffset).toBe(12011); expect(page.eof).toBe(false)
    const end = await run(change.content({ id: p.id, side: "after", path: "", offset: 19999 }))
    expect(Buffer.from(end.dataBase64, "base64")).toEqual(Buffer.from([255])); expect(end.eof).toBe(true)
    for (const name of ["../source", "/etc/passwd", "."]) await expect(run(change.content({ id: p.id, side: "after", path: name }))).rejects.toThrow()
    await expect(run(change.content({ id: p.id, side: "after", path: "", limit: 65537 }))).rejects.toThrow()
  }))
})
