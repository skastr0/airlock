import { Context, Effect, Layer, Path, Schema } from "effect"
import { mkdir, open, readFile, rename } from "node:fs/promises"
import { AirlockHome } from "../AirlockHome.ts"
import { reasonOf } from "../FailureText.ts"
import { type ArtifactId, artifactIdOf, type ArtifactStore } from "../native/Artifacts.ts"

/**
 * This host's artifacts, as files named by the digest of their content under
 * `<home>/artifacts/`.
 *
 * - An artifact is durable before `keep` returns, so a call record written
 *   afterwards never names bytes that are not there.
 * - A file is complete or absent under its name: bytes are written to a
 *   private name and renamed into place.
 * - Nothing here deletes. Only Hold's reaper unlinks; a bound on how long
 *   artifacts are kept will be a Hold retirement, not a removal.
 *
 * Readers do not trust this store: `artifactsOf` recomputes the digest of
 * whatever it returns.
 */

export class ArtifactStoreFailed extends Schema.TaggedError<ArtifactStoreFailed>()("ArtifactStoreFailed", {
  operation: Schema.Literals(["read", "keep"]),
  id: Schema.String,
  reason: Schema.String
}) {}

export class FileArtifacts extends Context.Service<FileArtifacts, ArtifactStore>()("airlock/FileArtifacts") {}

const make = Effect.gen(function* () {
  const home = yield* AirlockHome
  const path = yield* Path.Path
  const root = path.join(home.home, "artifacts")
  // `sha256:<hex>` names the file `<hex>`; the id's shape was checked by its schema.
  const fileOf = (id: ArtifactId) => path.join(root, id.slice("sha256:".length))

  const syncDirectory = async () => {
    const handle = await open(root, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  return FileArtifacts.of({
    read: (id) =>
      Effect.tryPromise({
        try: () => readFile(fileOf(id)),
        catch: (cause) => new ArtifactStoreFailed({ operation: "read", id, reason: reasonOf(cause) })
      }).pipe(Effect.map((bytes) => new Uint8Array(bytes))),
    keep: (id, bytes) =>
      Effect.tryPromise({
        try: async () => {
          if (artifactIdOf(bytes) !== id) throw new Error("bytes do not have the digest they are kept under")
          await mkdir(root, { recursive: true, mode: 0o700 })
          const existing = await readFile(fileOf(id)).catch(() => undefined)
          // Already there and whole: the same content has one file.
          if (existing !== undefined && artifactIdOf(existing) === id) return
          const pending = `${fileOf(id)}.pending-${crypto.randomUUID()}`
          const handle = await open(pending, "wx", 0o600)
          try {
            await handle.writeFile(bytes)
            await handle.sync()
          } finally {
            await handle.close()
          }
          // Replaces a damaged file of the same name, if there was one.
          await rename(pending, fileOf(id))
          await syncDirectory()
        },
        catch: (cause) => new ArtifactStoreFailed({ operation: "keep", id, reason: reasonOf(cause) })
      })
  })
})

export const FileArtifactsLive = Layer.effect(FileArtifacts, make)
