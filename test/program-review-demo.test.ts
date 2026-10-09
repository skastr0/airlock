import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { sha256Canonical } from "../src/core/Canonical.ts"
import { ToolGrantPolicy, toolGrant } from "../src/core/admission/ToolGrant.ts"
import { decodeValue, deriveValue, labeledValue } from "../src/core/contract/Decoder.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { reviewPrototype, type Review } from "./support/air-review.ts"
import { CompanyRecipient, dataFlowPrograms, environment } from "./support/air-review-fixtures.ts"
import { lowerReviewPrototype, prototypeInstances, type ReviewSurface } from "./support/air-plan-review.ts"

const Send = defineToolContract({ name: "mail.send", version: "1", effect: "request",
  input: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }),
  output: Schema.Struct({ messageId: Schema.String }), public: ["to", "subject"] })
const env = { ...environment, tools: { ...environment.tools, "mail.send": { ...environment.tools["mail.send"]!, contract: Send } } }
const mailbox = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: ["mailbox"] })
const literal = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const sink = (id: string, confidentialityCeiling: SinkPolicy["confidentialityCeiling"] = "public", minimumIntegrity: SinkPolicy["minimumIntegrity"] = "untrusted") =>
  new SinkPolicy({ id, confidentialityCeiling, minimumIntegrity })
const surface = (review: Review, allowPrivateMail = false): Effect.Effect<ReviewSurface, unknown, import("effect").Crypto.Crypto> => Effect.gen(function* () {
  const sources: Record<string, InformationLabel> = {}
  // Known receipt/result fields are registered by the trusted fixture. Unknown
  // origins are deliberately omitted, rather than labeled from their spelling.
  for (const call of review.calls.filter((call) => call.tool === "mail.read")) {
    for (const field of ["state", "result", "result.from", "result.subject", "result.body", "result.preview"]) sources[`mail.read@${call.span.start}.${field}`] = mailbox
  }
  return { grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })), sources,
    sinks: { "mail.read": { id: sink("mail.read.id") }, "http.get": { url: sink("http.get.url") },
      "mail.send": { to: sink("mail.send.to", allowPrivateMail ? "private" : "public"), subject: sink("mail.send.subject", allowPrivateMail ? "private" : "public"), body: sink("mail.send.body", allowPrivateMail ? "private" : "public") } },
    registryDigest: yield* sha256Canonical({ tools: Object.keys(env.tools), contracts: "fixture-code-v1", decoders: "companyRecipient-v1" }),
    bindings: {}, maxPlanBytes: 65_536 }
})
const prepare = (source: string, allowPrivateMail = false) => Effect.gen(function* () {
  const review = yield* reviewPrototype(source, env)
  const policy = yield* surface(review, allowPrivateMail)
  return { review, policy, report: yield* lowerReviewPrototype(source, review, policy) }
})
const reason = <A>(effect: Effect.Effect<A, { readonly reason: string }>) => Effect.map(Effect.result(effect), (result) => Result.isFailure(result) ? result.failure.reason : "accepted")

describe("test-only: whole-program Plan review demonstration", () => {
  it("reports forwarding dependencies and bounds; validation does not release mailbox data", async () => {
    const { report } = await run(prepare(dataFlowPrograms.forward))
    expect(report.plan.maximumCalls).toEqual({ "mail.read": 1, "mail.send": 1 })
    expect(report.plan.nodes.map((node) => [node.effect, node.maximumOccurrences, node.approval, node.when])).toEqual([
      ["capture", 1, "program", "reviewed"], ["request", 1, "exact-batch", "staged"]
    ])
    const send = report.plan.nodes[1]!
    expect(send.arguments.map((arg) => [arg.field, arg.fixed, arg.label?.confidentiality, arg.proofs])).toEqual([
      ["to", undefined, "private", ["companyRecipient@1"]], ["subject", "Forward", "private", []], ["body", undefined, "private", []]
    ])
    expect(send.arguments.find((arg) => arg.field === "to")!.dependencies.some((origin) => origin.endsWith("result.from"))).toBe(true)
    expect(send.arguments.every((arg) => arg.control.some((origin) => origin.endsWith(".state")))).toBe(true)
    expect(report.refusals).toEqual(["to", "subject", "body"].map((field) => ({ nodeId: send.id, field, reason: "confidentiality" })))
    const accepted = await run(prepare(dataFlowPrograms.forward, true))
    expect(accepted.report.refusals).toEqual([])
    expect(accepted.report.plan.nodes[1]!.approval).toBe("exact-batch")
  })

  it("refuses private mailbox body in a capture URL, even though GET returns information", async () => {
    const { report } = await run(prepare(dataFlowPrograms.captureLeak))
    expect(report.plan.maximumCalls).toEqual({ "mail.read": 1, "http.get": 1 })
    const get = report.plan.nodes[1]!
    expect(get.effect).toBe("capture")
    expect(get.arguments[0]!.dependencies.some((origin) => origin.endsWith("result.body"))).toBe(true)
    expect(report.refusals).toEqual([{ nodeId: get.id, field: "url", reason: "confidentiality" }])
  })

  it("reports both fixed sends but at most one execution, and refuses the private control flow", async () => {
    const { report } = await run(prepare(dataFlowPrograms.controlLeak))
    expect(report.plan.maximumCalls).toEqual({ "mail.read": 1, "mail.send": 1 })
    const sends = report.plan.nodes.filter((node) => node.tool === "mail.send")
    expect(sends).toHaveLength(2)
    for (const send of sends) {
      expect(send.maximumOccurrences).toBe(1)
      expect(send.approval).toBe("program")
      expect(send.arguments.every((arg) => arg.fixed !== undefined)).toBe(true)
      expect(send.arguments.every((arg) => arg.control.some((origin) => origin.endsWith("result.body")))).toBe(true)
    }
    expect(report.refusals).toHaveLength(6)
    expect(report.refusals.every((refusal) => refusal.reason === "confidentiality")).toBe(true)
    const allowed = await run(prepare(dataFlowPrograms.controlLeak, true))
    expect(allowed.report.refusals).toEqual([])
    expect(allowed.report.plan.nodes.filter((node) => node.effect === "request").every((node) => node.approval === "program")).toBe(true)
  })

  it("refuses missing labels and missing sink policy, rather than treating them as public", async () => {
    const { review, policy } = await run(prepare(dataFlowPrograms.forward))
    const unknown = await run(lowerReviewPrototype(dataFlowPrograms.forward, review, { ...policy, sources: {} }))
    expect(unknown.refusals.filter((item) => item.reason === "unknown-label")).toHaveLength(3)
    const missing = await run(lowerReviewPrototype(dataFlowPrograms.forward, review, { ...policy, sinks: {} }))
    expect(missing.refusals.some((item) => item.reason === "missing-sink")).toBe(true)
  })

  it("checks every branch and every fixed grant constraint before any host call", async () => {
    const source = `if false { mail.read({id:"hidden"}) }; return true`
    const checked = await run(reviewPrototype(source, { ...env, granted: new Set() }).pipe(Effect.result))
    expect(Result.isFailure(checked)).toBe(true)
    const fixed = `let checked = decode(schema.companyRecipient,"sink@example.com"); if checked.state == "ok" { mail.send({to:checked.value,subject:"wrong",body:"fixed"}) }; return true`
    const { review, policy } = await run(prepare(fixed))
    const grants = [toolGrant(Send, { id: "fixed", where: { to: { equals: "sink@example.com" }, subject: { equals: "right" } } })]
    const report = await run(lowerReviewPrototype(fixed, review, { ...policy, grants }))
    expect(report.refusals).toEqual([{ nodeId: "call:1", field: "$", reason: "grant" }])
  })

  it("does not piece together different grants to excuse one mismatching call", async () => {
    const source = `let checked = decode(schema.companyRecipient,"sink@example.com"); if checked.state == "ok" { mail.send({to:checked.value,subject:"actual",body:"fixed"}) }; return true`
    const { review, policy } = await run(prepare(source))
    const grants = [toolGrant(Send, { id: "a", where: { to: { equals: "sink@example.com" }, subject: { equals: "other" } } }),
      toolGrant(Send, { id: "b", where: { to: { equals: "other@example.com" }, subject: { equals: "actual" } } })]
    const report = await run(lowerReviewPrototype(source, review, { ...policy, grants }))
    expect(report.refusals.some((item) => item.reason === "grant")).toBe(true)
  })

  it("binds approval identity to source, bindings, registry, policy and limits", async () => {
    const source = dataFlowPrograms.forward
    const { review, policy, report } = await run(prepare(source, true))
    for (const [text, changed] of [
      [source + "\n", policy], [source, { ...policy, bindings: { mailbox: "different" } }],
      [source, { ...policy, registryDigest: await run(sha256Canonical("different contract")) }],
      [source, { ...policy, grants: [] }], [source, { ...policy, maxPlanBytes: 60_000 }]
    ] as const) {
      expect((await run(lowerReviewPrototype(text, review, changed))).plan.id).not.toBe(report.plan.id)
    }
    expect((await run(lowerReviewPrototype(source, review, policy))).plan.id).toBe(report.plan.id)
  })

  it("checks exact-value decoder proofs, fixed values, and bounded node instances at run time", async () => {
    const { report, review, policy } = await run(prepare(dataFlowPrograms.forward, true))
    const send = report.plan.nodes[1]!
    const recipient = Result.getOrThrow(decodeValue(CompanyRecipient, labeledValue("alice@example.com", mailbox)))
    const input = { to: recipient, subject: labeledValue("Forward", literal), body: labeledValue("new content unknown at review", mailbox) }
    const instance = { planId: report.plan.id, nodeId: send.id, occurrence: 1, tool: send.tool }
    const guard = prototypeInstances(report, review, policy)
    expect((await run(guard(instance, input, mailbox))).approval).toBe("exact-batch")
    expect(await run(reason(guard({ ...instance, occurrence: 2 }, input, mailbox)))).toBe("bound")
    expect(await run(reason(guard(instance, input, mailbox)))).toBe("ended")
    expect(await run(reason(prototypeInstances(report, review, policy)(instance, { ...input, to: deriveValue(recipient.value, recipient) }, mailbox)))).toBe("proof")
    expect(await run(reason(prototypeInstances(report, review, policy)(instance, { ...input, subject: labeledValue("changed", literal) }, mailbox)))).toBe("argument")
    expect(await run(reason(prototypeInstances(report, review, policy)({ ...instance, nodeId: "absent" }, input, mailbox)))).toBe("plan-mismatch")
    expect(await run(reason(prototypeInstances(report, review, { ...policy, bindings: { changed: true } })(instance, input, mailbox)))).toBe("plan-mismatch")
    expect(await run(reason(prototypeInstances({ ...report }, review, policy)(instance, input, mailbox)))).toBe("plan-mismatch")
  })

  it("preserves runtime dynamic grant, label and occurrence checks after static acceptance", async () => {
    const { report, review, policy } = await run(prepare(dataFlowPrograms.forward, true))
    const grant = toolGrant(Send, { id: "recipient", where: { to: { equals: "allowed@example.com" } } })
    const narrowed = { ...policy, grants: [...policy.grants.filter((item) => item.tool !== "mail.send"), grant] }
    const reviewed = await run(lowerReviewPrototype(dataFlowPrograms.forward, review, narrowed))
    expect(reviewed.refusals).toEqual([])
    const send = report.plan.nodes[1]!
    const input = { to: Result.getOrThrow(decodeValue(CompanyRecipient, labeledValue("other@example.com", mailbox))), subject: labeledValue("Forward", literal), body: labeledValue("body", mailbox) }
    expect(await run(reason(prototypeInstances(reviewed, review, narrowed)({ planId: reviewed.plan.id, nodeId: send.id, occurrence: 1, tool: send.tool }, input, mailbox)))).toBe("grant")
    const secret = new InformationLabel({ confidentiality: "secret", integrity: "untrusted", provenance: ["other-source"] })
    expect(await run(reason(prototypeInstances(report, review, policy)({ planId: report.plan.id, nodeId: send.id, occurrence: 1, tool: send.tool }, { ...input, body: labeledValue("secret", secret) }, mailbox)))).toBe("label")
  })
})
