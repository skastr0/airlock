import * as Core from "@skastr0/airlock/core"
import * as Testing from "@skastr0/airlock/core/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"

/**
 * The kernel as a consumer gets it: imported by package name through the
 * `./core` and `./core/testing` exports, and run with nothing a host would
 * add. No Bun or Node platform Layer is provided anywhere in this file; the
 * only services are the in-memory adapters and Web Crypto, all from core.
 */
const AirlockOutbox = Core.defineOutbox({ http: Core.HttpIntent })

const wire = Layer.succeed(AirlockOutbox.Dispatcher, AirlockOutbox.Dispatcher.of({
  http: ({ permit }) =>
    Core.isLivePermit(permit)
      ? Effect.succeed({ outcome: { status: 204 }, response: new Uint8Array(0), truncated: false })
      : Effect.fail(new Core.DispatchFailed({ reason: "dispatch permit is not live" }))
}))

const kernel = AirlockOutbox.layer.pipe(
  Layer.provide(wire),
  Layer.provide(Testing.memoryOutboxStore(Testing.makeMemoryOutboxState())),
  Layer.provide(Testing.memoryLedger(Testing.makeMemoryLedgerState())),
  Layer.provide(Core.WebCrypto.layer)
)

describe("@skastr0/airlock/core", () => {
  it.effect("stages, commits and replays with no host platform layer", () =>
    Effect.gen(function* () {
      const outbox = yield* AirlockOutbox.Outbox
      const request = {
        key: Schema.decodeUnknownSync(Core.IdempotencyKey)("exports-test"),
        intent: {
          kind: "http" as const,
          dispatch: { url: "https://example.invalid/hook", method: "POST" as const, headers: {} }
        },
        holdMillis: 0
      }
      const staged = yield* outbox.stage(request)
      expect(staged.state).toBe("staged")
      const committed = yield* outbox.commit(
        staged.id,
        new Core.DispatchProvenance({ committedBy: "supervisor" })
      )
      expect(committed).toMatchObject({ state: "committed", outcome: { status: 204 } })
      // Same key, same content: the emission that already exists, as it is now.
      const replayed = yield* outbox.stage(request)
      expect(replayed).toMatchObject({ id: staged.id, state: "committed" })
    }).pipe(Effect.provide(kernel)))

  it("exposes the pure modules through the same entry point", () => {
    expect(typeof Core.Canonical.canonicalJson).toBe("function")
    expect(Core.transitions.staged).toEqual(["committing", "cancelled"])
  })
})
