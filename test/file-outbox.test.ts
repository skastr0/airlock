import { BunServices } from "@effect/platform-bun"
import { describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import type { EmissionId } from "../src/core/index.ts"
import { outboxConformance } from "../src/core/testing/index.ts"
import { FileLedgerLive, ledgerLayer } from "../src/host/FileLedger.ts"
import * as FileOutboxStore from "../src/host/FileOutboxStore.ts"

/**
 * The kernel's own invariants, held over this host's durable state: the file
 * store and the file ledger in one Airlock home, with Bun's Crypto.
 */
outboxConformance(
  { describe, test: it.effect },
  "file store and file ledger",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-outbox-" })
    const host = AirlockHome.layer(home).pipe(Layer.provideMerge(BunServices.layer))
    const outbox = path.join(home, "outbox")
    const stateDirectory = (id: EmissionId) =>
      Effect.flatMap(fs.readDirectory(outbox), (entries) => {
        const found = entries.find((entry) => entry.startsWith(`${id}.`))
        return found === undefined
          ? Effect.die(`no state directory for ${id}`)
          : Effect.succeed(path.join(outbox, found))
      })
    return {
      store: FileOutboxStore.layer.pipe(Layer.provide(host)),
      ledger: ledgerLayer.pipe(Layer.provide(FileLedgerLive), Layer.provide(host)),
      crypto: BunServices.layer,
      corruptRecord: (id: EmissionId) =>
        Effect.gen(function* () {
          const directory = yield* stateDirectory(id)
          const state = directory.slice(directory.lastIndexOf(".") + 1)
          yield* fs.writeFileString(
            path.join(directory, `record.${state}.json`),
            "{ not a record"
          )
        }),
      tamperDispatch: (id: EmissionId) =>
        Effect.gen(function* () {
          const file = path.join(yield* stateDirectory(id), "dispatch.json")
          const sealed = JSON.parse(yield* fs.readFileString(file)) as {
            readonly digest: string
            readonly canonical: string
          }
          // Same digest claim, different bytes: only recomputation can tell.
          yield* fs.writeFileString(file, JSON.stringify({
            digest: sealed.digest,
            canonical: sealed.canonical.replace(/"payload":"[^"]*"/, '"payload":"substituted"')
          }))
        })
    }
  }).pipe(Effect.provide(BunServices.layer))
)
