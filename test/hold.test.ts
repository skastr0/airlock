import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { utimes } from "node:fs/promises"
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

  it.effect("retains filesystem metadata alongside the held payload", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "metadata.txt")
        yield* fs.writeFileString(file, "retain me")
        const receipt = yield* hold.remove(file)
        const raw = yield* fs.readFileString(
          path.join(tmp, "airlock-home", "hold", receipt.id, "manifest.json")
        )
        const journal = JSON.parse(raw) as {
          readonly state: string
          readonly retained: { readonly device: number; readonly mode: number; readonly bytes: number }
        }

        expect(journal.state).toBe("held")
        expect(journal.retained.device).toBeTypeOf("number")
        expect(journal.retained.mode).toBeTypeOf("number")
        expect(journal.retained.bytes).toBe("retain me".length)
      })
    )
  )

  it.effect("reconciles a crash-left prepared rename to held on next construction", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "prepared.txt")
        yield* fs.writeFileString(file, "still recoverable")
        const receipt = yield* hold.remove(file)
        const home = path.join(tmp, "airlock-home")
        const journalPath = path.join(home, "hold", receipt.id, "manifest.json")
        const journal = JSON.parse(yield* fs.readFileString(journalPath)) as Record<string, unknown>
        yield* fs.writeFileString(journalPath, JSON.stringify({ ...journal, state: "prepared" }))

        const recovered = yield* Effect.provide(Hold, layersFor(home))
        const held = yield* recovered.held
        expect(held.some((manifest) => manifest.id === receipt.id)).toBe(true)
        expect(
          (JSON.parse(yield* fs.readFileString(journalPath)) as { readonly state: string }).state
        ).toBe("held")
      })
    )
  )

  it.effect("promotes a durable staged-only journal after a publication crash", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const file = path.join(tmp, "staged-journal.txt")
        yield* fs.writeFileString(file, "recover me")
        const receipt = yield* hold.remove(file)
        const home = path.join(tmp, "airlock-home")
        const canonical = path.join(
          home,
          "hold",
          receipt.id,
          "manifest.json"
        )
        const staged = `${canonical}.next-crash-fixture`
        yield* fs.rename(canonical, staged)

        const reconstructed = yield* Effect.provide(Hold, layersFor(home))
        expect((yield* reconstructed.held).map((entry) => entry.id)).toContain(
          receipt.id
        )
        expect(yield* fs.exists(canonical)).toBe(true)
        yield* reconstructed.undo(receipt.id)
        expect(yield* fs.readFileString(file)).toBe("recover me")
      })
    )
  )

  it.effect("replaceFrom renames a Cell file into place and undo restores the prior target", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const target = path.join(tmp, "target.txt")
        const source = path.join(tmp, "cell-output.txt")
        yield* fs.writeFileString(target, "before")
        yield* fs.writeFileString(source, "after")

        const receipt = yield* hold.replaceFrom(target, source)
        expect(receipt.kind).toBe("file")
        expect(receipt.metadata.bytes).toBe("after".length)
        expect(receipt.previousHeld).toBe(true)
        expect(yield* fs.exists(source)).toBe(false)
        expect(yield* fs.readFileString(target)).toBe("after")

        yield* hold.undo(receipt.id)
        expect(yield* fs.readFileString(target)).toBe("before")
      })
    )
  )

  it.effect("replaceFrom installs a whole binary-containing directory without copying", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const source = path.join(tmp, "cell-tree")
        const target = path.join(tmp, "published-tree")
        const binary = new Uint8Array([0, 255, 17, 128, 64])
        yield* fs.makeDirectory(path.join(source, "nested"), { recursive: true })
        yield* fs.writeFile(path.join(source, "nested", "output.bin"), binary)

        const receipt = yield* hold.replaceFrom(target, source)
        expect(receipt.kind).toBe("directory")
        expect(yield* fs.exists(source)).toBe(false)
        expect(Array.from(yield* fs.readFile(path.join(target, "nested", "output.bin")))).toEqual(
          Array.from(binary)
        )

        yield* hold.undo(receipt.id)
        expect(yield* fs.exists(target)).toBe(false)
      })
    )
  )

  it.effect("replaceFrom rejects missing and cross-volume sources before mutation", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const target = path.join(tmp, "target")
        const missing = yield* hold
          .replaceFrom(target, path.join(tmp, "missing-cell-output"))
          .pipe(Effect.flip)
        expect(missing._tag).toBe("SourceNotFound")

        // /dev is devfs on macOS; its device differs from the writable test
        // workspace. The source is rejected before any rename can happen.
        const crossVolume = yield* hold.replaceFrom(target, "/dev/null").pipe(Effect.flip)
        expect(crossVolume._tag).toBe("SourceVolumeMismatch")
        expect(yield* fs.exists(target)).toBe(false)
      })
    )
  )

  it.effect("replaceFrom fails closed on source and dangling target symlinks", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const target = path.join(tmp, "target")
        const sourceLink = path.join(tmp, "cell-output-link")
        yield* fs.symlink("/missing-cell-output", sourceLink)

        const sourceError = yield* hold.replaceFrom(target, sourceLink).pipe(Effect.flip)
        expect(sourceError._tag).toBe("UnsupportedReplacementSymlink")
        expect(yield* fs.readLink(sourceLink)).toBe("/missing-cell-output")

        const source = path.join(tmp, "cell-output")
        yield* fs.writeFileString(source, "safe")
        yield* fs.symlink("/missing-target", target)
        const targetError = yield* hold.replaceFrom(target, source).pipe(Effect.flip)
        expect(targetError._tag).toBe("UnsupportedReplacementSymlink")
        expect(yield* fs.readLink(target)).toBe("/missing-target")
        expect(yield* fs.exists(source)).toBe(true)
      })
    )
  )

  it.effect("replaceFrom rejects both source/target ancestry overlaps before holding either path", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const container = path.join(tmp, "container")
        const nestedSource = path.join(container, "cell-output")
        yield* fs.makeDirectory(container, { recursive: true })
        yield* fs.writeFileString(nestedSource, "inside target")

        const sourceInside = yield* hold.replaceFrom(container, nestedSource).pipe(Effect.flip)
        expect(sourceInside._tag).toBe("OverlappingReplacementPaths")
        expect(yield* fs.readFileString(nestedSource)).toBe("inside target")

        const sourceTree = path.join(tmp, "source-tree")
        const nestedTarget = path.join(sourceTree, "output")
        yield* fs.makeDirectory(sourceTree, { recursive: true })
        const targetInside = yield* hold.replaceFrom(nestedTarget, sourceTree).pipe(Effect.flip)
        expect(targetInside._tag).toBe("OverlappingReplacementPaths")
        expect(yield* fs.exists(sourceTree)).toBe(true)
      })
    )
  )

  it.effect("fails closed on raw symlink mutation without moving the link", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const target = path.join(tmp, "target.txt")
        const link = path.join(tmp, "link.txt")
        yield* fs.writeFileString(target, "target")
        yield* fs.symlink("target.txt", link)

        const removeError = yield* hold.remove(link).pipe(Effect.flip)
        expect(removeError._tag).toBe("UnsupportedReplacementSymlink")
        expect(yield* fs.readLink(link)).toBe("target.txt")

        const overwriteError = yield* hold.overwrite(link, "replacement").pipe(Effect.flip)
        expect(overwriteError._tag).toBe("UnsupportedReplacementSymlink")
        expect(yield* fs.readFileString(target)).toBe("target")
      })
    )
  )

  it.effect("ignores private native staging directories when reconstructing Hold", () =>
    world(({ fs, path, tmp }) =>
      Effect.gen(function* () {
        const home = path.join(tmp, "airlock-home")
        const orphan = path.join(home, "hold", "native-stage-orphan")
        yield* fs.makeDirectory(orphan, { recursive: true })
        yield* fs.writeFileString(path.join(orphan, "partial"), "private stage")

        const reconstructed = yield* Effect.provide(Hold, layersFor(home))
        expect(yield* reconstructed.held).toEqual([])
        expect(yield* fs.readFileString(path.join(orphan, "partial"))).toBe("private stage")
      })
    )
  )

  it.effect("serializes concurrent Hold instances over the same target", () =>
    world(({ fs, hold: first, path, tmp }) =>
      Effect.gen(function* () {
        const home = path.join(tmp, "airlock-home")
        const second = yield* Effect.provide(Hold, layersFor(home))
        const target = path.join(tmp, "shared.txt")
        yield* fs.writeFileString(target, "initial")

        const receipts = yield* Effect.all(
          [
            first.overwrite(target, "from-first"),
            second.overwrite(target, "from-second")
          ],
          { concurrency: "unbounded" }
        )
        expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(2)
        expect(["from-first", "from-second"]).toContain(yield* fs.readFileString(target))

        const reconstructed = yield* Effect.provide(Hold, layersFor(home))
        const held = yield* reconstructed.held
        expect(held.map((manifest) => manifest.id)).toEqual(
          expect.arrayContaining(receipts.map((receipt) => receipt.id))
        )
        yield* reconstructed.undoLast
        expect(["initial", "from-first", "from-second"]).toContain(
          yield* fs.readFileString(target)
        )
      })
    )
  )

  it.effect("reclaims an old malformed lock and keeps lock storage bounded", () =>
    world(({ fs, hold, path, tmp }) =>
      Effect.gen(function* () {
        const home = path.join(tmp, "airlock-home")
        const lockRoot = path.join(home, "hold-locks")
        const active = path.join(lockRoot, "active")
        yield* fs.writeFileString(active, "{}")
        yield* Effect.tryPromise(() =>
          utimes(active, new Date(0), new Date(0))
        )

        const reconstructed = yield* Effect.provide(Hold, layersFor(home))
        const target = path.join(tmp, "bounded.txt")
        for (let index = 0; index < 20; index += 1) {
          yield* reconstructed.overwrite(target, String(index))
        }

        const lockEntries = yield* fs.readDirectory(lockRoot)
        expect(lockEntries.every((entry) =>
          entry === "active" ||
          entry === "released" ||
          entry === "abandoned"
        )).toBe(true)
        expect(lockEntries.length).toBeLessThanOrEqual(3)
        expect(yield* fs.readFileString(target)).toBe("19")
        // Ensure the original service can still acquire the shared protocol.
        expect((yield* hold.overwrite(target, "final")).previousHeld).toBe(true)
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
      const sourceFiles: (
        directory: string
      ) => Effect.Effect<ReadonlyArray<string>, PlatformError> = (directory) =>
        Effect.gen(function* () {
          const entries = yield* fs.readDirectory(directory)
          const files: Array<string> = []
          for (const entry of entries) {
            const candidate = path.join(directory, entry)
            const info = yield* fs.stat(candidate)
            if (info.type === "Directory") {
              files.push(...(yield* sourceFiles(candidate)))
            } else if (candidate.endsWith(".ts")) {
              files.push(candidate)
            }
          }
          return files
        })
      const files = yield* sourceFiles(srcDir)
      let unlinkSites = 0
      for (const file of files) {
        const source = yield* fs.readFileString(file)
        unlinkSites += (source.match(/\bfs\s*\.remove\(/g) ?? []).length
      }
      expect(unlinkSites).toBe(1)
    }).pipe(Effect.provide(BunContext.layer))
  )
})
