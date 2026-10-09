import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { sha256Canonical } from "../src/core/Canonical.ts"
import { ToolGrantPolicy } from "../src/core/admission/ToolGrant.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { lowerReviewPrototype } from "./support/air-plan-review.ts"
import { reviewPrototype } from "./support/air-review.ts"
import { environment } from "./support/air-review-fixtures.ts"

const Choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture",
  input: Schema.Struct({}), output: Schema.Struct({ index: Schema.Number }), public: [] })
const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: Choice } },
  granted: new Set([...environment.granted, "choice.read"]) }
const label = (confidentiality: "private" | "public") => new InformationLabel({ confidentiality, integrity: "untrusted", provenance: [] })

describe("security: selecting a record carries the selector into its fields", () => {
  it.each([
    ['[{url:"https://example.com/a"},{url:"https://example.com/b"}]', "selected.url"],
    ['[{nested:{url:"https://example.com/a"}},{nested:{url:"https://example.com/b"}}]', "selected.nested.url"]
  ])("reports a private index as a dependency after projection (%s)", async (candidates, projected) => {
    const source = `let choice = choice.read({})
if choice.state == "done" {
  let candidates = ${candidates}
  let selected = candidates[choice.result.index]
  http.get({url:${projected}})
}
return true`
    const review = await run(reviewPrototype(source, env))
    const pick = review.calls.find((call) => call.tool === "choice.read")!
    const origin = `choice.read@${pick.span.start}.result.index`
    const report = await run(lowerReviewPrototype(source, review, {
      grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
      sources: { [`choice.read@${pick.span.start}.state`]: label("public"), [origin]: label("private") },
      sinks: { "http.get": { url: new SinkPolicy({ id: "http.url", confidentialityCeiling: "public", minimumIntegrity: "untrusted" }) } },
      registryDigest: await run(sha256Canonical("selection-test-v1")), bindings: {}, maxPlanBytes: 65_536
    }))
    const get = report.plan.nodes.find((node) => node.tool === "http.get")!
    expect({ control: get.arguments[0]!.control, refusals: report.refusals }).toEqual({
      control: expect.arrayContaining([origin]),
      refusals: expect.arrayContaining([{ nodeId: get.id, field: "url", reason: "confidentiality" }])
    })
    expect(get.arguments[0]!.flows).toContainEqual(expect.objectContaining({ origin, mode: "control" }))
  })
})
