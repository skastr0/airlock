import { Result, Schema, SchemaAST } from "effect"
import { Confidentiality, Integrity } from "../labels/Labels.ts"
import { DecoderIdentity, type TrustedDecoder } from "./Decoder.ts"
import type { FlowRejection } from "./Flow.ts"
import type { ToolContract } from "./ToolContract.ts"

/** Exact origins only: no patterns, tool wildcards or implicit control release. */
export const FlowSource = Schema.Union([
  Schema.Struct({ tool: Schema.String, part: Schema.Literal("result"), field: Schema.String }),
  Schema.Struct({ tool: Schema.String, part: Schema.Literal("receipt"), field: Schema.Literal("state") })
])
export type FlowSource = typeof FlowSource.Type
export const FlowSink = Schema.Struct({ tool: Schema.String, field: Schema.String })
export type FlowSink = typeof FlowSink.Type
export const FlowCondition = Schema.Struct({ field: Schema.String, decoder: DecoderIdentity })
export type FlowCondition = typeof FlowCondition.Type

const scope = {
  id: Schema.String,
  source: FlowSource,
  sink: FlowSink,
  mode: Schema.Literals(["data", "control"]),
  /** All conditions apply to exact, owned sibling arguments at this sink occurrence. */
  when: Schema.Array(FlowCondition)
}
export const FlowRule = Schema.Union([
  Schema.Struct({ ...scope, operation: Schema.Literal("release"), from: Confidentiality, to: Confidentiality }),
  Schema.Struct({ ...scope, operation: Schema.Literal("endorse"), from: Integrity, to: Integrity })
])
export type FlowRule = typeof FlowRule.Type

export class InvalidFlowRule extends Schema.TaggedError<InvalidFlowRule>()("InvalidFlowRule", {
  field: Schema.String, reason: Schema.String
}) {}

type ResultField<Contract> = "$" | (ToolContract.OutputOf<Contract> extends infer Output
  ? Output extends object ? keyof Output & string : never : never)
type SourceOf<Contract> = { readonly part: "result"; readonly field: ResultField<Contract> }
  | { readonly part: "receipt"; readonly field: "state" }
type RuleScope<Source, Sink> = {
  readonly id: string
  readonly source: SourceOf<Source>
  readonly sink: keyof ToolContract.WireOf<Sink> & string
  readonly mode: "data" | "control"
  readonly when?: ReadonlyArray<{ readonly field: keyof ToolContract.WireOf<Sink> & string; readonly decoder: TrustedDecoder.Any }>
}

const authorScope = {
  id: Schema.String,
  source: Schema.Union([
    Schema.Struct({ part: Schema.Literal("result"), field: Schema.String }),
    Schema.Struct({ part: Schema.Literal("receipt"), field: Schema.Literal("state") })
  ]),
  sink: Schema.String,
  mode: Schema.Literals(["data", "control"]),
  when: Schema.optionalKey(Schema.Array(Schema.Struct({ field: Schema.String, decoder: Schema.Unknown })))
}
const ReleaseSpec = Schema.Struct({ ...authorScope, from: Confidentiality, to: Confidentiality })
const EndorsementSpec = Schema.Struct({ ...authorScope, from: Integrity, to: Integrity })
const validateAuthorSpec = (schema: Schema.Top, spec: unknown): void => {
  if (Result.isFailure(Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(spec))) {
    throw new InvalidFlowRule({ field: "spec", reason: "must contain exact author rule fields" })
  }
}

const ruleScope = <Source extends ToolContract.Any, Sink extends ToolContract.Any>(
  source: Source, sink: Sink, spec: RuleScope<Source, Sink>
) => ({
  id: spec.id, source: { tool: source.tag, part: spec.source.part, field: spec.source.field }, sink: { tool: sink.tag, field: spec.sink }, mode: spec.mode,
  when: (spec.when ?? []).map(({ field, decoder }) => ({ field, decoder: { name: decoder.name, version: decoder.version } }))
})

/** The author deliberately releases one exact origin to one exact sink and flow mode. */
export const releaseRule = <Source extends ToolContract.Any, Sink extends ToolContract.Any>(
  source: Source, sink: Sink,
  spec: RuleScope<Source, Sink> & { readonly from: Confidentiality; readonly to: Confidentiality }
): Extract<FlowRule, { operation: "release" }> => {
  validateAuthorSpec(ReleaseSpec, spec)
  return composeFlowRules([{
  ...ruleScope(source, sink, spec), operation: "release", from: spec.from, to: spec.to
}])[0]! as Extract<FlowRule, { operation: "release" }>
}

/** Endorsement is a separate, conspicuous author decision, never a decoder side effect. */
export const endorsementRule = <Source extends ToolContract.Any, Sink extends ToolContract.Any>(
  source: Source, sink: Sink,
  spec: RuleScope<Source, Sink> & { readonly from: Integrity; readonly to: Integrity }
): Extract<FlowRule, { operation: "endorse" }> => {
  validateAuthorSpec(EndorsementSpec, spec)
  return composeFlowRules([{
  ...ruleScope(source, sink, spec), operation: "endorse", from: spec.from, to: spec.to
}])[0]! as Extract<FlowRule, { operation: "endorse" }>
}

const secrecy = ["public", "project", "private", "secret"] as const
const trust = ["untrusted", "project", "operator", "runtime"] as const
const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

/** Own and normalize reusable rule sets. Duplicate ids are refused even if equal. */
export const composeFlowRules = (...sets: ReadonlyArray<ReadonlyArray<FlowRule>>): ReadonlyArray<FlowRule> => {
  const decoded = Schema.decodeUnknownResult(Schema.Array(FlowRule), { onExcessProperty: "error" })(sets.flat())
  const invalid = (field: string, reason: string): never => { throw new InvalidFlowRule({ field, reason }) }
  if (Result.isFailure(decoded)) return invalid("rules", "must contain exact flow rule declarations")
  const ids = new Set<string>()
  const targets = new Map<string, string>()
  for (const rule of decoded.success) {
    if (!rule.id.trim() || ids.has(rule.id)) invalid("id", "must be non-blank and unique across composed rule sets")
    ids.add(rule.id)
    if (![rule.source.tool, rule.source.field, rule.sink.tool, rule.sink.field].every((value) => value.trim())) {
      invalid(rule.id, "source and sink must name exact non-blank tools and fields")
    }
    const validDirection = rule.operation === "release"
      ? secrecy.indexOf(rule.from) > secrecy.indexOf(rule.to)
      : trust.indexOf(rule.from) < trust.indexOf(rule.to)
    if (!validDirection) invalid(rule.id, "release must lower confidentiality; endorsement must raise integrity")
    const sameFlow = JSON.stringify([rule.operation, rule.source.tool, rule.source.part, rule.source.field,
      rule.sink.tool, rule.sink.field, rule.mode, rule.from])
    const target = targets.get(sameFlow)
    if (target !== undefined && target !== rule.to) invalid(rule.id, "overlapping flow transformations have conflicting targets")
    targets.set(sameFlow, rule.to)
    const conditions = rule.when.map(({ field, decoder }) => JSON.stringify([field, decoder.name, decoder.version]))
    if (new Set(conditions).size !== conditions.length || rule.when.some(({ field, decoder }) =>
      !field.trim() || !decoder.name.trim() || !decoder.version.trim())) invalid(rule.id, "conditions must be distinct exact field and decoder identities")
  }
  // These declarations contain only strings, so this round trip cannot change numeric refinements.
  return freeze(JSON.parse(JSON.stringify([...decoded.success].sort((a, b) => a.id.localeCompare(b.id)))) as FlowRule[])
}

const hasField = (schema: Schema.Top, field: string, decoded: boolean): boolean => {
  const walk = (ast: SchemaAST.AST): boolean => SchemaAST.isObjects(ast)
    ? ast.propertySignatures.some((property) => property.name === field)
    : SchemaAST.isUnion(ast) && ast.types.some(walk)
  return walk((decoded ? Schema.toType(schema) : Schema.toEncoded(schema)).ast)
}

/** Registration checks trusted identities; matching and exact-value checks belong to review. */
export const validateFlowRules = (
  rules: ReadonlyArray<FlowRule>, contracts: Readonly<Record<string, ToolContract.Any>>,
  decoders: Readonly<Record<string, TrustedDecoder.Any>>
): FlowRejection | undefined => {
  try { composeFlowRules(rules) } catch { return { field: "rules", reason: "invalid or duplicate flow rule declarations" } }
  for (const rule of rules) {
    const at = `rules.${rule.id}`
    const source = Object.hasOwn(contracts, rule.source.tool) ? contracts[rule.source.tool] : undefined
    const sink = Object.hasOwn(contracts, rule.sink.tool) ? contracts[rule.sink.tool] : undefined
    if (source === undefined || sink === undefined) return { field: at, reason: "source and sink must name registered contracts" }
    if (rule.source.part === "result" && rule.source.field !== "$" && !hasField(source.outcome, rule.source.field, true)) {
      return { field: `${at}.source`, reason: "must name a decoded result field or $" }
    }
    if (!sink.flow.sinks.includes(rule.sink.field)) return { field: `${at}.sink`, reason: "must name a declared disclosure sink" }
    for (const condition of rule.when) {
      if (!hasField(sink.input, condition.field, false)) return { field: `${at}.when`, reason: "must name an encoded input field of the same sink call" }
      const decoder = Object.hasOwn(decoders, condition.decoder.name) ? decoders[condition.decoder.name] : undefined
      if (decoder === undefined || decoder.version !== condition.decoder.version) {
        return { field: `${at}.when`, reason: `no trusted decoder ${condition.decoder.name} at version ${condition.decoder.version}` }
      }
    }
  }
  return undefined
}
