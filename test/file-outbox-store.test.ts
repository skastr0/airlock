import { BunServices } from "@effect/platform-bun"
import { describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { outboxStoreConformance } from "../src/core/testing/index.ts"
import type { EmissionId } from "../src/core/outbox/Records.ts"
import * as FileOutboxStore from "../src/host/FileOutboxStore.ts"

/**
 * The file adapter earns its place under the kernel by passing the same
 * conformance suite as every other OutboxStore. Each world is one fresh
 * Airlock home; building the Layer again reopens the same directory.
 */
outboxStoreConformance(
  { describe, test: it.effect },
  "file",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-outbox-store-" })
    const outbox = path.join(home, "outbox")
    return {
      store: FileOutboxStore.layer.pipe(
        Layer.provide(AirlockHome.layer(home)),
        Layer.provide(BunServices.layer)
      ),
      corruptRecord: (id: EmissionId) =>
        Effect.gen(function* () {
          const directory = (yield* fs.readDirectory(outbox)).find((entry) =>
            entry.startsWith(`${id}.`)
          )
          if (directory === undefined) return yield* Effect.die(`no state directory for ${id}`)
          const state = directory.slice(id.length + 1)
          yield* fs.writeFileString(
            path.join(outbox, directory, `record.${state}.json`),
            "{ not a record"
          )
        })
    }
  }).pipe(Effect.provide(BunServices.layer))
)
