import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { DuplicateBinding } from "../src/core/language/bindings.ts"
import { evaluate, type ActionResolver } from "../src/core/language/evaluator.ts"
import { parseSync } from "../src/core/language/parser.ts"

describe("immutable language bindings", () => {
  for (const source of [
    "let count = 1; let count = touch()",
    "let count = 1; if false { let count = 2 }",
    "let count = 1; for count in 0..2 { touch() }",
    "for count in [1] { let count = 2 }",
    "for count in [1] { for count in [2] { touch() } }",
    "return 1; let count = 1; let count = 2"
  ]) {
    it.effect(`rejects before any effect: ${source}`, () => Effect.gen(function* () {
      let calls = 0
      const resolver: ActionResolver = { resolve: () => Effect.sync(() => { calls++; return null }) }
      const error = yield* evaluate(parseSync(`touch(); ${source}`), resolver).pipe(Effect.flip)
      expect(error).toBeInstanceOf(DuplicateBinding)
      expect(error).toMatchObject({ name: "count", span: { line: 1 } })
      expect(error._tag === "DuplicateBinding" && error.previous).toBeDefined()
      expect(calls).toBe(0)
    }))
  }

  it.effect("protects injected names before resolving an initializer", () => Effect.gen(function* () {
    let calls = 0
    const resolver: ActionResolver = { resolve: () => Effect.sync(() => { calls++; return null }) }
    const error = yield* evaluate(parseSync("let count = touch()"), resolver, { bindings: { count: 3 } }).pipe(Effect.flip)
    expect(error).toBeInstanceOf(DuplicateBinding)
    expect(calls).toBe(0)
  }))

  it.effect("allows independent sibling scopes and fresh bindings on each iteration", () => Effect.gen(function* () {
    const visited: number[] = []
    const resolver: ActionResolver = { resolve: (_, args) => Effect.sync(() => { visited.push(args[0] as number); return null }) }
    const result = yield* evaluate(parseSync(`
if true { let value = 1; touch(value) } else { let value = 2; touch(value) }
for value in [3, 4] { let next = value + 1; touch(next) }
for value in [5] { touch(value) }
return true
`), resolver)
    expect(result.value).toBe(true)
    expect(visited).toEqual([1, 4, 5, 5])
  }))
})
