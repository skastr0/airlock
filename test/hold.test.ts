import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Hold, HoldLive } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"

const layersFor = (home: string) =>
  HoldLive.pipe(
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

interface World {
  readonly tmp: string
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly hold: Context.Tag.Service<typeof Hold>
}

// each test gets a fresh temp world: workspace + airlock home
const world = <A, E>(body: (ctx: World) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmp = yield* fs.makeTempDirectoryScoped()
      const home = path.join(tmp, "airlock-home")
      const hold = yield* Effect.provide(Hold, layersFor(home))
      return yield* body({ tmp, fs, path, hold })
    })
  ).pipe(Effect.provide(BunContext.layer))

describe("Hold — undoable mutations", () => {
  it.effect("remove then undo restores the exact bytes", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "data.txt")
        yield* fs.writeFileString(file, "precious bytes")

        const receipt = yield* hold.remove(file)
        expect(yield* fs.exists(file)).toBe(false)

        const undone = yield* hold.undo(receipt.id)
        expect(undone.target).toBe(file)
        expect(yield* fs.readFileString(file)).toBe("precious bytes")
      })
    )
  )

  it.effect("recursive directory remove round-trips", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const dir = path.join(tmp, "project")
        yield* fs.makeDirectory(path.join(dir, "nested"), { recursive: true })
        yield* fs.writeFileString(path.join(dir, "nested", "deep.txt"), "deep")

        const receipt = yield* hold.remove(dir)
        expect(receipt.kind).toBe("directory")
        expect(yield* fs.exists(dir)).toBe(false)

        yield* hold.undo(receipt.id)
        expect(
          yield* fs.readFileString(path.join(dir, "nested", "deep.txt"))
        ).toBe("deep")
      })
    )
  )

  it.effect("undo refuses to clobber a recreated target", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "data.txt")
        yield* fs.writeFileString(file, "v1")
        const receipt = yield* hold.remove(file)
        yield* fs.writeFileString(file, "recreated")

        const error = yield* hold.undo(receipt.id).pipe(Effect.flip)
        expect(error._tag).toBe("UndoConflict")
        expect(yield* fs.readFileString(file)).toBe("recreated")
      })
    )
  )

  it.effect("overwrite holds the previous version; undo restores it and displaces the new one", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "config.json")
        yield* fs.writeFileString(file, "v1")

        const receipt = yield* hold.overwrite(file, "v2")
        expect(receipt.previousHeld).toBe(true)
        expect(yield* fs.readFileString(file)).toBe("v2")

        const undone = yield* hold.undo(receipt.id)
        expect(yield* fs.readFileString(file)).toBe("v1")
        // v2 was not destroyed — it was displaced into the hold
        expect(undone.displaced).toBeDefined()
        const heldNow = yield* hold.held
        expect(heldNow.some((m) => m.id === undone.displaced)).toBe(true)
      })
    )
  )

  it.effect("undoing a creation displaces the created file — still zero unlinks", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "fresh.txt")
        const receipt = yield* hold.overwrite(file, "made by agent")
        expect(receipt.previousHeld).toBe(false)

        yield* hold.undo(receipt.id)
        expect(yield* fs.exists(file)).toBe(false)
      })
    )
  )

  it.effect("the airlock home is a protected path", () =>
    world(({ hold, path, tmp }) =>
      Effect.gen(function* () {
        const error = yield* hold
          .remove(path.join(tmp, "airlock-home", "ledger.jsonl"))
          .pipe(Effect.flip)
        expect(error._tag).toBe("ProtectedPath")
      })
    )
  )

  it.effect("reap reclaims held bytes and closes the recovery window", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "junk.txt")
        yield* fs.writeFileString(file, "junk")
        const receipt = yield* hold.remove(file)

        const report = yield* hold.reap(0)
        expect(report.reaped).toContain(receipt.id)

        const error = yield* hold.undo(receipt.id).pipe(Effect.flip)
        expect(error._tag).toBe("UnknownAct")
      })
    )
  )
})

describe("construction invariant", () => {
  it.effect("only the reaper unlinks: exactly one fs.remove in src", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const srcDir = fileURLToPath(new URL("../src", import.meta.url))
      const files = yield* fs.readDirectory(srcDir)
      let unlinkSites = 0
      for (const file of files) {
        const source = yield* fs.readFileString(path.join(srcDir, file))
        unlinkSites += (source.match(/\bfs\s*\.remove\(/g) ?? []).length
      }
      expect(unlinkSites).toBe(1)
    }).pipe(Effect.provide(BunContext.layer))
  )
})
