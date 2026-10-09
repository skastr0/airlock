import { describe, expect, it } from "vitest"
import { Result, Schema } from "effect"
import { defineToolContract, InvalidToolContract } from "../src/core/contract/ToolContract.ts"

const base = {
  name: "file.transfer",
  version: "1",
  effect: "apply",
  input: Schema.Struct({ source: Schema.String, destination: Schema.String, paths: Schema.Array(Schema.String), count: Schema.Number, secret: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  public: ["source", "destination", "paths", "count"]
} as const

describe("core: resource-bearing contracts", () => {
  it("marks every operand independently, with rights and explicit list semantics", () => {
    const contract = defineToolContract({ ...base, resources: {
      source: { kind: "path", rights: ["read", "write"] },
      destination: { kind: "path", rights: ["write"] },
      paths: { kind: "path", rights: ["read"], collection: "each" }
    } })
    expect(contract.resources.source.rights).toEqual(["read", "write"])
    expect(contract.resources.paths.collection).toBe("each")
    const summary = Result.getOrThrow(contract.summarize({ source: "/a", destination: "/b", paths: ["/c"], count: 1, secret: "private" }))
    expect(summary.public).toEqual({ source: "/a", destination: "/b", paths: ["/c"], count: 1 })
    expect(JSON.stringify(summary)).not.toContain("private")
  })

  it("rejects private, mismatched, duplicate and unsupported descriptors from JavaScript", () => {
    const invalid = (resources: unknown) => defineToolContract({ ...base, resources: resources as never })
    for (const resources of [
      { secret: { kind: "path", rights: ["read"] } },
      { count: { kind: "path", rights: ["read"] } },
      { paths: { kind: "path", rights: ["read"] } },
      { source: { kind: "path", rights: ["read"], collection: "each" } },
      { source: { kind: "path", rights: ["read", "read"] } },
      { source: { kind: "path", rights: ["emit"] } },
      { source: { kind: "device", rights: ["read"] } }
    ]) expect(() => invalid(resources)).toThrow(InvalidToolContract)

    const numberDecodedFromString = { ...base, input: Schema.Struct({ source: Schema.NumberFromString }), public: ["source"] } as const
    expect(() => defineToolContract({ ...numberDecodedFromString, resources: { source: { kind: "path", rights: ["read"] } } })).toThrow(InvalidToolContract)
  })

  it("binds descendants to a scalar root and owns its metadata", () => {
    const resources = {
      root: { kind: "executable", role: "root", rights: ["invoke"] },
      children: { kind: "executable", role: "descendant", parent: "root", rights: ["execute"], collection: "each" }
    } as const
    const contract = defineToolContract({ name: "process.run", version: "1", effect: "invoke",
      input: Schema.Struct({ root: Schema.String, children: Schema.Array(Schema.String) }),
      output: Schema.Boolean, public: ["root", "children"], resources })
    expect(contract.resources.children.parent).toBe("root")
    expect(contract.resources).not.toBe(resources)
    expect(Object.isFrozen(contract.resources.children.rights)).toBe(true)
    expect(() => defineToolContract({ name: "bad.process", version: "1", effect: "invoke",
      input: Schema.Struct({ children: Schema.Array(Schema.String) }), output: Schema.Boolean,
      public: ["children"], resources: { children: { ...resources.children, parent: "children" } } })).toThrow(InvalidToolContract)
  })

  it("rejects resource fields that are private or have the wrong encoded type at compile time", () => {
    const privateField = () => defineToolContract({ ...base, resources: {
      // @ts-expect-error private input is not authority visible to a grant
      secret: { kind: "path", rights: ["read"] }
    } })
    // @ts-expect-error a number is not a resource selector
    const number = () => defineToolContract({ ...base, resources: {
      count: { kind: "path", rights: ["read"] }
    } })
    const list = () => defineToolContract({ ...base, resources: {
      // @ts-expect-error each is required for a list of selectors
      paths: { kind: "path", rights: ["read"] }
    } })
    expect([privateField, number, list].every((declaration) => typeof declaration === "function")).toBe(true)
  })
})
