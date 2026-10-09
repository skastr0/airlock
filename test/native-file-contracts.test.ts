import { Result, Schema } from "effect"
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

  it("make every path a call names public, so a grant can bound it", () => {
    const paths: { readonly [tool: string]: ReadonlyArray<string> } = {
      "file.inspect": ["path"],
      "file.stat": ["path"],
      "file.read": ["path"],
      "file.list": ["path"],
      "file.glob": ["root"],
      "file.write": ["path"],
      "file.remove": ["path"],
      "file.copy": ["source", "destination"],
      "file.move": ["source", "destination"],
      "file.mkdir": ["path"]
    }
    for (const contract of FileContracts) {
      for (const field of paths[contract.tag]!) {
        expect(contract.publicFields, `${contract.tag}.${field}`).toContain(field)
      }
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
