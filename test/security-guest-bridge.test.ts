import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { AirlockFailure, type GuestSurface } from "../src/core/airlock/Airlock.ts"
import { defineToolContract, type ToolContract } from "../src/core/contract/ToolContract.ts"
import { boundedJson, guestLimits, notJson, tooLarge } from "../src/core/runner/Bounds.ts"
import { type GuestLimits, type GuestOutcome, GuestRunner } from "../src/core/runner/GuestRunner.ts"
import { programRunner } from "../src/core/runner/ProgramRunner.ts"
import { reviewContext } from "./support/ReviewContext.ts"

/** Each program is checked against the contract it calls; this one takes nothing and answers null. */
type Spec = Parameters<typeof defineToolContract>[0]
const reading = (input: Spec["input"] = Schema.Struct({}), output: Spec["output"] = Schema.Null) =>
  defineToolContract({ name: "security.read", version: "1", effect: "capture", input, output })

const surface = (call: GuestSurface["call"], contract: ToolContract.Any): GuestSurface => ({
  tools: ["security.read"], actions: [], description: "", call, review: reviewContext(contract)
})

/** What a host tool answers, as the kernel hands it over: a done receipt around the result. */
const done = (result: unknown) => ({ state: "done" as const, id: "call-1", result: result as never })

const run = (
  source: string,
  call: GuestSurface["call"],
  { contract = reading(), ...options }: { readonly limits?: Partial<GuestLimits>; readonly signal?: AbortSignal; readonly contract?: ToolContract.Any } = {}
): Promise<GuestOutcome> =>
  Effect.runPromise(Effect.gen(function* () {
    const runner = yield* GuestRunner
    return yield* runner.run({ source, surface: surface(call, contract), ...options })
  }).pipe(Effect.provide(programRunner)))

const read = "return security.read({})"
const thrown = (bound: () => unknown): unknown => {
  try { bound() } catch (error) { return error }
  return undefined
}

describe("security: the program runner enforces the host boundary", () => {
  it("keeps unexpected host exception text out of the outcome", async () => {
    const outcome = await run(read, () => Effect.die(new Error("host-canary-secret")))
    expect(outcome).toEqual({ ok: false, reason: "execution_failed", toolCalls: 1 })
    expect(JSON.stringify(outcome)).not.toContain("host-canary-secret")
  })

  it("also redacts exceptions thrown before the tool returns an Effect", async () => {
    const outcome = await run(read, () => { throw new Error("host-canary-secret") })
    expect(outcome).toEqual({ ok: false, reason: "execution_failed", toolCalls: 1 })
  })

  it("ends the run at a tool fault with Airlock's sentence, without exposing its cause", async () => {
    const outcome = await run(`${read}\nreturn "continued"`, () => Effect.fail(Object.assign(new AirlockFailure({
      code: "uncertain", message: "This call may have acted."
    }), { cause: new Error("host-canary-secret") })))
    expect(outcome).toEqual({
      ok: false,
      reason: "tool_failed",
      toolCalls: 1,
      failure: { tool: "security.read", code: "uncertain", message: "This call may have acted." }
    })
  })

  it("ends the run when a grant has run out, with its own fixed reason and nothing after it", async () => {
    let calls = 0
    const outcome = await run(`
      let first = security.read({})
      if first.state == "refused" { return "branched" }
      security.read({})
      return "continued"`, () => {
        calls += 1
        return Effect.fail(new AirlockFailure({ code: "expired", message: "security.read was not run: its grant has expired" }))
      })
    expect(outcome).toEqual({ ok: false, reason: "grant_expired", toolCalls: 1 })
    expect(calls).toBe(1)
  })

  it("hands a refusal to the program as a receipt, and lets no host object ride along on it", async () => {
    const refused = { state: "refused" as const, refusal: { code: "not-allowed", message: "This call is refused." } }
    const outcome = await run(`let receipt = security.read({})\nif receipt.state == "refused" { return [receipt.state, receipt.refusal.code, "continued"] }\nreturn null`,
      () => Effect.succeed(refused))
    expect(outcome).toEqual({ ok: true, result: ["refused", "not-allowed", "continued"], toolCalls: 1 })
    // A receipt carrying anything that is not plain data does not cross at all.
    const carrying = await run(read, () => Effect.succeed(Object.assign({ ...refused }, { cause: new Error("host-canary-secret") })))
    expect(carrying).toEqual({ ok: false, reason: "execution_failed", toolCalls: 1 })
  })

  it("cuts a fault's sentence and a called name to a fixed length", async () => {
    const long = await run(read, () => Effect.fail(new AirlockFailure({ code: "uncertain", message: "m".repeat(5_000) })))
    expect(!long.ok && long.failure?.message.length).toBe(512)
    // A name the session does not grant fails the check: it never reaches the host or the outcome.
    let reached = 0
    const named = await run(`return ${"n".repeat(4_000)}({})`, () => Effect.sync(() => { reached += 1; return done(null) }))
    expect(named).toMatchObject({ ok: false, reason: "invalid_code", toolCalls: 0 })
    expect(JSON.stringify(named)).not.toContain("nnnn")
    expect(reached).toBe(0)
  })

  it("never invokes a getter on a host result", async () => {
    let reads = 0
    const result = Object.defineProperty({}, "private", {
      enumerable: true, get: () => { reads += 1; throw new Error("host-canary-secret") }
    })
    const outcome = await run(read, () => Effect.succeed(done(result)))
    expect({ outcome, reads }).toEqual({ outcome: { ok: false, reason: "execution_failed", toolCalls: 1 }, reads: 0 })
  })

  it("serializes host data without invoking a toJSON hook", async () => {
    let hooks = 0
    const result = Object.defineProperty({ answer: 42 }, "toJSON", {
      value: () => { hooks += 1; throw new Error("host-canary-secret") }
    })
    expect(await run(`let r = security.read({})\nif r.state == "done" { return r.result }\nreturn null`, () => Effect.succeed(done(result)), { contract: reading(Schema.Struct({}), Schema.Struct({ answer: Schema.Number })) }))
      .toEqual({ ok: true, result: { answer: 42 }, toolCalls: 1 })
    expect(hooks).toBe(0)
  })

  it("hands a tool its own copy of the input, and the program its own copy of the result", async () => {
    const held: Array<unknown> = []
    const shared = { list: [1, 2] }
    const outcome = await run(`
      let input = { nested: { leaf: 1 } }
      let first = security.read(input)
      let second = security.read(input)
      if first.state == "done" { if second.state == "done" { return [first.result, second.result, input] } }
      return null`, (_tool, input) => Effect.sync(() => {
        held.push(input)
        ;(input as { nested: { leaf: number } }).nested.leaf = 99
        shared.list.push(3)
        return done(shared)
      }), { contract: reading(Schema.Struct({ nested: Schema.Struct({ leaf: Schema.Number }) }), Schema.Struct({ list: Schema.Array(Schema.Number) })) })
    expect(outcome).toEqual({
      ok: true,
      result: [{ list: [1, 2, 3] }, { list: [1, 2, 3, 3] }, { nested: { leaf: 1 } }],
      toolCalls: 2
    })
    expect(held[0]).not.toBe(held[1])
  })

  it("carries a number across the boundary exactly, in each direction", async () => {
    const received: Array<unknown> = []
    const outcome = await run(`
      let first = security.read({})
      if first.state == "done" {
        security.read({ scalar: first.result.scalar, list: first.result.list })
        return first.result
      }
      return null`, (_tool, input) => Effect.sync(() => {
        received.push(input)
        return done({ scalar: -0, list: [-0, 0], large: 9007199254740991, small: 5e-324 })
      }), { contract: reading(
        Schema.Struct({ scalar: Schema.optionalKey(Schema.Number), list: Schema.optionalKey(Schema.Array(Schema.Number)) }),
        Schema.Struct({ scalar: Schema.Number, list: Schema.Array(Schema.Number), large: Schema.Number, small: Schema.Number })
      ) })
    // Tool to program to host: the run's result still holds negative zero.
    const result = (outcome.ok ? outcome.result : {}) as { scalar: number; list: ReadonlyArray<number>; large: number; small: number }
    expect([Object.is(result.scalar, -0), Object.is(result.list[0], -0), Object.is(result.list[1], 0)]).toEqual([true, true, true])
    expect([result.large, result.small]).toEqual([9007199254740991, 5e-324])
    // Tool to program to tool: the second call was handed what the first one answered.
    const second = received[1] as { scalar: number; list: ReadonlyArray<number> }
    expect([Object.is(second.scalar, -0), Object.is(second.list[0], -0), Object.is(second.list[1], 0)]).toEqual([true, true, true])
    expect(boundedJson({ a: -0, b: [0, -0] }, 1_000, guestLimits())).toBe('{"a":-0,"b":[0,-0]}')
  })

  it("interrupts an admitted call when the run is stopped before staging", async () => {
    let unblock!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { unblock = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let emissions = 0
    const controller = new AbortController()
    const pending = run(read, () => {
      entered()
      return Effect.promise(() => waiting).pipe(Effect.andThen(Effect.sync(() => {
        emissions += 1
        return done(null)
      })))
    }, { signal: controller.signal })
    await started
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: "aborted", toolCalls: 1 })
    unblock()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(emissions).toBe(0)
  })

  it("ends a pre-aborted run without starting it", async () => {
    let calls = 0
    const controller = new AbortController()
    controller.abort()
    const outcome = await run(read, () => Effect.sync(() => { calls += 1; return done(null) }), { signal: controller.signal })
    expect({ outcome, calls }).toEqual({ outcome: { ok: false, reason: "aborted", toolCalls: 0 }, calls: 0 })
  })

  it("does not call a tool if aborted before the program's first step", async () => {
    const controller = new AbortController()
    let calls = 0
    const pending = run(read, () => Effect.sync(() => { calls += 1; return done(null) }), { signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: "aborted", toolCalls: 0 })
    expect(calls).toBe(0)
  })

  it("settles a program that exhausts the evaluator without host text", async () => {
    const outcome = await run(`return ${"[".repeat(7_000)}1${"]".repeat(7_000)}`, () => Effect.succeed(done(null)))
    expect(outcome.ok).toBe(false)
    expect(JSON.stringify(outcome)).not.toMatch(/RangeError|stack|Maximum/)
  })

  it("rejects excessive JSON depth in a tool input before the tool is reached", async () => {
    let calls = 0
    const outcome = await run(`return security.read({ nested: { deeper: { leaf: 1 } } })`,
      () => Effect.sync(() => { calls += 1; return done(null) }), { limits: { maxDepth: 1 },
        contract: reading(Schema.Struct({ nested: Schema.Struct({ deeper: Schema.Struct({ leaf: Schema.Number }) }) })) })
    expect({ outcome, calls }).toEqual({ outcome: { ok: false, reason: "tool_input_limit", toolCalls: 1 }, calls: 0 })
  })

  it("rejects excessive node counts before the tool is reached", async () => {
    let calls = 0
    const outcome = await run(`return security.read({ a: 1, b: 2 })`,
      () => Effect.sync(() => { calls += 1; return done(null) }), { limits: { maxNodes: 2 },
        contract: reading(Schema.Struct({ a: Schema.Number, b: Schema.Number })) })
    expect(outcome.ok).toBe(false)
    expect(calls).toBe(0)
    // The boundary check itself, apart from the evaluator's own limit on built values.
    expect(thrown(() => boundedJson({ a: 1, b: 2 }, 1_000, guestLimits({ maxNodes: 2 })))).toBe(tooLarge)
    expect(thrown(() => boundedJson({ nested: { deeper: { leaf: 1 } } }, 1_000, guestLimits({ maxDepth: 1 })))).toBe(tooLarge)
    expect(thrown(() => boundedJson("éé", 4, guestLimits()))).toBe(tooLarge)
    expect(thrown(() => boundedJson({ when: new Date(0) }, 1_000, guestLimits()))).toBe(notJson)
    expect(thrown(() => boundedJson(Number.NaN, 1_000, guestLimits()))).toBe(notJson)
  })

  it.each([
    [{ maxDepth: 1 }, { nested: { deeper: { leaf: 1 } } }],
    [{ maxNodes: 2 }, { a: 1, b: 2 }],
    [{ maxToolResultBytes: 4 }, "éé"]
  ])("bounds host tool results independently (%j)", async (overrides, result) => {
    const outcome = await run(`security.read({})\nreturn "continued"`, () => Effect.succeed(done(result)), { limits: overrides })
    expect(outcome).toEqual({ ok: false, reason: "tool_result_limit", toolCalls: 1 })
  })

  it("checks the program's final result against the node and byte limits", async () => {
    expect((await run(`return { a: 1, b: 2 }`, () => Effect.succeed(done(null)), { limits: { maxNodes: 2 } })).ok).toBe(false)
    const text = await run(`return "éééé"`, () => Effect.succeed(done(null)), { limits: { maxOutputBytes: 8 } })
    expect(text).toEqual({ ok: false, reason: "output_limit", toolCalls: 0 })
  })
})
