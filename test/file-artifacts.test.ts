import { Effect, FileSystem, Layer, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as AirlockHome from "../src/AirlockHome.ts"
import { FileArtifacts, FileArtifactsLive } from "../src/host/FileArtifacts.ts"
import { artifactIdOf, artifactsOf } from "../src/native/Artifacts.ts"

const bytesOf = (text: string) => new TextEncoder().encode(text)

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly directory: string
  /** A fresh process over the same home. */
  readonly open: Effect.Effect<typeof FileArtifacts.Service>
}) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = path.join(yield* fs.makeTempDirectoryScoped(), "airlock-home")
    const layer = FileArtifactsLive.pipe(
      Layer.provideMerge(AirlockHome.layer(home)),
      Layer.provideMerge(BunServices.layer)
    )
    return yield* body({
      fs,
      directory: path.join(home, "artifacts"),
      open: Effect.gen(function* () { return yield* FileArtifacts }).pipe(Effect.provide(layer), Effect.orDie)
    })
  })).pipe(Effect.provide(BunServices.layer))

describe("file artifacts", () => {
  it.effect("keeps bytes under the digest of their content, across a restart", () =>
    world(({ fs, directory, open }) =>
      Effect.gen(function* () {
        const content = new Uint8Array([0xef, 0xbb, 0xbf, 0x00, 0xff, ...bytesOf("kept")])
        const kept = yield* artifactsOf(yield* open).keep(content, "application/octet-stream")
        expect(kept).toEqual({ id: artifactIdOf(content), media_type: "application/octet-stream", byte_length: content.byteLength })
        expect(yield* fs.readDirectory(directory)).toEqual([kept.id.slice("sha256:".length)])

        const later = artifactsOf(yield* open)
        expect([...(yield* later.read(kept.id))]).toEqual([...content])
        // The same content again is the same one file.
        yield* later.keep(content, "application/octet-stream")
        expect(yield* fs.readDirectory(directory)).toHaveLength(1)
      })
    )
  )

  it.effect("never hands back bytes that are not the named content", () =>
    world(({ fs, directory, open }) =>
      Effect.gen(function* () {
        const store = yield* open
        const artifacts = artifactsOf(store)
        const kept = yield* artifacts.keep(bytesOf("approved"), "text/plain")
        const file = `${directory}/${kept.id.slice("sha256:".length)}`

        // Missing, and never stored.
        expect((yield* artifacts.read(artifactIdOf(bytesOf("never stored"))).pipe(Effect.flip))).toMatchObject({ _tag: "ArtifactStoreFailed" })
        // Changed on disk after it was kept.
        yield* fs.writeFileString(file, "tampered")
        expect((yield* artifacts.read(kept.id).pipe(Effect.flip))).toMatchObject({ _tag: "ArtifactMismatch" })
        // Keeping the true content again repairs the file.
        yield* artifacts.keep(bytesOf("approved"), "text/plain")
        expect(new TextDecoder().decode(yield* artifacts.read(kept.id))).toBe("approved")
        // The store itself refuses bytes under a name that is not theirs.
        expect((yield* store.keep(kept.id, bytesOf("other"), "text/plain").pipe(Effect.flip))).toMatchObject({ _tag: "ArtifactStoreFailed" })
        expect(new TextDecoder().decode(yield* artifacts.read(kept.id))).toBe("approved")
      })
    )
  )
})
