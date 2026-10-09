import { Effect, Result, Schema } from "effect"
import { canonicalizeEndpoint, canonicalizeEndpointSelector } from "../admission/DispatchPolicy.ts"
import { canonicalJson } from "../Canonical.ts"
import type { ResourceField } from "./Resource.ts"
import { type BoundResource, type BoundScope, HostGrantRefused, ResourceBinding, type ResourceBindRequest, type ResourceResolver, ResourceRefused, type ToolHost } from "./ToolHost.ts"

type EndpointScope = ReadonlyArray<{ readonly target: string; readonly prefix: boolean }>

const scopes = new WeakMap<object, EndpointScope>()
const endpoints = new WeakSet<object>()

const refuse = (field: string, reason: string) => new ResourceRefused({ field, reason })

const bind = (request: ResourceBindRequest): Effect.Effect<BoundResource, ResourceRefused> => Effect.gen(function* () {
  if (request.kind !== "endpoint") return yield* refuse(request.field, "this host does not support the resource kind")
  if (request.parent !== undefined || !request.rights.every((right) => right === "connect" || right === "emit")) {
    return yield* refuse(request.field, "endpoint binding has invalid rights or a parent")
  }
  const parsed = canonicalizeEndpoint(request.selector)
  if (Result.isFailure(parsed)) return yield* refuse(request.field, "endpoint must be canonical http or https without credentials")
  const url = new URL(request.selector)
  // Preserve query and fragment in identity and actual-use selector. Matching
  // uses only the separately canonicalized scheme, host and path.
  const selector = url.href
  const identity = { url: selector }
  const decoded = Schema.decodeUnknownResult(ResourceBinding, { onExcessProperty: "error" })({
    field: request.field,
    ...(request.index === undefined ? {} : { index: request.index }),
    kind: "endpoint", rights: [...request.rights], selector, identity
  })
  if (Result.isFailure(decoded)) return yield* refuse(request.field, "endpoint binding evidence is invalid or too large")
  const binding = Object.freeze({ ...decoded.success, rights: Object.freeze(decoded.success.rights), identity: Object.freeze(identity) })
  const resource: BoundResource = Object.freeze({ binding, capability: Object.freeze({ url: selector }) })
  endpoints.add(resource)
  return resource
})

/** The same canonical URL behavior for every host. No network I/O. */
export const endpointResources: ResourceResolver = Object.freeze<ResourceResolver>({
  kinds: Object.freeze(["endpoint"] as const),
  scope: ({ kind, selectors }) => Effect.gen(function* () {
    if (kind !== "endpoint") return yield* refuse("resources", "this host does not support the resource kind")
    const allowed: Array<{ readonly target: string; readonly prefix: boolean }> = []
    for (const selector of selectors) {
      const parsed = canonicalizeEndpointSelector(selector)
      if (Result.isFailure(parsed)) return yield* refuse("resources.endpoint", "scope must be a canonical endpoint selector without query or fragment")
      allowed.push(Object.freeze({ ...parsed.success }))
    }
    const scope: BoundScope = Object.freeze({ kind, capability: Object.freeze(allowed) })
    scopes.set(scope, allowed)
    return scope
  }),
  bind,
  within: (resource, scope) => {
    if (!endpoints.has(resource) || scope.kind !== "endpoint") return false
    const allowed = scopes.get(scope)
    if (allowed === undefined) return false
    const parsed = canonicalizeEndpoint(resource.binding.selector)
    return Result.isSuccess(parsed) && allowed.some((entry) =>
      entry.prefix ? parsed.success.target.startsWith(entry.target) : parsed.success.target === entry.target
    )
  },
  rebind: ({ binding, parent }) => Effect.gen(function* () {
    const bound = yield* bind({ ...binding, ...(parent === undefined ? {} : { parent }) })
    if (canonicalJson(bound.binding) !== canonicalJson(binding)) {
      return yield* refuse(binding.field, "endpoint identity changed since admission")
    }
    return bound
  })
})

/** No Hold and no confined process: captures may run now; other effects wait. */
export const portableToolHost: ToolHost = Object.freeze<ToolHost>({
  resources: endpointResources,
  validateGrant: ({ contract, grant }) => {
    if (grant.tool !== contract.tag) return Result.fail(new HostGrantRefused({ tool: grant.tool, reason: "grant names a different tool" }))
    if (grant.host !== undefined && Object.keys(grant.host).length > 0) {
      return Result.fail(new HostGrantRefused({ tool: grant.tool, reason: "this host accepts no host parameters" }))
    }
    if (grant.when === "now" && contract.effect !== "capture") {
      return Result.fail(new HostGrantRefused({ tool: grant.tool, reason: "this host cannot put this effect back; approval is required" }))
    }
    if (Object.values<ResourceField>(contract.resources).some((resource) => resource.kind !== "endpoint")) {
      return Result.fail(new HostGrantRefused({ tool: grant.tool, reason: "this host does not support a declared resource kind" }))
    }
    return Result.succeed(undefined)
  }
})
