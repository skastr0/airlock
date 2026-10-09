import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { defineDecoder, defineDecoderCatalog } from "../src/core/contract/Decoder.ts"
import { validateFlowDecoders } from "../src/core/contract/Flow.ts"
import { defineToolContract, InvalidToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"

const label = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: ["mail.body"] })
const ref = { name: "mail.address", version: "1" }
const base = { name: "mail.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String, privateQuery: Schema.String }),
  output: Schema.Struct({ address: Schema.String, body: Schema.String }), public: ["id"] } as const

describe("core: contract flow obligations", () => {
  it("marks every request argument as a disclosure sink, including private content", () => {
    const request = defineToolContract({ ...base, effect: "request", flow: { sinks: ["id"] } })
    expect(request.flow.sinks).toEqual(["id", "privateQuery"])
  })
  it("describes private disclosure fields, origins and exact decoder versions without publishing input", () => {
    const contract = defineToolContract({ ...base, flow: { sources: { body: label }, sinks: ["privateQuery"], requires: { privateQuery: [ref] }, provides: { address: [ref] } } })
    expect(contract.flow.sinks).toEqual(["privateQuery"])
    expect(contract.flow.sources["body"]).toEqual(label)
    expect(contract.flow.provides["address"]).toEqual([ref])
    expect(contract.model.input.kind).toBe("record")
    expect(JSON.stringify(contract.summarize({ id: "m1", privateQuery: "private-canary" }))).not.toContain("private-canary")
  })

  it("owns metadata and keeps undeclared origins unknown", () => {
    const provenance = ["mail.body"], refs = [{ ...ref }]
    const flow = { sources: { body: new InformationLabel({ ...label, provenance }) }, requires: { privateQuery: refs } }
    const contract = defineToolContract({ ...base, flow })
    provenance[0] = "operator"
    refs[0]!.version = "2"
    expect(contract.flow.sources["body"]?.provenance).toEqual(["mail.body"])
    expect(contract.flow.requires["privateQuery"]?.[0]?.version).toBe("1")
    expect(Object.isFrozen(contract.flow.sources["body"]?.provenance)).toBe(true)
    expect(Object.isFrozen(contract.flow.requires["privateQuery"])).toBe(true)
    expect(Object.hasOwn(contract.flow.sources, "address")).toBe(false)
    expect(defineToolContract(base).flow).toEqual({ sources: {}, sinks: [], requires: {}, provides: {} })
  })

  it("rejects absent fields, repeated or malformed references, and excess metadata", () => {
    for (const flow of [
      { sinks: ["missing"] }, { sources: { missing: label } }, { sinks: ["id", "id"] },
      { requires: { id: [ref, ref] } }, { requires: { id: [] } }, { provides: { address: [{ name: "", version: "1" }] } },
      { sources: { body: label }, releaseAll: true }, null
    ]) expect(() => defineToolContract({ ...base, flow: flow as never })).toThrow(InvalidToolContract)
    const absentInput = () => defineToolContract({ ...base, flow: { requires: {
      // @ts-expect-error obligations must name encoded input fields
      missing: [ref]
    } } })
    const absentOutput = () => defineToolContract({ ...base, flow: { sources: {
      // @ts-expect-error origins must name decoded result fields
      missing: label
    } } })
    expect([absentInput, absentOutput].every((declaration) => typeof declaration === "function")).toBe(true)
  })

  it("supports whole-result labels and refuses unregistered or wrong-version proofs", () => {
    const decoder = defineDecoder({ name: "mail.address", version: "1", schema: Schema.String })
    const contract = defineToolContract({ name: "mail.address", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }),
      output: Schema.String, flow: { sources: { $: label }, provides: { $: [ref] } } })
    expect(validateFlowDecoders(contract.flow, defineDecoderCatalog([decoder]))).toBeUndefined()
    expect(validateFlowDecoders(contract.flow, {})).toMatchObject({ field: "flow.provides.$" })
    const other = defineDecoder({ name: decoder.name, version: "2", schema: Schema.String })
    expect(validateFlowDecoders(contract.flow, defineDecoderCatalog([other]))).toMatchObject({ field: "flow.provides.$" })
    const policyWithoutCalls = toolPolicy({ toolGrants: [], budget: { maxCalls: 0, maxInputBytes: 0 } })
    expect(() => defineAirlock({ contracts: [contract], implement: { "mail.address": () => "alice@example.com" }, policy: policyWithoutCalls })).toThrow(InvalidToolContract)
    const airlock = defineAirlock({ contracts: [contract], decoders: [decoder], implement: { "mail.address": () => "alice@example.com" }, policy: policyWithoutCalls })
    expect(airlock.decoders[decoder.name]).toBe(decoder)
    const policy = toolPolicy({ toolGrants: [], budget: { maxCalls: 1, maxInputBytes: 100 }, flow: { "mail.read": { privateQuery: new SinkPolicy({
      id: "mail.query", confidentialityCeiling: "public", minimumIntegrity: "operator"
    }) } } })
    expect(policy.flow["mail.read"]?.["privateQuery"]?.confidentialityCeiling).toBe("public")
  })
})
