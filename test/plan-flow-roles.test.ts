import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { sha256Canonical } from "../src/core/Canonical.ts"
import { ToolGrantPolicy } from "../src/core/admission/ToolGrant.ts"
import { addInfluence, hasRefinement, labeledValue, type TrackedValue } from "../src/core/contract/Decoder.ts"
import { createRoleWitnessIssuer, type RoleWitnessIssuer } from "../src/core/contract/RoleWitness.ts"
import { releaseRule } from "../src/core/contract/FlowRules.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { combine, InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { CompanyRecipient, environment } from "./support/air-review-fixtures.ts"
import { reviewProgram, planGuard, type ReviewSurface } from "../src/core/review/Review.ts"
import { checkSource } from "../src/core/language/check.ts"
import { runChecked } from "../src/core/language/run.ts"

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
  const review = await run(checkSource(source, env))
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
const witnessed = (issuer: RoleWitnessIssuer, value: TrackedValue, selection = literal, control = literal) => {
  const aggregate = Result.getOrThrow(addInfluence(value, combine(selection, control)))
  return { value: aggregate, witness: Result.getOrThrow(issuer.issue(aggregate, { data: value.label, selection, control })) }
}
const failure = <A>(effect: Effect.Effect<A, { readonly reason: string }>) => Effect.map(Effect.result(effect),
  (result) => Result.isFailure(result) ? result.failure.reason : "accepted")

describe("test-only: Plan enforces separate payload and selection roles", () => {
  it("requires a control release for private selection, while a data release stays scoped to payload", async () => {
    const issuer = createRoleWitnessIssuer("role-run")
    const { review, surface, index, url } = await prepare("public")
    const wrong = await run(reviewProgram(source, review, { ...surface, rules: [rule("data", "url"), rule("data", "index")] }))
    const selected = wrong.plan.nodes[2]!
    expect(selected.arguments[0]!.dependencies).toEqual([])
    expect(selected.arguments[0]!.control).toContain(index)
    expect(selected.arguments[0]!.flows.find((edge) => edge.origin === index)).toMatchObject({ mode: "control", rules: [] })
    expect(wrong.explanations).toContainEqual(expect.objectContaining({ origin: index, mode: "control", reason: "confidentiality" }))
    expect(wrong.refusals).toEqual([{ nodeId: selected.id, field: "url", reason: "confidentiality" }])

    const authored = { ...surface, rules: [rule("data", "url"), rule("control", "index")] }
    const accepted = await run(reviewProgram(source, review, authored))
    expect(accepted.refusals).toEqual([])
    expect(accepted.plan.nodes[1]!.arguments[0]!.dependencies).toContain(url)
    const node = accepted.plan.nodes[2]!
    const selection = token(index)
    const input = { url: witnessed(issuer, labeledValue("https://example.com/a", literal), selection.label) }
    const instance = { planId: accepted.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    expect(await run(failure(planGuard(accepted, review, authored, issuer)(instance, input, labeledValue(false, literal))))).toBe("accepted")
    expect(selection.label.confidentiality).toBe("private")
  })

  it("rejects wrong-role origins even when private sinks need no author release", async () => {
    const issuer = createRoleWitnessIssuer("role-run")
    const { review, surface, state, index, url } = await prepare("private")
    const report = await run(reviewProgram(source, review, surface))
    expect(report.refusals).toEqual([])
    const node = report.plan.nodes[2]!
    const instance = { planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    const pc = token(state, literal)
    const selected = witnessed(issuer, labeledValue("https://example.com/a", literal), token(index).label)
    expect(await run(failure(planGuard(report, review, surface, issuer)(instance, { url: selected }, pc)))).toBe("accepted")
    const wrongData = { ...selected, value: labeledValue("https://example.com/a", token(index).label) }
    expect(await run(failure(planGuard(report, review, surface, issuer)(instance, { url: wrongData }, pc)))).toBe("label")
    expect(await run(failure(planGuard(report, review, surface, issuer)(instance, { url: witnessed(issuer, labeledValue("https://example.com/a", literal), token(url).label) }, pc)))).toBe("label")
    const payload = report.plan.nodes[1]!
    expect(await run(failure(planGuard(report, review, surface, issuer)({ ...instance, nodeId: payload.id }, {
      url: witnessed(issuer, labeledValue("https://example.com/a", literal), token(url).label)
    }, pc)))).toBe("label")
  })

  it("falls back on missing, copied, stale and wrong-value witnesses and ends rejected runs", async () => {
    const issuer = createRoleWitnessIssuer("role-run")
    const { review, surface, index } = await prepare("private")
    const report = await run(reviewProgram(source, review, surface))
    const node = report.plan.nodes[2]!, pc = labeledValue(false, literal)
    const instance = { planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    const selected = witnessed(issuer, labeledValue("https://example.com/a", literal), token(index).label)
    const stale = createRoleWitnessIssuer("role-run")
    for (const attack of [
      { value: selected.value },
      { ...selected, witness: { ...selected.witness } },
      { ...selected, witness: Result.getOrThrow(stale.issue(selected.value, { data: literal, selection: token(index).label, control: literal })) },
      { ...selected, value: labeledValue(selected.value.value, selected.value.label) },
      { ...selected, value: { ...selected.value } }
    ]) {
      const guard = planGuard(report, review, surface, issuer)
      expect(await run(failure(guard(instance, { url: attack }, pc)))).toBe("label")
      expect(await run(failure(guard(instance, { url: selected }, pc)))).toBe("ended")
    }
    expect(await run(failure(planGuard(report, review, surface, { ...issuer })(instance, { url: selected }, pc)))).toBe("label")
  })

  it("conservatively refuses a selected value whose owned token already joins control", async () => {
    const issuer = createRoleWitnessIssuer("role-run")
    const { review, surface, index } = await prepare("private")
    const report = await run(reviewProgram(source, review, surface))
    const node = report.plan.nodes[2]!
    // Without a role witness, aggregate secrecy is checked as data, never
    // lowered by re-minting this exact value with the public payload label.
    const aggregate = labeledValue("https://example.com/a", token(index).label)
    expect(await run(failure(planGuard(report, review, surface, issuer)({ planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }, {
      url: { value: aggregate }
    }, labeledValue(false, literal))))).toBe("label")
    expect(aggregate.label.confidentiality).toBe("private")
  })

  it.each([false, true])("guards evaluator-issued roles before the resolver, with copied witness=%s", async (copy) => {
    const issuer = createRoleWitnessIssuer("evaluator-run")
    const { review, surface, state } = await prepare("private")
    const policy = { ...surface, sources: { ...surface.sources, [state]: privateLabel } }
    const report = await run(reviewProgram(source, review, policy))
    expect(report.refusals).toEqual([])
    const guard = planGuard(report, review, policy, issuer)
    const resolved: string[] = []
    const outcome = await run(runChecked(review, {
      roleIssuer: issuer,
      beforeCall: (call) => {
        const node = report.plan.nodes.find((node) => node.sourceOffset === call.span.start)!
        const fields = copy && node.id === "call:3" ? { ...call.fields,
          url: { ...call.fields.url!, witness: { ...call.fields.url!.witness } } } : call.fields
        return guard({ planId: report.plan.id, nodeId: node.id, tool: call.tool, occurrence: 1 }, fields, call.pc)
      },
      resolve: (tool) => {
        resolved.push(tool)
        const result: Schema.Json = tool === "choice.read" ? { index: 0, url: "https://example.com/payload" } : { text: "ok" }
        return Effect.succeed({ state: "done", id: "fixture", result })
      }
    }).pipe(Effect.result))
    if (copy) {
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("out-of-plan")
      expect(resolved).toEqual(["choice.read", "http.get"])
    } else {
      expect(Result.isSuccess(outcome) && outcome.success).toBe(true)
      expect(resolved).toEqual(["choice.read", "http.get", "http.get"])
    }
  })

  it("keeps a validated selected request dynamic and staged for exact-batch approval", async () => {
    const text = `let choice = choice.read({})
if choice.state == "done" {
  let recipient = decode(schema.companyRecipient,["a@example.com","b@example.com"][choice.result.index])
  if recipient.state == "ok" { mail.send({to:recipient.value,subject:"Hi",body:"fixed"}) }
}
return true`
    const review = await run(checkSource(text, env))
    const root = `choice.read@${review.calls[0]!.span.start}`
    const sink = new SinkPolicy({ id: "private-mail", confidentialityCeiling: "private", minimumIntegrity: "untrusted" })
    const surface = { ...(await prepare("private")).surface,
      sources: { [`${root}.state`]: privateLabel, [`${root}.result.index`]: privateLabel },
      sinks: { "mail.send": { to: sink, subject: sink, body: sink } } }
    const report = await run(reviewProgram(text, review, surface))
    expect(report.refusals).toEqual([])
    const send = report.plan.nodes[1]!
    expect(send).toMatchObject({ effect: "request", approval: "exact-batch", when: "staged" })
    expect(send.arguments.find((argument) => argument.field === "to")).toMatchObject({ dependencies: [],
      control: expect.arrayContaining([`${root}.result.index`]), proofs: [JSON.stringify(["companyRecipient", "1"])] })
    expect(send.arguments.every((argument) => argument.control.includes(`${root}.result.index`))).toBe(true)
    const issuer = createRoleWitnessIssuer("selected-request")
    const guard = planGuard(report, review, surface, issuer)
    let sends = 0
    const outcome = await run(runChecked(review, {
      roleIssuer: issuer,
      beforeCall: (call) => {
        const node = report.plan.nodes.find((node) => node.sourceOffset === call.span.start)!
        if (call.tool === "mail.send") {
          expect(call.fields.to!.value.label.confidentiality).toBe("private")
          expect(hasRefinement(call.fields.to!.value, CompanyRecipient)).toBe(true)
        }
        return guard({ planId: report.plan.id, nodeId: node.id, tool: call.tool, occurrence: 1 }, call.fields, call.pc)
      },
      resolve: (tool) => {
        if (tool === "mail.send") sends++
        const result: Schema.Json = tool === "choice.read" ? { index: 0, url: "unused" } : { messageId: "sent" }
        return Effect.succeed({ state: "done", id: "fixture", result })
      }
    }))
    expect(outcome).toBe(true)
    expect(sends).toBe(1)
  })
})
