import { Effect } from "effect"
import { type ArtifactId, artifactIdOf, type ArtifactStore } from "../../src/native/Artifacts.ts"

/** A host artifact store in memory. `corrupt` makes it return other bytes under a name, as a faulty store would. */
export const memoryArtifacts = () => {
  const held = new Map<string, Uint8Array>()
  const store: ArtifactStore = {
    read: (id) => {
      const bytes = held.get(id)
      return bytes === undefined ? Effect.fail("unknown artifact") : Effect.succeed(bytes)
    },
    keep: (id, bytes) => Effect.sync(() => { held.set(id, bytes) })
  }
  return {
    store,
    held,
    /** Puts bytes in the store and returns their name. */
    put: (content: string | Uint8Array): ArtifactId => {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
      const id = artifactIdOf(bytes)
      held.set(id, bytes)
      return id
    },
    corrupt: (id: ArtifactId, content: string) => { held.set(id, new TextEncoder().encode(content)) }
  }
}
