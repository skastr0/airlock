import { expect, it } from "vitest"
import { BunContext } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Change, ChangeLive } from "../src/change/Change.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const layers = (home: string) => ChangeLive.pipe(Layer.provideMerge(HoldLayer), Layer.provideMerge(ExclusiveRenameTestLive),
  Layer.provideMerge(LedgerLive), Layer.provideMerge(AirlockHome.layer(home)), Layer.provideMerge(BunContext.layer))
const crash = (input: { home: string, id: string, digest: string, point: string, collect: boolean }) => {
  const script = `
    import { FileSystem } from "@effect/platform"
    import { BunContext } from "@effect/platform-bun"
    import { Effect, Layer, ManagedRuntime } from "effect"
    import { readFileSync } from "node:fs"
    import * as AirlockHome from "./src/AirlockHome.ts"
    import { Change, ChangeLive } from "./src/change/Change.ts"
    import { HoldLayer } from "./src/Hold.ts"
    import { LedgerLive } from "./src/Ledger.ts"
    import { ExclusiveRename } from "./src/platform/ExclusiveRename.ts"
    import { ExclusiveRenameTestLive } from "./test/support/ExclusiveRenameTestLive.ts"
    const input = ${JSON.stringify(input)}
    const moves = Layer.effect(ExclusiveRename, Effect.gen(function* () {
      const real = yield* ExclusiveRename
      return ExclusiveRename.of({ moveNoReplace: (source, target) => Effect.gen(function* () {
        yield* real.moveNoReplace(source, target)
        if (input.point === "after-move" && target.endsWith("/payload/candidate")) process.exit(86)
      }) })
    })).pipe(Layer.provide(ExclusiveRenameTestLive))
    const fileSystem = Layer.effect(FileSystem.FileSystem, Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem
      return { ...real, rename: (source, target) => Effect.gen(function* () {
        const record = target.includes("/snapshot-retirements/") ? JSON.parse(readFileSync(source, "utf8")) : undefined
        yield* real.rename(source, target)
        if (record && ((input.point === "after-approval" && record.phase === "prepared" && !record.bundle) ||
          (input.point === "after-binding" && record.phase === "prepared" && record.bundle) ||
          input.point === "after-" + record.phase)) process.exit(86)
      }), remove: (target, options) => Effect.gen(function* () {
        if (target.endsWith("/payload") && input.point === "partial-remove") {
          yield* real.remove(target + "/candidate", { recursive: true }); process.exit(86)
        }
        yield* real.remove(target, options)
        if (target.endsWith("/payload") && input.point === "after-remove") process.exit(86)
      }) }
    })).pipe(Layer.provide(BunContext.layer))
    const runtime = ManagedRuntime.make(ChangeLive.pipe(Layer.provideMerge(HoldLayer), Layer.provideMerge(moves),
      Layer.provideMerge(LedgerLive), Layer.provideMerge(AirlockHome.layer(input.home)),
      Layer.provideMerge(fileSystem), Layer.provideMerge(BunContext.layer)))
    const change = await runtime.runPromise(Change)
    await runtime.runPromise(input.collect ? change.collect(input.id) : change.retire({ id: input.id, expectedDigest: input.digest }))
    await runtime.dispose(); process.exit(87)
  `
  const child = spawnSync("bun", ["-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30000 })
  expect(child.stderr).toBe("")
  expect(child.status, `actual process exit at ${input.point}`).toBe(86)
}

for (const point of ["after-approval", "after-binding", "after-move", "after-retired", "after-collecting", "partial-remove", "after-remove", "after-collected"]) {
  it(`snapshot lifecycle restarts at ${point} without releasing retained/private bytes early`, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "change-lifecycle-crash-"))), home = path.join(root, "home")
    const runtime = ManagedRuntime.make(layers(home))
    try {
      const change = await runtime.runPromise(Change), hold = await runtime.runPromise(Hold)
      const source = path.join(root, "source"), target = path.join(root, "target")
      await writeFile(source, "new"); await writeFile(target, "old")
      const proposal = await runtime.runPromise(change.stage({ source, target }))
      // Rejected application leaves an independently copied private /stage.
      await writeFile(target, "foreign")
      expect((await runtime.runPromise(change.apply({ id: proposal.id, expectedDigest: proposal.proposalDigest }))).state).toBe("rejected")
      const row = (await runtime.runPromise(change.inventory())).rows[0]!
      const collect = ["after-collecting", "partial-remove", "after-remove", "after-collected"].includes(point)
      if (collect) expect((await runtime.runPromise(change.retire({ id: proposal.id, expectedDigest: row.retirementDigest! }))).state).toBe("retired")
      crash({ home, id: proposal.id, digest: row.retirementDigest!, point, collect })
      const restarted = ManagedRuntime.make(layers(home))
      try {
        const next = await restarted.runPromise(Change)
        const inventory = await restarted.runPromise(next.inventory())
        if (point !== "after-collected") {
          expect(inventory.totals.active).toBe(1); expect(inventory.totals.reservedBytes).toBeGreaterThan(0)
        }
        if (["after-approval", "after-binding", "after-move"].includes(point)) expect((await runtime.runPromise(hold.reap(0))).reaped).toEqual([])
        if (!collect) expect((await restarted.runPromise(next.retire({ id: proposal.id, expectedDigest: row.retirementDigest! }))).state).toBe("retired")
        expect((await restarted.runPromise(next.collect(proposal.id))).state).toBe("collected")
        expect((await restarted.runPromise(next.inventory())).totals.reservedBytes).toBe(0)
        expect(await readFile(target, "utf8")).toBe("foreign")
      } finally { await restarted.dispose() }
    } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 30000)
}
