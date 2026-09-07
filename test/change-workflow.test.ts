import { describe, expect, it } from "vitest"
import { BunContext } from "@effect/platform-bun"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Change, ChangeLive } from "../src/change/Change.ts"
import { exists, scan } from "../src/change/Tree.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { ExclusiveRename, ExclusiveRenameFailed } from "../src/platform/ExclusiveRename.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const layersFor = (home: string, moves = ExclusiveRenameTestLive) => ChangeLive.pipe(
  Layer.provideMerge(HoldLayer), Layer.provideMerge(moves),
  Layer.provideMerge(LedgerLive), Layer.provideMerge(AirlockHome.layer(home)), Layer.provideMerge(BunContext.layer)
)
type Services = { change: Context.Tag.Service<typeof Change>, hold: Context.Tag.Service<typeof Hold> }
const world = async (body: (w: Services & { root: string, home: string, restart: () => Promise<Services> }) => Promise<void>, moves = ExclusiveRenameTestLive) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "change-workflow-"))), home = path.join(root, "home")
  const runtimes: Array<{ dispose: () => Promise<void> }> = []
  const restart = async () => {
    const runtime = ManagedRuntime.make(layersFor(home, moves))
    runtimes.push(runtime)
    return runtime.runPromise(Effect.all({ change: Change, hold: Hold }))
  }
  try { await body({ root, home, restart, ...await restart() }) }
  finally { for (const runtime of runtimes) await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}
const run = Effect.runPromise
const files = async (root: string, existing = true) => {
  const source = path.join(root, "source"), target = path.join(root, "target")
  await writeFile(source, "new\n")
  if (existing) await writeFile(target, "old\n")
  return { source, target }
}

describe("Change immutable proposal workflow", () => {
  it("source changes after staging are irrelevant; exact file apply and checked undo retain both versions", () => world(async ({ root, home, change, hold }) => {
    const input = await files(root)
    const staged = await run(change.stage(input))
    await writeFile(input.source, "later, irrelevant")
    expect((await run(change.review(staged.id))).diff).toEqual([])
    const review = await run(change.review(staged.id, { diff: true }))
    expect(review.diff[0]!.beforeText?.text).toBe("old\n")
    expect(review.diff[0]!.afterText?.text).toBe("new\n")
    const receipt = await run(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))
    expect(receipt.state).toBe("installed")
    expect(await readFile(input.target, "utf8")).toBe("new\n")
    expect(await readFile(path.join(home, "hold", receipt.actId!, "payload"), "utf8")).toBe("old\n")
    const undone = await run(change.undo(receipt.receiptId))
    expect(undone.state).toBe("undone")
    expect(await readFile(input.target, "utf8")).toBe("old\n")
    expect(await readFile(path.join(home, "hold", undone.displacedActId!, "payload"), "utf8")).toBe("new\n")
    expect((await run(change.undo(receipt.receiptId))).receiptId).toBe(undone.receiptId)
    expect((await run(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))).receiptId).toBe(receipt.receiptId)
    expect(await readFile(input.target, "utf8")).toBe("old\n")
    expect((await run(hold.reap(0))).reaped.length).toBe(2)
  }))

  it("whole-directory replacement discloses deletions, binary, text truncation and modes", () => world(async ({ root, change }) => {
    const source = path.join(root, "source"), target = path.join(root, "target")
    await mkdir(source); await mkdir(target)
    await writeFile(path.join(target, "deleted"), "important")
    await writeFile(path.join(source, "binary"), Buffer.from([255, 0, 1]))
    await writeFile(path.join(source, "long"), "x".repeat(9000))
    await chmod(source, 0o750)
    const staged = await run(change.stage({ source, target }))
    const review = await run(change.review(staged.id, { diff: true }))
    expect(review.diff.find(d => d.path === "deleted")?.change).toBe("deleted")
    expect(review.diff.find(d => d.path === "binary")?.afterText?.binary).toBe(true)
    expect(review.diff.find(d => d.path === "long")?.afterText?.truncated).toBe(true)
    const receipt = await run(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))
    expect(receipt.state).toBe("installed")
    expect(await exists(path.join(target, "deleted"))).toBe(false)
    expect((await lstat(target)).mode & 0o777).toBe(0o750)
    expect((await run(change.undo(receipt.receiptId))).state).toBe("undone")
    expect(await readFile(path.join(target, "deleted"), "utf8")).toBe("important")
  }))

  it("wrong digest does not claim; cancel is available only before claim", () => world(async ({ root, change }) => {
    const staged = await run(change.stage(await files(root)))
    await expect(run(change.apply({ id: staged.id, expectedDigest: "0".repeat(64) }))).rejects.toThrow()
    expect((await run(change.status(staged.id))).state).toBe("staged")
    expect((await run(change.cancel(staged.id))).state).toBe("cancelled")
    await expect(run(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))).rejects.toThrow()
  }))

  for (const tamper of ["bytes", "mode", "identity", "candidate", "baseline", "proposal"] as const) {
    it(`refuses ${tamper} tampering without replacing target`, () => world(async ({ root, home, change }) => {
      const input = await files(root)
      const staged = await run(change.stage(input))
      if (tamper === "bytes") await writeFile(input.target, "bad\n")
      if (tamper === "mode") await chmod(input.target, 0o600)
      if (tamper === "identity") { await rename(input.target, input.target + "-original"); await writeFile(input.target, "old\n") }
      if (tamper === "candidate" || tamper === "baseline") await writeFile(path.join(home, "changes", staged.id, tamper), "bad\n")
      if (tamper === "proposal") {
        const file = path.join(home, "changes", staged.id, "proposal.json")
        const data = JSON.parse(await readFile(file, "utf8")); data.proposal.target += "-other"
        await writeFile(file, JSON.stringify(data))
        await expect(run(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))).rejects.toThrow()
        expect((await run(change.status(staged.id))).state).toBe("staged")
      } else {
        expect((await run(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))).state).toBe("rejected")
        await writeFile(input.target, "old\n")
        expect((await run(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))).state).toBe("rejected")
        await expect(run(change.cancel(staged.id))).rejects.toThrow()
      }
      expect(await readFile(input.target, "utf8")).not.toBe("new\n")
    }))
  }

  it("absent target occupation is refused; successful creation undo restores absence", () => world(async ({ root, change }) => {
    const input = await files(root, false)
    const a = await run(change.stage(input))
    await writeFile(input.target, "foreign")
    expect((await run(change.apply({ id: a.id, expectedDigest: a.proposalDigest }))).state).toBe("rejected")
    const b = await run(change.stage({ ...input, target: input.target + "-absent" }))
    const receipt = await run(change.apply({ id: b.id, expectedDigest: b.proposalDigest }))
    expect(receipt.state).toBe("installed")
    expect((await run(change.undo(receipt.receiptId))).state).toBe("undone")
    expect(await exists(input.target + "-absent")).toBe(false)
    expect(await readFile(input.target, "utf8")).toBe("foreign")
  }))

  it("checked undo refuses current target drift and retained original tampering", () => world(async ({ root, home, change }) => {
    const input = await files(root)
    const a = await run(change.stage(input))
    const receipt = await run(change.apply({ id: a.id, expectedDigest: a.proposalDigest }))
    await writeFile(input.target, "bad\n")
    expect((await run(change.undo(receipt.receiptId))).state).toBe("rejected")
    expect(await readFile(input.target, "utf8")).toBe("bad\n")
    const b = await run(change.stage(input))
    const next = await run(change.apply({ id: b.id, expectedDigest: b.proposalDigest }))
    await writeFile(path.join(home, "hold", next.actId!, "payload"), "tampered")
    expect((await run(change.undo(next.receiptId))).state).toBe("rejected")
    expect(await readFile(input.target, "utf8")).toBe("new\n")
  }))

  it("concurrent/repeated apply across instances executes at most once; competing baseline loses", () => world(async ({ root, home, change, restart }) => {
    const input = await files(root)
    const a = await run(change.stage(input)), b = await run(change.stage(input))
    const other = await restart()
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => run((i % 2 ? change : other.change).apply({ id: a.id, expectedDigest: a.proposalDigest }))))
    expect(new Set(outcomes.map(r => r.actId)).size).toBe(1)
    expect(outcomes.every(r => r.state === "installed")).toBe(true)
    expect((await run(other.change.apply({ id: b.id, expectedDigest: b.proposalDigest }))).state).toBe("rejected")
    expect((await readdir(path.join(home, "hold"))).filter(n => n.startsWith("act_")).length).toBe(2)
  }))

  it("receipt publication failure pins recovery bytes; restart recover publishes without repeating", () => world(async ({ root, home, change, hold, restart }) => {
    const input = await files(root)
    const a = await run(change.stage(input))
    const blocked = path.join(home, "changes", a.id, "receipt.json")
    await mkdir(blocked)
    await expect(run(change.apply({ id: a.id, expectedDigest: a.proposalDigest }))).rejects.toThrow()
    expect(await readFile(input.target, "utf8")).toBe("new\n")
    expect((await run(hold.reap(0))).reaped).toEqual([])
    await rename(blocked, blocked + "-retained")
    const next = await restart()
    const recovered = await run(next.change.recover(a.id))
    expect(recovered.state).toBe("installed")
    expect(recovered.receipt?.actId).toBeDefined()
    expect((await run(next.hold.reap(0))).reaped).toEqual([recovered.receipt!.actId])
  }))

  it("unresolved checked act stays inspectable on restart and pinned after retain failure", async () => {
    let failed = false
    const moves = Layer.effect(ExclusiveRename, Effect.gen(function* () {
      const real = yield* ExclusiveRename
      return ExclusiveRename.of({ moveNoReplace: (source, target) => real.moveNoReplace(source, target).pipe(Effect.flatMap(() => {
        if (!failed && target.endsWith("/payload")) { failed = true; return Effect.fail(new ExclusiveRenameFailed({ source, target, errno: 5, reason: "injected lost acknowledgement after retain" })) }
        return Effect.void
      })) })
    })).pipe(Layer.provide(ExclusiveRenameTestLive))
    await world(async ({ root, home, change, hold, restart }) => {
      const input = await files(root)
      const a = await run(change.stage(input))
      const outcome = await run(change.apply({ id: a.id, expectedDigest: a.proposalDigest }))
      expect(outcome.state).toBe("recovery-required")
      expect(await exists(input.target)).toBe(false)
      expect(await readFile(path.join(home, "hold", outcome.actId!, "payload"), "utf8")).toBe("old\n")
      expect((await run(hold.reap(0))).reaped).toEqual([])
      const next = await restart()
      expect((await run(next.change.recover(a.id))).state).toBe("recovery-required")
      expect((await run(next.change.apply({ id: a.id, expectedDigest: a.proposalDigest }))).state).toBe("recovery-required")
      expect(await exists(input.target)).toBe(false)
    }, moves)
  })

  it("proves lost install acknowledgement by exact identity+digest, never resumes installation", async () => {
    let failed = false
    const moves = Layer.effect(ExclusiveRename, Effect.gen(function* () {
      const real = yield* ExclusiveRename
      return ExclusiveRename.of({ moveNoReplace: (source, target) => real.moveNoReplace(source, target).pipe(Effect.flatMap(() => {
        if (!failed && source.endsWith("/stage")) { failed = true; return Effect.fail(new ExclusiveRenameFailed({ source, target, errno: 5, reason: "injected lost install acknowledgement" })) }
        return Effect.void
      })) })
    })).pipe(Layer.provide(ExclusiveRenameTestLive))
    await world(async ({ root, change, restart }) => {
      const input = await files(root)
      const a = await run(change.stage(input))
      expect((await run(change.apply({ id: a.id, expectedDigest: a.proposalDigest }))).state).toBe("recovery-required")
      const installed = await scan(input.target)
      const next = await restart()
      expect((await run(next.change.recover(a.id))).state).toBe("installed")
      expect((await scan(input.target)).identity).toEqual(installed.identity)
    }, moves)
  })

  for (const undo of [false, true]) {
    it(`explicit restoration recovers ${undo ? "undo displaced candidate" : "retained original"} and refuses foreign occupation`, async () => {
      let armed = false
      const moves = Layer.effect(ExclusiveRename, Effect.gen(function* () {
        const real = yield* ExclusiveRename
        return ExclusiveRename.of({ moveNoReplace: (source, target) => {
          if (armed && (undo ? source.endsWith("/payload") : source.endsWith("/stage"))) {
            armed = false
            return Effect.fail(new ExclusiveRenameFailed({ source, target, errno: 5, reason: "injected installation failure" }))
          }
          return real.moveNoReplace(source, target)
        } })
      })).pipe(Layer.provide(ExclusiveRenameTestLive))
      await world(async ({ root, change, hold, restart }) => {
        const input = await files(root)
        const a = await run(change.stage(input))
        expect(a.proposalDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
        if (!undo) armed = true
        const applied = await run(change.apply({ id: a.id, expectedDigest: a.proposalDigest }))
        if (undo) { armed = true; expect((await run(change.undo(applied.receiptId))).state).toBe("recovery-required") }
        else expect(applied.state).toBe("recovery-required")
        expect(await exists(input.target)).toBe(false)
        expect((await run(hold.reap(0))).reaped).toEqual([])
        await writeFile(input.target, "foreign")
        const next = await restart()
        expect((await run(next.change.recover(a.id, { restore: true }))).state).toBe("recovery-required")
        expect(await readFile(input.target, "utf8")).toBe("foreign")
        await rename(input.target, input.target + "-foreign-retained")
        expect((await run(next.change.recover(a.id, { restore: true }))).state).toBe("rolled-back")
        expect(await readFile(input.target, "utf8")).toBe(undo ? "new\n" : "old\n")
        expect((await run(next.change.recover(a.id, { restore: true }))).state).toBe("rolled-back")
        expect(await readFile(input.target + "-foreign-retained", "utf8")).toBe("foreign")
      }, moves)
    })
  }

  it("an incomplete allocation is conservatively charged without bricking staging", () => world(async ({ root, home, change }) => {
    const input = await files(root)
    await mkdir(path.join(home, "changes"), { mode: 0o700 })
    await mkdir(path.join(home, "changes", `change_${crypto.randomUUID()}`), { mode: 0o700 })
    const staged = await run(change.stage(input))
    expect((await run(change.status(staged.id))).state).toBe("staged")
  }))
})
