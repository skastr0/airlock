import { memoryAdapters } from "./support/memory.ts"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { defineAirlock } from "../src/airlock/Airlock.ts"
import { toolGrant } from "../src/admission/ToolGrant.ts"
import { defineToolContract } from "../src/contract/ToolContract.ts"
import { portableToolHost } from "../src/contract/PortableToolHost.ts"
import { HeldReference, type ToolHost } from "../src/contract/ToolHost.ts"
import { toolPolicy } from "../src/session/ToolPolicy.ts"
import * as WebCrypto from "../src/WebCrypto.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/testing/index.ts"

const write = defineToolContract({ name: "write", version: "1", effect: "apply",
  input: Schema.Struct({ body: Schema.String }), output: Schema.Boolean })

describe("core: completed host recovery receipts", () => {
  it.effect("retains the same reference through record encoding, restart and restoration after grant expiry", () => Effect.gen(function* () {
    const state = makeMemoryOutboxState(), ledger = makeMemoryLedgerState()
    const restored: HeldReference[] = []
    let prepared = 0, implemented = 0
    const now = yield* DateTime.now
    const host: ToolHost = { ...portableToolHost, validateGrant: () => Result.succeed(undefined), recovery: {
      prepare: (call) => Effect.sync(() => { prepared++; return { callId: call.callId, recoveryId: "held-private-store",
        heldUntil: DateTime.add(now, { days: 1 }) } }),
      inspect: (reference) => Effect.succeed({ state: "done", reference }),
      restore: (reference) => Effect.sync(() => { restored.push(reference); return { state: "restored" as const, reference } })
    } }
    const env = { host }
    const airlock = defineAirlock({ contracts: [write], host: (environment: typeof env) => environment.host,
      implement: { write: () => { implemented++; return true } }, policy: toolPolicy({
        toolGrants: [toolGrant(write, { id: "write", when: "now", validUntil: DateTime.add(now, { seconds: 1 }) })],
        budget: { maxCalls: 2, maxInputBytes: 4096 } }) })
    const layer = () => airlock.layer(env).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(state, ledger), memoryLedger(ledger), WebCrypto.layer)))
    yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "held-reference", env })
      yield* guest.call("write", { body: "private-before-image-canary" })
    }).pipe(Effect.provide(layer()))
    const stored = [...state.records.values()][0]!
    if (stored.state !== "committed") throw new Error("completed apply must be committed")
    expect(stored.held?.callId).toBe(stored.id)
    expect(stored.held?.recoveryId).toBe("held-private-store")
    expect(JSON.stringify(stored)).not.toContain("private-before-image-canary")
    const encoded = Schema.encodeSync(Schema.fromJsonString(HeldReference))(stored.held!)
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(HeldReference))(encoded)).toEqual(stored.held)
    yield* TestClock.adjust("2 seconds")
    yield* Effect.gen(function* () {
      const supervisor = yield* airlock.supervisor(env)
      const result = yield* supervisor.restore(stored.id)
      expect(result).toMatchObject({ state: "restored", reference: { callId: stored.id, recoveryId: "held-private-store" } })
      expect(result.reference.heldUntil).toBe(DateTime.formatIso(stored.held!.heldUntil))
      const inspected = yield* supervisor.inspect(stored.id)
      expect(inspected).toMatchObject({ held: result.reference })
    }).pipe(Effect.provide(layer()))
    expect(prepared).toBe(1)
    expect(implemented).toBe(1)
    expect(restored).toEqual([stored.held])
  }))

  it.effect("refuses an invalid or already expired host reference before a forward act", () => Effect.gen(function* () {
    for (const mismatch of [false, true]) {
      let implemented = 0
      const now = yield* DateTime.now
      const host: ToolHost = { ...portableToolHost, validateGrant: () => Result.succeed(undefined), recovery: {
        prepare: (call) => Effect.succeed({ callId: mismatch ? "another-call" : call.callId, recoveryId: "held",
          heldUntil: mismatch ? DateTime.add(now, { days: 1 }) : now }),
        inspect: (reference) => Effect.succeed({ state: "done", reference }),
        restore: (reference) => Effect.succeed({ state: "restored", reference })
      } }
      const airlock = defineAirlock({ contracts: [write], host, implement: { write: () => { implemented++; return true } },
        policy: toolPolicy({ toolGrants: [toolGrant(write, { id: "write", when: "now" })], budget: { maxCalls: 1, maxInputBytes: 4096 } }) })
      const result = yield* Effect.gen(function* () {
        const guest = yield* airlock.guest({ runId: "invalid-reference", env: undefined })
        return yield* guest.call("write", { body: "value" })
      }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(
        memoryAdapters(), WebCrypto.layer)))))
      expect(result).toMatchObject({ state: "refused", refusal: { code: "refused" } })
      expect(implemented).toBe(0)
    }
  }))
})
