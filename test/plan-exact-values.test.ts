import { describe, expect, it } from "vitest"
import { DateTime, Effect, Result, Schema } from "effect"
import { Sha256Digest, sha256Canonical } from "../src/core/Canonical.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { defineDecoder, defineDecoderCatalog, labeledValue } from "../src/core/contract/Decoder.ts"
import { createRoleWitnessIssuer } from "../src/core/contract/RoleWitness.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { InformationLabel, SinkPolicy } from "../src/core/labels/Labels.ts"
import { AuthorityAdmission, InvokeNode, NodeId, Plan, PlanDraft, PlanId, Receipt, ReceiptId,
  decodePlanDraftJson, decodePlanJson, decodeReceiptJson, encodePlanDraftJson, encodePlanJson, encodeReceiptJson } from "../src/core/plan/Plan.ts"
import { run } from "./support/CoreTest.ts"
import { lowerReviewPrototype, prototypeInstances, type ReviewSurface } from "./support/air-plan-review.ts"
import { environment } from "./support/air-review-fixtures.ts"
import { reviewPrototype } from "./support/air-review.ts"

const literal = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const NumberTool = defineToolContract({ name: "number.echo", version: "1", effect: "capture",
  input: Schema.Struct({ n: Schema.Number }), output: Schema.Boolean, public: ["n"], flow: { sinks: ["n"] } })
const NumberText = defineDecoder({ name: "numberText", version: "1", schema: Schema.NumberFromString })
const source = 'let n = decode(schema.numberText,"-0"); if n.state == "ok" { number.echo({n:n.value}) }; return true'
const env = () => ({ ...environment, tools: { "number.echo": { contract: NumberTool } },
  granted: new Set(["number.echo"]), decoders: defineDecoderCatalog([NumberText]), bindings: { zero: { schema: Schema.Number, value: -0, label: literal } } })
const policy = async (): Promise<ReviewSurface> => ({
  grants: [toolGrant(NumberTool, { id: "negative-zero", where: { n: { equals: -0 } } })],
  sources: {}, sinks: { "number.echo": { n: new SinkPolicy({ id: "number", confidentialityCeiling: "public", minimumIntegrity: "runtime" }) } },
  registryDigest: await run(sha256Canonical("exact-number-tool-v1")), bindings: {}, maxPlanBytes: 65_536
})

describe("Plan boundaries preserve exact finite JSON numbers", () => {
  it.each([-0, Number.MIN_VALUE, Number.MAX_VALUE, Math.PI])("round-trips each Schema-accepted number through draft, Plan and receipt codecs (%s)", async (number) => {
    const planId = PlanId.make("exact-plan"), nodeId = NodeId.make("exact-node")
    const digest = Sha256Digest.make(`sha256:${"0".repeat(64)}`)
    const at = DateTime.makeUnsafe("2026-10-09T00:00:00Z")
    const node = new InvokeNode({ id: nodeId, dependsOn: [], requires: [], produces: [],
      executable: "/usr/bin/true", args: [], outputLimitBytes: 4096, timeoutMs: number, cellProfile: "compatibility" })
    const draft = new PlanDraft({ schemaVersion: "airlock/plan-draft/v1", id: planId, actionReference: "exact", nodes: [node], requirements: [] })
    const plan = new Plan({ schemaVersion: "airlock/plan/v1", id: planId, actionReference: "exact", nodes: [node], handles: [], resolutions: [],
      admission: new AuthorityAdmission({ grantIds: [], admittedBy: "fixture", admittedAt: at }), planDigest: digest })
    const receipt = new Receipt({ id: ReceiptId.make("exact-receipt"), planId, nodeId, sequence: number, state: "planned", at,
      inputDigests: [], outputArtifacts: [], resourceIdentities: [] })
    const [decodedDraft, decodedPlan, decodedReceipt] = await run(Effect.gen(function* () {
      return [yield* decodePlanDraftJson(yield* encodePlanDraftJson(draft)),
        yield* decodePlanJson(yield* encodePlanJson(plan)), yield* decodeReceiptJson(yield* encodeReceiptJson(receipt))] as const
    }))
    for (const decoded of [decodedDraft, decodedPlan]) {
      const actual = decoded.nodes[0]!
      expect(actual._tag).toBe("Invoke")
      if (actual._tag !== "Invoke") throw new Error("expected invocation")
      expect(Object.is(actual.timeoutMs, number)).toBe(true)
    }
    expect(Object.is(decodedReceipt.sequence, number)).toBe(true)
    // Codec fidelity is independent of later admission/execution validation.
  })

  it("distinguishes signed zero in approval identity, including unused bindings", async () => {
    const surface = await policy(), negative = env(), positive = env()
    positive.bindings.zero.value = 0
    const a = await run(lowerReviewPrototype(source, await run(reviewPrototype(source, negative)), surface))
    const b = await run(lowerReviewPrototype(source, await run(reviewPrototype(source, positive)), surface))
    expect(a.refusals).toEqual([])
    expect(b.refusals).toEqual([])
    expect(Object.is(a.plan.nodes[0]!.arguments[0]!.fixed, -0)).toBe(true)
    expect(a.plan.contextDigest).not.toBe(b.plan.contextDigest)
    expect(a.plan.id).not.toBe(b.plan.id)
    const changed = source.replace('"-0"', '"0"')
    const c = await run(lowerReviewPrototype(changed, await run(reviewPrototype(changed, negative)), {
      ...surface, grants: [toolGrant(NumberTool, { id: "positive-zero", where: { n: { equals: 0 } } })]
    }))
    expect(c.plan.id).not.toBe(a.plan.id)
  })

  it("refuses positive zero for a fixed negative-zero grant and Plan argument", async () => {
    const surface = await policy(), review = await run(reviewPrototype(source, env()))
    const report = await run(lowerReviewPrototype(source, review, surface))
    const wrongGrant = await run(lowerReviewPrototype(source, review, { ...surface,
      grants: [toolGrant(NumberTool, { id: "positive-zero", where: { n: { equals: 0 } } })] }))
    expect(wrongGrant.refusals).toEqual([{ nodeId: "call:1", field: "$", reason: "grant" }])
    const node = report.plan.nodes[0]!, control = labeledValue(false, literal)
    const instance = { planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool }
    expect(await run(prototypeInstances(report, review, surface, createRoleWitnessIssuer("zero-run"))(
      instance, { n: { value: labeledValue(-0, literal) } }, control))).toMatchObject(instance)
    const guard = prototypeInstances(report, review, surface, createRoleWitnessIssuer("zero-run"))
    const result = await run(guard(instance, { n: { value: labeledValue(0, literal) } }, control).pipe(Effect.result))
    expect(Result.isFailure(result) && result.failure.reason).toBe("argument")
    const retry = await run(guard(instance, { n: { value: labeledValue(-0, literal) } }, control).pipe(Effect.result))
    expect(Result.isFailure(retry) && retry.failure.reason).toBe("ended")
  })

  it("ends an existing guard when an unused binding changes from negative to positive zero", async () => {
    const mutable = env(), surface = await policy()
    const review = await run(reviewPrototype(source, mutable))
    const report = await run(lowerReviewPrototype(source, review, surface))
    const node = report.plan.nodes[0]!
    const guard = prototypeInstances(report, review, surface, createRoleWitnessIssuer("zero-run"))
    mutable.bindings.zero.value = 0
    const result = await run(guard({ planId: report.plan.id, nodeId: node.id, occurrence: 1, tool: node.tool },
      { n: { value: labeledValue(-0, literal) } }, labeledValue(false, literal)).pipe(Effect.result))
    expect(Result.isFailure(result) && result.failure.reason).toBe("plan-mismatch")
  })
})
