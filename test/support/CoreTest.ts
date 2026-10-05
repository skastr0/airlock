import { it } from "@effect/vitest"
import { type Crypto, Effect, type Scope } from "effect"
import { WebCrypto } from "../../src/core/index.ts"

/** `it.effect` for kernel modules: the test body may require `effect/Crypto`. */
export const effect = <E>(
  name: string,
  body: () => Effect.Effect<void, E, Crypto.Crypto | Scope.Scope>,
  timeout?: number
) => it.effect(name, () => body().pipe(Effect.provide(WebCrypto.layer)), timeout)

/** Runs a kernel effect to a promise with Crypto provided. */
export const run = <A, E>(body: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(body.pipe(Effect.provide(WebCrypto.layer)))
