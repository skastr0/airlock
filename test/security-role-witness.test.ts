import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { sha256Canonical } from "../src/core/Canonical.ts"
import { ToolGrantPolicy } from "../src/core/admission/ToolGrant.ts"
import { createRoleWitnessIssuer, type RoleWitnessIssuer } from "../src/core/contract/RoleWitness.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { run } from "./support/CoreTest.ts"
import { environment } from "./support/air-review-fixtures.ts"
import { type InstanceArgument, reviewProgram, planGuard, type ReviewSurface } from "../src/core/review/Review.ts"
import { checkSource } from "../src/core/language/check.ts"
import { runChecked, type RunHost } from "../src/core/language/run.ts"

const Get = defineToolContract({ name: "http.get", version: "1", effect: "capture",
  input: Schema.Struct({ url: Schema.String }), output: Schema.Struct({ text: Schema.String }), flow: { sinks: ["url"] } })
const Choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture",
  input: Schema.Struct({}), output: Schema.Struct({ index: Schema.Number, url: Schema.String }) })
const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: Choice }, "http.get": { contract: Get } },
  granted: new Set([...environment.granted, "choice.read"]) }
const literal = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const privateLabel = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] })

// call:2 sends a payload (choice.result.url as data); call:3 sends fixed text
// selected by a private index (choice.result.index as control only).
const source = `let choice = choice.read({})
if choice.state == "done" {
  let payload = http.get({url:choice.result.url})
  let urls = ["https://example.com/a","https://example.com/b"]
  let selected = http.get({url:urls[choice.result.index]})
}
return true`

type Observed = Parameters<NonNullable<RunHost["beforeCall"]>>[0]["fields"]
type Fields = Readonly<Record<string, InstanceArgument>>
type Rewrite = (nodeId: string, fields: Observed, issuer: RoleWitnessIssuer) => Fields

const reviewed = async () => {
  const review = await run(checkSource(source, env))
  const root = `choice.read@${review.calls[0]!.span.start}`
  const sink = new SinkPolicy({ id: "http.url", confidentialityCeiling: "private", minimumIntegrity: "untrusted" })
  const surface: ReviewSurface = {
    grants: Object.keys(env.tools).map((tool) => new ToolGrantPolicy({ id: tool, tool })),
    sources: { [`${root}.state`]: privateLabel, [`${root}.result.index`]: privateLabel, [`${root}.result.url`]: privateLabel,
      ...Object.fromEntries(review.calls.filter((call) => call.tool === "http.get").map((call) => [`http.get@${call.span.start}.state`, literal])) },
    sinks: { "http.get": { url: sink } },
    registryDigest: await run(sha256Canonical("security-role-witness-v1")), bindings: {}, maxPlanBytes: 65_536
  }
  const report = await run(reviewProgram(source, review, surface))
  expect(report.refusals).toEqual([])
  return { review, surface, report }
}

/** One execution under a fresh issuer; `rewrite` stands in for anything between the evaluator and the guard. */
const execute = async (context: Awaited<ReturnType<typeof reviewed>>, issuer: RoleWitnessIssuer, rewrite?: Rewrite) => {
  const { review, surface, report } = context
  const guard = planGuard(report, review, surface, issuer)
  const resolved: Array<string> = []
  const seen = new Map<string, Observed>()
  const outcome = await run(runChecked(review, {
    roleIssuer: issuer,
    beforeCall: (call) => {
      const node = report.plan.nodes.find((candidate) => candidate.sourceOffset === call.span.start)!
      seen.set(node.id, call.fields)
      const fields = rewrite === undefined ? call.fields : rewrite(node.id, call.fields, issuer)
      return guard({ planId: report.plan.id, nodeId: node.id, tool: call.tool, occurrence: 1 }, fields, call.pc)
    },
    resolve: (tool) => {
      resolved.push(tool)
      const result: Schema.Json = tool === "choice.read" ? { index: 0, url: "https://example.com/payload" } : { text: "ok" }
      return Effect.succeed({ state: "done", id: "fixture", result })
    }
  }).pipe(Effect.result))
  return { outcome, resolved, seen }
}

const stoppedBeforeSelected = (result: Awaited<ReturnType<typeof execute>>) => {
  expect(Result.isFailure(result.outcome) && result.outcome.failure.reason).toBe("out-of-plan")
  expect(result.resolved).toEqual(["choice.read", "http.get"])
}

describe("security: role witnesses cannot be transplanted, misattributed or replayed", () => {
  it("runs the unaltered program to completion", async () => {
    const context = await reviewed()
    const result = await execute(context, createRoleWitnessIssuer("baseline"))
    expect(Result.isSuccess(result.outcome) && result.outcome.success).toBe(true)
    expect(result.resolved).toEqual(["choice.read", "http.get", "http.get"])
  })

  it("refuses a witness moved onto another value of the same run before the resolver", async () => {
    const context = await reviewed()
    let payload: Fields | undefined
    const result = await execute(context, createRoleWitnessIssuer("cross-value"), (nodeId, fields) => {
      if (nodeId === "call:2") payload = fields
      if (nodeId !== "call:3") return fields
      return { ...fields, url: { ...fields.url!, value: payload!.url!.value } }
    })
    stoppedBeforeSelected(result)
  })

  it("refuses a value carried with another value's witness before the resolver", async () => {
    const context = await reviewed()
    let payload: Fields | undefined
    const result = await execute(context, createRoleWitnessIssuer("cross-witness"), (nodeId, fields) => {
      if (nodeId === "call:2") payload = fields
      if (nodeId !== "call:3") return fields
      return { ...fields, url: { value: payload!.url!.value, witness: payload!.url!.witness } }
    })
    stoppedBeforeSelected(result)
  })

  it("refuses an authentic witness that claims a selection origin as payload data", async () => {
    const context = await reviewed()
    const result = await execute(context, createRoleWitnessIssuer("selection-as-data"), (nodeId, fields, issuer) => {
      if (nodeId !== "call:3") return fields
      const value = fields.url!.value
      const witness = Result.getOrThrow(issuer.issue(value, { data: value.label, selection: literal, control: literal }))
      return { ...fields, url: { value, witness } }
    })
    stoppedBeforeSelected(result)
  })

  it("refuses an authentic witness that claims a payload origin as control", async () => {
    const context = await reviewed()
    const result = await execute(context, createRoleWitnessIssuer("data-as-control"), (nodeId, fields, issuer) => {
      if (nodeId !== "call:2") return fields
      const value = fields.url!.value
      const witness = Result.getOrThrow(issuer.issue(value, { data: literal, selection: literal, control: value.label }))
      return { ...fields, url: { value, witness } }
    })
    expect(Result.isFailure(result.outcome) && result.outcome.failure.reason).toBe("out-of-plan")
    expect(result.resolved).toEqual(["choice.read"])
  })

  it("refuses a value and witness from an earlier execution with the same run id", async () => {
    const context = await reviewed()
    const earlier = await execute(context, createRoleWitnessIssuer("same-run"))
    const prior = earlier.seen.get("call:3")!
    const result = await execute(context, createRoleWitnessIssuer("same-run"), (nodeId, fields) =>
      nodeId === "call:3" ? { ...fields, url: prior.url! } : fields)
    stoppedBeforeSelected(result)
  })

  it("refuses to run under an issuer that already ran or was copied", async () => {
    const context = await reviewed()
    const issuer = createRoleWitnessIssuer("reused")
    await execute(context, issuer)
    for (const reused of [issuer, { ...issuer }]) {
      const again = await execute(context, reused)
      expect(Result.isFailure(again.outcome) && again.outcome.failure.reason).toBe("out-of-plan")
      expect(again.resolved).toEqual([])
    }
  })
})
