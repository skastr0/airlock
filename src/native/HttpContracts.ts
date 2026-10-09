import { Effect, Result, Schema } from "effect"
import { HttpIntent } from "../core/outbox/HttpIntent.ts"
import { defineToolContract } from "../core/contract/ToolContract.ts"
import { ArtifactId } from "./Artifacts.ts"

/**
 * HTTP as two tool contracts with two different meanings.
 *
 * `http.get` observes: it is a capture, so it may run when called. For that
 * to be safe it must not be a way to send: it has no body, its endpoint has
 * no query and no fragment, and the only header a call chooses comes from a
 * fixed list. What it can say to the server is which granted endpoint it
 * asked for.
 *
 * `http.stage` sends: it is a request, so it is staged and reaches the wire
 * only when a person commits it.
 */

const Response = {
  status: Schema.Finite,
  content_type: Schema.NullOr(Schema.String),
  /** Bytes kept, at most the host's response limit. */
  bytes: Schema.Finite,
  truncated: Schema.Boolean
}

const observable = (endpoint: string): true | string => {
  if (!URL.canParse(endpoint)) return "endpoint must be an absolute URL"
  const url = new URL(endpoint)
  if (url.protocol !== "https:" && url.protocol !== "http:") return "endpoint must be http or https"
  if (url.username !== "" || url.password !== "") return "endpoint must not carry credentials"
  // `URL` drops an empty query or fragment, so the text is checked too.
  if (url.search !== "" || url.hash !== "" || endpoint.includes("?") || endpoint.includes("#")) {
    return "endpoint must not carry a query or a fragment; use http.stage to send one"
  }
  return true
}

export const HttpGet = defineToolContract({
  name: "http.get",
  version: "1",
  effect: "capture",
  input: Schema.Struct({
    endpoint: Schema.String.check(Schema.makeFilter(observable)),
    accept: Schema.Literals(["application/json", "text/plain", "*/*"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("application/json" as const))
    )
  }),
  output: Schema.Struct({
    ...Response,
    /** The response text, when it is text and fits. */
    body: Schema.NullOr(Schema.String)
  }),
  public: ["endpoint", "accept"],
  resources: { endpoint: { kind: "endpoint", rights: ["connect"] } },
  /** The whole request. An implementation cannot add to it. */
  wire: (input) => ({ endpoint: "endpoint", method: "GET", headers: { accept: input.accept } })
})

export const HttpStage = defineToolContract({
  name: "http.stage",
  version: "1",
  effect: "request",
  input: Schema.Struct({
    endpoint: Schema.String,
    method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    headers: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({}))
    ),
    body: Schema.optionalKey(Schema.String),
    /** An artifact of this run to send as the body. */
    bodyArtifact: Schema.optionalKey(ArtifactId),
    /** How long a commit waits before the request is sent, so it can be cancelled. */
    holdMillis: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(30_000))
    )
  }).pipe(
    Schema.check(
      Schema.makeFilter((input) =>
        input.body === undefined || input.bodyArtifact === undefined ||
        "provide at most one of body and bodyArtifact"
      ),
      // A staged call is stored as it will be sent, so the rule every stored
      // request obeys applies here: http or https, and no credential in it.
      // The check also runs before the header default is filled in.
      Schema.makeFilter((input) => {
        const stored = HttpIntent.summarize({ url: input.endpoint, method: input.method, headers: input.headers ?? {} })
        return Result.isSuccess(stored) || `${stored.failure.field}: ${stored.failure.reason}`
      })
    )
  ),
  /** What came back once the request was committed and sent. */
  output: Schema.Struct({
    ...Response,
    response_artifact: Schema.NullOr(ArtifactId)
  }),
  public: ["endpoint", "method", "bodyArtifact", "holdMillis"],
  resources: { endpoint: { kind: "endpoint", rights: ["emit"] } },
  /** The whole request, as staged. An implementation cannot change it. */
  wire: (input) => ({
    endpoint: "endpoint",
    method: input.method,
    headers: input.headers,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.bodyArtifact === undefined ? {} : { bodyArtifact: input.bodyArtifact })
  })
})
