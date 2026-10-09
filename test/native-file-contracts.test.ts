import { Result, Schema, SchemaAST } from "effect"
import { describe, expect, it } from "vitest"
import { FileContracts, FileMkdir, FileRead, FileWrite } from "../src/native/FileContracts.ts"

const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
  Schema.decodeUnknownResult(schema)(input)

describe("native file contracts", () => {
  it("are five captures and five applies, each under one name", () => {
    expect(Object.fromEntries(FileContracts.map((contract) => [contract.tag, contract.effect]))).toEqual({
      "file.inspect": "capture",
      "file.stat": "capture",
      "file.read": "capture",
      "file.list": "capture",
      "file.glob": "capture",
      "file.write": "apply",
      "file.remove": "apply",
      "file.copy": "apply",
      "file.move": "apply",
      "file.mkdir": "apply"
    })
  })

  it("declare every path a call names as a resource with the rights it needs", () => {
    const read = { kind: "path", rights: ["read"] }
    const write = { kind: "path", rights: ["write"] }
    expect(Object.fromEntries(FileContracts.map((contract) => [contract.tag, contract.resources]))).toEqual({
      "file.inspect": { path: read },
      "file.stat": { path: read },
      "file.read": { path: read },
      "file.list": { path: read },
      "file.glob": { root: read },
      "file.write": { path: write },
      "file.remove": { path: write },
      "file.copy": { source: read, destination: write },
      // A move removes its source, so it needs to write there too.
      "file.move": { source: { kind: "path", rights: ["read", "write"] }, destination: write },
      "file.mkdir": { path: write }
    })
  })

  it("leave no string field that is neither a resource nor plainly not a path", () => {
    const notPaths: { readonly [tool: string]: ReadonlyArray<string> } = {
      "file.read": ["format"],
      "file.glob": ["pattern"],
      "file.write": ["content", "sourceArtifact"],
      "file.mkdir": ["parents"]
    }
    for (const contract of FileContracts) {
      const ast = Schema.toEncoded(contract.input).ast
      const fields = SchemaAST.isObjects(ast) ? ast.propertySignatures.map((field) => String(field.name)) : []
      expect(fields.length, contract.tag).toBeGreaterThan(0)
      expect(
        fields.filter((field) => !(field in contract.resources)).sort(),
        contract.tag
      ).toEqual([...(notPaths[contract.tag] ?? [])].sort())
    }
  })

  it("never show file content outside the handler", () => {
    expect(FileWrite.publicFields).toEqual(["path"])
    const summary = FileWrite.summarize({ path: "/work/note.txt", content: "the secret" })
    expect(Result.isSuccess(summary)).toBe(true)
    if (Result.isSuccess(summary)) {
      expect(summary.success.public).toEqual({ path: "/work/note.txt" })
      expect(JSON.stringify(summary.success)).not.toContain("the secret")
    }
  })

  it("accept exactly one content source for a write", () => {
    expect(Result.isSuccess(decode(FileWrite.input, { path: "/w/a", content: "x" }))).toBe(true)
    expect(Result.isSuccess(decode(FileWrite.input, { path: "/w/a", sourceArtifact: "artifact-1" }))).toBe(true)
    expect(Result.isFailure(decode(FileWrite.input, { path: "/w/a" }))).toBe(true)
    expect(Result.isFailure(decode(FileWrite.input, { path: "/w/a", content: "x", sourceArtifact: "artifact-1" }))).toBe(true)
  })

  it("default a read to text and a mkdir to no parents", () => {
    expect(Result.getOrThrow(decode(FileRead.input, { path: "/w/a" }))).toEqual({ path: "/w/a", format: "text" })
    expect(Result.getOrThrow(decode(FileMkdir.input, { path: "/w/d" }))).toEqual({ path: "/w/d", parents: false })
  })
})
