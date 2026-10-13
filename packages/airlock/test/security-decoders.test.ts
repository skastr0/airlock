import { describe, expect, it } from "vitest"
import { Result, Schema } from "effect"
import { decodeValue, defineDecoder, hasRefinement, labeledValue } from "../src/contract/Decoder.ts"
import { InformationLabel } from "../src/labels/Labels.ts"

const label = new InformationLabel({ confidentiality: "secret", integrity: "untrusted", provenance: ["decoder-boundary"] })
const negativeZero = Schema.NumberFromString.check(Schema.makeFilter((value) => Object.is(value, -0)))

describe("security: decoder ownership preserves refined values", () => {
  it("preserves negative zero when owning a nested JSON graph", () => {
    const tracked = labeledValue({ scalar: -0, list: [-0] }, label)
    expect(Object.is(tracked.value.scalar, -0)).toBe(true)
    expect(Object.is(tracked.value.list[0], -0)).toBe(true)
    expect(Object.isFrozen(tracked.value.list)).toBe(true)
  })

  it("issues a proof only for a scalar that still satisfies its decoded refinement", () => {
    const decoder = defineDecoder({ name: "number.negative-zero", version: "1", schema: negativeZero })
    const decoded = Result.getOrThrow(decodeValue(decoder, labeledValue("-0", label)))
    expect(hasRefinement(decoded, decoder)).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(Schema.toType(negativeZero))(decoded.value))).toBe(true)
    expect(Object.is(decoded.value, -0)).toBe(true)
    expect(decoded.label).toEqual(label)
  })

  it("preserves refinements through ownership at nested record and list positions", () => {
    const schema = Schema.Struct({ scalar: negativeZero, list: Schema.Array(negativeZero) })
    const decoder = defineDecoder({ name: "record.negative-zero", version: "1", schema })
    const decoded = Result.getOrThrow(decodeValue(decoder, labeledValue({ scalar: "-0", list: ["-0"] }, label)))
    expect(hasRefinement(decoded, decoder)).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(Schema.toType(schema))(decoded.value))).toBe(true)
    expect(Object.is(decoded.value.scalar, -0)).toBe(true)
    expect(Object.is(decoded.value.list[0], -0)).toBe(true)
  })
})
