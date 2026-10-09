import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { loadResourcePolicy } from "../src/core/admission/ResourcePolicy.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { portableToolHost } from "../src/core/contract/PortableToolHost.ts"
import { type BoundResource, type BoundScope, type ResourceResolver, type ToolHost } from "../src/core/contract/ToolHost.ts"

const get = defineToolContract({ name: "http.get", version: "1", effect: "capture",
  input: Schema.Struct({ urls: Schema.Array(Schema.String) }), output: Schema.Boolean, public: ["urls"],
  resources: { urls: { kind: "endpoint", rights: ["connect"], collection: "each" } } })
const contract = defineToolContract({ name: "process.run", version: "1", effect: "invoke",
  input: Schema.Struct({ executable: Schema.String, descendants: Schema.Array(Schema.String), cwd: Schema.String }),
  output: Schema.Boolean, public: ["executable", "descendants", "cwd"], resources: {
    // Deliberately declared before its parent; admission binds the root first.
    descendants: { kind: "executable", role: "descendant", parent: "executable", rights: ["execute"], collection: "each" },
    executable: { kind: "executable", role: "root", rights: ["invoke"] }, cwd: { kind: "path", rights: ["read", "write"] }
  } })
const testHost = () => {
  const issued = new WeakSet<object>(), scopes = new WeakMap<object, readonly string[]>()
  const physical = (value: string) => value === "/alias" ? "/safe/work" : value
  const seen: BoundResource[] = []
  const resolver: ResourceResolver = {
    kinds: ["path", "executable"],
    scope: ({ kind, selectors }) => Effect.sync(() => {
      const scope = { kind, capability: selectors.map(physical) }; scopes.set(scope, scope.capability); return scope
    }),
    bind: (request) => Effect.sync(() => {
      const resource = { binding: { field: request.field, kind: request.kind, rights: request.rights,
        ...(request.index === undefined ? {} : { index: request.index }), selector: physical(request.selector), identity: { selector: physical(request.selector) } },
      capability: request.parent ?? {} }
      issued.add(resource); seen.push(resource); return resource
    }),
    within: (resource: BoundResource, scope: BoundScope) => issued.has(resource) && scopes.get(scope)?.some((selector) =>
      resource.binding.selector === selector || (scope.kind === "path" && resource.binding.selector.startsWith(`${selector}/`))) === true,
    rebind: ({ binding, parent }) => resolver.bind({ ...binding, ...(parent === undefined ? {} : { parent }) })
  }
  const host: ToolHost = { resources: resolver, validateGrant: () => Result.succeed(undefined) }
  return { host, seen }
}

describe("core: resource ceiling and grant narrowing", () => {
  it("rejects missing ceilings and unsupported kinds at load", () => {
    const grant = toolGrant(get, { id: "read" })
    expect(Effect.runSync(loadResourcePolicy({}, [grant], { "http.get": get }, portableToolHost).pipe(Effect.result))).toMatchObject({
      _tag: "Failure", failure: { field: "resources.endpoint" }
    })
    expect(Effect.runSync(loadResourcePolicy({ path: ["/safe"] }, [], {}, portableToolHost).pipe(Effect.result))).toMatchObject({ _tag: "Failure" })
  })
  it("checks every endpoint against both ceiling and narrower grant using the same binding", () => {
    const grant = toolGrant(get, { id: "read", where: { urls: { within: ["https://example.test/private/*"] } } })
    const loaded = Effect.runSync(loadResourcePolicy({ endpoint: ["https://example.test/*"] }, [grant], { "http.get": get }, portableToolHost))
    const bind = (urls: readonly string[]) => Effect.runSync(loaded.bind(get, { urls }, Result.getOrThrow(get.summarize({ urls }))).pipe(Effect.result))
    const allowed = Result.getOrThrow(bind(["https://example.test/private/a"]))
    expect(allowed.match("urls", [], grant)).toBe(true)
    const wider = Result.getOrThrow(bind(["https://example.test/private/a", "https://example.test/public/b"]))
    expect(wider.match("urls", [], grant)).toBe(false)
    expect(Result.isFailure(bind(["https://evil.test/private/a"]))).toBe(true)
  })
  it("binds aliases before public matching and keeps executable edges separate from root grants", () => {
    const { host, seen } = testHost()
    const grant = toolGrant(contract, { id: "process", where: { cwd: { within: ["/safe"] } } })
    const policy = { path: ["/safe"], executable: { roots: ["/bin/root"], edges: [{ root: "/bin/root", descendants: ["/bin/child"] }] } }
    const loaded = Effect.runSync(loadResourcePolicy(policy, [grant], { "process.run": contract }, host))
    const bind = (descendants: readonly string[], executable = "/bin/root", cwd = "/alias") => {
      const input = { executable, descendants, cwd }
      return Effect.runSync(loaded.bind(contract, input, Result.getOrThrow(contract.summarize(input))).pipe(Effect.result))
    }
    const admitted = Result.getOrThrow(bind(["/bin/child"]))
    expect(admitted.summary.public.cwd).toBe("/safe/work")
    expect(admitted.match("cwd", [], grant)).toBe(true)
    expect(admitted.resources.map((resource) => resource.binding.field)).toEqual(["descendants", "executable", "cwd"])
    expect(admitted.resources[0]!.capability).toBe(admitted.resources[1])
    expect(admitted.resources[2]!.binding.rights).toEqual(["read", "write"])
    expect(seen).toContain(admitted.resources[2])
    expect(Result.isFailure(bind(["/bin/root"]))).toBe(true) // Root permission grants no child edge.
    expect(Result.isFailure(bind([], "/bin/child"))).toBe(true) // Child permission grants no root.
    expect(Result.isFailure(bind([], "/bin/root", "/safe-evil"))).toBe(true)
    expect(Result.isFailure(bind(["/bin/child", "/bin/evil"]))).toBe(true)
  })
})
