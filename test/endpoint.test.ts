import { describe, expect, it } from "vitest"
import { canonicalizeEndpoint, canonicalizeEndpointSelector } from "../src/core/admission/Endpoint.ts"

describe("endpoint canonicalization", () => {
  it("accepts only an endpoint already in its normalized form", () => {
    expect(canonicalizeEndpoint("https://STATUS.Internal.example/v1/health")).toMatchObject({
      _tag: "Success",
      success: { target: "https://status.internal.example/v1/health" }
    })
    for (const [url, reason] of [
      ["https://status.internal.example/v1/../admin", "not-canonical"],
      ["https://status.internal.example:443/v1/health", "not-canonical"],
      ["https://u:p@status.internal.example/v1", "userinfo-present"],
      ["file:///etc/passwd", "unsupported-scheme"],
      ["not a url", "unparseable"]
    ] as const) {
      expect(canonicalizeEndpoint(url)).toMatchObject({ _tag: "Failure", failure: { reason } })
    }
  })

  it("keeps query and fragment out of every selector", () => {
    expect(canonicalizeEndpointSelector("https://status.internal.example/v1/*")).toMatchObject({
      _tag: "Success",
      success: { target: "https://status.internal.example/v1/", prefix: true }
    })
    for (const selector of ["https://status.internal.example/v1?x=1", "https://status.internal.example/v1#top"]) {
      expect(canonicalizeEndpointSelector(selector)).toMatchObject({ _tag: "Failure", failure: { reason: "not-canonical" } })
    }
  })
})
