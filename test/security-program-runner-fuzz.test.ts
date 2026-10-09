import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import type { GuestSurface } from "../src/core/airlock/Airlock.ts"
import { GuestOutcome, GuestRunner, type GuestRun } from "../src/core/runner/GuestRunner.ts"
import { programRunner } from "../src/core/runner/ProgramRunner.ts"
import { hostileSources, runnerExamples, seeded } from "./support/hostile-air-corpus.ts"

const run = (source: string, call: GuestSurface["call"], options: Pick<GuestRun, "limits" | "bindings"> = {}) =>
  Effect.runPromise(Effect.gen(function* () {
    const runner = yield* GuestRunner
    return yield* runner.run({ source, surface: { tools: ["security.echo"], actions: [], description: "", call },
      ...options, limits: { wallTimeMs: 5_000, ...options.limits } })
  }).pipe(Effect.provide(programRunner)))

const outcomeIsFixed = (outcome: GuestOutcome, clue: string) => {
  expect(Result.isSuccess(Schema.decodeUnknownResult(GuestOutcome, { onExcessProperty: "error" })(outcome)), clue).toBe(true)
  expect(JSON.stringify(outcome), clue).not.toMatch(/host-canary|RangeError|Maximum call stack|node_modules|file:\/\//)
}

describe("security: reproducible hostile programs through the production runner", () => {
  it("agrees with 1,000 generated expression values and call counts", async () => {
    const seed = 0x41_52_4c
    for (const [index, example] of runnerExamples(seed, 1_000).entries()) {
      const clue = `seed=${seed} case=${index}\n${example.source}`
      let calls = 0
      const outcome = await run(example.source, (_tool, input) => Effect.sync(() => { calls++; return input as never }))
      outcomeIsFixed(outcome, clue)
      // The public result crosses JSON, whose numeric representation normalizes -0.
      expect(outcome, clue).toEqual({ ok: true, result: JSON.parse(JSON.stringify(example.value)), toolCalls: example.calls })
      expect(calls, clue).toBe(example.calls)
    }
  }, 30_000)

  it("settles 1,000 token mutations and wrong-shaped operations without an escaped exception", async () => {
    const seed = 0x42_41_44
    for (const [index, source] of hostileSources(seed, 1_000).entries()) {
      const clue = `seed=${seed} case=${index}\n${JSON.stringify(source)}`
      let calls = 0
      const outcome = await run(source, () => Effect.sync(() => { calls++; return { answer: 1 } }),
        { limits: { maxSteps: 512, maxLoopIterations: 32, maxToolCalls: 4 } })
      outcomeIsFixed(outcome, clue)
      expect(calls, clue).toBeLessThanOrEqual(4)
      expect(outcome.toolCalls, clue).toBeGreaterThanOrEqual(calls)
    }
  }, 30_000)

  it("keeps defective host values and exception text out of 1,000 generated calls", async () => {
    const seed = 0x48_4f_53, pick = seeded(seed)
    let hooks = 0
    const accessor = Object.defineProperty({}, "secret", { enumerable: true,
      get: () => { hooks++; throw new Error("host-canary-getter") } })
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const values = [accessor, cyclic, new Date(0), Number.NaN, BigInt(1), Object.assign(Object.create({ secret: "host-canary-prototype" }), { value: 1 })]
    for (const [index, example] of runnerExamples(seed, 1_000).entries()) {
      const mode = pick(values.length + 2), clue = `seed=${seed} case=${index} mode=${mode}`
      const source = `security.echo({ value: ${JSON.stringify(example.value)} }); return "continued"`
      const outcome = await run(source, () => {
        if (mode === values.length) throw new Error("host-canary-throw")
        return mode === values.length + 1 ? Effect.die(new Error("host-canary-defect")) : Effect.succeed(values[mode] as never)
      })
      outcomeIsFixed(outcome, clue)
      expect(outcome, clue).toEqual({ ok: false, reason: mode === 1 ? "tool_result_limit" : "execution_failed", toolCalls: 1 })
    }
    expect(hooks).toBe(0)
  }, 30_000)

  it.each([
    `return ${"!".repeat(15_000)}true`,
    `return ${Array.from({ length: 2_000 }, () => "1").join(" + ")}`,
    `return x${".field".repeat(2_000)}`,
    `${"if true { ".repeat(300)}security.echo({})${" }".repeat(300)}`,
    `return ${"[".repeat(300)}0${"]".repeat(300)}`
  ])("rejects recursive and iterative depth attacks before calling the host", async (source) => {
    let calls = 0
    const outcome = await run(source, () => Effect.sync(() => { calls++; return null }))
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_code", toolCalls: 0 })
    expect(calls).toBe(0)
    outcomeIsFixed(outcome, source.slice(0, 80))
  })

  it("charges empty iterations and straight-line work before the following call", async () => {
    for (const source of ["for n in 0..10000 {}; security.echo({})", `${"true;".repeat(200)}security.echo({})`]) {
      let calls = 0
      const outcome = await run(source, () => Effect.sync(() => { calls++; return null }),
        { limits: { maxSteps: 64, maxLoopIterations: 20_000 } })
      expect(outcome).toMatchObject({ ok: false, reason: "step_limit", toolCalls: 0 })
      expect(calls).toBe(0)
    }
  })

  it("bounds aliases, record keys and nested scopes without retaining exited scopes", async () => {
    for (const source of [
      `let a = [0,1,2]; let b = a; security.echo({})`,
      `let a = {long_key: ""}; let b = {long_key: ""}; security.echo({})`,
      `let a = "abc"; if true { let b = a; let c = a; security.echo({}) }`
    ]) {
      let calls = 0
      const outcome = await run(source, () => Effect.sync(() => { calls++; return null }),
        { limits: { maxTotalNodes: 7, maxTotalStringUnits: 8 } })
      expect(outcome).toMatchObject({ ok: false, reason: "value_limit", toolCalls: 0 })
      expect(calls).toBe(0)
    }
    const released = await run(`for n in 0..100 { let held = "12345" }; return true`, () => Effect.succeed(null),
      { limits: { maxTotalStringUnits: 5 } })
    expect(released).toEqual({ ok: true, result: true, toolCalls: 0 })
  })
})
