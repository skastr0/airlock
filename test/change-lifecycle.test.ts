import { describe, expect, it } from "vitest"
import { BunContext } from "@effect/platform-bun"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Change, ChangeLive } from "../src/change/Change.ts"
import { exists } from "../src/change/Tree.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const run = Effect.runPromise
type ChangeService = Context.Tag.Service<typeof Change>
const world = async (body: (w: { root: string, home: string, change: ChangeService, hold: Context.Tag.Service<typeof Hold> }) => Promise<void>) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "change-lifecycle-"))), home = path.join(root, "home")
  const runtime = ManagedRuntime.make(ChangeLive.pipe(Layer.provideMerge(HoldLayer), Layer.provideMerge(ExclusiveRenameTestLive),
    Layer.provideMerge(LedgerLive), Layer.provideMerge(AirlockHome.layer(home)), Layer.provideMerge(BunContext.layer)))
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
    expect(await exists(path.join(home, "changes", p.id, "proposal.json"))).toBe(true)
    expect((await run(change.review(p.id))).proposalDigest).toBe(p.proposalDigest)
    await expect(run(change.content({ id: p.id, side: "after", path: "" }))).rejects.toThrow("retired")
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
