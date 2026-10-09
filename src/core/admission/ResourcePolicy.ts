import { Effect, Schema } from "effect"
import type { ResourceField } from "../contract/Resource.ts"
import type { ToolContract, ToolSummary } from "../contract/ToolContract.ts"
import { type BoundResource, type BoundScope, ResourceRefused, type ToolHost } from "../contract/ToolHost.ts"
import type { ResourceMatch, ToolGrantPolicy } from "./ToolGrant.ts"

/** A machine-wide ceiling. Per-tool matchers can only narrow this authority. */
export const ResourcePolicy = Schema.Struct({
  path: Schema.optionalKey(Schema.Array(Schema.String)),
  endpoint: Schema.optionalKey(Schema.Array(Schema.String)),
  executable: Schema.optionalKey(Schema.Struct({
    roots: Schema.Array(Schema.String),
    edges: Schema.Array(Schema.Struct({ root: Schema.String, descendants: Schema.Array(Schema.String) }))
  }))
})
export type ResourcePolicy = typeof ResourcePolicy.Type

interface Edge { readonly root: BoundScope; readonly descendants: BoundScope }
export interface LoadedResources {
  readonly bind: (contract: ToolContract.Any, input: Readonly<Record<string, unknown>>, summary: ToolSummary) =>
    Effect.Effect<{ readonly resources: ReadonlyArray<BoundResource>; readonly summary: ToolSummary; readonly match: ResourceMatch }, ResourceRefused>
}
const refuse = (field: string, reason: string) => new ResourceRefused({ field, reason })

/** Resolve ceilings and narrowing once. No call can create a missing resource ceiling. */
export const loadResourcePolicy = (
  policy: ResourcePolicy, grants: ReadonlyArray<ToolGrantPolicy>,
  contracts: Readonly<Record<string, ToolContract.Any>>, host: ToolHost
): Effect.Effect<LoadedResources, ResourceRefused> => Effect.gen(function* () {
  const resolver = host.resources
  const used = new Set(Object.keys(policy))
  for (const grant of grants) {
    const contract = contracts[grant.tool]
    if (contract === undefined) return yield* refuse("toolGrants", "resource policy names an unregistered tool")
    for (const descriptor of Object.values<ResourceField>(contract.resources)) {
      used.add(descriptor.kind)
      if (policy[descriptor.kind] === undefined) return yield* refuse(`resources.${descriptor.kind}`, "a granted resource-bearing tool requires an explicit resource ceiling")
    }
  }
  for (const kind of used) {
    if (!resolver.kinds.includes(kind as "path" | "endpoint" | "executable")) {
      return yield* refuse(`resources.${kind}`, "host cannot bind this resource kind")
    }
  }
  const ceilings = new Map<string, BoundScope>()
  for (const kind of ["path", "endpoint"] as const) {
    const selectors = policy[kind]
    if (selectors !== undefined) ceilings.set(kind, yield* resolver.scope({ kind, selectors }))
  }
  const edges: Edge[] = []
  if (policy.executable !== undefined) {
    ceilings.set("executable", yield* resolver.scope({ kind: "executable", selectors: policy.executable.roots }))
    for (const edge of policy.executable.edges) {
      edges.push({ root: yield* resolver.scope({ kind: "executable", selectors: [edge.root] }),
        descendants: yield* resolver.scope({ kind: "executable", selectors: edge.descendants }) })
    }
  }
  const narrowing = new Map<string, Map<string, BoundScope>>()
  for (const grant of grants) {
    const fields = new Map<string, BoundScope>()
    for (const [field, match] of Object.entries(grant.where)) {
      if ("within" in match) {
        const descriptor = contracts[grant.tool]!.resources[field] as ResourceField | undefined
        if (descriptor === undefined) return yield* refuse(`toolGrants.${grant.id}.where.${field}`, "within requires a declared resource operand")
        fields.set(field, yield* resolver.scope({ kind: descriptor.kind, selectors: match.within }))
      }
    }
    narrowing.set(grant.id, fields)
  }
  return {
    bind: (contract, input, summary) => Effect.gen(function* () {
      const fields = new Map<string, ReadonlyArray<BoundResource>>()
      const descriptors = Object.entries<ResourceField>(contract.resources)
      const roots = descriptors.filter(([, resource]) => resource.kind === "executable" && resource.role === "root")
      const rest = descriptors.filter(([, resource]) => !(resource.kind === "executable" && resource.role === "root"))
      for (const [field, descriptor] of [...roots, ...rest]) {
        const supplied = Object.hasOwn(input, field) ? input[field] : undefined
        // The tool input schema already checked whether absence is legal.
        if (supplied === undefined) continue
        const values = descriptor.collection === "each" ? supplied : [supplied]
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
          return yield* refuse(field, "resource operand must be a string or declared string list")
        }
        const parent = descriptor.kind === "executable" && descriptor.role === "descendant"
          ? fields.get(descriptor.parent)?.[0] : undefined
        if (descriptor.kind === "executable" && descriptor.role === "descendant" && parent === undefined) {
          return yield* refuse(field, "descendant operand requires the bound executable root")
        }
        const bound: BoundResource[] = []
        for (const [index, selector] of values.entries()) {
          const resource = yield* resolver.bind({ kind: descriptor.kind, selector, field,
            rights: descriptor.rights, ...(descriptor.collection === "each" ? { index } : {}),
            ...(parent === undefined ? {} : { parent }) })
          const ceiling = ceilings.get(descriptor.kind)
          const allowed = descriptor.kind === "executable" && descriptor.role === "descendant"
            ? edges.some((edge) => resolver.within(parent!, edge.root) && resolver.within(resource, edge.descendants))
            : ceiling !== undefined && resolver.within(resource, ceiling)
          if (!allowed) return yield* refuse(field, "resource operand exceeds the policy ceiling")
          bound.push(resource)
        }
        fields.set(field, Object.freeze(bound))
      }
      const publicFields: Record<string, Schema.Json> = Object.assign(Object.create(null), summary.public)
      for (const [field, descriptor] of descriptors) {
        const bound = fields.get(field)
        if (bound !== undefined) publicFields[field] = descriptor.collection === "each"
          ? bound.map((resource) => resource.binding.selector) : bound[0]!.binding.selector
      }
      const resources = Object.freeze(descriptors.flatMap(([field]) => fields.get(field) ?? []))
      const match: ResourceMatch = (field, _selectors, grant) => {
        const scope = narrowing.get(grant.id)?.get(field), operands = fields.get(field)
        return scope !== undefined && operands !== undefined && operands.every((resource) => resolver.within(resource, scope))
      }
      return { resources, summary: { ...summary, public: publicFields }, match }
    })
  } satisfies LoadedResources
})
