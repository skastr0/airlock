import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import * as AirlockHome from "../src/AirlockHome.ts"
import { ActId } from "../src/domain.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import {
  NativeFileSystem,
  NativeFileSystemLive,
  NativeFilesystemConfig
} from "../src/native/index.ts"
import { MacosExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const HoldTestLive = HoldLayer.pipe(
  Layer.provide(MacosExclusiveRenameTestLive)
)

const layersFor = (home: string, workspace: string) =>
  NativeFileSystemLive(new NativeFilesystemConfig({ workspace })).pipe(
    Layer.provideMerge(HoldTestLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly workspace: string
  readonly native: typeof NativeFileSystem.Service
  readonly hold: typeof Hold.Service
}) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const workspace = path.join(root, "workspace")
      const home = path.join(root, "airlock-home")
      yield* fs.makeDirectory(workspace)
      const layer = layersFor(home, workspace)
      const native = yield* Effect.provide(NativeFileSystem, layer)
      const hold = yield* Effect.provide(Hold, layer)
      return yield* body({ fs, path, workspace, native, hold })
    })
  ).pipe(Effect.provide(BunContext.layer))

describe("NativeFileSystem — scoped native actions", () => {
  it.effect("denies lexical traversal before touching the filesystem", () =>
    world(({ native }) =>
      Effect.gen(function* () {
        const result = yield* native.readText("../outside.txt").pipe(Effect.flip)
        expect(result._tag).toBe("ScopeEscape")
      })
    )
  )

  it.effect("writes through Hold and can recover the prior bytes", () =>
    world(({ fs, native, hold, path, workspace }) =>
      Effect.gen(function* () {
        const target = path.join(workspace, "config.txt")
        yield* fs.writeFileString(target, "before")

        const receipt = yield* native.writeText("config.txt", "after")
        expect(yield* fs.readFileString(target)).toBe("after")
        expect(receipt.receipt.previousHeld).toBe(true)

        yield* hold.undo(ActId.make(receipt.receipt.id))
        expect(yield* fs.readFileString(target)).toBe("before")
      })
    )
  )

  it.effect("copies binary bytes through a journaled private stage without a shell", () =>
    world(({ fs, native, hold, path, workspace }) =>
      Effect.gen(function* () {
        const input = new Uint8Array([0, 255, 17, 128, 64, 10])
        yield* fs.writeFile(path.join(workspace, "input.bin"), input)

        const receipt = yield* native.copy("input.bin", "output.bin")
        expect(receipt.bytes).toBe(input.byteLength)
        expect([...yield* fs.readFile(path.join(workspace, "output.bin"))]).toEqual([...input])
        expect(
          (yield* hold.held).filter(
            (manifest) => manifest.purpose === "runtime-private"
          )
        ).toEqual([])
      })
    )
  )

  it.effect("creates parent directories and moves through recoverable acts", () =>
    world(({ fs, native, hold, path, workspace }) =>
      Effect.gen(function* () {
        const made = yield* native.mkdir("generated/deep", { parents: true })
        expect(made.installs).toHaveLength(2)
        yield* fs.writeFileString(path.join(workspace, "generated", "deep", "source.txt"), "move me")

        const moved = yield* native.move("generated/deep/source.txt", "published.txt")
        expect(yield* fs.exists(path.join(workspace, "generated", "deep", "source.txt"))).toBe(false)
        expect(yield* fs.readFileString(path.join(workspace, "published.txt"))).toBe("move me")

        // Both sides have recovery acts; undoing the source removal restores
        // it without deleting the installed destination.
        yield* hold.undo(ActId.make(moved.sourceRemoval.id))
        expect(yield* fs.readFileString(path.join(workspace, "generated", "deep", "source.txt"))).toBe("move me")
      })
    )
  )

  it.effect("reads JSON and rejects malformed JSON with a typed error", () =>
    world(({ fs, native, path, workspace }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(workspace, "value.json"), '{"ok":true}')
        yield* fs.writeFileString(path.join(workspace, "bad.json"), "{")
        expect(yield* native.readJson("value.json")).toEqual({ ok: true })
        const invalid = yield* native.readJson("bad.json").pipe(Effect.flip)
        expect(invalid._tag).toBe("NativeJsonInvalid")
      })
    )
  )

  it.effect("fails closed for a symlink inside the workspace", () =>
    world(({ fs, native, path, workspace }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(workspace, "real.txt"), "real")
        yield* fs.symlink("real.txt", path.join(workspace, "link.txt"))

        const result = yield* native.readText("link.txt").pipe(Effect.flip)
        expect(result._tag).toBe("NativePathUnsupported")
        if (result._tag === "NativePathUnsupported") expect(result.kind).toBe("symlink")
      })
    )
  )

  it.effect("refuses workspace-root mutation and overlapping tree operations", () =>
    world(({ fs, native, path, workspace }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(workspace, "tree"))
        yield* fs.writeFileString(path.join(workspace, "tree", "value.txt"), "value")

        const rootRemoval = yield* native.remove(".").pipe(Effect.flip)
        expect(rootRemoval).toMatchObject({
          _tag: "ProtectedPath",
          target: native.workspace
        })

        const nestedCopy = yield* native.copy("tree", "tree/copy").pipe(Effect.flip)
        expect(nestedCopy).toMatchObject({
          _tag: "NativePathOverlap",
          source: path.join(native.workspace, "tree"),
          destination: path.join(native.workspace, "tree", "copy")
        })

        const ancestorMove = yield* native.move("tree/value.txt", "tree").pipe(Effect.flip)
        expect(ancestorMove).toMatchObject({ _tag: "NativePathOverlap" })
        expect(yield* fs.readFileString(path.join(workspace, "tree", "value.txt"))).toBe("value")
      })
    )
  )

  it.effect("preserves the typed unsupported-path error while admitting a copy tree", () =>
    world(({ fs, native, path, workspace }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(workspace, "tree"))
        yield* fs.writeFileString(path.join(workspace, "outside.txt"), "outside")
        yield* fs.symlink("../outside.txt", path.join(workspace, "tree", "link.txt"))

        const result = yield* native.copy("tree", "tree-copy").pipe(Effect.flip)
        expect(result).toMatchObject({
          _tag: "NativePathUnsupported",
          kind: "symlink"
        })
        expect(yield* fs.exists(path.join(workspace, "tree-copy"))).toBe(false)
      })
    )
  )

  it.effect("lists and bounds glob expansion with typed useful output", () =>
    world(({ fs, native, path, workspace }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(workspace, "nested"))
        yield* fs.writeFileString(path.join(workspace, "one.ts"), "one")
        yield* fs.writeFileString(path.join(workspace, "nested", "two.ts"), "two")
        yield* fs.writeFileString(path.join(workspace, "nested", "three.txt"), "three")

        const listed = yield* native.list(".")
        expect(listed.map((entry) => entry.name)).toEqual(["nested", "one.ts"])
        expect(new Set(yield* native.glob(".", "**/*.ts"))).toEqual(new Set([
          path.join(native.workspace, "nested", "two.ts"),
          path.join(native.workspace, "one.ts")
        ]))
      })
    )
  )

  it("contains no direct unlink authority", async () => {
    const source = await readFile(new URL("../src/native/NativeFileSystem.ts", import.meta.url), "utf-8")
    expect(source).not.toContain("fs.remove")
    expect(source).not.toContain("unlink(")
    expect(source).not.toContain("native-stage")
  })
})
