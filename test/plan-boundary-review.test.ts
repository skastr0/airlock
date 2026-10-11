import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { sha256Canonical } from "../src/core/Canonical.ts"
import { ToolGrantPolicy } from "../src/core/admission/ToolGrant.ts"
import { labeledValue } from "../src/core/contract/Decoder.ts"
import { createRoleWitnessIssuer } from "../src/core/contract/RoleWitness.ts"
import { releaseRule } from "../src/core/contract/FlowRules.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { environment, Read, Get, CompanyRecipient } from "./support/air-review-fixtures.ts"
import { reviewProgram, planGuard, type ReviewSurface } from "../src/core/review/Review.ts"
import { decoderIdentity, checkSource } from "../src/core/language/check.ts"

const literal = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const privateLabel = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] })
const urlSink = new SinkPolicy({ id: "http.url", confidentialityCeiling: "public", minimumIntegrity: "untrusted" })
const policy = async (): Promise<ReviewSurface> => ({
  grants: Object.keys(environment.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
  sources: {}, sinks: { "http.get": { url: urlSink } },
  registryDigest: await run(sha256Canonical("boundary-review-fixture-v1")), bindings: {}, maxPlanBytes: 65_536
})
const withBinding = () => ({ ...environment, bindings: {
  config: { schema: Schema.Struct({ token: Schema.String }), value: { token: "one" }, label: literal }
} })
const source = 'http.get({url:"https://example.com/fixed"}); return true'

describe("test-only: review binds expanded language boundaries", () => {
  it("hashes checked binding values, labels and models even when the program never reads them", async () => {
    const surface = await policy()
    const a = withBinding(), b = withBinding(), c = withBinding(), d = withBinding()
    b.bindings.config.value.token = "two"
    c.bindings.config.label = privateLabel
    d.bindings.config.schema = Schema.Struct({ token: Schema.String, extra: Schema.optionalKey(Schema.String) })
    const plans = []
    for (const env of [a, b, c, d]) plans.push((await run(reviewProgram(source, await run(checkSource(source, env)), surface))).plan)
    expect(new Set(plans.map((plan) => plan.contextDigest)).size).toBe(4)
    expect(new Set(plans.map((plan) => plan.id)).size).toBe(4)
    expect(plans[0]!.nodes).toEqual(plans[1]!.nodes)
  })

  it.each(["value", "label", "codec", "remove", "add", "invalid-codec"] as const)("ends the run before a call after binding %s drift", async (kind) => {
    const env = withBinding(), surface = await policy()
    const review = await run(checkSource(source, env))
    const report = await run(reviewProgram(source, review, surface))
    expect(report.refusals).toEqual([])
    const node = report.plan.nodes[0]!
    const guard = planGuard(report, review, surface, createRoleWitnessIssuer("boundary-run"))
    const instance = { planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    const control = labeledValue(false, literal)
    const input = { url: { value: labeledValue("https://example.com/fixed", literal) } }
    if (kind === "value") env.bindings.config.value.token = "two"
    if (kind === "label") env.bindings.config.label = privateLabel
    if (kind === "codec") env.bindings.config.schema = Schema.Struct({ token: Schema.String })
    if (kind === "remove") Reflect.deleteProperty(env.bindings, "config")
    if (kind === "add") Reflect.set(env.bindings, "other", { ...env.bindings.config })
    if (kind === "invalid-codec") Reflect.set(env.bindings.config, "schema", null)
    const result = await run(guard(instance, input, control).pipe(Effect.result))
    expect(Result.isFailure(result) && result.failure.reason).toBe("plan-mismatch")
    const retry = await run(guard(instance, input, control).pipe(Effect.result))
    expect(Result.isFailure(retry) && retry.failure.reason).toBe("ended")
  })

  it("refuses a binding-dependent argument until the typed source bridge can represent it", async () => {
    const text = "http.get({url:config.token}); return true"
    const review = await run(checkSource(text, withBinding()))
    const report = await run(reviewProgram(text, review, { ...await policy(), sources: { "binding.config.token": literal } }))
    expect(report.refusals).toEqual([{ nodeId: report.plan.nodes[0]!.id, field: "url", reason: "unknown-label" }])
    expect(report.explanations).toContainEqual(expect.objectContaining({ origin: "binding.config.token", reason: "unknown-label" }))
  })

  it("reports opaque request input as dependent and refuses an unsupported instance shape", async () => {
    const opaque = Schema.Record(Schema.String, Schema.Json)
    const read = defineToolContract({ name: "opaque.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: opaque })
    const send = defineToolContract({ name: "opaque.send", version: "1", effect: "request", input: opaque, output: Schema.Boolean })
    const env = { ...environment, tools: { "opaque.read": { contract: read }, "opaque.send": { contract: send } }, granted: new Set(["opaque.read", "opaque.send"]) }
    const text = 'let r = opaque.read({id:"one"}); if r.state == "done" { opaque.send(r.result) }; return true'
    const review = await run(checkSource(text, env))
    const root = `opaque.read@${review.calls[0]!.span.start}`
    const surface = { ...await policy(), grants: [read, send].map((contract) => new ToolGrantPolicy({ id: contract.tag, tool: contract.tag })),
      sources: { [`${root}.state`]: privateLabel, [`${root}.result`]: privateLabel },
      sinks: { "opaque.read": { id: urlSink }, "opaque.send": { "$": new SinkPolicy({ id: "opaque.whole", confidentialityCeiling: "private", minimumIntegrity: "untrusted" }) } } }
    const report = await run(reviewProgram(text, review, surface))
    const node = report.plan.nodes[1]!
    expect(node).toMatchObject({ tool: "opaque.send", approval: "exact-batch", when: "staged" })
    expect(node.arguments).toHaveLength(1)
    expect(node.arguments[0]).toMatchObject({ field: "$", dependencies: expect.arrayContaining([`${root}.result`]) })
    expect(report.refusals).toEqual([{ nodeId: node.id, field: "$", reason: "argument-shape" }])
    const result = await run(planGuard(report, review, surface, createRoleWitnessIssuer("boundary-run"))({ planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }, {}, labeledValue(false, literal)).pipe(Effect.result))
    expect(Result.isFailure(result) && result.failure.reason).toBe("review-refused")
  })

  it("contract-provided proofs never lower captured secrecy or preapprove dynamic requests", async () => {
    const read = defineToolContract({ name: "provided.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ from: Schema.String }), flow: { provides: { from: [{ name: CompanyRecipient.name, version: CompanyRecipient.version }] } } })
    const env = { ...environment, tools: { ...environment.tools, "provided.read": { contract: read } }, granted: new Set([...environment.granted, "provided.read"]) }
    const text = 'let r = provided.read({id:"one"}); if r.state == "done" { mail.send({to:r.result.from,subject:"Hi",body:"fixed"}) }; return true'
    const review = await run(checkSource(text, env))
    const root = `provided.read@${review.calls[0]!.span.start}`
    const report = await run(reviewProgram(text, review, { ...await policy(),
      grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
      sources: { [`${root}.state`]: privateLabel, [`${root}.result.from`]: privateLabel },
      sinks: { "provided.read": { id: urlSink }, "mail.send": { to: urlSink, subject: urlSink, body: urlSink } }
    }))
    const send = report.plan.nodes[1]!
    expect(send).toMatchObject({ approval: "exact-batch", when: "staged" })
    expect(send.arguments.find((arg) => arg.field === "to")).toMatchObject({ proofs: [decoderIdentity(CompanyRecipient)], label: { confidentiality: "private" } })
    expect(report.refusals).toEqual(["to", "subject", "body"].map((field) => ({ nodeId: send.id, field, reason: "confidentiality" })))
  })

  it.each([
    ["done", "r.id", "id"],
    ["refused", "r.refusal.message", "refusal.message"],
    ["refused", "r.refusal.code", "refusal.code"],
    ["done", "r.wayBack.recoveryId", "wayBack.recoveryId"]
  ])("a receipt-state rule grants no authority for %s receipt field %s", async (state, field, suffix) => {
    const use = `http.get({url:${field}})`
    const text = `let r = mail.read({id:"one"}); if r.state == "${state}" { ${suffix.startsWith("wayBack") ? `if r.wayBack != null { ${use} }` : use} }; return true`
    const review = await run(checkSource(text, environment))
    const read = review.calls.find((call) => call.tool === "mail.read")!
    const root = `mail.read@${read.span.start}`
    const surface = { ...await policy(), sources: { [`${root}.state`]: privateLabel, [`${root}.${suffix}`]: privateLabel },
      sinks: { "mail.read": { id: urlSink }, "http.get": { url: urlSink } },
      rules: (["data", "control"] as const).map((mode) => releaseRule(Read, Get, {
        id: `state.${mode}`, source: { part: "receipt", field: "state" }, sink: "url", mode, from: "private", to: "public"
      })) }
    const report = await run(reviewProgram(text, review, surface))
    const get = report.plan.nodes.find((node) => node.tool === "http.get")!
    expect(report.refusals).toContainEqual({ nodeId: get.id, field: "url", reason: "unknown-label" })
    expect(get.arguments[0]!.flows.find((flow) => flow.origin === `${root}.${suffix}`)).toMatchObject({ rules: [] })
    expect(report.explanations).toContainEqual(expect.objectContaining({ origin: `${root}.${suffix}`, reason: "unknown-label" }))
  })
})
