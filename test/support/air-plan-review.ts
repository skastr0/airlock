import { Effect, Result, Schema } from "effect"
import { canonicalJson, sha256Canonical, type Sha256Digest } from "../../src/core/Canonical.ts"
import { fittingToolGrants, ToolGrantPolicy, validateToolGrants } from "../../src/core/admission/ToolGrant.ts"
import { hasRefinement, isTrackedValue, type TrackedValue } from "../../src/core/contract/Decoder.ts"
import { FlowRule, validateFlowRules } from "../../src/core/contract/FlowRules.ts"
import { modelSchema } from "../../src/core/contract/SchemaModel.ts"
import { combine, checkSink, InformationLabel, SinkPolicy } from "../../src/core/labels/Labels.ts"
import { PlanEffect } from "../../src/core/plan/Plan.ts"
import { decoderIdentity, type Fact, type Review } from "./air-review.ts"
import { dischargeFlow, FlowObligation, type FlowExplanation, reviewArgumentFlows } from "./air-flow-review.ts"

/** Test-only lowering of language-owned typed facts. No host imports this. */
export const ArgumentEnvelope = Schema.Struct({
  field: Schema.String,
  fixed: Schema.optionalKey(Schema.Json),
  dependencies: Schema.Array(Schema.String),
  control: Schema.Array(Schema.String),
  label: Schema.optionalKey(InformationLabel),
  effectiveLabel: Schema.optionalKey(InformationLabel),
  flows: Schema.Array(FlowObligation),
  proofs: Schema.Array(Schema.String)
})
export const CallEnvelope = Schema.Struct({
  id: Schema.String, tool: Schema.String, version: Schema.String, effect: PlanEffect,
  sourceOffset: Schema.Int, maximumOccurrences: Schema.Int,
  arguments: Schema.Array(ArgumentEnvelope),
  approval: Schema.Literals(["program", "exact-batch"]),
  when: Schema.Literals(["reviewed", "staged"])
})
export const PrototypePlan = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/review-demo/v2"),
  id: Schema.String,
  nodes: Schema.Array(CallEnvelope),
  maximumCalls: Schema.Record(Schema.String, Schema.Int),
  iterations: Schema.Int,
  contextDigest: Schema.String,
  rules: Schema.Array(FlowRule)
})
export type PrototypePlan = typeof PrototypePlan.Type
export interface ReviewSurface {
  readonly grants: readonly ToolGrantPolicy[]
  /** Trusted result labels keyed by exact checker origins, including state. */
  readonly sources: Readonly<Record<string, InformationLabel>>
  readonly sinks: Readonly<Record<string, Readonly<Record<string, SinkPolicy>>>>
  /** Supplied by the trusted registry; not inferred from guest text/version. */
  readonly registryDigest: Sha256Digest
  readonly bindings: Schema.Json
  readonly maxPlanBytes: number
  readonly rules?: readonly FlowRule[]
}
export const ReviewRefusal = Schema.Struct({
  nodeId: Schema.String, field: Schema.String,
  reason: Schema.Literals(["grant", "rules", "unknown-label", "confidentiality", "integrity", "missing-sink", "plan-size", "argument-shape"])
})
export type ReviewRefusal = typeof ReviewRefusal.Type
export interface DemonstrationReview {
  readonly plan: PrototypePlan
  readonly refusals: readonly ReviewRefusal[]
  readonly explanations: readonly FlowExplanation[]
}
interface ContextWitness {
  readonly review: Review
  readonly surface: string
  readonly environment: string
  readonly program: string
  readonly definitions: readonly { readonly name: string; readonly contract: import("../../src/core/contract/ToolContract.ts").ToolContract.Any; readonly input: unknown; readonly outcome: unknown; readonly summarize: unknown; readonly target: unknown }[]
  readonly decoders: readonly { readonly name: string; readonly decoder: import("../../src/core/contract/Decoder.ts").TrustedDecoder.Any }[]
  readonly bindings: readonly { readonly name: string; readonly schema: unknown; readonly ast: unknown }[]
}
const contexts = new WeakMap<DemonstrationReview, ContextWitness>()
const bindingDescription = (review: Review) => Object.entries(review.environment.bindings ?? {}).map(([name, binding]) => ({
  name, value: binding.value, label: binding.label,
  encoded: modelSchema(binding.schema, { identity: JSON.stringify(["binding", name]), side: "encoded" }),
  decoded: modelSchema(binding.schema, { identity: JSON.stringify(["binding", name]), side: "decoded" })
})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const environmentDescription = (review: Review) => canonicalJson({
  granted: [...review.environment.granted].sort(), maxCalls: review.environment.maxCalls,
  maxIterations: review.environment.maxIterations, maxListItems: review.environment.maxListItems,
  tools: Object.entries(review.environment.tools).map(([name, tool]) => ({ name, tag: tool.contract.tag,
    version: tool.contract.version, effect: tool.contract.effect, publicFields: tool.contract.publicFields,
    resources: tool.contract.resources, flow: tool.contract.flow })),
  decoders: Object.entries(review.environment.decoders).map(([name, decoder]) => ({ name, version: decoder.version })),
  bindings: bindingDescription(review)
})
const sameEnvironment = (review: Review, witness: ContextWitness) => {
  try { return environmentDescription(review) === witness.environment &&
  witness.definitions.every((definition) => {
    const contract = review.environment.tools[definition.name]?.contract
    return contract === definition.contract && contract.input === definition.input && contract.outcome === definition.outcome &&
      contract.summarize === definition.summarize && contract.target === definition.target
  }) && witness.decoders.every((definition) => review.environment.decoders[definition.name] === definition.decoder) &&
  witness.bindings.every((definition) => {
    const binding = review.environment.bindings?.[definition.name]
    return binding !== undefined && binding.schema === definition.schema && binding.schema.ast === definition.ast
  }) } catch { return false }
}
const literal = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const fieldsOf = (value: Fact): readonly (readonly [string, Fact])[] => value.type.kind === "record" ? [...value.type.fields] : [["$", value]]
const summary = (review: Review, tool: string, publicFields: Record<string, Schema.Json>) => {
  const contract = review.environment.tools[tool]!.contract
  return { tool, version: contract.version, effect: contract.effect, target: `tool:${tool}`, fields: Object.keys(publicFields), public: publicFields, inputBytes: 0 }
}

/** The candidate Plan remains inspectable on refusal; refusal grants no authority. */
export const lowerReviewPrototype = (source: string, review: Review, surface: ReviewSurface) => Effect.gen(function* () {
  const refusals: ReviewRefusal[] = []
  const contracts = Object.fromEntries(Object.entries(review.environment.tools).map(([name, tool]) => [name, tool.contract]))
  const invalid = validateToolGrants(surface.grants, contracts)
  const invalidRules = validateFlowRules(surface.rules ?? [], contracts, review.environment.decoders)
  const explanations: FlowExplanation[] = []
  const nodes: Array<typeof CallEnvelope.Type> = []
  for (const [index, call] of review.calls.entries()) {
    const contract = review.environment.tools[call.tool]!.contract
    const id = `call:${index + 1}`
    const deny = (field: string, reason: ReviewRefusal["reason"]) => { refusals.push({ nodeId: id, field, reason }) }
    // The field-map instance guard cannot fit an opaque whole input. Preserve
    // its facts in the report, but never mistake it for a fixed empty record.
    const modeledInput = call.arguments.type.kind === "record"
    if (!modeledInput) deny("$", "argument-shape")
    const args: Array<typeof ArgumentEnvelope.Type> = []
    for (const [field, fact] of fieldsOf(call.arguments)) {
      const reviewed = yield* reviewArgumentFlows(id, call, field, review, surface.sources, surface.sinks[call.tool]?.[field], invalidRules === undefined ? surface.rules ?? [] : [])
      explanations.push(...reviewed.explanations)
      const labels = reviewed.flows.map((flow) => flow.label)
      const label = labels.some((value) => value === undefined) ? undefined : combine(literal, ...labels as InformationLabel[])
      args.push({ field, ...(fact.constant === undefined ? {} : { fixed: fact.constant }),
        dependencies: [...fact.dataOrigins], control: [...new Set([...call.control, ...fact.controlOrigins])], ...(label === undefined ? {} : { label }),
        ...(reviewed.label === undefined ? {} : { effectiveLabel: reviewed.label }), flows: reviewed.flows,
        proofs: (contract.flow.requires[field] ?? []).map(decoderIdentity) })
    }
    // A partial grant can still fit unknown fields, but every known constraint
    // must fit the SAME grant; combining pieces of different grants is forbidden.
    const viable = surface.grants.filter((grant) => grant.tool === call.tool && args.every((arg) => {
      if (arg.fixed === undefined || !Object.hasOwn(grant.where, arg.field)) return true
      const partial = new ToolGrantPolicy({ ...grant, where: { [arg.field]: grant.where[arg.field]! } })
      return fittingToolGrants([partial], summary(review, call.tool, { [arg.field]: arg.fixed })).length === 1
    }))
    if (invalid !== undefined || viable.length === 0) deny("$", "grant")
    if (invalidRules !== undefined) deny("$", "rules")
    for (const arg of args) {
      if (arg.label === undefined || arg.effectiveLabel === undefined) { deny(arg.field, "unknown-label"); continue }
      // This demo treats every argument as a sink. Contract metadata will name
      // the production sinks; omission here fails closed.
      const sink = surface.sinks[call.tool]?.[arg.field]
      if (sink === undefined) { deny(arg.field, "missing-sink"); continue }
      const checked = yield* checkSink(arg.effectiveLabel, sink).pipe(Effect.result)
      if (Result.isFailure(checked)) deny(arg.field, checked.failure.reason)
    }
    nodes.push({ id, tool: call.tool, version: contract.version, effect: contract.effect,
      sourceOffset: call.span.start, maximumOccurrences: call.maximumOccurrences,
      arguments: args, approval: contract.effect === "request" && (!modeledInput || args.some((arg) => arg.fixed === undefined)) ? "exact-batch" : "program", when: contract.effect === "request" ? "staged" : "reviewed" })
  }
  const contextDigest = yield* sha256Canonical({ source, bindings: surface.bindings, checkedBindings: bindingDescription(review),
    registryDigest: surface.registryDigest, grants: surface.grants, sources: surface.sources, sinks: surface.sinks,
    limits: { maxCalls: review.environment.maxCalls, maxIterations: review.environment.maxIterations,
      maxListItems: review.environment.maxListItems, maxPlanBytes: surface.maxPlanBytes },
    rules: surface.rules ?? [], semantics: "airlock/review-demo/v2" })
  const body = { schemaVersion: "airlock/review-demo/v2" as const, nodes, maximumCalls: review.maximumCalls,
    iterations: review.iterations, contextDigest, rules: [...surface.rules ?? []] }
  const id = yield* sha256Canonical(body)
  const plan = Schema.decodeUnknownSync(PrototypePlan)({ ...body, id })
  if (!Number.isSafeInteger(surface.maxPlanBytes) || surface.maxPlanBytes < 1 || new TextEncoder().encode(canonicalJson(plan)).length > surface.maxPlanBytes) {
    refusals.push({ nodeId: "$", field: "$", reason: "plan-size" })
  }
  const report = freeze({ plan: freeze(plan), refusals: freeze(refusals), explanations: freeze(explanations) }) satisfies DemonstrationReview
  contexts.set(report, { review, surface: canonicalJson(surface), environment: environmentDescription(review), program: canonicalJson(review.program),
    definitions: Object.entries(review.environment.tools).map(([name, { contract }]) => ({ name, contract, input: contract.input, outcome: contract.outcome, summarize: contract.summarize, target: contract.target })),
    decoders: Object.entries(review.environment.decoders).map(([name, decoder]) => ({ name, decoder })),
    bindings: Object.entries(review.environment.bindings ?? {}).map(([name, binding]) => ({ name, schema: binding.schema, ast: binding.schema.ast })) })
  return report
})
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

export class InstanceRefused extends Schema.TaggedError<InstanceRefused>()("InstanceRefused", {
  reason: Schema.Literals(["review-refused", "plan-mismatch", "argument", "proof", "grant", "label", "bound", "ended"])
}) {}

/** A trusted interpreter keeps selection influence separate from the exact value proof. */
export interface InstanceArgument {
  readonly value: TrackedValue
  readonly control: TrackedValue
}

/** Call-time guard demonstration, before any receipt or handler is invoked. */
export const prototypeInstances = (report: DemonstrationReview, review: Review, surface: ReviewSurface) => {
  const counts = new Map<string, number>(), tools = new Map<string, number>()
  let ended = report.refusals.length > 0
  return (instance: { readonly planId: string; readonly nodeId: string; readonly occurrence: number; readonly tool: string },
    input: Readonly<Record<string, InstanceArgument>>, control: TrackedValue) => Effect.gen(function* () {
    const fail = (reason: InstanceRefused["reason"]) => { ended = true; return Effect.fail(new InstanceRefused({ reason })) }
    if (ended) return yield* fail(report.refusals.length > 0 ? "review-refused" : "ended")
    const context = contexts.get(report)
    if (context?.review !== review || context.surface !== canonicalJson(surface) || context.program !== canonicalJson(review.program) || !sameEnvironment(review, context)) return yield* fail("plan-mismatch")
    if (!isTrackedValue(control) || !Object.values(input).every((argument) => argument !== null && typeof argument === "object" &&
      isTrackedValue(argument.value) && isTrackedValue(argument.control))) return yield* fail("label")
    const node = report.plan.nodes.find((node) => node.id === instance.nodeId)
    if (instance.planId !== report.plan.id || node === undefined || node.tool !== instance.tool) return yield* fail("plan-mismatch")
    const occurrence = (counts.get(node.id) ?? 0) + 1, total = (tools.get(node.tool) ?? 0) + 1
    if (occurrence !== instance.occurrence || occurrence > node.maximumOccurrences || total > (report.plan.maximumCalls[node.tool] ?? 0)) return yield* fail("bound")
    if (Object.keys(input).length !== node.arguments.length) return yield* fail("argument")
    const contract = review.environment.tools[node.tool]!.contract
    const raw = Object.fromEntries(Object.entries(input).map(([field, argument]) => [field, argument.value.value]))
    const decoded = Schema.decodeUnknownResult(contract.input, { onExcessProperty: "error" })(raw)
    if (Result.isFailure(decoded)) return yield* fail("argument")
    for (const arg of node.arguments) {
      const argument = Object.hasOwn(input, arg.field) ? input[arg.field] : undefined
      const value = argument?.value
      if (value === undefined || (arg.fixed !== undefined && canonicalJson(arg.fixed) !== canonicalJson(value.value))) return yield* fail("argument")
      for (const required of arg.proofs) {
        const decoder = Object.values(review.environment.decoders).find((decoder) => decoderIdentity(decoder) === required)
        if (decoder === undefined || !hasRefinement(value, decoder)) return yield* fail("proof")
      }
      const sink = surface.sinks[node.tool]?.[arg.field]
      if (sink === undefined || arg.label === undefined) return yield* fail("label")
      const actualControl = combine(argument!.control.label, control.label)
      const actual = combine(value.label, actualControl)
      if (actual.provenance.some((origin) => !arg.label!.provenance.includes(origin))) return yield* fail("label")
      const envelope = new SinkPolicy({ id: "plan-envelope", confidentialityCeiling: arg.label.confidentiality, minimumIntegrity: arg.label.integrity })
      if (Result.isFailure(yield* checkSink(actual, envelope).pipe(Effect.result))) return yield* fail("label")
      const released: InformationLabel[] = []
      for (const [mode, label] of [["data", value.label], ["control", actualControl]] as const) {
        const role = arg.flows.filter((flow) => flow.mode === mode)
        if (role.some((edge) => edge.label === undefined)) return yield* fail("label")
        const roleLabel = combine(literal, ...role.map((edge) => edge.label!))
        if (label.provenance.some((origin) => !roleLabel.provenance.includes(origin))) return yield* fail("label")
        const roleBoundary = new SinkPolicy({ id: `plan-${mode}-envelope`, confidentialityCeiling: roleLabel.confidentiality, minimumIntegrity: roleLabel.integrity })
        if (Result.isFailure(yield* checkSink(label, roleBoundary).pipe(Effect.result))) return yield* fail("label")
        const edges = role.filter((flow) => label.provenance.includes(flow.origin))
        if (label.confidentiality !== "public" && edges.length === 0) return yield* fail("label")
        if (edges.length === 0) { released.push(label); continue }
        const raw = combine(literal, ...edges.map((edge) => edge.label!))
        const rawBoundary = new SinkPolicy({ id: "origin-envelope", confidentialityCeiling: raw.confidentiality, minimumIntegrity: raw.integrity })
        if (Result.isFailure(yield* checkSink(label, rawBoundary).pipe(Effect.result))) return yield* fail("label")
        for (const edge of edges) {
          const applied = dischargeFlow(edge, node.tool, arg.field, report.plan.rules, (rule) => rule.when.every((condition) => {
            const decoder = review.environment.decoders[condition.decoder.name], sibling = input[condition.field]
            return decoder !== undefined && decoder.version === condition.decoder.version && sibling !== undefined && hasRefinement(sibling.value, decoder)
          }))
          if (applied.effective === undefined) return yield* fail("label")
          released.push(applied.effective)
        }
      }
      const effective = combine(literal, ...released)
      if (Result.isFailure(yield* checkSink(effective, sink).pipe(Effect.result))) return yield* fail("label")
    }
    const described = contract.summarize(decoded.success)
    if (Result.isFailure(described) || fittingToolGrants(surface.grants, described.success).length === 0) return yield* fail("grant")
    counts.set(node.id, occurrence); tools.set(node.tool, total)
    return { ...instance, approval: node.approval, when: node.when }
  })
}
