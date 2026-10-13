import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { sha256Canonical } from "../src/Canonical.ts"
import { ToolGrantPolicy } from "../src/admission/ToolGrant.ts"
import { defineToolContract } from "../src/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { reviewProgram } from "../src/review/Review.ts"
import { environment } from "./support/air-review-fixtures.ts"
import { checkSource } from "../src/language/check.ts"
import { runChecked } from "../src/language/run.ts"
import { seeded } from "./support/hostile-air-corpus.ts"

const Choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture",
  input: Schema.Struct({}), output: Schema.Struct({ index: Schema.Number }) })
const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: Choice } },
  granted: new Set([...environment.granted, "choice.read"]) }
const label = (confidentiality: "private" | "public") =>
  new InformationLabel({ confidentiality, integrity: "untrusted", provenance: [] })

describe("test-only: Plan preserves selection dependencies through projection", () => {
  it.each([1, 2, 4])("retains a private selector through %i projections without tainting an independent field", async (depth) => {
    const leaf = (url: string): string => Array.from({ length: depth - 1 }).reduce<string>((value) => `{nested:${value}}`, `{url:${JSON.stringify(url)}}`)
    const path = "selected" + ".nested".repeat(depth - 1) + ".url"
    const source = `let choice = choice.read({})
if choice.state == "done" {
  let unrelated = {secret:choice.result.index,url:"https://example.com/fixed"}
  let fixed = http.get({url:unrelated.url})
  let candidates = [${leaf("https://example.com/a")},${leaf("https://example.com/b")}]
  let selected = candidates[choice.result.index]
  let fetched = http.get({url:${path}})
}
return true`
    const review = await run(checkSource(source, env))
    const pick = review.calls.find((call) => call.tool === "choice.read")!
    const origin = `choice.read@${pick.span.start}.result.index`
    const report = await run(reviewProgram(source, review, {
      grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
      sources: { [`choice.read@${pick.span.start}.state`]: label("public"), [origin]: label("private") },
      sinks: { "http.get": { url: new SinkPolicy({ id: "http.url", confidentialityCeiling: "public", minimumIntegrity: "untrusted" }) } },
      registryDigest: await run(sha256Canonical("plan-selection-v1")), bindings: {}, maxPlanBytes: 65_536
    }))
    const [fixed, selected] = report.plan.nodes.filter((node) => node.tool === "http.get")
    expect(fixed!.arguments[0]!.dependencies).toEqual([])
    expect(fixed!.arguments[0]!.fixed).toBe("https://example.com/fixed")
    expect(selected!.arguments[0]!.dependencies).not.toContain(origin)
    expect(selected!.arguments[0]!.control).toContain(origin)
    expect(report.refusals).toEqual([{ nodeId: selected!.id, field: "url", reason: "confidentiality" }])
    expect(report.plan.maximumCalls).toEqual({ "choice.read": 1, "http.get": 2 })
    expect(report.plan.nodes.every((node) => node.maximumOccurrences === 1)).toBe(true)
  })

  it("keeps nullable selection origins after an alias and non-null narrowing", async () => {
    const source = `let choice = choice.read({})
if choice.state == "done" {
  let selected = at([{nested:{url:"https://example.com/a"}},{nested:{url:"https://example.com/b"}}],choice.result.index)
  let alias = selected
  if alias != null { http.get({url:alias.nested.url}) }
}
return true`
    const review = await run(checkSource(source, env))
    const pick = review.calls.find((call) => call.tool === "choice.read")!
    const origin = `choice.read@${pick.span.start}.result.index`
    const report = await run(reviewProgram(source, review, {
      grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
      sources: { [`choice.read@${pick.span.start}.state`]: label("public"), [origin]: label("private") },
      sinks: { "http.get": { url: new SinkPolicy({ id: "http.url", confidentialityCeiling: "public", minimumIntegrity: "untrusted" }) } },
      registryDigest: await run(sha256Canonical("plan-selection-v1")), bindings: {}, maxPlanBytes: 65_536
    }))
    const get = report.plan.nodes.find((node) => node.tool === "http.get")!
    expect(get.arguments[0]!.dependencies).not.toContain(origin)
    expect(get.arguments[0]!.control).toContain(origin)
    expect(report.refusals).toEqual([{ nodeId: get.id, field: "url", reason: "confidentiality" }])
  })

  it("bounds every observed argument and control origin in 500 accepted generated Plans", async () => {
    const random = seeded(0x7351ec7)
    const registryDigest = await run(sha256Canonical("plan-selection-v1"))
    for (let sample = 0; sample < 500; sample++) {
      const depth = 1 + random(5), safe = random(2) === 0, index = random(2)
      const leaf = (url: string): string => Array.from({ length: depth - 1 }).reduce<string>((value) => `{nested:${value}}`, `{url:${JSON.stringify(url)},ignored:choice.result.index}`)
      const path = "alias" + ".nested".repeat(depth - 1) + ".url"
      const selected = safe ? "at(candidates,choice.result.index)" : "candidates[choice.result.index]"
      const use = `let alias = selected; http.get({url:${path}})`
      const source = `let choice = choice.read({})
if choice.state == "done" {
  let candidates = [${leaf("https://example.com/a")},${leaf("https://example.com/b")}]
  let selected = ${selected}
  ${safe ? `if selected != null { ${use} }` : use}
}
return true`
      const review = await run(checkSource(source, env))
      const pick = review.calls.find((call) => call.tool === "choice.read")!
      // This fixture explicitly permits private data at the URL sink so the
      // property observes accepted Plans; the tests above prove default refusal.
      const report = await run(reviewProgram(source, review, {
        grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
        sources: { [`choice.read@${pick.span.start}.state`]: label("private"), [`choice.read@${pick.span.start}.result.index`]: label("private") },
        sinks: { "http.get": { url: new SinkPolicy({ id: "http.url", confidentialityCeiling: "private", minimumIntegrity: "untrusted" }) } },
        registryDigest, bindings: {}, maxPlanBytes: 65_536
      }))
      expect(report.refusals, `sample=${sample}`).toEqual([])
      let observedCalls = 0
      const outcome = await run(runChecked(review, {
        observe: (observed) => {
          observedCalls++
          const node = report.plan.nodes.find((node) => node.tool === observed.tool && node.sourceOffset === observed.span.start)
          expect(node, `sample=${sample} tool=${observed.tool}`).toBeDefined()
          for (const [field, actual] of Object.entries(observed.fields)) {
            const envelope = node!.arguments.find((argument) => argument.field === field)
            expect(envelope, `sample=${sample} field=${field}`).toBeDefined()
            for (const origin of actual.data.provenance) expect(envelope!.dependencies, `sample=${sample} ${field} data=${origin}`).toContain(origin)
            for (const origin of [...actual.control.provenance, ...observed.control.provenance]) expect(envelope!.control, `sample=${sample} ${field} control=${origin}`).toContain(origin)
          }
        },
        resolve: (tool) => {
          const result: Schema.Json = tool === "choice.read" ? { index } : { text: "ok" }
          return Effect.succeed({ state: "done", id: "fixture", result })
        }
      }))
      expect(outcome).toBe(true)
      expect(observedCalls).toBe(2)
    }
  }, 60_000)
})
