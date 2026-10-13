import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Result, Schema } from "effect"
import { defineAirlock } from "../src/airlock/Airlock.ts"
import { ToolGrantPolicy } from "../src/admission/ToolGrant.ts"
import { defineToolContract } from "../src/contract/ToolContract.ts"
import { InformationLabel } from "../src/labels/Labels.ts"
import { toolPolicy } from "../src/session/ToolPolicy.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/testing/index.ts"
import * as WebCrypto from "../src/WebCrypto.ts"

const persistence = (crypto: Layer.Layer<Crypto.Crypto> = WebCrypto.layer) => {
  const state = makeMemoryOutboxState(), ledger = makeMemoryLedgerState()
  return { state, layer: Layer.mergeAll(memoryOutboxStore(state, ledger), memoryLedger(ledger), crypto) }
}
const policy = toolPolicy({
  toolGrants: [new ToolGrantPolicy({ id: "read", tool: "read", when: "now", retention: "keep" })], budget: { maxCalls: 1, maxInputBytes: 4096 }
})

describe("security: capture records own the exact returned result", () => {
  it.effect("kept replay preserves signed zero at scalar and list positions", () => Effect.gen(function* () {
    const read = defineToolContract({ name: "read", version: "1", effect: "capture", input: Schema.Struct({}),
      output: Schema.Struct({ scalar: Schema.Number, list: Schema.Array(Schema.Number) }) })
    const world = persistence()
    let calls = 0
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => { calls++; return { scalar: -0, list: [-0] } } }, policy })
    const call = () => Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "signed-zero", env: undefined })
      return yield* guest.call("read", {})
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    for (const receipt of [yield* call(), yield* call()]) {
      if (receipt.state !== "done") throw new Error("capture must complete")
      const result = Schema.decodeUnknownSync(read.outcome)(receipt.result)
      expect(Object.is(result.scalar, -0)).toBe(true)
      expect(Object.is(result.list[0], -0)).toBe(true)
    }
    expect(calls).toBe(1)
  }))

  it.effect("kept replay still satisfies the original exact output refinement", () => Effect.gen(function* () {
    const output = Schema.Number.check(Schema.makeFilter((value) => Object.is(value, -0)))
    const read = defineToolContract({ name: "read", version: "1", effect: "capture", input: Schema.Struct({}), output })
    const world = persistence()
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => -0 }, policy })
    const call = () => Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "refined-zero", env: undefined })
      return yield* guest.call("read", {})
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    expect(yield* call()).toMatchObject({ state: "done", result: -0 })
    const replay = yield* call().pipe(Effect.result)
    expect(Result.isSuccess(replay)).toBe(true)
    if (Result.isSuccess(replay)) expect(replay.success).toMatchObject({ state: "done", result: -0 })
  }))

  it.effect("public metadata describes the returned snapshot after an asynchronous digest", () => Effect.gen(function* () {
    const value = { count: 1, secret: "private-result-canary" }
    const crypto = Layer.effect(Crypto.Crypto, Effect.map(Crypto.Crypto, (inner) => Crypto.Crypto.of({
      ...inner, digest: (algorithm, bytes) => Effect.suspend(() => {
        if (new TextDecoder().decode(bytes) === '{"count":1,"secret":"private-result-canary"}') value.count = 2
        return inner.digest(algorithm, bytes)
      })
    }))).pipe(Layer.provide(WebCrypto.layer))
    const world = persistence(crypto)
    const read = defineToolContract({ name: "read", version: "1", effect: "capture", input: Schema.Struct({}),
      output: Schema.Struct({ count: Schema.Number, secret: Schema.String }), flow: { sources: {
        count: new InformationLabel({ confidentiality: "public", integrity: "untrusted", provenance: [] }),
        secret: new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] })
      } } })
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => value }, policy })
    const receipt = yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "metadata-snapshot", env: undefined })
      return yield* guest.call("read", {})
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(world.layer))))
    expect(value.count).toBe(2)
    expect(receipt).toMatchObject({ state: "done", result: { count: 1 } })
    expect([...world.state.records.values()]).toMatchObject([{ outcome: { state: "done", metadata: { count: 1 } } }])
    expect(JSON.stringify([...world.state.records.values()])).not.toContain("private-result-canary")
  }))
})
