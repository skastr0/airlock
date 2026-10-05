import { Crypto, Effect, Layer, PlatformError } from "effect"

/**
 * `effect/Crypto` over the Web Crypto API, for hosts that have no platform
 * package: a Worker, a Durable Object, a browser. Hosts with one (Bun, Node)
 * provide their own Crypto Layer instead.
 */
export const layer: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data))),
        catch: (cause) =>
          PlatformError.systemError({
            module: "Crypto",
            method: "digest",
            _tag: "Unknown",
            description: "Could not compute digest",
            cause
          })
      })
  })
)
