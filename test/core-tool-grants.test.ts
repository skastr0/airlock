import { describe, expect, it } from "vitest"
import { DateTime, Result, Schema } from "effect"
import { fittingToolGrants, toolDispatchDecision, toolGrant, ToolGrantPolicy, validateToolGrants } from "../src/core/admission/ToolGrant.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { portableToolHost } from "../src/core/contract/PortableToolHost.ts"
import type { ToolHost } from "../src/core/contract/ToolHost.ts"

const inspect = defineToolContract({ name: "inspect", version: "1", effect: "capture",
  input: Schema.Struct({ path: Schema.String, names: Schema.Array(Schema.String), count: Schema.Number }),
  output: Schema.Boolean, public: ["path", "names", "count"], resources: { path: { kind: "endpoint", rights: ["connect"] } } })
const call = (names: readonly string[], count = 2) => Result.getOrThrow(inspect.summarize({ path: "https://example.test/root", names, count }))
const registry = { inspect }
const host: ToolHost = { ...portableToolHost, validateGrant: () => Result.succeed(undefined) }

describe("core: tool grant timing and typed matchers", () => {
  it("defaults to approval and refuses obsolete fields instead of converting them", () => {
    expect(toolGrant(inspect, { id: "default" }).when).toBe("approved")
    expect(() => Schema.decodeUnknownSync(ToolGrantPolicy, { onExcessProperty: "error" })({ id: "old", tool: "inspect", class: "read", commit: "auto" })).toThrow()
  })
  it("requires every list member and numeric bound to fit the same grant", () => {
    const grant = toolGrant(inspect, { id: "fit", where: { names: { subsetOf: ["a", "b"] }, count: { range: { min: 1, max: 3 } } } })
    expect(validateToolGrants([grant], registry)).toBeUndefined()
    expect(fittingToolGrants([grant], call(["a", "b"]))).toHaveLength(1)
    expect(fittingToolGrants([grant], call(["a", "evil"]))).toHaveLength(0)
    expect(fittingToolGrants([grant], call(["a"], 4))).toHaveLength(0)
    const empty = toolGrant(inspect, { id: "empty", where: { count: { range: {} } } })
    expect(validateToolGrants([empty], registry)?.reason).toContain("finite ordered bounds")
    expect(validateToolGrants([new ToolGrantPolicy({ id: "wrong-members", tool: "inspect", where: { names: { subsetOf: [1] } } })], registry)?.reason).toContain("list element schema")
    if (false) {
      // @ts-expect-error startsWith is not a numeric matcher
      toolGrant(inspect, { id: "bad", where: { count: { startsWith: "1" } } })
      // @ts-expect-error list members are strings
      toolGrant(inspect, { id: "bad", where: { names: { subsetOf: [1] } } })
      // @ts-expect-error within is only for declared resource operands
      toolGrant(inspect, { id: "bad", where: { names: { within: ["a"] } } })
    }
  })
  it("never evaluates physical within as a textual match", () => {
    const grant = toolGrant(inspect, { id: "scope", where: { path: { within: ["https://example.test/*"] } } })
    expect(fittingToolGrants([grant], call([]))).toHaveLength(0)
    expect(fittingToolGrants([grant], call([]), () => false)).toHaveLength(0)
    expect(fittingToolGrants([grant], call([]), (field, selectors, actual) => field === "path" && selectors[0] === "https://example.test/*" && actual === grant)).toHaveLength(1)
  })
  it("requires all fitting grants to allow now and refuses conflicting parameters in either order", () => {
    const now = toolGrant(inspect, { id: "now", when: "now" })
    const approved = toolGrant(inspect, { id: "approved" })
    for (const grants of [[now, approved], [approved, now]]) expect(toolDispatchDecision(grants, registry, call([]))._tag).toBe("Approved")
    const a = toolGrant(inspect, { id: "a", when: "now", host: { profile: "a" } })
    const b = toolGrant(inspect, { id: "b", when: "now", host: { profile: "b" } })
    const omitted = toolGrant(inspect, { id: "omitted", when: "now" })
    const empty = toolGrant(inspect, { id: "empty", when: "now", host: {} })
    for (const grants of [[a, b], [b, a], [omitted, empty], [empty, omitted]]) {
      expect(toolDispatchDecision(grants, registry, call([]), { host })).toMatchObject({ _tag: "Refused", reason: "fitting grants disagree on host parameters" })
    }
  })
  it("expires exactly at the earliest fitting deadline without falling back to another grant", () => {
    const deadline = DateTime.makeUnsafe("2026-10-09T10:00:00Z")
    const expiring = toolGrant(inspect, { id: "expiring", when: "now", validUntil: deadline })
    const other = toolGrant(inspect, { id: "other", when: "now" })
    expect(toolDispatchDecision([expiring, other], registry, call([]), { now: deadline })).toMatchObject({ _tag: "Refused", reason: "a fitting grant has expired" })
    expect(toolDispatchDecision([other, expiring], registry, call([]), { now: DateTime.makeUnsafe("2026-10-09T09:59:59Z") })).toMatchObject({ _tag: "Now", validUntil: deadline })
  })
})
