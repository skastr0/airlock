import { memoryAdapters } from "./support/memory.ts"
import { describe, expect, it } from "@effect/vitest"
import { Clock, DateTime, Effect, Layer, Result, Schema } from "effect"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { refused } from "../src/core/airlock/Implement.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { portableToolHost } from "../src/core/contract/PortableToolHost.ts"
import type { HeldReference, ToolHost } from "../src/core/contract/ToolHost.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState } from "../src/core/testing/index.ts"

const write = defineToolContract({ name: "write", version: "1", effect: "apply",
  input: Schema.Struct({ body: Schema.String }), output: Schema.Boolean })
const read = defineToolContract({ name: "read", version: "1", effect: "capture",
  input: Schema.Struct({ id: Schema.String }), public: ["id"], output: Schema.Number })

const START = 100_000
const DEADLINE = 150_000
const LATE = 200_000

/** Wall time set by hand, so a step inside the call can move it past the deadline. */
const manualClock = Effect.gen(function* () {
  const base = yield* Clock.Clock
  let now = START
  const nanos = () => BigInt(now) * 1_000_000n
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) => base.sleep(duration)
  }
  return { clock, lapse: () => { now = LATE } }
})

const world = () => {
  const outbox = makeMemoryOutboxState(), ledger = makeMemoryLedgerState()
  return { outbox, ledger, layer: Layer.mergeAll(memoryAdapters(outbox, ledger), WebCrypto.layer) }
}

const recoveringHost = (onPrepare: () => void, restored: Array<HeldReference>): ToolHost => ({
  ...portableToolHost, validateGrant: () => Result.succeed(undefined), recovery: {
    prepare: (call) => Effect.sync(() => {
      onPrepare()
      return { callId: call.callId, recoveryId: "held", heldUntil: DateTime.makeUnsafe(LATE + 86_400_000) }
    }),
    inspect: (reference) => Effect.succeed({ state: "done", reference }),
    restore: (reference) => Effect.sync(() => { restored.push(reference); return { state: "restored" as const, reference } })
  }
})

const policyFor = (contract: typeof write | typeof read) => toolPolicy({
  toolGrants: [toolGrant(contract, { id: contract.tag, when: "now", validUntil: DateTime.makeUnsafe(DEADLINE) })],
  budget: { maxCalls: 2, maxInputBytes: 4096 }
})

const actsFor = (entries: ReadonlyArray<{ readonly act: string; readonly ref: string }>, id: string) =>
  entries.filter((entry) => entry.ref === id).map((entry) => entry.act)

describe("core: a grant that runs out while its call is in flight", () => {
  it.effect("ends the run as expired when the deadline passes while recovery is prepared, and runs nothing", () => Effect.gen(function* () {
    const { clock, lapse } = yield* manualClock
    const { outbox, ledger, layer } = world()
    let implemented = 0
    const host = recoveringHost(lapse, [])
    const airlock = defineAirlock({ contracts: [write], host, policy: policyFor(write),
      implement: { write: () => { implemented++; return true } } })
    const ended = yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "prepare-lapse", env: undefined })
      return yield* guest.call("write", { body: "value" }).pipe(Effect.result)
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(layer))), Effect.provideService(Clock.Clock, clock))

    expect(ended).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
    expect(implemented).toBe(0)
    const [record] = [...outbox.records.values()]
    expect(record?.state).toBe("refused")
    expect(actsFor(ledger.entries, record!.id)).toEqual(["stage", "refuse", "expire"])
  }))

  it.effect("keeps a completed call and its way back when the deadline passes during the call, and still restores", () => Effect.gen(function* () {
    const { clock, lapse } = yield* manualClock
    const { outbox, ledger, layer } = world()
    const restored: Array<HeldReference> = []
    let implemented = 0
    const host = recoveringHost(() => {}, restored)
    const airlock = defineAirlock({ contracts: [write], host, policy: policyFor(write),
      implement: { write: () => { implemented++; lapse(); return true } } })
    const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
      effect.pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(layer))), Effect.provideService(Clock.Clock, clock)) as Effect.Effect<A, E>

    const ended = yield* run(Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "dispatch-lapse", env: undefined })
      return yield* guest.call("write", { body: "value" }).pipe(Effect.result)
    }))
    expect(ended).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
    if (Result.isSuccess(ended)) throw new Error("the run must end")
    const [record] = [...outbox.records.values()]
    if (record?.state !== "committed") throw new Error("the completed call must stay committed")
    expect(ended.failure.message).toContain(record.id)
    expect(record.held?.callId).toBe(record.id)
    expect(implemented).toBe(1)
    expect(actsFor(ledger.entries, record.id)).toEqual(["stage", "commit", "expire"])

    const restoration = yield* run(Effect.gen(function* () {
      const supervisor = yield* airlock.supervisor(undefined)
      return yield* supervisor.restore(record.id)
    }))
    expect(restoration).toMatchObject({ state: "restored", reference: { callId: record.id } })
    expect(restored).toHaveLength(1)
  }))

  for (const outcome of ["value", "refusal"] as const) {
    it.effect(`ends a capture as expired, not ${outcome === "refusal" ? "refused" : "done"}, when the deadline passes during the read`, () => Effect.gen(function* () {
      const { clock, lapse } = yield* manualClock
      const { outbox, ledger, layer } = world()
      const airlock = defineAirlock({ contracts: [read], policy: policyFor(read),
        implement: { read: () => { lapse(); return outcome === "value" ? 7 : refused("not configured") } } })
      const ended = yield* Effect.gen(function* () {
        const guest = yield* airlock.guest({ runId: `capture-lapse-${outcome}`, env: undefined })
        return yield* guest.call("read", { id: "a" }).pipe(Effect.result)
      }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(layer))), Effect.provideService(Clock.Clock, clock))

      expect(ended).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
      const [record] = [...outbox.records.values()]
      expect(record?.state).toBe("captured")
      expect(actsFor(ledger.entries, record!.id)).toEqual(["capture", "expire"])
    }))
  }

  it.effect("keeps a refusal branchable while the grant is still valid", () => Effect.gen(function* () {
    const { clock } = yield* manualClock
    const { ledger, layer } = world()
    const airlock = defineAirlock({ contracts: [write], host: recoveringHost(() => {}, []), policy: policyFor(write),
      implement: { write: () => refused("not configured") } })
    const receipt = yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "valid-refusal", env: undefined })
      return yield* guest.call("write", { body: "value" })
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(layer))), Effect.provideService(Clock.Clock, clock))

    expect(receipt).toMatchObject({ state: "refused", refusal: { code: "refused" } })
    expect(ledger.entries.map((entry) => entry.act)).not.toContain("expire")
  }))
})
