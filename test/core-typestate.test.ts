import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"
import {
  Canonical,
  defineIntentKind,
  defineOutbox,
  type DispatchPermit,
  DispatchProvenance,
  EmissionId,
  HttpIntent,
  isLegalTransition,
  isLivePermit,
  type Next,
  OutboxStore,
  WebCrypto
} from "../src/core/index.ts"
import { digestOf, emissionId, instant } from "../src/core/testing/Fixtures.ts"

/**
 * The claims here are enforced by the compiler: each `@ts-expect-error` line
 * fails the typecheck if the illegal program ever becomes legal.
 */
describe("core: what the types rule out", () => {
  it("has no transition out of a terminal state and none that skips committing", () => {
    const legal: ReadonlyArray<Next<"staged">> = ["committing", "cancelled"]
    const settle: ReadonlyArray<Next<"committing">> = ["committed", "uncertain"]
    // @ts-expect-error a staged emission cannot become committed directly
    const skipped: Next<"staged"> = "committed"
    // @ts-expect-error a terminal state has no next state at all
    const revived: Next<"uncertain"> = "committing"
    expect([legal.length, settle.length, skipped, revived]).toEqual([2, 2, "committed", "committing"])
    expect(isLegalTransition("staged", "committed")).toBe(false)
    expect(isLegalTransition("uncertain", "committing")).toBe(false)
    expect(isLegalTransition("committed", "uncertain")).toBe(false)
  })

  it("types the store's transition by the same table", () => {
    const program = Effect.gen(function* () {
      const store = yield* OutboxStore
      const provenance = new DispatchProvenance({ committedBy: "supervisor" })
      yield* store.transition(emissionId(1), "staged", {
        state: "committing",
        provenance,
        committingAt: instant(1)
      })
      yield* store.transition(emissionId(1), "staged", {
        // @ts-expect-error staged cannot arrive at uncertain
        state: "uncertain",
        reason: "dispatch-failed",
        uncertainAt: instant(1)
      })
      // @ts-expect-error a terminal state is not a state one can move from
      yield* store.transition(emissionId(1), "committed", { state: "cancelled", cancelledAt: instant(1) })
      // @ts-expect-error a committing arrival must say who committed
      yield* store.transition(emissionId(1), "staged", { state: "committing", committingAt: instant(1) })
    })
    expect(Effect.isEffect(program)).toBe(true)
  })

  it("requires a handler for every intent kind and nothing else", () => {
    const Ping = defineIntentKind({
      tag: "ping",
      dispatch: Schema.Struct({ to: Schema.String }),
      summary: Schema.Struct({ to: Schema.String }),
      outcome: Schema.Struct({ ok: Schema.Boolean }),
      summarize: (dispatch) => Result.succeed(dispatch),
      target: (summary) => summary.to
    })
    const outbox = defineOutbox({ http: HttpIntent, ping: Ping })
    const delivered = Effect.succeed({
      outcome: { status: 204 },
      response: new Uint8Array(0),
      truncated: false
    })
    // @ts-expect-error the ping kind has no handler
    const missing = Layer.succeed(outbox.Dispatcher, { http: () => delivered })
    const total = Layer.succeed(outbox.Dispatcher, {
      http: () => delivered,
      ping: () => Effect.succeed({ outcome: { ok: true }, response: new Uint8Array(0), truncated: false })
    })
    expect([Layer.isLayer(missing), Layer.isLayer(total)]).toEqual([true, true])
  })

  it("gives no module outside the kernel a way to make a live permit", () => {
    // The permit's brand key is a symbol private to the kernel module, so an
    // object literal cannot satisfy the type.
    // @ts-expect-error a permit cannot be written by hand
    const handmade: DispatchPermit<"http"> = {
      emissionId: emissionId(1),
      kind: "http",
      dispatchDigest: digestOf("a")
    }
    // A cast gets past the compiler and is still refused at run time.
    const forged = { emissionId: emissionId(1), kind: "http", dispatchDigest: digestOf("a") } as unknown as DispatchPermit
    expect([isLivePermit(handmade), isLivePermit(forged)]).toEqual([false, false])
  })

  it("derives emission ids and digests the same way on every host", async () => {
    expect(() => EmissionId.make(`emi_${crypto.randomUUID().slice(0, 13)}`)).toThrow()
    expect(Canonical.canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } }))
      .toBe("{\"a\":{\"c\":[2,{\"y\":2,\"z\":1}]},\"b\":1}")
    // Reference value from `printf airlock | shasum -a 256`.
    const digest = await Effect.runPromise(
      Canonical.sha256Text("airlock").pipe(Effect.provide(WebCrypto.layer))
    )
    expect(digest).toBe("sha256:e17ff958e1a3487cf583033fb295d45d3d030bd18c31441992dc781030fb4f51")
  })
})
