import { describe, expect, it } from "vitest"
import { Result, Schema } from "effect"
import { defineToolContract } from "../src/contract/ToolContract.ts"

const prototypeField = "__proto__"
const contract = () => defineToolContract({
  name: "security.paths",
  version: "1",
  effect: "capture",
  input: Schema.Struct({
    [prototypeField]: Schema.String,
    constructor: Schema.String,
    toString: Schema.String
  }),
  output: Schema.Boolean,
  public: [prototypeField, "constructor", "toString"],
  resources: {
    [prototypeField]: { kind: "path", rights: ["read"] },
    constructor: { kind: "path", rights: ["read"] },
    toString: { kind: "path", rights: ["read"] }
  }
})

describe("security: resource field names remain own data", () => {
  it("keeps prototype-shaped names visible to resource enumeration", () => {
    const resources = contract().resources
    expect(Object.keys(resources).sort()).toEqual([prototypeField, "constructor", "toString"].sort())
    for (const name of [prototypeField, "constructor", "toString"] as const) {
      expect(Object.hasOwn(resources, name)).toBe(true)
      expect(resources[name]).toEqual({ kind: "path", rights: ["read"] })
      expect(Object.isFrozen(resources[name].rights)).toBe(true)
    }
  })

  it("keeps the same operands in the public summary that admission matches", () => {
    const input = { [prototypeField]: "/outside", constructor: "/work/a", toString: "/work/b" }
    const summary = Result.getOrThrow(contract().summarize(input))
    expect(Object.keys(summary.public).sort()).toEqual(Object.keys(input).sort())
    for (const name of Object.keys(input)) expect(Object.hasOwn(summary.public, name)).toBe(true)
    expect(JSON.stringify(summary.public)).toBe(JSON.stringify(input))
  })
})
