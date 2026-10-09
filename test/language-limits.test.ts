import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { parse, parseSync } from "../src/core/language/parser.ts"
import { evaluate, StepLimitExceeded, ValueLimitExceeded, type ActionResolver } from "../src/core/language/evaluator.ts"

describe("language execution bounds", () => {
  for (const source of [
    `return ${"!".repeat(15_000)}true`,
    `return ${"(".repeat(1000)}true${")".repeat(1000)}`,
    `return x${".field".repeat(15_000)}`,
    `return ${Array.from({ length: 15_000 }, () => "1").join("+")}`,
    `${"if true {".repeat(1000)}return true${"}".repeat(1000)}`
  ]) it.effect(`refuses excessive syntax depth without overflowing (${source.length} chars)`, () => Effect.gen(function* () {
    const error = yield* parse(source).pipe(Effect.flip)
    expect(error._tag).toBe("LanguageDiagnostic")
    expect(error.detail).toBe("syntax nesting limit exceeded")
  }))

  it.effect("allows a tighter syntax depth but refuses unsafe configuration", () => Effect.gen(function* () {
    expect((yield* parse("return true", { maxNestingDepth: 4 })).body).toHaveLength(1)
    for (const limit of [0, 129, Infinity, 1.5]) {
      const error = yield* parse("return true", { maxNestingDepth: limit }).pipe(Effect.flip)
      expect(error.detail).toContain("maxNestingDepth must be")
    }
    expect((yield* parse("return !!!!true", { maxNestingDepth: 4 }).pipe(Effect.flip)).detail).toBe("syntax nesting limit exceeded")
  }))

  it.effect("charges statements, expressions and call arguments before resolving", () => Effect.gen(function* () {
    let calls = 0
    const resolver: ActionResolver = { resolve: () => Effect.sync(() => { calls++; return true }) }
    const program = parseSync("let ready = true; echo(ready); return ready")
    const stopped = yield* evaluate(program, resolver, { maxSteps: 4 }).pipe(Effect.flip)
    expect(stopped).toBeInstanceOf(StepLimitExceeded)
    expect(calls).toBe(0)
    expect((yield* evaluate(program, resolver, { maxSteps: 7 })).value).toBe(true)
    expect(calls).toBe(1)
    expect(yield* evaluate(parseSync("return true"), resolver, { maxSteps: 0 }).pipe(Effect.flip)).toBeInstanceOf(StepLimitExceeded)
  }))

  it.effect("charges empty loop iterations and shares the step budget across nesting", () => Effect.gen(function* () {
    const resolver: ActionResolver = { resolve: () => Effect.succeed(true) }
    const stopped = yield* evaluate(parseSync("for item in [1,2,3] {}"), resolver, { maxSteps: 6 }).pipe(Effect.flip)
    expect(stopped).toBeInstanceOf(StepLimitExceeded)
    expect((yield* evaluate(parseSync("for item in [1,2,3] {}; return true"), resolver, { maxSteps: 10 })).value).toBe(true)
    expect(yield* evaluate(parseSync("for outer in [1,2] { for inner in [1,2] {} }"), resolver, { maxSteps: 9 }).pipe(Effect.flip)).toBeInstanceOf(StepLimitExceeded)
  }))

  it.effect("caps live roots even when every individual value fits", () => Effect.gen(function* () {
    let calls = 0
    const resolver: ActionResolver = { resolve: () => Effect.sync(() => { calls++; return true }) }
    for (const source of ["let first = [1,2]; let second = [3,4]; echo(true)", "let first = [1,2]; let alias = first; echo(true)"]) {
      const stopped = yield* evaluate(parseSync(source), resolver, { maxValueNodes: 3, maxTotalNodes: 5 }).pipe(Effect.flip)
      expect(stopped).toBeInstanceOf(ValueLimitExceeded)
      expect(stopped._tag === "ValueLimitExceeded" && stopped.measure).toBe("total-nodes")
    }
    const strings = yield* evaluate(parseSync('let first = "aaaa"; let second = "bbbb"; echo(true)'), resolver, { maxTotalStringUnits: 7 }).pipe(Effect.flip)
    expect(strings._tag === "ValueLimitExceeded" && strings.measure).toBe("total-string-units")
    const keys = yield* evaluate(parseSync('let value = {body:"xx"}'), resolver, { maxTotalStringUnits: 5 }).pipe(Effect.flip)
    expect(keys._tag === "ValueLimitExceeded" && keys.measure).toBe("total-string-units")
    expect(calls).toBe(0)
  }))

  it.effect("releases lexical roots and caps host-injected bindings before effects", () => Effect.gen(function* () {
    let calls = 0
    const resolver: ActionResolver = { resolve: () => Effect.sync(() => { calls++; return true }) }
    const result = yield* evaluate(parseSync('for index in 0..3 { let text = "1234" }; return true'), resolver, { maxTotalNodes: 2, maxTotalStringUnits: 4 })
    expect(result.value).toBe(true)
    const stopped = yield* evaluate(parseSync("echo(true)"), resolver, { bindings: { first: [1,2], second: [3,4] }, maxTotalNodes: 5 }).pipe(Effect.flip)
    expect(stopped._tag === "ValueLimitExceeded" && stopped.measure).toBe("total-nodes")
    expect(calls).toBe(0)
  }))
})
