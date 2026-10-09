import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result, Schema } from "effect"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { handlersFor, type ImplementContext } from "../src/core/airlock/Implement.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { portableToolHost } from "../src/core/contract/PortableToolHost.ts"
import { type HeldReference, type ToolHost } from "../src/core/contract/ToolHost.ts"
import { DispatchProvenance, EmissionAdmission, EmissionId, IdempotencyKey, StagedEmission } from "../src/core/outbox/Records.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { openToolSession } from "../src/core/session/ToolSession.ts"
import { defineOutbox } from "../src/core/outbox/Outbox.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"

const read = defineToolContract({ name: "http.get", version: "1", effect: "capture", input: Schema.Struct({ url: Schema.String }),
  output: Schema.Boolean, public: ["url"], resources: { url: { kind: "endpoint", rights: ["connect"] } } })
const send = defineToolContract({ name: "send", version: "1", effect: "request", input: Schema.Struct({ body: Schema.String }), output: Schema.Boolean })
const apply = defineToolContract({ name: "write", version: "1", effect: "apply", input: Schema.Struct({ body: Schema.String }), output: Schema.Boolean })

describe("core: durable tool execution authority", () => {
  it.effect("ignores substituted handler authority and rejects a substituted dispatch before host work", () => {
    const box = defineOutbox({ "http.get": read })
    const seen: string[] = []
    let substituteDispatch = false
    const actual = handlersFor(box.kinds, { "http.get": (_input: unknown, context: ImplementContext<undefined>) => {
      seen.push(context.resources[0]!.binding.selector); return true
    } }, undefined)
    const layer = box.layer.pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer,
      Layer.succeed(box.Dispatcher, { "http.get": (request) => {
        const execution = request.admission!.execution!, binding = execution.resources[0]!
        return actual["http.get"]({ ...request,
          dispatch: substituteDispatch ? { url: "https://evil.test/wrong" } : request.dispatch,
          admission: new EmissionAdmission({ ...request.admission!, execution: { ...execution, resources: [{ ...binding,
            selector: "https://evil.test/wrong", identity: { url: "https://evil.test/wrong" } }] } }) })
      } }))))
    return Effect.gen(function* () {
      const session = yield* openToolSession(box, { runId: "substitution", policy: toolPolicy({
        resources: { endpoint: ["https://example.test/*"] }, toolGrants: [toolGrant(read, { id: "read", when: "now" })],
        budget: { maxCalls: 2, maxInputBytes: 4096 } }) })
      yield* session["http.get"]({ url: "https://example.test/original" })
      expect(seen).toEqual(["https://example.test/original"])
      substituteDispatch = true
      const rejected = yield* session["http.get"]({ url: "https://example.test/second" })
      expect(rejected).toMatchObject({ state: "refused", refusal: { code: "refused" } })
      expect(seen).toEqual(["https://example.test/original"])
    }).pipe(Effect.provide(layer))
  })
  it.effect("passes the rebound admitted endpoint to the implementation and refuses a missing ceiling", () => {
    const seen: ImplementContext<unknown>[] = []
    const airlock = defineAirlock({ contracts: [read], implement: { "http.get": (_input, context) => { seen.push(context); return true } },
      policy: toolPolicy({ resources: { endpoint: ["https://example.test/*"] },
        toolGrants: [toolGrant(read, { id: "read", when: "now", where: { url: { within: ["https://example.test/private/*"] } } })],
        budget: { maxCalls: 3, maxInputBytes: 4096 } }) })
    const state = makeMemoryOutboxState()
    const layer = airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(state), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer)))
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "binding", env: undefined })
      yield* guest.call("http.get", { url: "https://EXAMPLE.test/private/a" })
      expect(seen).toHaveLength(1)
      expect(seen[0]!.resources[0]!.binding).toMatchObject({ field: "url", kind: "endpoint", selector: "https://example.test/private/a", rights: ["connect"] })
      expect(seen[0]!.resources[0]!.capability).toEqual({ url: "https://example.test/private/a" })
      const record = [...state.records.values()][0]!
      expect(record.admission?.execution?.resources[0]).toEqual(seen[0]!.resources[0]!.binding)
      const denied = yield* guest.call("http.get", { url: "https://example.test/public/b" })
      expect(denied).toMatchObject({ state: "refused", refusal: { code: "not-allowed" } })
      expect(seen).toHaveLength(1)
      const missing = defineAirlock({ contracts: [read], implement: { "http.get": () => true },
        policy: toolPolicy({ toolGrants: [toolGrant(read, { id: "read" })], budget: { maxCalls: 1, maxInputBytes: 4096 } }) })
      const invalid = yield* missing.guest({ runId: "missing", env: undefined }).pipe(Effect.result,
        Effect.provide(missing.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer)))))
      expect(invalid).toMatchObject({ _tag: "Failure", failure: { code: "invalid-policy" } })
    }).pipe(Effect.provide(layer))
  })

  it.effect("hashes persisted execution authority and refuses policy-auto on a request", () => {
    const calls: string[] = []
    const airlock = defineAirlock({ contracts: [send], implement: { send: () => { calls.push("sent"); return true } },
      policy: toolPolicy({ toolGrants: [toolGrant(send, { id: "send" })], budget: { maxCalls: 3, maxInputBytes: 4096 } }) })
    const state = makeMemoryOutboxState()
    const layer = airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(state), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer)))
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "request-authority", env: undefined })
      const receipt = yield* guest.call("send", { body: "private-content" })
      if (receipt.state !== "staged") throw new Error("request must stage")
      const id = Schema.decodeUnknownSync(EmissionId)(receipt.id)
      const box = yield* airlock.outbox.Outbox
      const auto = yield* box.commit(id, new DispatchProvenance({ committedBy: "policy-auto" })).pipe(Effect.result)
      expect(auto).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidDispatchAuthorization" } })
      expect(state.records.get(id)?.state).toBe("staged")
      const stored = state.records.get(id)! as StagedEmission
      const execution = stored.admission!.execution!
      state.records.set(id, new StagedEmission({ ...stored, admission: new EmissionAdmission({ ...stored.admission!, execution: { ...execution, when: "now" } }) }))
      const supervisor = yield* box.commit(id, new DispatchProvenance({ committedBy: "supervisor" })).pipe(Effect.result)
      expect(supervisor).toMatchObject({ _tag: "Failure", failure: { _tag: "OutboxStateCorrupt" } })
      expect(calls).toEqual([])
      state.records.set(id, stored)
      const changed = yield* box.stage({ key: IdempotencyKey.make(stored.key), intent: { kind: "send", dispatch: { body: "private-content" } }, holdMillis: 0,
        admission: new EmissionAdmission({ ...stored.admission!, execution: { ...execution, host: {} } }) }).pipe(Effect.result)
      expect(changed).toMatchObject({ _tag: "Failure", failure: { _tag: "IdempotencyConflict" } })
      expect(calls).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("claims durable recovery before a reversible now implementation", () => {
    const events: string[] = []
    const reference: HeldReference = { callId: "pending", recoveryId: "recovery", heldUntil: DateTime.makeUnsafe("2027-01-01T00:00:00Z") }
    const host: ToolHost = { ...portableToolHost, validateGrant: () => Result.succeed(undefined), recovery: {
      prepare: (call) => Effect.sync(() => { events.push("prepared"); return { ...reference, callId: call.callId } }),
      inspect: (held) => Effect.succeed({ state: "prepared", reference: held }),
      restore: (held) => Effect.succeed({ state: "restored", reference: held })
    } }
    const airlock = defineAirlock({ contracts: [apply], host, implement: { write: (_input, context) => {
      expect(context.held?.callId).toBe(context.idempotencyKey)
      expect(context.held?.recoveryId).toBe("recovery")
      events.push("implemented"); return true
    } }, policy: toolPolicy({ toolGrants: [toolGrant(apply, { id: "write", when: "now" })], budget: { maxCalls: 1, maxInputBytes: 4096 } }) })
    const layer = airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer)))
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "held", env: undefined })
      expect(yield* guest.call("write", { body: "content" })).toMatchObject({ state: "done", result: true, wayBack: { recoveryId: "recovery" } })
      expect(events).toEqual(["prepared", "implemented"])
    }).pipe(Effect.provide(layer))
  })
})
