import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Admission, defineAirlock, toolPolicy, WebCrypto } from "../src/core/index.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { DurationSchema } from "../src/core/language/ast.ts"
import { GuestRunner } from "../src/core/runner/GuestRunner.ts"
import { programRunner } from "../src/core/runner/ProgramRunner.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"

describe("language: current duration contract boundary", () => {
  it.effect("rejects a malformed tagged record before a duration handler runs", () => Effect.gen(function* () {
    let handled = 0
    const duration = defineToolContract({ name: "duration.echo", version: "1", effect: "capture", input: Schema.Struct({ duration: DurationSchema }), output: Schema.Boolean })
    const airlock = defineAirlock({ contracts: [duration], implement: { "duration.echo": () => { handled++; return true } }, policy: toolPolicy({ budget: { maxCalls: 4, maxInputBytes: 4096 }, toolGrants: [Admission.toolGrant(duration, { id: "duration", when: "now" })] }) })
    const ledger = makeMemoryLedgerState()
    const layer = airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryLedger(ledger), memoryOutboxStore(makeMemoryOutboxState(), ledger), WebCrypto.layer)))
    const outcomes = yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "duration-boundary", env: undefined })
      const runner = yield* GuestRunner
      const malformed = yield* runner.run({ source: 'return duration.echo({duration:{kind:"Duration",value:"bad",unit:"s"}})', surface: guest })
      expect(handled).toBe(0)
      const valid = yield* runner.run({ source: 'return duration.echo({duration:1s})', surface: guest })
      return { malformed, valid }
    }).pipe(Effect.provide(layer), Effect.provide(programRunner), Effect.scoped)
    expect(handled).toBe(1)
    // The literal is checked against the contract's input before the run, so nothing is called.
    expect(outcomes.malformed).toEqual({ ok: false, reason: "invalid_code", toolCalls: 0, at: { line: 1, column: 8 } })
    expect(outcomes.valid.ok).toBe(true)
  }))
})
