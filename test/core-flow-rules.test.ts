import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { defineDecoder, defineDecoderCatalog } from "../src/core/contract/Decoder.ts"
import { composeFlowRules, endorsementRule, InvalidFlowRule, releaseRule, validateFlowRules } from "../src/core/contract/FlowRules.ts"

const read = defineToolContract({ name: "mail.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ body: Schema.String, from: Schema.String }) })
const send = defineToolContract({ name: "mail.send", version: "1", effect: "request",
  input: Schema.Struct({ to: Schema.String, body: Schema.String }), output: Schema.Boolean })
const address = defineDecoder({ name: "companyRecipient", version: "1", schema: Schema.String.check(Schema.isEndsWith("@company.test")) })
const registry = { "mail.read": read, "mail.send": send }
const catalog = defineDecoderCatalog([address])
const body = releaseRule(read, send, { id: "forward-company-body", source: { part: "result", field: "body" }, sink: "body",
  mode: "data", from: "private", to: "public", when: [{ field: "to", decoder: address }] })

describe("core: trusted author flow rules", () => {
  it("keeps exact source, sink, flow mode, label direction and same-call conditions visible", () => {
    expect(body).toEqual({ id: "forward-company-body", source: { tool: "mail.read", part: "result", field: "body" },
      sink: { tool: "mail.send", field: "body" }, mode: "data", operation: "release", from: "private", to: "public",
      when: [{ field: "to", decoder: { name: "companyRecipient", version: "1" } }] })
    expect(validateFlowRules([body], registry, catalog)).toBeUndefined()
    const control = releaseRule(read, send, { id: "release-read-branch", source: { part: "receipt", field: "state" },
      sink: "body", mode: "control", from: "private", to: "public" })
    expect(control.source.part).toBe("receipt")
    expect(control.mode).toBe("control")
    expect(validateFlowRules([control], registry, catalog)).toBeUndefined()
  })

  it("owns reused rules and makes composition order independent without silently overriding", () => {
    const given = { ...body, when: [{ field: "to", decoder: { name: address.name, version: address.version } }] }
    const endorse = endorsementRule(read, send, { id: "checked-address-authorship", source: { part: "result", field: "from" },
      sink: "to", mode: "data", from: "untrusted", to: "operator", when: [{ field: "to", decoder: address }] })
    const rules = composeFlowRules([given], [endorse])
    given.when[0]!.decoder.version = "changed"
    expect(rules).toEqual(composeFlowRules([endorse], [body]))
    expect(Object.isFrozen(rules[1]!.when[0]!.decoder)).toBe(true)
    expect(() => composeFlowRules([body], [body])).toThrow(InvalidFlowRule)
    for (const sets of [[[body], [{ ...body, id: "different-target", to: "project" as const }]],
      [[{ ...body, id: "different-target", to: "project" as const }], [body]]] as const) {
      expect(() => composeFlowRules(...sets)).toThrow(InvalidFlowRule)
    }
  })

  it("rejects invalid directions, extra properties and condition duplicates", () => {
    expect(() => composeFlowRules([{ ...body, from: "public" }])).toThrow(InvalidFlowRule)
    expect(() => composeFlowRules([{ ...body, when: [...body.when, ...body.when] }])).toThrow(InvalidFlowRule)
    expect(() => composeFlowRules([{ ...body, wildcard: true } as typeof body])).toThrow(InvalidFlowRule)
    expect(() => endorsementRule(read, send, { id: "wrong", source: { part: "result", field: "body" }, sink: "body",
      mode: "data", from: "runtime", to: "untrusted" })).toThrow(InvalidFlowRule)
  })

  it("rejects reused author records with hidden scope or condition fields", () => {
    const spec = { id: "exact", source: { part: "result" as const, field: "body" as const }, sink: "body" as const,
      mode: "data" as const, from: "private" as const, to: "public" as const }
    for (const given of [{ ...spec, source: { ...spec.source, tool: "vault.read" } },
      { ...spec, sink: { tool: "mail.send", field: "body" } },
      { ...spec, operation: "endorse" },
      { ...spec, when: [{ field: "to", decoder: address, tool: "other.send" }] }]) {
      expect(() => releaseRule(read, send, given as typeof spec)).toThrow(InvalidFlowRule)
    }
    const reused = { ...spec.source, tool: "vault.read" }
    expect(() => endorsementRule(read, send, { ...spec, source: reused, from: "untrusted", to: "operator" })).toThrow(InvalidFlowRule)
  })

  it("refuses unknown result fields, sinks, sibling fields and changed decoder identities at registration", () => {
    expect(validateFlowRules([{ ...body, source: { tool: read.tag, part: "result", field: "missing" } }], registry, catalog)?.field).toContain("source")
    expect(validateFlowRules([{ ...body, sink: { ...body.sink, field: "missing" } }], registry, catalog)?.field).toContain("sink")
    expect(validateFlowRules([{ ...body, when: [{ ...body.when[0]!, field: "otherCall.to" }] }], registry, catalog)?.field).toContain("when")
    expect(validateFlowRules([{ ...body, when: [{ field: "to", decoder: { name: address.name, version: "2" } }] }], registry, catalog)?.reason).toContain("version 2")
    expect(validateFlowRules([body], registry, {})).toBeDefined()
  })

  it("keeps author field selection tied to both contracts", () => {
    if (false) {
      // @ts-expect-error unknown source field
      releaseRule(read, send, { id: "bad", source: { part: "result", field: "missing" }, sink: "body", mode: "data", from: "private", to: "public" })
      // @ts-expect-error unknown sink field
      releaseRule(read, send, { id: "bad", source: { part: "result", field: "body" }, sink: "missing", mode: "data", from: "private", to: "public" })
      // @ts-expect-error condition must name a sibling argument of this sink
      releaseRule(read, send, { id: "bad", source: { part: "result", field: "body" }, sink: "body", mode: "data", from: "private", to: "public", when: [{ field: "from", decoder: address }] })
    }
  })
})
