import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Result, Schema } from "effect"
import {
  Admission,
  defineOutbox,
  defineToolContract,
  openToolSession,
  ToolPolicy,
  toolPolicy,
  WebCrypto
} from "../src/core/index.ts"
import {
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore
} from "../src/core/testing/index.ts"

const JsonRead = defineToolContract({
  name: "security.read",
  version: "1",
  input: Schema.Struct({ resource: Schema.Json }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  public: ["resource"],
  effect: "capture"
})

const PrivateRead = defineToolContract({
  name: "security.private",
  version: "1",
  input: Schema.Struct({ privateCount: Schema.Number }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  effect: "capture"
})

const tools = defineOutbox({ "security.read": JsonRead, "security.private": PrivateRead })

const world = (
  seen: Array<Schema.Json>,
  crypto: Layer.Layer<Crypto.Crypto> = WebCrypto.layer,
  state = makeMemoryOutboxState()
) =>
  tools.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    memoryOutboxStore(state),
    memoryLedger(makeMemoryLedgerState()),
    crypto,
    Layer.succeed(tools.Dispatcher, {
      "security.read": (request) => Effect.sync(() => {
        seen.push(request.dispatch.resource)
        return { outcome: { ok: true }, response: new Uint8Array(0), truncated: false }
      }),
      "security.private": () => Effect.succeed({
        outcome: { ok: true }, response: new Uint8Array(0), truncated: false
      })
    })
  )))

const policyFor = (resource: Schema.Json) => toolPolicy({
  toolGrants: [Admission.toolGrant(JsonRead, {
    id: "allowed-resource", when: "now", where: { resource: { equals: resource } }
  })],
  budget: { maxCalls: 5, maxInputBytes: 4_096 }
})

describe("security: tool-session admission owns its data", () => {
  it.effect("refuses unknown policy and matcher fields instead of dropping them", () => {
    const seen: Array<Schema.Json> = []
    const state = makeMemoryOutboxState()
    return Effect.gen(function* () {
      const plain = Schema.encodeSync(ToolPolicy)(policyFor("allowed"))
      for (const policy of [
        { ...plain, endpointGrants: [] },
        { ...plain, toolGrants: plain.toolGrants.map((grant) => ({ ...grant, where: { resource: { equals: "allowed", startsWith: "denied" } } })) }
      ]) {
        const result = yield* openToolSession(tools, { runId: "excess-policy", policy: policy as never }).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("InvalidToolSession")
      }
      expect(seen).toEqual([])
      expect(state.records.size).toBe(0)
    }).pipe(Effect.provide(world(seen, WebCrypto.layer, state)))
  })

  it.effect("refuses undeclared input fields before matching, staging or dispatch", () => {
    const seen: Array<Schema.Json> = []
    const state = makeMemoryOutboxState()
    return Effect.gen(function* () {
      const session = yield* openToolSession(tools, { runId: "excess-input", policy: policyFor("allowed") })
      for (const input of [
        { resource: "allowed", extra: "private-excess-canary" },
        JSON.parse('{"resource":"allowed","__proto__":{"extra":"private-excess-canary"}}')
      ]) {
        const result = yield* session["security.read"](input)
        expect(result).toMatchObject({ state: "refused", refusal: { code: "invalid-input" } })
        expect(JSON.stringify(result)).not.toContain("private-excess-canary")
      }
      expect(seen).toEqual([])
      expect(state.records.size).toBe(0)
      expect(state.dispatches.size).toBe(0)
    }).pipe(Effect.provide(world(seen, WebCrypto.layer, state)))
  })

  it.effect("sends the admitted JSON snapshot when the caller mutates input during hashing", () => {
    const wire = { resource: { bucket: "allowed" } }
    const seen: Array<Schema.Json> = []
    const state = makeMemoryOutboxState()
    // A digest is an asynchronous boundary. Mutate the caller's argument at
    // exactly that boundary, after its public fields have matched the grant.
    const crypto = Layer.effect(Crypto.Crypto, Effect.map(Crypto.Crypto, (inner) => Crypto.Crypto.of({
      ...inner,
      digest: (algorithm, bytes) => Effect.suspend(() => {
        if (new TextDecoder().decode(bytes) === '{"resource":{"bucket":"allowed"}}') {
          wire.resource.bucket = "denied"
        }
        return inner.digest(algorithm, bytes)
      })
    }))).pipe(Layer.provide(WebCrypto.layer))
    return Effect.gen(function* () {
      const session = yield* openToolSession(tools, { runId: "input-snapshot", policy: policyFor({ bucket: "allowed" }) })
      const result = yield* session["security.read"](wire)
      expect(wire.resource.bucket).toBe("denied")
      expect({
        result: result.state,
        sealed: [...state.dispatches.values()].map((dispatch) => JSON.parse(dispatch.canonical))
      }).toEqual({ result: "done", sealed: [{ resource: { bucket: "allowed" } }] })
      expect(seen).toEqual([{ bucket: "allowed" }])
    }).pipe(Effect.provide(world(seen, crypto, state)))
  })

  it.effect("keeps nested grant values fixed when the caller mutates its original policy", () => {
    const allowed = { bucket: "allowed" }
    const policy = policyFor(allowed)
    const seen: Array<Schema.Json> = []
    return Effect.gen(function* () {
      const session = yield* openToolSession(tools, { runId: "policy-snapshot", policy })
      allowed.bucket = "denied"
      const result = yield* session["security.read"]({ resource: { bucket: "denied" } })
      expect(result).toMatchObject({ state: "refused", refusal: { code: "not-allowed" } })
      expect(seen).toEqual([])
    }).pipe(Effect.provide(world(seen)))
  })

  it.effect("keeps the run identity fixed after opening a session", () => {
    const seen: Array<Schema.Json> = []
    const options = { runId: "original-run", policy: policyFor({ bucket: "allowed" }) }
    return Effect.gen(function* () {
      const session = yield* openToolSession(tools, options)
      options.runId = "replacement-run"
      const first = yield* session["security.read"]({ resource: { bucket: "allowed" } })
      const replay = yield* openToolSession(tools, { ...options, runId: "original-run" })
      const again = yield* replay["security.read"]({ resource: { bucket: "allowed" } })
      if (first.state !== "done" || again.state !== "done") throw new Error("admitted capture must complete")
      expect(again.id).toBe(first.id)
      expect(seen).toEqual([{ bucket: "allowed" }])
    }).pipe(Effect.provide(world(seen)))
  })

  it.effect("does not repeat private input in a validation error", () => {
    const seen: Array<Schema.Json> = []
    return Effect.gen(function* () {
      const session = yield* openToolSession(tools, {
        runId: "private-input", policy: toolPolicy({
          toolGrants: [Admission.toolGrant(PrivateRead, { id: "private-read", when: "now" })],
          budget: { maxCalls: 5, maxInputBytes: 4_096 }
        })
      })
      // A caller bypassing TypeScript still receives a redacted typed error.
      // @ts-expect-error deliberately invalid private input
      const result = yield* session["security.private"]({ privateCount: "private-canary-123" })
      expect(result).toMatchObject({ state: "refused", refusal: { code: "invalid-input" } })
      expect(JSON.stringify(result)).not.toContain("private-canary-123")
    }).pipe(Effect.provide(world(seen)))
  })
})
