import { describe, expect, it } from "vitest"
import { type ExactJson, exactJsonText } from "../src/ExactJson.ts"

/** What the Durable Object store writes must parse back to exactly what it was given. */
describe("cloud: stored JSON text is exact", () => {
  const same = (left: unknown, right: unknown): boolean => {
    if (typeof left === "number" || typeof right === "number") return Object.is(left, right)
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right
    if (Array.isArray(left) !== Array.isArray(right)) return false
    const [a, b] = [Object.keys(left), Object.keys(right)]
    // Key order is part of the value: a digest may be taken over it.
    return a.length === b.length && a.every((key, index) =>
      key === b[index] && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
  }
  const values: ReadonlyArray<ExactJson> = [
    -0, 0, [-0], { scalar: -0, list: [-0, 0, -1] },
    9007199254740991, -9007199254740991, 9007199254740993, 1e21, 5e-324, 1.7976931348623157e308, 0.1 + 0.2,
    "", "😀", "\ud800", "a\u0000b", "  ", "line\nbreak \"quoted\" \\",
    { z: 1, a: 2, "10": 3, "2": 4 }, JSON.parse('{"__proto__":{"polluted":true},"constructor":"c"}') as ExactJson,
    [], {}, [[], {}, null, true, false], { nested: { deeper: [{ leaf: -0 }] } }
  ]

  it.each(values.map((value) => [value] as const))("round-trips %j exactly", (value) => {
    const back = JSON.parse(exactJsonText(value)) as unknown
    expect(same(back, value)).toBe(true)
  })

  it("writes negative zero as -0, where JSON.stringify would write 0", () => {
    expect(exactJsonText({ a: -0, b: [0, -0] })).toBe('{"a":-0,"b":[0,-0]}')
    expect(JSON.stringify({ a: -0 })).toBe('{"a":0}')
  })

  it("writes every other value as JSON.stringify does", () => {
    for (const value of values) {
      if (JSON.stringify(value).includes("0") && exactJsonText(value).includes("-0")) continue
      expect(exactJsonText(value)).toBe(JSON.stringify(value))
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
