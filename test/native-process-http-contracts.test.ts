import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { HttpGet, HttpStage, ProcessRun } from "../src/native/index.ts"

const accepts = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

describe("process.run contract", () => {
  const call = { executable: "/usr/bin/true", args: [], cwd: "/work" }

  it("is an invoke whose every authority-bearing operand is a declared resource", () => {
    expect(ProcessRun.effect).toBe("invoke")
    expect(ProcessRun.resources).toEqual({
      executable: { kind: "executable", role: "root", rights: ["invoke"] },
      descendantExecutables: {
        kind: "executable", role: "descendant", parent: "executable", rights: ["execute"], collection: "each"
      },
      cwd: { kind: "path", rights: ["read", "write"] }
    })
  })

  it("has no input that chooses its own confinement", () => {
    expect(accepts(ProcessRun.input, call)).toBe(true)
    const decoded = Result.getOrThrow(Schema.decodeUnknownResult(ProcessRun.input)(call))
    expect(Object.keys(decoded)).not.toContain("cellProfile")
    expect(Object.keys(decoded)).not.toContain("realm")
  })

  it("shows a reviewer the arguments and environment but never standard input text", () => {
    const summary = Result.getOrThrow(ProcessRun.summarize(
      Result.getOrThrow(Schema.decodeUnknownResult(ProcessRun.input)({
        ...call,
        args: ["--flag"],
        env: { MODE: "dry" },
        stdin: "the secret"
      }))
    ))
    expect(summary.public).toMatchObject({ executable: "/usr/bin/true", args: ["--flag"], env: { MODE: "dry" } })
    expect(JSON.stringify(summary)).not.toContain("the secret")
  })

  it("takes standard input from text or an artifact, never both, and never the terminal", () => {
    expect(accepts(ProcessRun.input, { ...call, stdin: "x" })).toBe(true)
    expect(accepts(ProcessRun.input, { ...call, stdinArtifact: "artifact-1" })).toBe(true)
    expect(accepts(ProcessRun.input, { ...call, stdin: "x", stdinArtifact: "artifact-1" })).toBe(false)
    expect(accepts(ProcessRun.input, { ...call, stdout: "inherit" })).toBe(false)
    expect(accepts(ProcessRun.input, { ...call, timeoutMs: 0 })).toBe(false)
  })
})

describe("http contracts", () => {
  it("make observing a capture and sending a request", () => {
    expect(HttpGet.effect).toBe("capture")
    expect(HttpGet.resources).toEqual({ endpoint: { kind: "endpoint", rights: ["connect"] } })
    expect(HttpStage.effect).toBe("request")
    expect(HttpStage.resources).toEqual({ endpoint: { kind: "endpoint", rights: ["emit"] } })
  })

  it("give http.get no way to carry data out", () => {
    const get = (input: Record<string, unknown>) => accepts(HttpGet.input, input)
    expect(get({ endpoint: "https://example.test/v1/status" })).toBe(true)
    for (const endpoint of [
      "https://example.test/v1/status?token=abc",
      "https://example.test/v1/status?",
      "https://example.test/v1/status#frag",
      "https://example.test/v1/status#",
      "https://user:secret@example.test/v1/status",
      "file:///etc/passwd",
      "/v1/status",
      "not a url"
    ]) expect(get({ endpoint }), endpoint).toBe(false)
    expect(get({ endpoint: "https://example.test/", accept: "text/plain" })).toBe(true)
    expect(get({ endpoint: "https://example.test/", accept: "x-data/secret" })).toBe(false)

    const fields = Object.keys(Result.getOrThrow(
      Schema.decodeUnknownResult(HttpGet.input)({ endpoint: "https://example.test/" })
    ))
    expect(fields.sort()).toEqual(["accept", "endpoint"])
  })

  it("keep a staged request's body and headers out of its public summary", () => {
    const summary = Result.getOrThrow(HttpStage.summarize({
      endpoint: "https://example.test/send",
      method: "POST",
      headers: { authorization: "Bearer hidden" },
      body: "the payload",
      holdMillis: 0
    }))
    expect(summary.public).toEqual({ endpoint: "https://example.test/send", method: "POST", holdMillis: 0 })
    expect(JSON.stringify(summary)).not.toContain("hidden")
    expect(JSON.stringify(summary)).not.toContain("the payload")
    expect(accepts(HttpStage.input, {
      endpoint: "https://example.test/send", method: "POST", body: "a", bodyArtifact: "artifact-1"
    })).toBe(false)
  })
})
