import { describe, expect, it } from "vitest"
import { Result, Schema, SchemaGetter } from "effect"
import { decodeValue, defineDecoder, defineDecoderCatalog, deriveValue, hasRefinement, InvalidDecoder, labeledValue, projectValue } from "../src/core/contract/Decoder.ts"
import { InformationLabel } from "../src/core/labels/Labels.ts"

const secret = new InformationLabel({ confidentiality: "secret", integrity: "untrusted", provenance: ["mail.body"] })
const Address = defineDecoder({ name: "mail.address", version: "1", schema: Schema.String.check(Schema.isPattern(/^[a-z]+@example\.com$/)) })
const success = <Value>(result: Result.Result<Value, unknown>): Value => Result.getOrThrow(result)

describe("core: trusted decoder refinements", () => {
  it("issues an exact-value proof only after successful decoding, preserving the label", () => {
    const source = labeledValue("alice@example.com", secret)
    const decoded = success(decodeValue(Address, source))
    expect(decoded.value).toBe("alice@example.com")
    expect(decoded.label).toEqual(secret)
    expect(hasRefinement(source, Address)).toBe(false)
    expect(hasRefinement(decoded, Address)).toBe(true)
    const denied = decodeValue(Address, labeledValue("private-canary-rejected", secret))
    expect(Result.isFailure(denied)).toBe(true)
    expect(JSON.stringify(denied)).not.toContain("private-canary-rejected")
  })

  it("proves the decoded output of a transform and drops its earlier proof", () => {
    const numeric = defineDecoder({ name: "number.positive", version: "1", schema: Schema.NumberFromString.check(Schema.isGreaterThan(0)) })
    const text = defineDecoder({ name: "number.text", version: "1", schema: Schema.String })
    const source = success(decodeValue(text, labeledValue("12", secret)))
    const decoded = success(decodeValue(numeric, source))
    expect(decoded.value).toBe(12)
    expect(hasRefinement(decoded, numeric)).toBe(true)
    expect(hasRefinement(source, numeric)).toBe(false)
    expect(hasRefinement(decoded, text)).toBe(false)
  })

  it("snapshots a transform's shared output before issuing proof", () => {
    const shared = { addresses: ["alice@example.com"] }
    const schema = Schema.String.pipe(Schema.decodeTo(Schema.Struct({ addresses: Schema.Array(Schema.String) }), {
      decode: SchemaGetter.transform(() => shared),
      encode: SchemaGetter.transform(() => "encoded")
    }))
    const decoder = defineDecoder({ name: "shared.envelope", version: "1", schema })
    const decoded = success(decodeValue(decoder, labeledValue("source", secret)))
    shared.addresses[0] = "changed@outside.test"
    expect(decoded.value).toEqual({ addresses: ["alice@example.com"] })
    expect(hasRefinement(decoded, decoder)).toBe(true)
    expect(Object.isFrozen(decoded.value.addresses)).toBe(true)
  })

  it("owns immutable values and labels, refusing structural proof copies", () => {
    const record = defineDecoder({ name: "mail.envelope", version: "1", schema: Schema.Struct({ addresses: Schema.Array(Schema.String) }) })
    const input = { addresses: ["alice@example.com"] }
    const provenance = ["mail.body"]
    const label = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance })
    const source = labeledValue(input, label)
    const decoded = success(decodeValue(record, source))
    input.addresses[0] = "changed@outside.test"
    provenance[0] = "operator"
    expect(decoded.value).toEqual({ addresses: ["alice@example.com"] })
    expect(decoded.label.provenance).toEqual(["mail.body"])
    expect(Object.isFrozen(decoded.value.addresses)).toBe(true)
    expect(Object.isFrozen(decoded.label.provenance)).toBe(true)
    for (const copy of [{ ...decoded }, JSON.parse(JSON.stringify(decoded))]) {
      expect(hasRefinement(copy, record)).toBe(false)
      expect(Result.isFailure(decodeValue(record, copy))).toBe(true)
    }
  })

  it("projection and computation preserve labels, discard proofs and never endorse", () => {
    const record = defineDecoder({ name: "mail.envelope", version: "1", schema: Schema.Struct({ recipient: Schema.String }) })
    const decoded = success(decodeValue(record, labeledValue({ recipient: "alice@example.com" }, secret)))
    const projected = projectValue(decoded, "recipient")
    const rebuilt = deriveValue({ recipient: projected.value }, projected)
    expect(projected.label).toEqual(secret)
    expect(rebuilt.label).toEqual(secret)
    expect(hasRefinement(projected, record)).toBe(false)
    expect(hasRefinement(rebuilt, record)).toBe(false)
    expect(hasRefinement(success(decodeValue(Address, projected)), Address)).toBe(true)
    const publicValue = labeledValue("literal", new InformationLabel({ confidentiality: "public", integrity: "operator", provenance: ["source"] }))
    expect(deriveValue("joined", decoded, publicValue).label).toEqual(new InformationLabel({
      confidentiality: "secret", integrity: "untrusted", provenance: ["mail.body", "source"]
    }))
  })

  it("owns catalog identities and rejects duplicate, forged and same-name definitions", () => {
    const spec = { name: "schema.record", version: "1", schema: Schema.String }
    const decoder = defineDecoder(spec)
    spec.version = "2"
    spec.schema = Schema.String.check(Schema.isMinLength(100))
    expect(decoder.version).toBe("1")
    expect(Result.isSuccess(decodeValue(decoder, labeledValue("short", secret)))).toBe(true)
    const catalog = defineDecoderCatalog([Address, decoder])
    expect(catalog["mail.address"]).toBe(Address)
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(() => defineDecoderCatalog([Address, Address])).toThrow(InvalidDecoder)
    const second = defineDecoder({ name: Address.name, version: Address.version, schema: Schema.String })
    expect(hasRefinement(success(decodeValue(Address, labeledValue("alice@example.com", secret))), second)).toBe(false)
    expect(Result.isFailure(decodeValue({ ...Address }, labeledValue("alice@example.com", secret)))).toBe(true)
    const protoName = defineDecoder({ name: "__proto__", version: "1", schema: Schema.String })
    expect(Object.hasOwn(defineDecoderCatalog([protoName]), "__proto__")).toBe(true)
  })
})
