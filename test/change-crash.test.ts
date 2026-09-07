import { describe, expect, it } from "vitest"
import { BunContext } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Change, ChangeLive } from "../src/change/Change.ts"
import { exists } from "../src/change/Tree.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const repository = fileURLToPath(new URL("..", import.meta.url))
const layers = (home: string) => ChangeLive.pipe(
  Layer.provideMerge(HoldLayer), Layer.provideMerge(ExclusiveRenameTestLive), Layer.provideMerge(LedgerLive),
  Layer.provideMerge(AirlockHome.layer(home)), Layer.provideMerge(BunContext.layer)
)
const makeRuntime = (home: string) => ManagedRuntime.make(layers(home))
const crash = (input: { home: string, id: string, digest: string, target: string, point: string, action: string }) => {
  const script = `
    import { FileSystem } from "@effect/platform"
    import { BunContext } from "@effect/platform-bun"
    import { Effect, Layer, ManagedRuntime } from "effect"
    import { readFileSync } from "node:fs"
    import * as AirlockHome from "./src/AirlockHome.ts"
    import { Change, ChangeLive } from "./src/change/Change.ts"
    import { Hold, HoldLayer } from "./src/Hold.ts"
    import { LedgerLive } from "./src/Ledger.ts"
    import { ExclusiveRename } from "./src/platform/ExclusiveRename.ts"
    import { ExclusiveRenameTestLive } from "./test/support/ExclusiveRenameTestLive.ts"
    const input = ${JSON.stringify(input)}
    const moves = Layer.effect(ExclusiveRename, Effect.gen(function* () {
      const real = yield* ExclusiveRename
      return ExclusiveRename.of({ moveNoReplace: (source, target) => Effect.gen(function* () {
        if (input.point === "before-retain" && target.endsWith("/payload")) process.exit(86)
        yield* real.moveNoReplace(source, target)
        if (input.point === "after-retain" && target.endsWith("/payload")) process.exit(86)
        if (input.point === "after-install" && target === input.target) process.exit(86)
      }) })
    })).pipe(Layer.provide(ExclusiveRenameTestLive))
    const fileSystem = Layer.effect(FileSystem.FileSystem, Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem
      return { ...real, rename: (source, target) => Effect.gen(function* () {
        const checked = target.includes("/hold/checked/")
        const content = checked ? readFileSync(source, "utf8") : ""
        if (input.point === "before-outcome" && checked && JSON.parse(content).phase === "finished") process.exit(86)
        yield* real.rename(source, target)
        if (input.point === "after-outcome" && checked && JSON.parse(content).phase === "finished") process.exit(86)
        if (input.point === "after-acknowledgement" && checked && JSON.parse(content).acknowledged) process.exit(86)
      }) }
    })).pipe(Layer.provide(BunContext.layer))
    const base = HoldLayer.pipe(Layer.provideMerge(moves), Layer.provideMerge(LedgerLive),
      Layer.provideMerge(AirlockHome.layer(input.home)), Layer.provideMerge(fileSystem), Layer.provideMerge(BunContext.layer))
    const hooked = Layer.effect(Hold, Effect.gen(function* () {
      const real = yield* Hold
      return { ...real,
        replaceChecked: (request) => Effect.gen(function* () {
          if (input.point === "before-hold-claim") process.exit(86)
          const outcome = yield* real.replaceChecked(request)
          if (input.point === "before-receipt") process.exit(86)
          return outcome
        }),
        acknowledgeChecked: (key) => Effect.gen(function* () {
          if (input.point === "after-receipt") process.exit(86)
          yield* real.acknowledgeChecked(key)
        })
      }
    })).pipe(Layer.provide(base))
    const runtime = ManagedRuntime.make(ChangeLive.pipe(Layer.provide(hooked), Layer.provide(base)))
    const change = await runtime.runPromise(Change)
    await runtime.runPromise(input.action === "undo" ? change.undo(input.id) : input.action === "restore"
      ? change.recover(input.id, { restore: true }) : change.apply({ id: input.id, expectedDigest: input.digest }))
    await runtime.dispose()
    process.exit(87)
  `
  const child = spawnSync("bun", ["-e", script], { cwd: repository, encoding: "utf8", timeout: 30000 })
  expect(child.stderr, `crash helper ${input.point}`).toBe("")
  expect(child.status, `must actually terminate at ${input.point}, not finish or time out`).toBe(86)
}
const world = async (body: (w: { root: string, home: string, runtime: ReturnType<typeof makeRuntime> }) => Promise<void>) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "change-crash-"))), home = path.join(root, "home")
  const runtime = ManagedRuntime.make(layers(home))
  try { await body({ root, home, runtime }) } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}

describe("checked operation process-exit boundaries (real no-replace renames)", () => {
  for (const point of ["before-hold-claim", "before-retain", "after-retain", "after-install", "before-outcome", "after-outcome", "before-receipt", "after-receipt", "after-acknowledgement"]) {
    it(`apply restart reconciles ${point} without repeating world effect`, () => world(async ({ root, home, runtime }) => {
      const change = await runtime.runPromise(Change), hold = await runtime.runPromise(Hold)
      const source = path.join(root, "source"), target = path.join(root, "target")
      await writeFile(source, "new"); await writeFile(target, "old")
      const staged = await runtime.runPromise(change.stage({ source, target }))
      crash({ home, id: staged.id, digest: staged.proposalDigest, target, point, action: "apply" })
      expect((await runtime.runPromise(hold.reap(0))).reaped).toEqual([])
      const restarted = ManagedRuntime.make(layers(home))
      try {
        const next = await restarted.runPromise(Change)
        const recovered = await restarted.runPromise(next.recover(staged.id))
        if (point === "before-hold-claim" || point === "before-retain") {
          expect(recovered.state).toBe("rejected")
          expect(await readFile(target, "utf8")).toBe("old")
        } else if (point === "after-retain") {
          expect(recovered.state).toBe("recovery-required")
          expect(await exists(target)).toBe(false)
          expect((await restarted.runPromise(next.recover(staged.id, { restore: true }))).state).toBe("rolled-back")
          expect(await readFile(target, "utf8")).toBe("old")
        } else {
          expect(recovered.state).toBe("installed")
          expect(await readFile(target, "utf8")).toBe("new")
        }
        const acts = (await readdir(path.join(home, "hold"))).filter(n => n.startsWith("act_"))
        expect(acts.length).toBe(point === "before-hold-claim" ? 0 : 1)
        const after = await restarted.runPromise(next.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))
        expect(after.state).not.toBe("recovery-required")
        expect(after.proposalDigest).toBe(staged.proposalDigest)
        expect(after.claim?.localUid).toBe(process.getuid?.() ?? null)
        expect((await readdir(path.join(home, "hold"))).filter(n => n.startsWith("act_"))).toEqual(acts)
      } finally { await restarted.dispose() }
    }))
  }

  it("restart reconciles a process exit after explicit rollback rename", () => world(async ({ root, home, runtime }) => {
    const change = await runtime.runPromise(Change), hold = await runtime.runPromise(Hold)
    const source = path.join(root, "source"), target = path.join(root, "target")
    await writeFile(source, "new"); await writeFile(target, "old")
    const staged = await runtime.runPromise(change.stage({ source, target }))
    const input = { home, id: staged.id, digest: staged.proposalDigest, target }
    crash({ ...input, point: "after-retain", action: "apply" })
    crash({ ...input, point: "after-install", action: "restore" })
    expect(await readFile(target, "utf8")).toBe("old")
    expect((await runtime.runPromise(hold.reap(0))).reaped).toEqual([])
    expect((await runtime.runPromise(change.recover(staged.id))).state).toBe("rolled-back")
    expect((await runtime.runPromise(hold.reap(0))).reaped.length).toBe(1)
  }))

  for (const point of ["before-retain", "after-retain", "after-install", "before-outcome", "after-receipt", "after-acknowledgement"]) {
    it(`undo process exit at ${point} retains displaced bytes and reconciles once`, () => world(async ({ root, home, runtime }) => {
      const change = await runtime.runPromise(Change), hold = await runtime.runPromise(Hold)
      const source = path.join(root, "source"), target = path.join(root, "target")
      await writeFile(source, "new"); await writeFile(target, "old")
      const staged = await runtime.runPromise(change.stage({ source, target }))
      await runtime.runPromise(change.apply({ id: staged.id, expectedDigest: staged.proposalDigest }))
      crash({ home, id: staged.id, digest: staged.proposalDigest, target, point, action: "undo" })
      // A stale apply acknowledgement may not release newer undo pins.
      await runtime.runPromise(hold.acknowledgeChecked(staged.id))
      if (point !== "after-acknowledgement") expect((await runtime.runPromise(hold.reap(0))).reaped).toEqual([])
      const recovered = await runtime.runPromise(change.recover(staged.id))
      if (point === "before-retain") {
        expect(recovered.state).toBe("rejected")
        expect(await readFile(target, "utf8")).toBe("new")
      } else if (point === "after-retain") {
        expect(recovered.state).toBe("recovery-required")
        expect((await runtime.runPromise(change.recover(staged.id, { restore: true }))).state).toBe("rolled-back")
        expect(await readFile(target, "utf8")).toBe("new")
      } else {
        expect(recovered.state).toBe("undone")
        expect(await readFile(target, "utf8")).toBe("old")
      }
      expect((await runtime.runPromise(change.undo(staged.id))).state).not.toBe("recovery-required")
      expect((await runtime.runPromise(hold.reap(0))).reaped.length).toBe(2)
    }))
  }
})
