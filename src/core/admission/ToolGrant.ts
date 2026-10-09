import { DateTime, Effect, Result, Schema, SchemaAST } from "effect"
import { canonicalJson } from "../Canonical.ts"
import type { ToolContract, ToolSummary } from "../contract/ToolContract.ts"
import type { ResourceField } from "../contract/Resource.ts"
import { GrantWhen, HostParameters, type ToolHost } from "../contract/ToolHost.ts"
import { portableToolHost } from "../contract/PortableToolHost.ts"

/** Conditions inspect public inputs; physical scope checks require a host binding. */
export const FieldMatch = Schema.Union([
  Schema.Struct({ equals: Schema.Json }),
  Schema.Struct({ oneOf: Schema.Array(Schema.Json) }),
  Schema.Struct({ startsWith: Schema.String }),
  Schema.Struct({ endsWith: Schema.String }),
  Schema.Struct({ subsetOf: Schema.Array(Schema.Json) }),
  Schema.Struct({ range: Schema.Struct({ min: Schema.optionalKey(Schema.Number), max: Schema.optionalKey(Schema.Number) }) }),
  Schema.Struct({ within: Schema.Array(Schema.String) })
])
export type FieldMatch = typeof FieldMatch.Type

type MatchFor<Value, Resource> = { readonly equals: Value } | { readonly oneOf: ReadonlyArray<Value> }
  | (Value extends string ? { readonly startsWith: string } | { readonly endsWith: string } : never)
  | (Value extends number ? { readonly range: { readonly min?: number; readonly max?: number } } : never)
  | (Value extends ReadonlyArray<infer Item> ? { readonly subsetOf: ReadonlyArray<Item> } : never)
  | ([Resource] extends [never] ? never : { readonly within: ReadonlyArray<string> })

/** One explicit timing decision, validated by the host before a policy is loaded. */
export class ToolGrantPolicy extends Schema.Class<ToolGrantPolicy>("ToolGrantPolicy")({
  id: Schema.String,
  tool: Schema.String,
  when: GrantWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("approved" as const)),
    Schema.withConstructorDefault(Effect.succeed("approved" as const))
  ),
  host: Schema.optionalKey(HostParameters),
  validUntil: Schema.optionalKey(Schema.DateTimeUtcFromString),
  where: Schema.Record(Schema.String, FieldMatch).pipe(
    Schema.withDecodingDefault(Effect.succeed({})), Schema.withConstructorDefault(Effect.succeed({}))
  )
}) {}

export const toolGrant = <Contract extends ToolContract.Any>(contract: Contract, grant: {
  readonly id: string
  readonly when?: ToolContract.EffectOf<Contract> extends "request" ? "approved" : GrantWhen
  readonly host?: HostParameters
  readonly validUntil?: DateTime.Utc
  readonly where?: { readonly [Field in ToolContract.PublicOf<Contract>]?: MatchFor<
    ToolContract.WireOf<Contract>[Field & keyof ToolContract.WireOf<Contract>],
    Field extends keyof ToolContract.ResourcesOf<Contract> ? ToolContract.ResourcesOf<Contract>[Field] : never
  > }
}): ToolGrantPolicy & { readonly tool: Contract["tag"] } => new ToolGrantPolicy({
  ...grant, tool: contract.tag, where: grant.where as Record<string, FieldMatch> | undefined
})

export type ToolGrantRejection = Readonly<{ readonly field: string; readonly reason: string }>
const fieldAst = (contract: ToolContract.Any, field: string): SchemaAST.AST | undefined => {
  const ast = Schema.toEncoded(contract.input).ast
  return SchemaAST.isObjects(ast) ? ast.propertySignatures.find((property) => property.name === field)?.type : undefined
}
const stringField = (ast: SchemaAST.AST | undefined): boolean => ast !== undefined &&
  (SchemaAST.isString(ast) || (SchemaAST.isLiteral(ast) && typeof ast.literal === "string") ||
    (SchemaAST.isUnion(ast) && ast.types.every(stringField)))
const numberField = (ast: SchemaAST.AST | undefined): boolean => ast !== undefined &&
  (SchemaAST.isNumber(ast) || (SchemaAST.isLiteral(ast) && typeof ast.literal === "number") ||
    (SchemaAST.isUnion(ast) && ast.types.every(numberField)))

/** Data policies cannot grant request-now, unknown fields, malformed ranges or unbound resource kinds. */
export const validateToolGrants = (grants: ReadonlyArray<ToolGrantPolicy>,
  contracts: Readonly<Record<string, ToolContract.Any>>, host: ToolHost = portableToolHost
): ToolGrantRejection | undefined => {
  const seen = new Set<string>()
  for (const [index, grant] of grants.entries()) {
    const at = `policy.toolGrants[${index}]`
    if (Result.isFailure(Schema.decodeUnknownResult(Schema.toType(ToolGrantPolicy), { onExcessProperty: "error" })(grant))) {
      return { field: at, reason: "must contain only valid current grant fields" }
    }
    if (!grant.id.trim() || seen.has(grant.id)) return { field: `${at}.id`, reason: "must be non-blank and unique" }
    seen.add(grant.id)
    const contract = Object.hasOwn(contracts, grant.tool) ? contracts[grant.tool] : undefined
    if (contract === undefined) return { field: `${at}.tool`, reason: `no contract is registered for tool ${grant.tool}` }
    if (Object.values<ResourceField>(contract.resources).some((resource) => !host.resources.kinds.includes(resource.kind))) {
      return { field: `${at}.tool`, reason: "host cannot bind a declared resource kind" }
    }
    if (grant.when === "now" && contract.effect === "request") return { field: `${at}.when`, reason: "a request always requires approval, including a compensated request" }
    if (grant.when === "now" && (contract.effect === "apply" || contract.effect === "invoke") && host.recovery === undefined) {
      return { field: `${at}.when`, reason: "now requires a durable host recovery capability" }
    }
    const hostCheck = host.validateGrant({ contract, grant })
    if (Result.isFailure(hostCheck)) return { field: `${at}.host`, reason: hostCheck.failure.reason }
    for (const [field, match] of Object.entries(grant.where)) {
      if (!contract.publicFields.includes(field)) return { field: `${at}.where.${field}`, reason: "must name a public input field" }
      const ast = fieldAst(contract, field)
      if (("startsWith" in match || "endsWith" in match) && !stringField(ast)) return { field: `${at}.where.${field}`, reason: "string match requires a string input field" }
      if ("subsetOf" in match && (ast === undefined || !SchemaAST.isArrays(ast))) return { field: `${at}.where.${field}`, reason: "subsetOf requires a list input field" }
      if ("subsetOf" in match && ast !== undefined && SchemaAST.isArrays(ast) && ast.elements.length === 0 && ast.rest.length === 1 &&
        match.subsetOf.some((value) => Result.isFailure(Schema.decodeUnknownResult(Schema.make<Schema.Codec<Schema.Json>>(ast.rest[0]!))(value)))) {
        return { field: `${at}.where.${field}`, reason: "subsetOf values must satisfy the encoded list element schema" }
      }
      if ("within" in match && !Object.hasOwn(contract.resources, field)) return { field: `${at}.where.${field}`, reason: "within requires a declared physical resource operand" }
      if ("range" in match) {
        const { min, max } = match.range
        if (!numberField(ast) || (min === undefined && max === undefined) ||
          (min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) ||
          (min !== undefined && max !== undefined && min > max)) return { field: `${at}.where.${field}`, reason: "range requires a numeric field and finite ordered bounds" }
      }
      if ("equals" in match || "oneOf" in match) {
        const candidates = "equals" in match ? [match.equals] : match.oneOf
        if (ast === undefined || candidates.some((value) => Result.isFailure(Schema.decodeUnknownResult(Schema.make<Schema.Codec<Schema.Json>>(ast))(value)))) {
          return { field: `${at}.where.${field}`, reason: "matching values must satisfy the encoded input field schema" }
        }
      }
    }
  }
  return undefined
}

/** Returns true only after the same host-owned operand passed this physical scope. */
export type ResourceMatch = (field: string, selectors: ReadonlyArray<string>, grant: ToolGrantPolicy) => boolean
const matches = (match: FieldMatch, value: Schema.Json | undefined, field: string, grant: ToolGrantPolicy, resource?: ResourceMatch): boolean => {
  if (value === undefined) return false
  if ("within" in match) return resource?.(field, match.within, grant) === true
  if ("equals" in match) return canonicalJson(match.equals) === canonicalJson(value)
  if ("oneOf" in match) return match.oneOf.some((allowed) => canonicalJson(allowed) === canonicalJson(value))
  if ("subsetOf" in match) return Array.isArray(value) && value.every((item) => match.subsetOf.some((allowed) => canonicalJson(allowed) === canonicalJson(item)))
  if ("range" in match) return typeof value === "number" && Number.isFinite(value) &&
    (match.range.min === undefined || value >= match.range.min) && (match.range.max === undefined || value <= match.range.max)
  if (typeof value !== "string") return false
  return "startsWith" in match ? value.startsWith(match.startsWith) : value.endsWith(match.endsWith)
}
export const fittingToolGrants = (grants: ReadonlyArray<ToolGrantPolicy>, call: ToolSummary, resource?: ResourceMatch): ReadonlyArray<ToolGrantPolicy> =>
  grants.filter((grant) => grant.tool === call.tool && Object.entries(grant.where).every(([field, match]) =>
    matches(match, Object.hasOwn(call.public, field) ? call.public[field] : undefined, field, grant, resource)))
export const unmetToolGrants = (grants: ReadonlyArray<ToolGrantPolicy>, call: ToolSummary, resource?: ResourceMatch): ReadonlyArray<{ readonly grantId: string; readonly field: string }> =>
  grants.filter((grant) => grant.tool === call.tool).flatMap((grant) => {
    const unmet = Object.entries(grant.where).find(([field, match]) => !matches(match, Object.hasOwn(call.public, field) ? call.public[field] : undefined, field, grant, resource))
    return unmet === undefined ? [] : [{ grantId: grant.id, field: unmet[0] }]
  })

export type ToolDispatchDecision =
  | { readonly _tag: "Now" | "Approved"; readonly host?: HostParameters; readonly validUntil?: DateTime.Utc }
  | { readonly _tag: "Refused"; readonly reason: string }

/** Every fitting grant participates: stricter timing wins; conflicting host authority refuses. */
export const toolDispatchDecision = (grants: ReadonlyArray<ToolGrantPolicy>, contracts: Readonly<Record<string, ToolContract.Any>>,
  call: ToolSummary, options: { readonly host?: ToolHost; readonly resource?: ResourceMatch; readonly now?: DateTime.Utc } = {}
): ToolDispatchDecision => {
  const invalid = validateToolGrants(grants, contracts, options.host)
  if (invalid !== undefined) return { _tag: "Refused", reason: `invalid policy: ${invalid.field} ${invalid.reason}` }
  const fitting = fittingToolGrants(grants, call, options.resource)
  if (!fitting.length) return { _tag: "Refused", reason: "no tool grant fits this call" }
  const first = fitting[0]!
  if (fitting.some((grant) => (grant.host === undefined) !== (first.host === undefined) ||
    (grant.host !== undefined && first.host !== undefined && canonicalJson(grant.host) !== canonicalJson(first.host)))) {
    return { _tag: "Refused", reason: "fitting grants disagree on host parameters" }
  }
  const deadlines = fitting.flatMap((grant) => grant.validUntil === undefined ? [] : [grant.validUntil])
  const validUntil = deadlines.sort((a, b) => DateTime.toEpochMillis(a) - DateTime.toEpochMillis(b))[0]
  if (validUntil !== undefined && options.now !== undefined && DateTime.toEpochMillis(validUntil) <= DateTime.toEpochMillis(options.now)) {
    return { _tag: "Refused", reason: "a fitting grant has expired" }
  }
  return { _tag: fitting.every((grant) => grant.when === "now") ? "Now" : "Approved",
    ...(first.host === undefined ? {} : { host: first.host }), ...(validUntil === undefined ? {} : { validUntil }) }
}
