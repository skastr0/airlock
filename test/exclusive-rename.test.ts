import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { fileURLToPath } from "node:url"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { ExclusiveRename } from "../src/platform/ExclusiveRename.ts"
import { MacosExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const holdLayer = (
  home: string,
  rename: Layer.Layer<ExclusiveRename>
) =>
  HoldLayer.pipe(
    Layer.provideMerge(rename),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

const racingLayer = (
  base: typeof ExclusiveRename.Service,
  target: string,
  createForeign: () => void
) => {
  let fired = false
  return {
    layer: Layer.succeed(
      ExclusiveRename,
      ExclusiveRename.of({
        moveNoReplace: (source, destination) => {
          const race =
            !fired && destination === target
              ? Effect.sync(() => {
                  fired = true
                  createForeign()
                })
              : Effect.void
          return race.pipe(
            Effect.zipRight(base.moveNoReplace(source, destination))
          )
        }
      })
    ),
    fired: () => fired
  }
}

const world = <A, E>(
  body: (context: {
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
    readonly root: string
    readonly home: string
    readonly base: typeof ExclusiveRename.Service
  }) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const home = path.join(root, "airlock-home")
      const base = yield* Effect.provide(
        ExclusiveRename,
        MacosExclusiveRenameTestLive
      )
      return yield* body({ fs, path, root, home, base })
    })
  ).pipe(Effect.provide(BunContext.layer))

describe("ExclusiveRename — macOS Hold boundary", () => {
  it.effect("preserves foreign, staged, and held file bytes when install loses the race", () =>
    world(({ fs, path, root, home, base }) =>
      Effect.gen(function* () {
        const target = path.join(root, "managed.txt")
        yield* fs.writeFileString(target, "original bytes")
        const race = racingLayer(base, target, () =>
          writeFileSync(target, "foreign bytes", { flag: "wx" })
        )
        const hold = yield* Effect.provide(
          Hold,
          holdLayer(home, race.layer)
        )

        const error = yield* hold
          .overwrite(target, "staged bytes")
          .pipe(Effect.flip)
        expect(error._tag).toBe("HoldRecoveryRequired")
        expect(race.fired()).toBe(true)
        expect(yield* fs.readFileString(target)).toBe("foreign bytes")
        if (error._tag !== "HoldRecoveryRequired") return
        const act = path.join(home, "hold", error.id)
        expect(yield* fs.readFileString(path.join(act, "payload"))).toBe(
          "original bytes"
        )
        expect(yield* fs.readFileString(path.join(act, "stage"))).toBe(
          "staged bytes"
        )
      })
    )
  )

  it.effect("preserves both directory trees and the held prior tree on collision", () =>
    world(({ fs, path, root, home, base }) =>
      Effect.gen(function* () {
        const source = path.join(root, "cell-output")
        const target = path.join(root, "managed-tree")
        yield* fs.makeDirectory(source)
        yield* fs.writeFileString(path.join(source, "new.txt"), "source tree")
        yield* fs.makeDirectory(target)
        yield* fs.writeFileString(path.join(target, "old.txt"), "held tree")

        const race = racingLayer(base, target, () => {
          mkdirSync(target)
          writeFileSync(path.join(target, "foreign.txt"), "foreign tree")
        })
        const hold = yield* Effect.provide(
          Hold,
          holdLayer(home, race.layer)
        )
        const error = yield* hold.replaceFrom(target, source).pipe(Effect.flip)

        expect(error._tag).toBe("HoldRecoveryRequired")
        expect(race.fired()).toBe(true)
        expect(yield* fs.readFileString(path.join(source, "new.txt"))).toBe(
          "source tree"
        )
        expect(yield* fs.readFileString(path.join(target, "foreign.txt"))).toBe(
          "foreign tree"
        )
        if (error._tag !== "HoldRecoveryRequired") return
        expect(
          yield* fs.readFileString(
            path.join(home, "hold", error.id, "payload", "old.txt")
          )
        ).toBe("held tree")
      })
    )
  )

  it.effect("undo reports a conflict without clobbering the foreign file or held payload", () =>
    world(({ fs, path, root, home, base }) =>
      Effect.gen(function* () {
        const target = path.join(root, "undo.txt")
        yield* fs.writeFileString(target, "recoverable bytes")
        const race = racingLayer(base, target, () =>
          writeFileSync(target, "foreign undo bytes", { flag: "wx" })
        )
        const hold = yield* Effect.provide(
          Hold,
          holdLayer(home, race.layer)
        )
        const removed = yield* hold.remove(target)
        const error = yield* hold.undo(removed.id).pipe(Effect.flip)

        expect(error._tag).toBe("UndoConflict")
        expect(race.fired()).toBe(true)
        expect(yield* fs.readFileString(target)).toBe("foreign undo bytes")
        expect(
          yield* fs.readFileString(
            path.join(home, "hold", removed.id, "payload")
          )
        ).toBe("recoverable bytes")
        expect((yield* hold.held).map((entry) => entry.id)).toContain(
          removed.id
        )
      })
    )
  )

  it.effect("rejects a FIFO replacement source without moving it", () =>
    world(({ fs, path, root, home }) =>
      Effect.gen(function* () {
        const fifo = path.join(root, "pipe")
        const target = path.join(root, "target")
        const made = spawnSync("/usr/bin/mkfifo", [fifo], {
          encoding: "utf8"
        })
        expect(made.status).toBe(0)
        const hold = yield* Effect.provide(
          Hold,
          holdLayer(home, MacosExclusiveRenameTestLive)
        )

        const error = yield* hold.replaceFrom(target, fifo).pipe(Effect.flip)
        expect(error._tag).toBe("HoldFilesystemError")
        expect(lstatSync(fifo).isFIFO()).toBe(true)
        expect(yield* fs.exists(target)).toBe(false)
      })
    )
  )

  it.effect("keeps replacing rename exclusive to journals by construction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString(
        fileURLToPath(new URL("../src/Hold.ts", import.meta.url))
      )

      expect(source.match(/\bfs\.rename\(/g)).toHaveLength(1)
      expect(
        source.match(/\brenameJournalReplacingDurable\(/g)
      ).toHaveLength(2)
      expect(source).toContain(
        'renameJournalReplacingDurable(staged, target, "install hold journal")'
      )
      expect(source).toContain('"promote staged hold journal"')
      expect(source.match(/\brenameExclusiveDurable\(/g)).toHaveLength(5)
      for (const operation of [
        "retain target",
        "install staged replacement",
        "install replacement source",
        "restore target after failed install",
        "restore held payload"
      ]) {
        expect(source).toContain(`"${operation}"`)
      }
    }).pipe(Effect.provide(BunContext.layer))
  )

  it.effect("survives Bun compilation and exercises a complete overwrite/undo path", () =>
    process.platform !== "darwin"
      ? Effect.void
      : Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const root = yield* fs.makeTempDirectoryScoped()
            const binary = `${root}/exclusive-rename-proof`
            const fixture = fileURLToPath(
              new URL("./fixtures/exclusive-rename-compiled.ts", import.meta.url)
            )
            const built = spawnSync(
              "bun",
              ["build", "--compile", "--outfile", binary, fixture],
              { encoding: "utf8", timeout: 60_000 }
            )
            expect(built.status, built.stderr).toBe(0)

            const proofRoot = `${root}/proof`
            yield* fs.makeDirectory(proofRoot)
            const result = spawnSync(binary, [proofRoot], {
              encoding: "utf8",
              timeout: 30_000
            })
            expect(result.status, result.stderr).toBe(0)
            expect(JSON.parse(result.stdout.trim())).toEqual({
              collision: "ExclusiveRenameTargetExists",
              collisionSource: "compiled source",
              collisionTarget: "compiled foreign",
              previousHeld: true,
              restored: "compiled-original"
            })
            expect(readFileSync(`${proofRoot}/managed.txt`, "utf8")).toBe(
              "compiled-original"
            )
          })
        ).pipe(Effect.provide(BunContext.layer))
  )
})
