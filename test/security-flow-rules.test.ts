import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { sha256Canonical } from "../src/core/Canonical.ts"
import { ToolGrantPolicy } from "../src/core/admission/ToolGrant.ts"
import { decodeValue, defineDecoder, defineDecoderCatalog, deriveValue, labeledValue } from "../src/core/contract/Decoder.ts"
import { InvalidFlowRule, releaseRule, type FlowRule } from "../src/core/contract/FlowRules.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { lowerReviewPrototype, prototypeInstances } from "./support/air-plan-review.ts"
import { reviewPrototype } from "./support/air-review.ts"
import { CompanyRecipient, environment, Read, Send } from "./support/air-review-fixtures.ts"

const ApprovedSubject = defineDecoder({ name: "approvedSubject", version: "1", schema: Schema.Literal("Forward") })
const env = { ...environment, decoders: defineDecoderCatalog([CompanyRecipient, ApprovedSubject]) }
const publicLabel = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const privateLabel = (origins: readonly string[]) => new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [...origins] })
const bodyRule = releaseRule(Read, Send, { id: "only-body", source: { part: "result", field: "body" }, sink: "body",
  mode: "data", from: "private", to: "public",
  when: [{ field: "to", decoder: CompanyRecipient }, { field: "subject", decoder: ApprovedSubject }] })
const source = (body: string, branch = "true") => `let reading = mail.read({id:"m1"})
if reading.state == "done" {
  let to = decode(schema.companyRecipient,"sink@example.com")
  let subject = decode(schema.approvedSubject,"Forward")
  if to.state == "ok" && subject.state == "ok" {
    if ${branch} { mail.send({to:to.value,subject:subject.value,body:${body}}) }
  }
}
return true`
const prepare = async (text = source("reading.result.body"), rules: readonly FlowRule[] = [bodyRule]) => {
  const review = await run(reviewPrototype(text, env))
  const read = review.calls.find((call) => call.tool === "mail.read")!
  const prefix = `mail.read@${read.span.start}`
  const policy = {
    grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
    sources: { [`${prefix}.state`]: publicLabel, [`${prefix}.result.body`]: privateLabel(["mailbox"]),
      [`${prefix}.result.subject`]: privateLabel(["mailbox"]) },
    sinks: { "mail.read": { id: new SinkPolicy({ id: "read.id", confidentialityCeiling: "public", minimumIntegrity: "untrusted" }) },
      "mail.send": Object.fromEntries(["to", "subject", "body"].map((field) => [field,
        new SinkPolicy({ id: `send.${field}`, confidentialityCeiling: "public", minimumIntegrity: "untrusted" })])) },
    registryDigest: await run(sha256Canonical("conditional-flow-security-v1")), bindings: {}, maxPlanBytes: 65_536, rules
  }
  return { review, policy, prefix, report: await run(lowerReviewPrototype(text, review, policy)) }
}
const proof = (decoder: typeof CompanyRecipient | typeof ApprovedSubject, value: string) => Result.getOrThrow(decodeValue(decoder, labeledValue(value, publicLabel)))

describe("security: trusted flow rules grant only their written scope", () => {
  it("cannot override the source contract by reusing a record with an extra tool property", () => {
    const Vault = defineToolContract({ name: "vault.read", version: "1", effect: "capture",
      input: Schema.Struct({}), output: Schema.Struct({ body: Schema.String }) })
    // TypeScript permits extra fields on a previously bound record. The typed
    // constructor must still bind its positional source contract exactly.
    const reused = { part: "result" as const, field: "body" as const, tool: Vault.tag }
    expect(() => releaseRule(Read, Send, { id: "mail-only", source: reused, sink: "body", mode: "data", from: "private", to: "public" }))
      .toThrow(InvalidFlowRule)
  })

  it("does not release another private source combined into the same argument", async () => {
    const { report } = await prepare(source("reading.result.body + reading.result.subject"))
    const send = report.plan.nodes.find((node) => node.tool === "mail.send")!
    expect(report.refusals).toContainEqual({ nodeId: send.id, field: "body", reason: "confidentiality" })
    const flows = send.arguments.find((arg) => arg.field === "body")!.flows
    expect(flows.find((flow) => flow.origin.endsWith("result.body"))!.effective!.confidentiality).toBe("public")
    expect(flows.find((flow) => flow.origin.endsWith("result.subject"))!.effective!.confidentiality).toBe("private")
  })

  it("does not let a data rule release private branch selection", async () => {
    const { report } = await prepare(source('"fixed"', 'reading.result.body == "yes"'))
    const send = report.plan.nodes.find((node) => node.tool === "mail.send")!
    expect(report.refusals).toContainEqual({ nodeId: send.id, field: "body", reason: "confidentiality" })
    expect(send.arguments.find((arg) => arg.field === "body")!.flows.find((flow) => flow.origin.endsWith("result.body")))
      .toMatchObject({ mode: "control", rules: [], effective: { confidentiality: "private" } })
  })

  it("requires every conditional sibling proof on the exact owned value at runtime", async () => {
    const { review, policy, report, prefix } = await prepare()
    expect(report.refusals, JSON.stringify(report.explanations)).toEqual([])
    const send = report.plan.nodes.find((node) => node.tool === "mail.send")!
    const instance = { planId: report.plan.id, nodeId: send.id, occurrence: 1, tool: send.tool }
    const input = { to: proof(CompanyRecipient, "sink@example.com"), subject: proof(ApprovedSubject, "Forward"),
      body: labeledValue("private body", privateLabel(["mailbox", `${prefix}.result.body`])) }
    const control = labeledValue(false, publicLabel)
    expect(await run(prototypeInstances(report, review, policy)(instance, input, control))).toMatchObject({ approval: "exact-batch", when: "staged" })
    const Twin = defineDecoder({ name: ApprovedSubject.name, version: ApprovedSubject.version, schema: Schema.Literal("Forward") })
    for (const subject of [labeledValue("Forward", publicLabel), deriveValue(input.subject.value, input.subject), proof(Twin, "Forward")]) {
      const result = await run(prototypeInstances(report, review, policy)(instance, { ...input, subject }, control).pipe(Effect.result))
      expect(Result.isFailure(result) && result.failure.reason).toBe("label")
    }
  })

  it("refuses an extra origin at runtime even when it shares the mailbox label", async () => {
    const { review, policy, report, prefix } = await prepare()
    const send = report.plan.nodes.find((node) => node.tool === "mail.send")!
    const input = { to: proof(CompanyRecipient, "sink@example.com"), subject: proof(ApprovedSubject, "Forward"),
      body: labeledValue("mixed", privateLabel(["mailbox", `${prefix}.result.body`, `${prefix}.result.subject`])) }
    const result = await run(prototypeInstances(report, review, policy)({ planId: report.plan.id, nodeId: send.id, occurrence: 1, tool: send.tool },
      input, labeledValue(false, publicLabel)).pipe(Effect.result))
    expect(Result.isFailure(result) && result.failure.reason).toBe("label")
  })
})
