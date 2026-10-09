import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { endpointResources, portableToolHost } from "../src/core/contract/PortableToolHost.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"

const contract = (effect: "capture" | "invoke" | "apply" | "request") => defineToolContract({
  name: `test.${effect}`, version: "1", effect,
  input: Schema.Struct({ endpoint: Schema.String }), output: Schema.String,
  public: ["endpoint"], resources: { endpoint: { kind: "endpoint", rights: ["connect"] } }
})

describe("core: portable tool host", () => {
  it("refuses unsupported resources and noncapture now grants at load", () => {
    for (const effect of ["capture", "invoke", "apply", "request"] as const) {
      const tool = contract(effect)
      const now = portableToolHost.validateGrant({ contract: tool, grant: { tool: tool.tag, when: "now" } })
      expect(Result.isSuccess(now)).toBe(effect === "capture")
      expect(Result.isSuccess(portableToolHost.validateGrant({ contract: tool, grant: { tool: tool.tag, when: "approved" } }))).toBe(true)
    }
    const file = defineToolContract({ name: "file.read", version: "1", effect: "capture", input: Schema.Struct({ path: Schema.String }),
      output: Schema.String, public: ["path"], resources: { path: { kind: "path", rights: ["read"] } } })
    expect(Result.isFailure(portableToolHost.validateGrant({ contract: file, grant: { tool: file.tag, when: "approved" } }))).toBe(true)
    expect(Result.isFailure(portableToolHost.validateGrant({ contract: contract("capture"), grant: { tool: "test.capture", when: "now", host: { profile: "unknown" } } }))).toBe(true)
  })

  it.effect("uses one bound endpoint for both scope intersections and persists exact URL identity", () => Effect.gen(function* () {
    const ceiling = yield* endpointResources.scope({ kind: "endpoint", selectors: ["https://example.com/v1/*"] })
    const narrow = yield* endpointResources.scope({ kind: "endpoint", selectors: ["https://example.com/v1/items"] })
    const resource = yield* endpointResources.bind({ kind: "endpoint", selector: "https://example.com/v1/items?key=value", rights: ["emit"], field: "endpoint" })
    expect(endpointResources.within(resource, ceiling)).toBe(true)
    expect(endpointResources.within(resource, narrow)).toBe(true)
    expect(resource.binding.identity).toEqual({ url: "https://example.com/v1/items?key=value" })
    const other = yield* endpointResources.bind({ kind: "endpoint", selector: "https://example.com/v1/other", rights: ["connect"], field: "endpoint" })
    expect(endpointResources.within(other, ceiling)).toBe(true)
    expect(endpointResources.within(other, narrow)).toBe(false)
    expect(endpointResources.within({ ...resource }, ceiling)).toBe(false)
    expect(endpointResources.within(resource, { ...ceiling })).toBe(false)
    const rebound = yield* endpointResources.rebind({ binding: JSON.parse(JSON.stringify(resource.binding)) })
    expect(rebound.binding).toEqual(resource.binding)
    const changed = yield* endpointResources.rebind({ binding: { ...resource.binding, identity: { url: "https://example.com/v1/items?changed=true" } } }).pipe(Effect.result)
    expect(Result.isFailure(changed)).toBe(true)
  }))

  it.effect("refuses credential, normalized-traversal, invalid-right and unsupported bindings", () => Effect.gen(function* () {
    for (const selector of ["https://user:secret@example.com/v1/items", "https://example.com/v1/../admin", "https://example.com/v1/%2e%2e/admin", "file:///etc/passwd"]) {
      const refused = yield* endpointResources.bind({ kind: "endpoint", selector, rights: ["connect"], field: "endpoint" }).pipe(Effect.result)
      expect(Result.isFailure(refused)).toBe(true)
      expect(JSON.stringify(refused)).not.toContain("user:secret")
    }
    const invalid = yield* endpointResources.bind({ kind: "endpoint", selector: "https://example.com/", rights: ["write"], field: "endpoint" }).pipe(Effect.result)
    expect(Result.isFailure(invalid)).toBe(true)
    const unsupported = yield* endpointResources.scope({ kind: "path", selectors: ["/"] }).pipe(Effect.result)
    expect(Result.isFailure(unsupported)).toBe(true)
    const widened = yield* endpointResources.scope({ kind: "endpoint", selectors: ["https://example.com/?token=private"] }).pipe(Effect.result)
    expect(Result.isFailure(widened)).toBe(true)
  }))

  it.effect("refuses unbounded identity evidence", () => Effect.gen(function* () {
    const bound = yield* endpointResources.bind({ kind: "endpoint", selector: `https://example.com/?q=${"x".repeat(9_000)}`, rights: ["emit"], field: "endpoint" }).pipe(Effect.result)
    expect(Result.isFailure(bound)).toBe(true)
  }))
})
