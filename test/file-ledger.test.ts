import { BunServices } from "@effect/platform-bun"
import { describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { ledgerConformance } from "../src/core/testing/index.ts"
import { FileLedgerLive, ledgerLayer } from "../src/host/FileLedger.ts"

/** The fsynced JSONL ledger, seen through the core port, passes the core suite. */
ledgerConformance(
  { describe, test: it.effect },
  "file",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-file-ledger-" })
    return {
      ledger: ledgerLayer.pipe(
        Layer.provide(FileLedgerLive),
        Layer.provide(AirlockHome.layer(home)),
        Layer.provide(BunServices.layer)
      )
    }
  }).pipe(Effect.provide(BunServices.layer))
)
