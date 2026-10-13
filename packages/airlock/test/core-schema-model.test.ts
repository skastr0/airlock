import { describe, expect, it } from "vitest"
import { DateTime, Result, Schema } from "effect"
import { acceptsLiteral, decodeModelValue, encodeModelValue, hasSameCodec, hasSameSchema, modelSchema } from "../src/contract/SchemaModel.ts"

describe("core: closed schema model", () => {
  it("preserves original codec identity and validates opaque values without exposing schema errors or accepting copies", () => {
    const output = modelSchema(Schema.DateTimeUtcFromString, { identity: "date.result", side: "decoded" })
    const input = modelSchema(Schema.DateTimeUtcFromString, { identity: "date.input", side: "encoded" })
    expect(hasSameCodec(output, input)).toBe(true)
    expect(hasSameSchema(output, input)).toBe(false)
    expect(hasSameCodec({ ...output }, input)).toBe(false)
    const wire = "2026-10-09T00:00:00.000Z"
    const decoded = Result.getOrThrow(decodeModelValue(output, wire))
    expect(DateTime.formatIso(decoded as DateTime.Utc)).toBe(wire)
    expect(Result.getOrThrow(encodeModelValue(input, decoded))).toBe(wire)
    expect(decodeModelValue({ ...output }, wire)).toMatchObject({ _tag: "Failure", failure: { reason: "unissued-model" } })
    for (const invalid of [decodeModelValue(output, "private-invalid-canary"), encodeModelValue(input, wire)]) {
      expect(invalid).toMatchObject({ _tag: "Failure", failure: { reason: "schema" } })
      expect(JSON.stringify(invalid)).not.toContain("private-invalid-canary")
    }
    const checked = modelSchema(Schema.DateTimeUtcFromString.check(Schema.makeFilter(() => true)), { identity: "checked", side: "encoded" })
    expect(hasSameCodec(output, checked)).toBe(false)
  })

  it("owns encoded opaque graphs and preserves negative zero and prototype-name fields", () => {
    const schema = Schema.Struct(Object.fromEntries([["__proto__", Schema.Number]]))
    const model = modelSchema(schema, { identity: "owned", side: "encoded" })
    const value = Object.fromEntries([["__proto__", -0]])
    const encoded = Result.getOrThrow(encodeModelValue(model, value)) as Schema.JsonObject
    value["__proto__"] = 1
    expect(Object.hasOwn(encoded, "__proto__")).toBe(true)
    expect(Object.is(encoded["__proto__"], -0)).toBe(true)
    expect(Object.isFrozen(encoded)).toBe(true)
  })
  it("models null and nullable unions without erasing optional-key absence", () => {
    for (const side of ["encoded", "decoded"] as const) {
      const literal = modelSchema(Schema.Null, { identity: "null", side })
      expect(literal).toEqual({ kind: "literal", value: null })
      expect(acceptsLiteral(literal, null)).toBe(true)
      expect(acceptsLiteral(literal, "null")).toBe(false)
      const model = modelSchema(Schema.Struct({ value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])) }), { identity: "nullable", side })
      expect(model).toMatchObject({ kind: "record", fields: { value: { optional: true,
        type: { kind: "union", members: [{ kind: "string" }, { kind: "literal", value: null }] } } } })
      const values: Schema.Json[] = [{}, { value: null }, { value: "text" }]
      for (const value of values) expect(acceptsLiteral(model, value)).toBe(true)
      expect(acceptsLiteral(model, { value: false })).toBe(false)
    }
  })
  it("recognizes the same trusted schema at different model paths without equating lookalike checks or wire transforms", () => {
    const checked = Schema.String.check(Schema.isEndsWith("@example.test"))
    const output = modelSchema(checked, { identity: "result.from", side: "decoded" })
    const input = modelSchema(checked, { identity: "input.to", side: "encoded" })
    expect(hasSameSchema(output, input)).toBe(true)
    expect(hasSameSchema({ ...output }, input)).toBe(false)
    const lookalike = modelSchema(Schema.String.check(Schema.isEndsWith("@example.test")), { identity: "input.to", side: "encoded" })
    expect(hasSameSchema(output, lookalike)).toBe(false)
    const transform = Schema.NumberFromString.check(Schema.isGreaterThan(0))
    expect(hasSameSchema(modelSchema(transform, { identity: "result.number", side: "decoded" }),
      modelSchema(transform, { identity: "input.text", side: "encoded" }))).toBe(false)
  })
  it("describes records, optional keys, tagged unions and bounded lists", () => {
    const schema = Schema.Struct({
      name: Schema.String, optional: Schema.optionalKey(Schema.Boolean),
      choice: Schema.Union([Schema.Struct({ tag: Schema.Literal("a"), a: Schema.Number }), Schema.Struct({ tag: Schema.Literal("b"), b: Schema.String })]),
      items: Schema.Array(Schema.String).check(Schema.isMaxLength(3))
    })
    const model = modelSchema(schema, { identity: "tool.output", side: "decoded" })
    expect(model.kind).toBe("record")
    if (model.kind !== "record") return
    expect(model.fields["name"]).toEqual({ type: { kind: "string" }, optional: false })
    expect(model.fields["optional"]).toEqual({ type: { kind: "boolean" }, optional: true })
    expect(model.fields["choice"]?.type.kind).toBe("union")
    const items = model.fields["items"]!.type
    expect(items.kind).toBe("nominal")
    if (items.kind !== "nominal") return
    expect(items.base).toEqual({ kind: "list", item: { kind: "string" }, maxLength: 3 })
    expect(acceptsLiteral(items, ["a", "b", "c"])).toBe(true)
    expect(acceptsLiteral(items, ["a", "b", "c", "d"])).toBe(false)
  })

  it("never erases transformed or checked input constraints, including nested fields", () => {
    const schema = Schema.Struct({ amount: Schema.NumberFromString.check(Schema.isGreaterThan(0)) })
    const input = modelSchema(schema, { identity: "tool.input", side: "encoded" })
    const output = modelSchema(schema, { identity: "tool.output", side: "decoded" })
    if (input.kind !== "record" || output.kind !== "record") throw new Error("must model the record")
    expect(input.fields["amount"]?.type).toEqual({ kind: "nominal", identity: "tool.input/amount", base: { kind: "string" } })
    expect(output.fields["amount"]?.type).toEqual({ kind: "nominal", identity: "tool.output/amount", base: { kind: "number" } })
    expect(acceptsLiteral(input.fields["amount"]!.type, "1")).toBe(true)
    expect(acceptsLiteral(input.fields["amount"]!.type, "not-a-number")).toBe(false)
    expect(acceptsLiteral(input.fields["amount"]!.type, "-1")).toBe(false)
    expect(acceptsLiteral(output.fields["amount"]!.type, 1)).toBe(true)
    expect(acceptsLiteral(output.fields["amount"]!.type, "1")).toBe(false)
    expect(acceptsLiteral(input, { amount: "1", extra: true })).toBe(false)
  })

  it("keeps unsupported, recursive, permissive empty structs and open records opaque", () => {
    for (const schema of [Schema.Json, Schema.Unknown, Schema.Struct({}), Schema.Record(Schema.String, Schema.String), Schema.Tuple([Schema.String, Schema.Number])]) {
      expect(modelSchema(schema, { identity: "opaque", side: "decoded" })).toEqual({ kind: "nominal", identity: "opaque" })
    }
    interface Node { readonly child: Node }
    const recursive = Schema.suspend((): Schema.Codec<Node> => Schema.Struct({ child: recursive }))
    expect(modelSchema(recursive, { identity: "recursive", side: "decoded" })).toEqual({ kind: "nominal", identity: "recursive" })
  })

  it("keeps model identity and validators private, without prototype-name omissions", () => {
    const schema = Schema.Struct(Object.fromEntries([["__proto__", Schema.String]]))
    const model = modelSchema(schema, { identity: "proto", side: "decoded" })
    if (model.kind !== "record") throw new Error("must model the record")
    expect(Object.hasOwn(model.fields, "__proto__")).toBe(true)
    expect(Object.isFrozen(model.fields)).toBe(true)
    expect(acceptsLiteral({ ...model }, JSON.parse('{"__proto__":"value"}'))).toBe(false)
    expect(acceptsLiteral(model, JSON.parse('{"__proto__":"value"}'))).toBe(true)
  })
})
