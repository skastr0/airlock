import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FileSystem } from "@effect/platform"
import { Console, Effect, Layer } from "effect"
import * as AirlockHome from "../../src/AirlockHome.ts"
import { Hold } from "../../src/Hold.ts"
import { HoldLive } from "../../src/HoldLive.ts"
import { LedgerLive } from "../../src/Ledger.ts"
import { ExclusiveRename } from "../../src/platform/ExclusiveRename.ts"
import { MacosExclusiveRenameLive } from "../../src/platform/macos/MacosExclusiveRename.ts"

const root = process.argv.at(-1)
if (root === undefined || root === process.argv[0]) {
  throw new Error("compiled exclusive-rename fixture requires a root path")
}
const home = `${root}/airlock-home`
const target = `${root}/managed.txt`

const layer = HoldLive.pipe(
  Layer.provideMerge(LedgerLive),
  Layer.provideMerge(AirlockHome.layer(home)),
  Layer.provideMerge(BunContext.layer)
)

const proof = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const hold = yield* Hold
  yield* fs.writeFileString(target, "compiled-original")
  const receipt = yield* hold.overwrite(target, "compiled-replacement")
  yield* hold.undo(receipt.id)
  const restored = yield* fs.readFileString(target)
  const collisionSource = `${root}/collision-source.txt`
  const collisionTarget = `${root}/collision-target.txt`
  yield* fs.writeFileString(collisionSource, "compiled source")
  yield* fs.writeFileString(collisionTarget, "compiled foreign")
  const collision = yield* Effect.flatMap(
    ExclusiveRename,
    (rename) =>
      rename.moveNoReplace(collisionSource, collisionTarget).pipe(Effect.flip)
  ).pipe(Effect.provide(MacosExclusiveRenameLive))
  yield* Console.log(JSON.stringify({
    collision: collision._tag,
    collisionSource: yield* fs.readFileString(collisionSource),
    collisionTarget: yield* fs.readFileString(collisionTarget),
    previousHeld: receipt.previousHeld,
    restored
  }))
}).pipe(Effect.provide(layer))

BunRuntime.runMain(proof)
