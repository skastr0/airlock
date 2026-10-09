import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { Sha256Digest } from "../core/Canonical.ts"

/**
 * An artifact is named by the digest of its bytes. A call that names one
 * therefore names exact content: the name is in the request a person
 * approves, and bytes that do not hash to it are never used.
 */
export const ArtifactId = Sha256Digest
export type ArtifactId = typeof ArtifactId.Type

export const artifactIdOf = (bytes: Uint8Array): ArtifactId =>
  ArtifactId.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)

/** Where a host keeps a run's artifacts. Host state; it is not trusted to return the right bytes. */
export interface ArtifactStore {
  readonly read: (id: ArtifactId) => Effect.Effect<Uint8Array, unknown>
  readonly keep: (id: ArtifactId, bytes: Uint8Array, mediaType: string) => Effect.Effect<void, unknown>
}

export class ArtifactMismatch extends Schema.TaggedError<ArtifactMismatch>()("ArtifactMismatch", {
  id: Schema.String
}) {}

export interface KeptArtifact {
  readonly id: ArtifactId
  readonly media_type: string
  readonly byte_length: number
}

/** A store as the tools use it: reads are checked against the name, and a kept artifact is named by its content. */
export const artifactsOf = (store: ArtifactStore) => ({
  read: (id: ArtifactId): Effect.Effect<Uint8Array, unknown> =>
    Effect.flatMap(store.read(id), (bytes) =>
      artifactIdOf(bytes) === id ? Effect.succeed(bytes) : Effect.fail(new ArtifactMismatch({ id }))),
  keep: (bytes: Uint8Array, mediaType: string): Effect.Effect<KeptArtifact, unknown> => {
    const id = artifactIdOf(bytes)
    return Effect.as(store.keep(id, bytes, mediaType), { id, media_type: mediaType, byte_length: bytes.byteLength })
  }
})
