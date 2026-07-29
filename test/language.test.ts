import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { format, parse, parseSync, restoreOrchestration, tokenize } from "../src/language/index.ts"

describe("Airlock language", () => {
  it("parses the full structured expression and control-flow surface", () => {
    const program = parseSync(`
let request = { target: jobs[0].path, delay: 30s, flags: [true, false] }
assert request.delay >= 1s, "delay is required"
if ready && !paused {
  run(request)
} else {
  return null
}
for member in 0..3 {
  inspect(member)
}
`)
    expect(program.body.map((statement) => statement.kind)).toEqual([
      "LetStatement", "AssertStatement", "IfStatement", "ForStatement"
    ])
    const letStatement = program.body[0]!
    expect(letStatement.kind).toBe("LetStatement")
    if (letStatement.kind === "LetStatement") expect(letStatement.value.kind).toBe("RecordExpression")
  })

  it("returns a typed parser failure with precise source location", () => {
    const error = Effect.runSync(parse("let = 1").pipe(Effect.flip))
    expect(error._tag).toBe("LanguageDiagnostic")
    expect(error.span).toMatchObject({ line: 1, column: 5 })
    expect(error.detail).toContain("expected identifier")
  })

  it("rejects shell interpolation and unbounded loops before lowering", () => {
    const interpolation = Effect.runSync(parse("run($HOME)").pipe(Effect.flip))
    expect(interpolation.detail).toContain("shell interpolation")
    const loop = Effect.runSync(parse("for item in members { run(item) }").pipe(Effect.flip))
    expect(loop.detail).toContain("bounded integer literal range")
  })

  it("prints canonical, parseable source", () => {
    const first = parseSync("let x={b:2,a:[1,2]}\nif x.b>1 { run(x) } else { return }")
    const printed = format(first)
    expect(printed).toBe("let x = { b: 2, a: [1, 2] }\nif x.b > 1 {\n  run(x)\n} else {\n  return\n}\n")
    expect(format(parseSync(printed))).toBe(printed)
  })

  it("accepts an else branch on the following line and preserves quoted keys", () => {
    const printed = format(parseSync('if ok { run({ "not-a-name": 1 }) }\nelse { return }'))
    expect(printed).toContain('"not-a-name": 1')
    expect(parseSync(printed).body[0]!.kind).toBe("IfStatement")
  })

  it("keeps a lowering-neutral restore orchestration corpus parseable", () => {
    const program = parseSync(restoreOrchestration)
    expect(program.body.map((statement) => statement.kind)).toEqual([
      "LetStatement", "AssertStatement", "LetStatement", "ForStatement", "IfStatement"
    ])
  })

  it("preserves duration tokens rather than treating suffixes as identifiers", () => {
    const durations = tokenize("let wait = 15ms\nlet long = 2h")
      .filter((token) => token.kind === "duration")
      .map((token) => token.text)
    expect(durations).toEqual(["15ms", "2h"])
  })
})
