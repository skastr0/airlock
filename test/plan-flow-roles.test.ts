import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { sha256Canonical } from "../src/core/Canonical.ts"
import { ToolGrantPolicy } from "../src/core/admission/ToolGrant.ts"
import { labeledValue } from "../src/core/contract/Decoder.ts"
import { releaseRule } from "../src/core/contract/FlowRules.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { environment } from "./support/air-review-fixtures.ts"
import { lowerReviewPrototype, prototypeInstances, type ReviewSurface } from "./support/air-plan-review.ts"
import { reviewPrototype } from "./support/air-review.ts"

const Get = defineToolContract({ name: "http.get", version: "1", effect: "capture",
  input: Schema.Struct({ url: Schema.String }), output: Schema.Struct({ text: Schema.String }), flow: { sinks: ["url"] } })
const Choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture",
  input: Schema.Struct({}), output: Schema.Struct({ index: Schema.Number, url: Schema.String }) })
const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: Choice }, "http.get": { contract: Get } },
  granted: new Set([...environment.granted, "choice.read"]) }
const literal = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const privateLabel = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] })
const source = `let choice = choice.read({})
if choice.state == "done" {
  let payload = http.get({url:choice.result.url})
  let urls = ["https://example.com/a","https://example.com/b"]
  let selected = http.get({url:urls[choice.result.index]})
}
return true`
const prepare = async (ceiling: "public" | "private") => {
  const review = await run(reviewPrototype(source, env))
  const root = `choice.read@${review.calls[0]!.span.start}`
  const state = `${root}.state`, index = `${root}.result.index`, url = `${root}.result.url`
  const surface: ReviewSurface = {
    grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
    sources: { [state]: literal, [index]: privateLabel, [url]: privateLabel,
      ...Object.fromEntries(review.calls.filter((call) => call.tool === "http.get").map((call) => [`http.get@${call.span.start}.state`, literal])) },
    sinks: { "http.get": { url: new SinkPolicy({ id: "http.url", confidentialityCeiling: ceiling, minimumIntegrity: "untrusted" }) } },
    registryDigest: await run(sha256Canonical("plan-role-fixture-v1")), bindings: {}, maxPlanBytes: 65_536
  }
  return { review, surface, state, index, url }
}
const rule = (mode: "data" | "control", field: "index" | "url") => releaseRule(Choice, Get, {
  id: `allow.${mode}.${field}`, source: { part: "result", field }, sink: "url", mode, from: "private", to: "public"
})
const token = (origin: string, label = privateLabel) => labeledValue(false, new InformationLabel({ ...label, provenance: [origin] }))
const failure = <A>(effect: Effect.Effect<A, { readonly reason: string }>) => Effect.map(Effect.result(effect),
  (result) => Result.isFailure(result) ? result.failure.reason : "accepted")

describe("test-only: Plan enforces separate payload and selection roles", () => {
  it("requires a control release for private selection, while a data release stays scoped to payload", async () => {
    const { review, surface, index, url } = await prepare("public")
    const wrong = await run(lowerReviewPrototype(source, review, { ...surface, rules: [rule("data", "url"), rule("data", "index")] }))
    const selected = wrong.plan.nodes[2]!
    expect(selected.arguments[0]!.dependencies).toEqual([])
    expect(selected.arguments[0]!.control).toContain(index)
    expect(selected.arguments[0]!.flows.find((edge) => edge.origin === index)).toMatchObject({ mode: "control", rules: [] })
    expect(wrong.explanations).toContainEqual(expect.objectContaining({ origin: index, mode: "control", reason: "confidentiality" }))
    expect(wrong.refusals).toEqual([{ nodeId: selected.id, field: "url", reason: "confidentiality" }])

    const authored = { ...surface, rules: [rule("data", "url"), rule("control", "index")] }
    const accepted = await run(lowerReviewPrototype(source, review, authored))
    expect(accepted.refusals).toEqual([])
    expect(accepted.plan.nodes[1]!.arguments[0]!.dependencies).toContain(url)
    const node = accepted.plan.nodes[2]!
    const selection = token(index)
    const input = { url: { value: labeledValue("https://example.com/a", literal), control: selection } }
    const instance = { planId: accepted.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    expect(await run(failure(prototypeInstances(accepted, review, authored)(instance, input, labeledValue(false, literal))))).toBe("accepted")
    expect(selection.label.confidentiality).toBe("private")
  })

  it("rejects wrong-role origins even when private sinks need no author release", async () => {
    const { review, surface, state, index, url } = await prepare("private")
    const report = await run(lowerReviewPrototype(source, review, surface))
    expect(report.refusals).toEqual([])
    const node = report.plan.nodes[2]!
    const instance = { planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    const pc = token(state, literal)
    const selected = { value: labeledValue("https://example.com/a", literal), control: token(index) }
    expect(await run(failure(prototypeInstances(report, review, surface)(instance, { url: selected }, pc)))).toBe("accepted")
    const wrongData = { ...selected, value: labeledValue("https://example.com/a", token(index).label) }
    expect(await run(failure(prototypeInstances(report, review, surface)(instance, { url: wrongData }, pc)))).toBe("label")
    expect(await run(failure(prototypeInstances(report, review, surface)(instance, { url: { ...selected, control: token(url) } }, pc)))).toBe("label")
    const payload = report.plan.nodes[1]!
    expect(await run(failure(prototypeInstances(report, review, surface)({ ...instance, nodeId: payload.id }, {
      url: { value: labeledValue("https://example.com/a", literal), control: token(url) }
    }, pc)))).toBe("label")
  })

  it("rejects absent or copied role tokens and ends the guard permanently", async () => {
    const { review, surface, index } = await prepare("private")
    const report = await run(lowerReviewPrototype(source, review, surface))
    const node = report.plan.nodes[2]!, pc = labeledValue(false, literal)
    const instance = { planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    const selected = { value: labeledValue("https://example.com/a", literal), control: token(index) }
    for (const attack of [{ ...selected, control: { ...selected.control } }, { ...selected }]) {
      if (attack.control === selected.control) Reflect.deleteProperty(attack, "control")
      const guard = prototypeInstances(report, review, surface)
      expect(await run(failure(guard(instance, { url: attack }, pc)))).toBe("label")
      expect(await run(failure(guard(instance, { url: selected }, pc)))).toBe("ended")
    }
  })

  it("conservatively refuses a selected value whose owned token already joins control", async () => {
    const { review, surface, index } = await prepare("private")
    const report = await run(lowerReviewPrototype(source, review, surface))
    const node = report.plan.nodes[2]!
    // No role witness exists yet: aggregate secrecy is checked as data, never
    // lowered by re-minting this exact value with the public payload label.
    const aggregate = labeledValue("https://example.com/a", token(index).label)
    expect(await run(failure(prototypeInstances(report, review, surface)({ planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }, {
      url: { value: aggregate, control: token(index) }
    }, labeledValue(false, literal))))).toBe("label")
    expect(aggregate.label.confidentiality).toBe("private")
  })

  it("keeps a validated selected request dynamic and staged for exact-batch approval", async () => {
    const text = `let choice = choice.read({})
if choice.state == "done" {
  let recipient = decode(schema.companyRecipient,["a@example.com","b@example.com"][choice.result.index])
  if recipient.state == "ok" { mail.send({to:recipient.value,subject:"Hi",body:"fixed"}) }
}
return true`
    const review = await run(reviewPrototype(text, env))
    const root = `choice.read@${review.calls[0]!.span.start}`
    const sink = new SinkPolicy({ id: "private-mail", confidentialityCeiling: "private", minimumIntegrity: "untrusted" })
    const surface = { ...(await prepare("private")).surface,
      sources: { [`${root}.state`]: literal, [`${root}.result.index`]: privateLabel },
      sinks: { "mail.send": { to: sink, subject: sink, body: sink } } }
    const report = await run(lowerReviewPrototype(text, review, surface))
    expect(report.refusals).toEqual([])
    const send = report.plan.nodes[1]!
    expect(send).toMatchObject({ effect: "request", approval: "exact-batch", when: "staged" })
    expect(send.arguments.find((argument) => argument.field === "to")).toMatchObject({ dependencies: [],
      control: expect.arrayContaining([`${root}.result.index`]), proofs: [JSON.stringify(["companyRecipient", "1"])] })
    expect(send.arguments.every((argument) => argument.control.includes(`${root}.result.index`))).toBe(true)
  })
})
