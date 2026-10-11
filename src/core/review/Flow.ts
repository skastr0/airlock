import { Effect, Result, Schema } from "effect"
import { type FlowRule, FlowRule as FlowRuleSchema, FlowSource } from "../contract/FlowRules.ts"
import { combine, checkSink, InformationLabel, type SinkPolicy } from "../labels/Labels.ts"
import { decoderIdentity, type CallFact, type Fact, type CheckedProgram } from "../language/check.ts"

/** Each release remains visible on the exact data or occurrence/control edge. */
export const FlowObligation = Schema.Struct({
  origin: Schema.String, mode: Schema.Literals(["data", "control"]),
  source: Schema.optionalKey(FlowSource), label: Schema.optionalKey(InformationLabel),
  effective: Schema.optionalKey(InformationLabel), rules: Schema.Array(Schema.String)
})
export type FlowObligation = typeof FlowObligation.Type
export const FlowExplanation = Schema.Struct({
  nodeId: Schema.String, field: Schema.String, origin: Schema.String,
  mode: Schema.Literals(["data", "control"]), policyId: Schema.String,
  reason: Schema.Literals(["unknown-label", "confidentiality", "integrity"]),
  /** A suggestion, never installed by review or executable by the guest. */
  allowWith: Schema.optionalKey(FlowRuleSchema)
})
export type FlowExplanation = typeof FlowExplanation.Type

const literal = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const sourceOf = (origin: string, review: CheckedProgram): typeof FlowSource.Type | undefined => {
  for (const call of review.calls) {
    const root = `${call.tool}@${call.span.start}.`
    if (origin === `${root}state`) return { tool: call.tool, part: "receipt", field: "state" }
    if (origin === `${root}result`) return { tool: call.tool, part: "result", field: "$" }
    if (origin.startsWith(`${root}result.`)) {
      const field = origin.slice(`${root}result.`.length)
      // The first demonstration uses scalar result fields. Nested or list
      // paths need a typed origin tree; never broaden them by string prefix.
      if (field.length > 0 && !/[.\[\]|]/.test(field)) return { tool: call.tool, part: "result", field }
    }
  }
  return undefined
}
const sameSource = (left: typeof FlowSource.Type, right: typeof FlowSource.Type) =>
  left.tool === right.tool && left.part === right.part && left.field === right.field

/** Rules are monotone, explicit transitions; decoder proof alone changes no label. */
export const dischargeFlow = (
  edge: FlowObligation, tool: string, field: string, rules: readonly FlowRule[],
  condition: (rule: FlowRule) => boolean
): FlowObligation => {
  if (edge.label === undefined || edge.source === undefined) return edge
  let label = edge.label
  const applied: string[] = []
  const scoped = rules.filter((rule) => sameSource(rule.source, edge.source!) && rule.sink.tool === tool && rule.sink.field === field && rule.mode === edge.mode)
  // At most three confidentiality lowers and three integrity raises exist.
  for (let step = 0; step < 6; step++) {
    const rule = scoped.find((rule) => !applied.includes(rule.id) &&
      (rule.operation === "release" ? label.confidentiality === rule.from : label.integrity === rule.from) && condition(rule))
    if (rule === undefined) break
    label = new InformationLabel({ ...label, ...(rule.operation === "release" ? { confidentiality: rule.to } : { integrity: rule.to }) })
    applied.push(rule.id)
  }
  return { ...edge, effective: label, rules: applied }
}

export const reviewArgumentFlows = (
  nodeId: string, call: CallFact, field: string, review: CheckedProgram,
  sources: Readonly<Record<string, InformationLabel>>, sink: SinkPolicy | undefined,
  rules: readonly FlowRule[]
) => Effect.gen(function* () {
  const facts: ReadonlyMap<string, Fact> = call.arguments.type.kind === "record" ? call.arguments.type.fields : new Map()
  const argument = call.arguments.type.kind === "record" ? facts.get(field) : field === "$" ? call.arguments : undefined
  const conditions = (rule: FlowRule) => rule.when.every((condition) => {
    const decoder = review.environment.decoders[condition.decoder.name]
    return decoder !== undefined && decoder.version === condition.decoder.version && facts.get(condition.field)?.refinements.includes(decoderIdentity(decoder)) === true
  })
  const explanations: FlowExplanation[] = []
  const flows: FlowObligation[] = []
  for (const [mode, origins] of [["data", argument?.dataOrigins ?? []], ["control", [...call.control, ...(argument?.controlOrigins ?? [])]]] as const) {
    for (const origin of [...new Set(origins)]) {
      const source = sourceOf(origin, review), declared = Object.hasOwn(sources, origin) ? sources[origin] : undefined
      const label = declared === undefined ? undefined : new InformationLabel({ ...declared, provenance: [...new Set([...declared.provenance, origin])] })
      let edge: FlowObligation = { origin, mode, ...(source === undefined ? {} : { source }), ...(label === undefined ? {} : { label, effective: label }), rules: [] }
      edge = dischargeFlow(edge, call.tool, field, rules, conditions)
      flows.push(edge)
      if (edge.effective === undefined || source === undefined) {
        explanations.push({ nodeId, field, origin, mode, policyId: sink?.id ?? "missing-sink", reason: "unknown-label" })
        continue
      }
      if (sink === undefined) continue
      const checked = yield* checkSink(edge.effective, sink).pipe(Effect.result)
      if (Result.isSuccess(checked)) continue
      const when = Object.entries(review.environment.decoders).flatMap(([name, decoder]) => [...facts].flatMap(([field, fact]) =>
        fact.refinements.includes(decoderIdentity(decoder)) ? [{ field, decoder: { name, version: decoder.version } }] : []))
      const scope = { id: `allow:${nodeId}:${field}:${mode}:${source.part}:${source.field}`, source, sink: { tool: call.tool, field }, mode, when }
      const allowWith: FlowRule = checked.failure.reason === "confidentiality"
        ? { ...scope, operation: "release", from: edge.effective.confidentiality, to: sink.confidentialityCeiling }
        : { ...scope, operation: "endorse", from: edge.effective.integrity, to: sink.minimumIntegrity }
      explanations.push({ nodeId, field, origin, mode, policyId: sink.id, reason: checked.failure.reason, allowWith })
    }
  }
  const label = flows.some((flow) => flow.effective === undefined || flow.source === undefined)
    ? undefined : combine(literal, ...flows.map((flow) => flow.effective!))
  return { flows, explanations, label }
})
