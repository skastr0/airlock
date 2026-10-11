import { type Crypto, Effect, Schema } from "effect"
import { type DigestUnavailable, sha256Canonical } from "../Canonical.ts"
import type { TrustedDecoder } from "../contract/Decoder.ts"
import { requestSinkFields } from "../contract/Flow.ts"
import type { ToolContract } from "../contract/ToolContract.ts"
import type { ToolHost } from "../contract/ToolHost.ts"
import { InformationLabel, SinkPolicy } from "../labels/Labels.ts"
import type { DuplicateBinding } from "../language/bindings.ts"
import { type CheckedProgram, type CheckError, checkSource } from "../language/check.ts"
import type { LanguageDiagnostic } from "../language/lexer.ts"
import type { ToolPolicy } from "../session/ToolPolicy.ts"
import { type ReviewReport, reviewProgram, type ReviewSurface } from "./Review.ts"

/** What review is given by the trusted side: the granted contracts, its decoders, its policy and its host. */
export interface ReviewContext {
  readonly contracts: Readonly<Record<string, ToolContract.Any>>
  readonly decoders: Readonly<Record<string, TrustedDecoder.Any>>
  readonly policy: ToolPolicy
  /** The host the session runs on, which decides what an immediate grant may cover. */
  readonly host: ToolHost
}

/** The bounds a reviewed program must fit before it may run. */
export interface ReviewLimits {
  readonly maxCalls: number
  readonly maxIterations: number
  /** The longest list a result may hold when its contract names no maximum. */
  readonly maxListItems: number
  readonly maxPlanBytes: number
}

export type CheckFailure = CheckError | DuplicateBinding | LanguageDiagnostic

export interface Reviewed {
  readonly checked: CheckedProgram
  readonly report: ReviewReport
  readonly surface: ReviewSurface
}

const label = (confidentiality: InformationLabel["confidentiality"], integrity: InformationLabel["integrity"]) =>
  new InformationLabel({ confidentiality, integrity, provenance: [] })

/** What the host binds is the operator's, and not for anyone else to read. */
export const bindingLabel = label("private", "operator")
const receiptLabel = label("private", "untrusted")
const heldLabel = label("private", "runtime")

/**
 * The label a run gives each origin, so review and the run agree on every
 * edge: a result field carries its contract's declared source label, else the
 * whole result's, else private and untrusted; receipt metadata is private and
 * untrusted; a way-back reference is private runtime data.
 */
export const originLabel = (origin: string, checked: CheckedProgram): InformationLabel | undefined => {
  if (origin.startsWith("binding.")) {
    const name = /^[^.[\]]+/.exec(origin.slice("binding.".length))?.[0]
    return name === undefined ? undefined : checked.environment.bindings?.[name]?.label
  }
  const at = origin.lastIndexOf("@")
  const dot = origin.indexOf(".", at)
  if (at < 1 || dot < 0) return undefined
  const contract = checked.environment.tools[origin.slice(0, at)]?.contract
  if (contract === undefined) return undefined
  const rest = origin.slice(dot + 1)
  if (rest === "state" || rest === "id" || rest === "refusal" || rest.startsWith("refusal.")) return receiptLabel
  if (rest === "wayBack" || rest.startsWith("wayBack.")) return heldLabel
  if (rest !== "result" && !rest.startsWith("result.")) return undefined
  const field = rest === "result" ? "$" : /^[^.[\]|]+/.exec(rest.slice("result.".length))?.[0]
  if (field === undefined) return undefined
  return contract.flow.sources[field] ?? contract.flow.sources["$"] ?? receiptLabel
}

const unrestricted = (id: string) => new SinkPolicy({ id, confidentialityCeiling: "secret", minimumIntegrity: "untrusted" })
const publicOnly = (id: string) => new SinkPolicy({ id, confidentialityCeiling: "public", minimumIntegrity: "untrusted" })

/**
 * Every argument has a sink policy. A field the contract does not declare a
 * sink accepts any label. A declared sink takes the policy's ceiling; without
 * one, a request's field accepts any label because a person sees what leaves,
 * and any other declared sink accepts public data only, because nobody does.
 */
export const sinkPolicies = (context: ReviewContext): ReviewSurface["sinks"] =>
  Object.fromEntries(Object.entries(context.contracts).map(([name, contract]) => {
    const fields = requestSinkFields(contract.input)
    const policies = Object.fromEntries([...fields, "$"].map((field) => {
      const id = `${name}.${field}`
      if (!contract.flow.sinks.includes(field)) return [field, unrestricted(id)]
      const chosen = context.policy.flow[name]?.[field]
      return [field, chosen ?? (contract.effect === "request" ? unrestricted(id) : publicOnly(id))]
    }))
    return [name, policies]
  }))

/** Names every contract and decoder review relied on, by what they are, not by where they came from. */
export const registryDigest = (context: ReviewContext) =>
  sha256Canonical({
    tools: Object.entries(context.contracts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, contract]) => ({
      name, version: contract.version, effect: contract.effect, public: contract.publicFields,
      resources: contract.resources, flow: contract.flow, model: contract.model
    })),
    decoders: Object.entries(context.decoders).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, decoder]) => ({ name, version: decoder.version }))
  })

/** The exact type of a bound value: review sees the very value the run will hold. */
const exactSchema = (value: Schema.Json): Schema.Codec<unknown, Schema.Json> => {
  if (value === null) return Schema.Null as never
  if (typeof value !== "object") return Schema.Literal(value) as never
  if (Array.isArray(value)) {
    const items = value.map(exactSchema)
    const item = items.length === 0 ? Schema.Never : items.length === 1 ? items[0]! : Schema.Union(items)
    return Schema.Array(item).check(Schema.isMaxLength(value.length)) as never
  }
  return Schema.Struct(Object.fromEntries(Object.entries(value).map(([key, field]) => [key, exactSchema(field)]))) as never
}

/** Parse, check against the granted contracts, then review against the policy. */
export const reviewSource = (
  source: string,
  context: ReviewContext,
  options: { readonly bindings?: Readonly<Record<string, Schema.Json>>; readonly limits: ReviewLimits }
): Effect.Effect<Reviewed, CheckFailure | DigestUnavailable, Crypto.Crypto> => Effect.gen(function* () {
  const bindings = options.bindings ?? {}
  const checked = yield* checkSource(source, {
    tools: Object.fromEntries(Object.entries(context.contracts).map(([name, contract]) => [name, { contract }])),
    decoders: context.decoders,
    granted: new Set(Object.keys(context.contracts)),
    maxCalls: options.limits.maxCalls,
    maxIterations: options.limits.maxIterations,
    maxListItems: options.limits.maxListItems,
    bindings: Object.fromEntries(Object.entries(bindings).map(([name, value]) =>
      [name, { schema: exactSchema(value), value, label: bindingLabel }]))
  })
  const origins = new Set(checked.calls.flatMap((call) => [...call.control, ...call.arguments.origins]))
  const sources: Record<string, InformationLabel> = {}
  for (const origin of origins) {
    const known = originLabel(origin, checked)
    if (known !== undefined) sources[origin] = known
  }
  const surface: ReviewSurface = {
    grants: context.policy.toolGrants.filter((grant) => Object.hasOwn(context.contracts, grant.tool)),
    sources,
    sinks: sinkPolicies(context),
    registryDigest: yield* registryDigest(context),
    bindings,
    maxPlanBytes: options.limits.maxPlanBytes,
    rules: context.policy.flowRules
  }
  const report = yield* reviewProgram(source, checked, surface, context.host)
  return { checked, report, surface }
})
