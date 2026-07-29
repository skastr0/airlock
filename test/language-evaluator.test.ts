import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { parseSync } from "../src/language/parser.ts"
import {
  AssertionFailed,
  InvalidCallTarget,
  InvalidLanguageOperation,
  LoopLimitExceeded,
  UnboundIdentifier,
  evaluate,
  type ActionResolver,
  type LanguageValue
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

  it.effect("evaluates a finite-list source once and visits a deep-frozen snapshot", () =>
    Effect.gen(function* () {
      const source: Array<{ name: string }> = [
        { name: "alpha" },
        { name: "beta" }
      ]
      let sourceCalls = 0
      const visited: string[] = []
      const snapshotResolver: ActionResolver = {
        resolve: (action, args) =>
          Effect.sync(() => {
            if (action === "members") {
              sourceCalls += 1
              return source
            }
            if (action === "visit") {
              const member = args[0] as Readonly<{ name: string }>
              expect(Object.isFrozen(member)).toBe(true)
              visited.push(member.name)
              if (visited.length === 1) source[1]!.name = "mutated-after-snapshot"
              return null
            }
            throw new Error(`unexpected action ${action}`)
          })
      }

      const result = yield* evaluate(
        parseSync(`
for member in members() {
  visit(member)
}
return "complete"
`),
        snapshotResolver
      )

      expect(result.value).toBe("complete")
      expect(sourceCalls).toBe(1)
      expect(visited).toEqual(["alpha", "beta"])
      expect(source[1]!.name).toBe("mutated-after-snapshot")
    })
  )

  it.effect("rejects non-list and over-budget list sources before resolving the body", () =>
    Effect.gen(function* () {
      let sourceCalls = 0
      let bodyCalls = 0
      const guarded: ActionResolver = {
        resolve: (action) =>
          Effect.sync(() => {
            if (action === "members") {
              sourceCalls += 1
              return [1, 2, 3]
            }
            bodyCalls += 1
            return null
          })
      }

      const nonList = yield* evaluate(
        parseSync("for item in 42 { visit(item) }"),
        guarded
      ).pipe(Effect.flip)
      expect(nonList).toBeInstanceOf(InvalidLanguageOperation)
      expect(nonList).toMatchObject({
        operation: "for",
        detail: "source must evaluate to a finite list"
      })
      expect(bodyCalls).toBe(0)

      const overBudget = yield* evaluate(
        parseSync("for item in members() { visit(item) }"),
        guarded,
        { maxLoopIterations: 2 }
      ).pipe(Effect.flip)
      expect(overBudget).toBeInstanceOf(LoopLimitExceeded)
      expect(sourceCalls).toBe(1)
      expect(bodyCalls).toBe(0)
    })
  )

  it.effect("shares one iteration budget across nested list and range loops", () =>
    Effect.gen(function* () {
      const visited: LanguageValue[] = []
      const tracking: ActionResolver = {
        resolve: (action, args) =>
          Effect.sync(() => {
            if (action !== "visit") throw new Error(`unexpected action ${action}`)
            visited.push(args[0] ?? null)
            return null
          })
      }
      const program = parseSync(`
for group in groups {
  for index in lower..upper {
    visit(group[index])
  }
}
return "complete"
`)
      const bindings = {
        groups: [[1, 2], [3, 4]],
        lower: 0,
        upper: 2
      } satisfies Readonly<Record<string, LanguageValue>>

      const limited = yield* evaluate(program, tracking, {
        bindings,
        maxLoopIterations: 5
      }).pipe(Effect.flip)
      expect(limited).toBeInstanceOf(LoopLimitExceeded)
      expect(visited).toEqual([1, 2])

      visited.length = 0
      const complete = yield* evaluate(program, tracking, {
        bindings,
        maxLoopIterations: 6
      })
      expect(complete.value).toBe("complete")
      expect(visited).toEqual([1, 2, 3, 4])
    })
  )

  it.effect("stops list iteration immediately when the body returns", () =>
    Effect.gen(function* () {
      const visited: number[] = []
      const tracking: ActionResolver = {
        resolve: (action, args) =>
          Effect.sync(() => {
            if (action !== "visit") throw new Error(`unexpected action ${action}`)
            visited.push(args[0] as number)
            return null
          })
      }
      const result = yield* evaluate(
        parseSync(`
for item in [1, 2, 3] {
  visit(item)
  if item == 2 { return item }
}
return 0
`),
        tracking,
        { maxLoopIterations: 3 }
      )

      expect(result).toMatchObject({ returned: true, value: 2 })
      expect(visited).toEqual([1, 2])
    })
  )

  it.effect("evaluates dynamic range endpoints once and requires safe integers", () =>
    Effect.gen(function* () {
      let lowerCalls = 0
      let upperCalls = 0
      const visited: number[] = []
      const dynamic: ActionResolver = {
        resolve: (action, args) =>
          Effect.sync(() => {
            if (action === "lower") {
              lowerCalls += 1
              return 2
            }
            if (action === "upper") {
              upperCalls += 1
              return 5
            }
            if (action === "visit") {
              visited.push(args[0] as number)
              return null
            }
            throw new Error(`unexpected action ${action}`)
          })
      }

      yield* evaluate(
        parseSync("for index in lower()..upper() { visit(index) }"),
        dynamic,
        { maxLoopIterations: 3 }
      )
      expect(lowerCalls).toBe(1)
      expect(upperCalls).toBe(1)
      expect(visited).toEqual([2, 3, 4])

      const unsafe = yield* evaluate(
        parseSync("for index in 0..9007199254740992 { visit(index) }"),
        dynamic
      ).pipe(Effect.flip)
      expect(unsafe).toBeInstanceOf(InvalidLanguageOperation)
      expect(unsafe).toMatchObject({
        operation: "for",
        detail: "bounds must evaluate to safe integers"
      })
    })
  )
})
