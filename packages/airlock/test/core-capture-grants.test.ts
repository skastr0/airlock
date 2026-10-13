import { describe, expect, it } from "vitest"
import { Result, Schema } from "effect"
import { toolDispatchDecision, toolGrant, ToolGrantPolicy, validateToolGrants } from "../src/admission/ToolGrant.ts"
import { defineToolContract } from "../src/contract/ToolContract.ts"

const base = { version: "1", input: Schema.Struct({ id: Schema.String }), output: Schema.String, public: ["id"] } as const
const read = defineToolContract({ ...base, name: "read", effect: "capture" })
const write = defineToolContract({ ...base, name: "write", effect: "apply" })
const invoke = defineToolContract({ ...base, name: "invoke", effect: "invoke" })
const request = defineToolContract({ ...base, name: "request", effect: "request" })
const registry = { read, write, invoke, request }
const call = Result.getOrThrow(read.summarize({ id: "a" }))

describe("core: deliberate capture retention grants", () => {
  it("defaults capture-now to digest, and keeps a result only when every fitting grant says keep", () => {
    const digest = toolGrant(read, { id: "digest", when: "now" })
    const keep = toolGrant(read, { id: "keep", when: "now", retention: "keep" })
    expect(toolDispatchDecision([digest], registry, call)).toMatchObject({ _tag: "Now", retention: "digest" })
    expect(toolDispatchDecision([keep], registry, call)).toMatchObject({ _tag: "Now", retention: "keep" })
    for (const grants of [[keep, digest], [digest, keep]]) {
      expect(toolDispatchDecision(grants, registry, call)).toMatchObject({ _tag: "Now", retention: "digest" })
    }
    const elsewhere = toolGrant(read, { id: "elsewhere", when: "now", retention: "digest", where: { id: { equals: "b" } } })
    expect(toolDispatchDecision([keep, elsewhere], registry, call)).toMatchObject({ _tag: "Now", retention: "keep" })
  })

  it("rejects any explicit retention on approved capture, apply, invoke or request at load", () => {
    for (const contract of [read, write, invoke, request]) {
      for (const retention of ["digest", "keep"] as const) {
        const grant = new ToolGrantPolicy({ id: "bad", tool: contract.tag, when: "approved", retention })
        expect(validateToolGrants([grant], registry)?.field).toContain("retention")
      }
    }
    for (const contract of [write, invoke, request]) {
      expect(validateToolGrants([new ToolGrantPolicy({ id: "bad", tool: contract.tag, when: "now", retention: "keep" })], registry)?.field).toContain("retention")
    }
    expect(validateToolGrants([toolGrant(read, { id: "approved" })], registry)).toBeUndefined()
    if (false) {
      // @ts-expect-error approved captures cannot retain result bytes
      toolGrant(read, { id: "bad", when: "approved", retention: "keep" })
      // @ts-expect-error retention belongs to capture, never apply
      toolGrant(write, { id: "bad", when: "now", retention: "keep" })
      // @ts-expect-error requests cannot declare capture retention
      toolGrant(request, { id: "bad", retention: "digest" })
    }
  })
})
