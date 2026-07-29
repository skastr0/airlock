// The founding incident, replayed against airlock physics.
//
// July 2026: an installer test suite derived its database path from the
// wrong root (ACCOUNT_HOME instead of the sandbox root) and ran
//
//   printf appeared > "$STATE_DATABASE"
//
// through bash. O_TRUNC fired before anything could object. The real
// database was left as 8 bytes of ASCII. No recovery path existed.
//
// Below is the same mistake — the wrong root, the same destructive write —
// written as an airlock script. The mistake still happens. It costs one undo.
//
//   AIRLOCK_HOME=/tmp/airlock-demo bun run examples/founding-incident.ts

import { FileSystem, Path } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Hold } from "../src/Hold.ts"
import { HoldLive } from "../src/HoldLive.ts"
import { LedgerLive } from "../src/Ledger.ts"

const original = "one canvas, three boxes, hours of real work"

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const hold = yield* Hold

  // ── the world before: a real database with real work in it ────────────
  const tmp = yield* fs.makeTempDirectory()
  const stateDir = path.join(tmp, "real-home", ".vellum", "state")
  yield* fs.makeDirectory(stateDir, { recursive: true })
  const realDb = path.join(stateDir, "vellum.db")
  yield* fs.writeFileString(realDb, original)

  // ── the buggy test: derives its target from the WRONG root ────────────
  // (the exact ACCOUNT_HOME / INSTALL_USER_ROOT confusion)
  const STATE_DATABASE = realDb // believed to be sandboxed; is not

  // bash:    printf appeared > "$STATE_DATABASE"    → bytes gone, forever
  // airlock: the same destructive intent is a staged overwrite
  const receipt = yield* hold.overwrite(STATE_DATABASE, "appeared")

  const damaged = yield* fs.readFileString(realDb)
  yield* Console.log(`damaged  : ${JSON.stringify(damaged)}`)

  // ── detection, however late — recovery is total ───────────────────────
  yield* hold.undo(receipt.id)
  const restored = yield* fs.readFileString(realDb)
  yield* Console.log(`restored : ${JSON.stringify(restored)}`)

  yield* Console.log(
    restored === original
      ? "VERDICT: incident reversed, byte-for-byte"
      : "VERDICT: recovery failed"
  )
})

const AirlockLive = HoldLive.pipe(
  Layer.provideMerge(LedgerLive),
  Layer.provideMerge(AirlockHome.layerFromEnv),
  Layer.provideMerge(BunContext.layer)
)

program.pipe(Effect.provide(AirlockLive), BunRuntime.runMain)
