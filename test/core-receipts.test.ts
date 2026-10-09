import { memoryAdapters } from "./support/memory.ts"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result, Schema } from "effect"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { CallReceipt } from "../src/core/contract/Receipt.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"

const read = defineToolContract({ name: "read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }),
  public: ["id"], output: Schema.NumberFromString })
const send = defineToolContract({ name: "send", version: "1", effect: "request", input: Schema.Struct({ text: Schema.String }), output: Schema.Boolean })
const adapters = () => Layer.mergeAll(memoryAdapters(), WebCrypto.layer)

describe("core: program call receipts", () => {
  it.effect("returns the decoded result only under done.result, and never reveals a committed request result on replay", () => {
    let sent = 0
    const airlock = defineAirlock({ contracts: [read, send], implement: { read: () => 7, send: () => { sent++; return true } },
      policy: toolPolicy({ toolGrants: [toolGrant(read, { id: "read", when: "now" }), toolGrant(send, { id: "send" })], budget: { maxCalls: 2, maxInputBytes: 4096 } }) })
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "receipt-replay", env: undefined })
      const done = yield* guest.call("read", { id: "a" })
      expect(done).toMatchObject({ state: "done", result: 7 })
      expect(Object.keys(done).sort()).toEqual(["id", "result", "state"])
      const staged = yield* guest.call("send", { text: "private-input" })
      expect(Object.keys(staged).sort()).toEqual(["id", "state"])
      if (staged.state !== "staged") throw new Error("request must stage")
      const supervisor = yield* airlock.supervisor(undefined)
      yield* supervisor.commit(staged.id)
      const replay = yield* airlock.guest({ runId: "receipt-replay", env: undefined })
      expect(yield* replay.call("read", { id: "a" })).toEqual(done)
      expect(yield* replay.call("send", { text: "private-input" })).toEqual(staged)
      expect(sent).toBe(1)
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(adapters()))))
  })

  it.effect("returns a branchable refusal without a record or result, and still spends the call budget", () => {
    let calls = 0
    const state = makeMemoryOutboxState()
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => { calls++; return 7 } },
      policy: toolPolicy({ toolGrants: [toolGrant(read, { id: "read", when: "now", where: { id: { equals: "allowed" } } })], budget: { maxCalls: 1, maxInputBytes: 4096 } }) })
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "refusal-budget", env: undefined })
      const refused = yield* guest.call("read", { id: "other" })
      expect(refused).toMatchObject({ state: "refused", refusal: { code: "not-allowed" } })
      expect(Object.keys(refused).sort()).toEqual(["refusal", "state"])
      const fault = yield* guest.call("read", { id: "allowed" }).pipe(Effect.result)
      expect(fault).toMatchObject({ _tag: "Failure", failure: { code: "budget-exceeded" } })
      expect(state.records.size).toBe(0)
      expect(calls).toBe(0)
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryAdapters(state), WebCrypto.layer)))))
  })

  it.effect("terminates on an expired grant instead of handing the program a refusal", () => Effect.gen(function* () {
    const now = yield* DateTime.now
    let calls = 0
    const airlock = defineAirlock({ contracts: [read], implement: { read: () => { calls++; return 7 } },
      policy: toolPolicy({ toolGrants: [toolGrant(read, { id: "read", when: "now", validUntil: now })], budget: { maxCalls: 2, maxInputBytes: 4096 } }) })
    const fault = yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "expired", env: undefined })
      return yield* guest.call("read", { id: "a" }).pipe(Effect.result)
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(adapters()))))
    expect(fault).toMatchObject({ _tag: "Failure", failure: { code: "expired" } })
    expect(calls).toBe(0)
  }))

  it("rejects result/authority fields on staged or refused receipts", () => {
    const decode = Schema.decodeUnknownResult(CallReceipt, { onExcessProperty: "error" })
    for (const receipt of [{ state: "staged", id: "a", result: true }, { state: "refused", refusal: { code: "no", message: "no" }, result: true },
      { state: "staged", id: "a", wayBack: { callId: "a", recoveryId: "b", heldUntil: "2027-01-01T00:00:00Z" } }]) {
      expect(Result.isFailure(decode(receipt))).toBe(true)
    }
  })
})
