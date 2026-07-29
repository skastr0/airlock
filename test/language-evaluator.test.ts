import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { parseSync } from "../src/language/parser.ts"
import {
  AssertionFailed,
  InvalidCallTarget,
  LoopLimitExceeded,
  UnboundIdentifier,
  evaluate,
  type ActionResolver
} from "../src/language/evaluator.ts"

const resolver: ActionResolver = {
  resolve: (action, args) => Effect.sync(() => {
    if (action === "echo") return args[0] ?? null
    if (action === "make_record") return { value: args[0] ?? null, enabled: true }
    throw new Error(`unexpected action ${action}`)
  })
}

describe("Airlock language evaluator", () => {
  it.effect("evaluates pure values, lexical lets, branches, bounded loops, and resolver calls", () =>
    Effect.gen(function* () {
      const program = parseSync(`
let total = 0
for index in 0..3 { let total = index + 1 }
let result = make_record(echo("ready"))
if result.enabled && result.value == "ready" { return { count: 3, delay: 2s } }
return null
`)
      const result = yield* evaluate(program, resolver)
      expect(result).toMatchObject({ returned: true, value: { count: 3, delay: { kind: "Duration", value: 2, unit: "s" } } })
    })
  )

  it.effect("short-circuits boolean expressions and keeps every action behind the resolver", () =>
    Effect.gen(function* () {
      let calls = 0
      const guarded: ActionResolver = { resolve: () => Effect.sync(() => { calls++; return true }) }
      const result = yield* evaluate(parseSync("return false && side_effect()"), guarded)
      expect(result.value).toBe(false)
      expect(calls).toBe(0)
    })
  )

  it.effect("returns typed failures for language violations", () =>
    Effect.gen(function* () {
      const missing = yield* evaluate(parseSync("return absent"), resolver).pipe(Effect.flip)
      expect(missing).toBeInstanceOf(UnboundIdentifier)

      const target = yield* evaluate(parseSync("return ({ run: echo }).run(1)"), resolver).pipe(Effect.flip)
      expect(target).toBeInstanceOf(InvalidCallTarget)

      const asserted = yield* evaluate(parseSync('assert false, "nope"'), resolver).pipe(Effect.flip)
      expect(asserted).toBeInstanceOf(AssertionFailed)
      expect(asserted.message).toBe("nope")
    })
  )

  it.effect("enforces the runtime loop budget even for syntactically bounded programs", () =>
    Effect.gen(function* () {
      const error = yield* evaluate(parseSync("for index in 0..5 { echo(index) }"), resolver, { maxLoopIterations: 4 }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LoopLimitExceeded)
    })
  )
})
