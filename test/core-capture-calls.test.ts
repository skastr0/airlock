import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result, Schema } from "effect"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { refused } from "../src/core/airlock/Implement.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel } from "../src/core/labels/Labels.ts"
import { makeMemoryLedgerState, memoryLedger } from "../src/core/testing/MemoryLedger.ts"
import { makeMemoryOutboxState, memoryOutboxStore } from "../src/core/testing/MemoryOutboxStore.ts"
import { OutboxStore } from "../src/core/outbox/OutboxStore.ts"
import { IdempotencyKey, OutboxStoreFailed } from "../src/core/outbox/Records.ts"
import { defineOutbox, isLivePermit, type DispatchPermit } from "../src/core/outbox/Outbox.ts"
import { DispatchRefused } from "../src/core/outbox/Dispatcher.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { Sha256Digest } from "../src/core/Canonical.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"

const read = defineToolContract({ name: "read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.NumberFromString })
const policy = (retention?: "keep") => toolPolicy({ toolGrants: [toolGrant(read, { id: "read", when: "now", ...(retention === undefined ? {} : { retention }) })], budget: { maxCalls: 2, maxInputBytes: 4096 } })
const persistence = () => {
  const state = makeMemoryOutboxState(), ledger = makeMemoryLedgerState()
  return { state, ledger, layer: Layer.mergeAll(memoryOutboxStore(state, ledger), memoryLedger(ledger), WebCrypto.layer) }
}

describe("core: capture-now terminal short path", () => {
  it.effect("defaults to digest, re-reads unchanged values and loudly rejects changed bytes", () => Effect.gen(function* () {
    const world = persistence()
    let value = 7, calls = 0
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => { calls++; return value } }, policy: policy() })
    const call = () => Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "digest-replay", env: undefined })
      expect(guest.actions[0]?.resultRetention).toBe("digest")
      expect(guest.description).toContain("Keeps only the result digest")
      return yield* guest.call("read", { id: "private-input-canary" })
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    const first = yield* call()
    expect(first).toMatchObject({ state: "done", result: 7 })
    expect(yield* call()).toEqual(first)
    expect(calls).toBe(2)
    value = 8
    expect(yield* call().pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
    expect(calls).toBe(3)
    expect(world.state.records.size).toBe(1)
    expect(world.state.dispatches.size).toBe(0)
    const record = [...world.state.records.values()][0]!
    expect(record.state).toBe("captured")
    expect(Object.keys(record)).not.toContain("stagedAt")
    expect(Object.keys(record)).not.toContain("holdUntil")
    expect(JSON.stringify(record)).not.toContain("private-input-canary")
    expect([...world.state.captures.values()].map((result) => Object.keys(result))).toEqual([["digest"]])
    expect(world.ledger.entries.map((entry) => entry.act)).toEqual(["capture"])
  }))

  it.effect("preserves exact input authority through policy snapshots and permit dispatch", () => Effect.gen(function* () {
    const world = persistence()
    const exact = defineToolContract({ name: "exact", version: "1", effect: "capture",
      input: Schema.Struct({ value: Schema.Number }), output: Schema.Number, public: ["value"] })
    let calls = 0
    const airlock = defineAirlock({ contracts: [exact], implement: { exact: ({ value }) => {
      calls++; expect(Object.is(value, -0)).toBe(true); return value
    } }, policy: toolPolicy({ toolGrants: [toolGrant(exact, { id: "negative-zero", when: "now", retention: "keep", where: { value: { equals: -0 } } })],
      budget: { maxCalls: 2, maxInputBytes: 4096 } }) })
    yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "exact-input", env: undefined })
      const first = yield* guest.call("exact", { value: -0 })
      expect(first.state).toBe("done")
      if (first.state === "done") expect(Object.is(first.result, -0)).toBe(true)
      expect((yield* guest.call("exact", { value: 0 })).state).toBe("refused")
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    expect(calls).toBe(1)
    expect(world.ledger.entries).toHaveLength(1)
  }))

  it.effect("kept replay uses the recorded encoded result after restart and validates its digest", () => Effect.gen(function* () {
    const world = persistence()
    let calls = 0
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => ++calls }, policy: policy("keep") })
    const call = () => Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "kept-replay", env: undefined })
      expect(guest.actions[0]?.resultRetention).toBe("keep")
      expect(guest.description).toContain("without reading again")
      return yield* guest.call("read", { id: "a" })
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    const first = yield* call()
    expect(first).toMatchObject({ state: "done", result: 1 })
    expect(yield* call()).toEqual(first)
    expect(calls).toBe(1)
    const id = [...world.state.records.keys()][0]!
    const kept = world.state.captures.get(id)!
    expect(kept.value).toBe("1")
    world.state.captures.set(id, { ...kept, value: "2" })
    expect(Result.isFailure(yield* call().pipe(Effect.result))).toBe(true)
    expect(calls).toBe(1)
    expect(world.ledger.entries).toHaveLength(1)
  }))

  it.effect("failed and refused reads leave one redacted terminal receipt and never retry on replay", () => Effect.gen(function* () {
    for (const refusal of [false, true]) {
      const world = persistence()
      let calls = 0
      const airlock = defineAirlock({ contracts: [read], implement: { read: () => { calls++;
        if (refusal) return refused("private-refusal-canary")
        throw new Error("private-error-canary")
      } }, policy: policy("keep") })
      const call = () => Effect.gen(function* () {
        const guest = yield* airlock.guest({ runId: `failed-${refusal}`, env: undefined })
        return yield* guest.call("read", { id: "a" }).pipe(Effect.result)
      }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
      const first = yield* call()
      expect(yield* call()).toEqual(first)
      expect(first._tag).toBe(refusal ? "Success" : "Failure")
      expect(calls).toBe(1)
      expect([...world.state.records.values()]).toMatchObject([{ state: "captured", outcome: { state: refusal ? "refused" : "failed" } }])
      expect(world.state.captures.size).toBe(0)
      expect(world.ledger.entries.map((entry) => entry.act)).toEqual(["capture"])
      expect(JSON.stringify([...world.state.records.values(), ...world.ledger.entries, first])).not.toContain("canary")
    }
  }))

  it.effect("a read-to-record persistence failure leaves nothing and may read again under the same key", () => Effect.gen(function* () {
    const world = persistence()
    let fail = true, calls = 0
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => { calls++; return 7 } }, policy: policy() })
    const faulting = Layer.effect(OutboxStore, Effect.map(OutboxStore, (store) => OutboxStore.of({ ...store,
      putCapture: (record, result, receipt) => fail ? Effect.fail(new OutboxStoreFailed({ operation: "put-capture", id: record.id, reason: "injected failure before publication" })) : store.putCapture(record, result, receipt)
    }))).pipe(Layer.provide(memoryOutboxStore(world.state, world.ledger)))
    const layer = Layer.mergeAll(faulting, memoryLedger(world.ledger), WebCrypto.layer)
    const call = () => Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "capture-crash", env: undefined })
      return yield* guest.call("read", { id: "a" })
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(layer))))
    expect(Result.isFailure(yield* call().pipe(Effect.result))).toBe(true)
    expect(calls).toBe(1)
    expect(world.state.records.size).toBe(0)
    expect(world.state.captures.size).toBe(0)
    expect(world.ledger.entries).toEqual([])
    fail = false
    expect(yield* call()).toMatchObject({ state: "done", result: 7 })
    expect(calls).toBe(2)
    expect(world.ledger.entries.map((entry) => entry.act)).toEqual(["capture"])
  }))

  it.effect("keeps only explicitly public JSON result metadata in the record", () => Effect.gen(function* () {
    const world = persistence()
    const observed = defineToolContract({ name: "observed", version: "1", effect: "capture", input: Schema.Struct({}),
      output: Schema.Struct({ count: Schema.Number, secret: Schema.String }), flow: { sources: {
        count: new InformationLabel({ confidentiality: "public", integrity: "untrusted", provenance: [] }),
        secret: new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] }) } } })
    const airlock = defineAirlock({ contracts: [observed], implement: { observed: () => ({ count: 3, secret: "private-result-canary" }) },
      policy: toolPolicy({ toolGrants: [toolGrant(observed, { id: "observed", when: "now", retention: "keep" })], budget: { maxCalls: 1, maxInputBytes: 4096 } }) })
    yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "metadata", env: undefined })
      expect(yield* guest.call("observed", {})).toMatchObject({ state: "done", result: { count: 3, secret: "private-result-canary" } })
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    expect([...world.state.records.values()]).toMatchObject([{ outcome: { state: "done", metadata: { count: 3 } } }])
    expect(JSON.stringify([...world.state.records.values(), ...world.ledger.entries])).not.toContain("private-result-canary")
  }))

  it.effect("revokes capture permits on completion, proven refusal, defect and interruption", () => Effect.gen(function* () {
    for (const outcome of ["done", "refused", "defect", "interrupted"] as const) {
      const world = persistence()
      const box = defineOutbox({ read })
      let permit: DispatchPermit | undefined
      let calls = 0
      const handler: Parameters<typeof box.Dispatcher.of>[0]["read"] = (request) => {
        permit = request.permit
        calls++
        expect(isLivePermit(request.permit)).toBe(true)
        if (outcome === "refused") return Effect.fail(new DispatchRefused({ reason: "not performed" }))
        if (outcome === "defect") throw new Error("handler construction failed")
        if (outcome === "interrupted") return Effect.interrupt
        return Effect.succeed({ outcome: 7, response: new Uint8Array(), truncated: false })
      }
      const digest = Sha256Digest.make(`sha256:${"a".repeat(64)}`)
      const result = yield* Effect.gen(function* () {
        const outbox = yield* box.Outbox
        return yield* outbox.capture({ key: IdempotencyKey.make(`permit-${outcome}`), intent: { kind: "read", dispatch: { id: "a" } },
          admission: { policyDigest: digest, grantIds: ["read"], execution: { runId: "permit", tool: "read", version: "1",
            effect: "capture", when: "now", retention: "digest", resources: [] } } }).pipe(Effect.result)
      }).pipe(Effect.provide(box.layer.pipe(Layer.provideMerge(Layer.mergeAll(world.layer, Layer.succeed(box.Dispatcher, { read: handler }))))))
      expect(calls).toBe(1)
      expect(permit).toBeDefined()
      expect(isLivePermit(permit!)).toBe(false)
      expect(result._tag).toBe(outcome === "done" || outcome === "refused" ? "Success" : "Failure")
      expect([...world.state.records.values()]).toMatchObject([{ state: "captured", outcome: {
        state: outcome === "done" ? "done" : outcome === "refused" ? "refused" : "failed" } }])
      expect(world.ledger.entries.map((entry) => entry.act)).toEqual(["capture"])
    }
  }))

  it.effect("blocks forged non-capture and approved authority before any implementation or storage", () => Effect.gen(function* () {
    const world = persistence()
    const write = defineToolContract({ name: "write", version: "1", effect: "apply", input: Schema.Struct({}), output: Schema.Boolean })
    let calls = 0
    const airlock = defineAirlock({ contracts: [read, write], implement: { read: () => { calls++; return 7 }, write: () => { calls++; return true } }, policy: policy() })
    const digest = Sha256Digest.make(`sha256:${"a".repeat(64)}`)
    yield* Effect.gen(function* () {
      const outbox = yield* airlock.outbox.Outbox
      const admission = { policyDigest: digest, grantIds: ["read"], execution: { runId: "forged", tool: "read", version: "1", effect: "capture" as const, when: "now" as const, retention: "digest" as const, resources: [] } }
      for (const [tool, effect, when] of [["write", "apply", "now"], ["read", "invoke", "now"], ["read", "request", "now"], ["read", "capture", "approved"]] as const) {
        const request = { key: IdempotencyKey.make(`forged-${effect}-${when}`), intent: { kind: tool, dispatch: { id: "a" } },
          admission: { ...admission, execution: { ...admission.execution, tool, effect, when } } }
        // Hostile JavaScript cannot opt a write into the read crash/retry law.
        const result = yield* outbox.capture(request as never).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }
      if (false) {
        // @ts-expect-error the short path only accepts a capture contract
        yield* outbox.capture({ key: IdempotencyKey.make("typed-write"), intent: { kind: "write", dispatch: {} }, admission })
      }
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    expect(calls).toBe(0)
    expect(world.state.records.size).toBe(0)
    expect(world.ledger.entries).toEqual([])
  }))
})
