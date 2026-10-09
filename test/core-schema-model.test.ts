import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { acceptsLiteral, hasSameSchema, modelSchema } from "../src/core/contract/SchemaModel.ts"

describe("core: closed schema model", () => {
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
