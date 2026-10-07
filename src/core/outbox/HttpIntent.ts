import { Result, Schema } from "effect"
import { defineIntentKind } from "./Intent.ts"
import { InvalidIntent } from "./Records.ts"

export const HttpMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"])
export type HttpMethod = typeof HttpMethod.Type

/** The request exactly as it will be sent. Private: stored sealed, never listed. */
export const HttpDispatch = Schema.Struct({
  url: Schema.String,
  method: HttpMethod,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optionalKey(Schema.String)
})
export type HttpDispatch = typeof HttpDispatch.Type

/** Names and sizes, never values. */
export const HttpSummary = Schema.Struct({
  method: HttpMethod,
  /** The URL with userinfo, query values and fragment removed. */
  endpoint: Schema.String,
  /** `scheme://host/path`: what a supervisor grant is matched against. */
  target: Schema.String,
  headerNames: Schema.Array(Schema.String),
  bodyBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type HttpSummary = typeof HttpSummary.Type

export const HttpOutcome = Schema.Struct({
  status: Schema.Int,
  contentType: Schema.optionalKey(Schema.String)
})
export type HttpOutcome = typeof HttpOutcome.Type

const encoder = new TextEncoder()

const invalid = (field: string, reason: string) =>
  Result.fail(new InvalidIntent({ kind: "http", field, reason }))

/**
 * A request is stored exactly as it will be sent, so a credential written into
 * it would sit in the store in plain text. Airlock holds no credentials: they
 * belong to the owner, in whatever sends on their behalf (a proxy that adds
 * the header, or a tool implementation reading its own environment). A request
 * that carries one literally is refused before anything is stored.
 *
 * This is a name match and cannot catch everything: a secret under a header
 * called `X-Trace` passes. It refuses the well-known positions so that the
 * ordinary mistake fails loudly.
 */
// Short aliases are whole names: a `sig` is a credential, a `design` is not.
const credentialName = /key|token|secret|auth|password|passwd|credential|session|cookie|signature|^(?:sig|pwd|jwt|bearer|assertion|client_assertion)$/i

const credentialPosition = (dispatch: HttpDispatch, url: URL): { field: string; what: string } | undefined => {
  if (url.username !== "" || url.password !== "") {
    return { field: "url", what: "user information in the URL" }
  }
  // `code` also names ordinary data; with `state` it has the OAuth callback shape.
  const callback = [...url.searchParams.keys()].some((name) => name.toLowerCase() === "state")
  for (const name of url.searchParams.keys()) {
    if (credentialName.test(name) || (callback && name.toLowerCase() === "code")) {
      return { field: `url query parameter ${name}`, what: `query parameter ${name}` }
    }
  }
  for (const name of Object.keys(dispatch.headers)) {
    if (credentialName.test(name)) return { field: `headers.${name}`, what: `header ${name}` }
  }
  return undefined
}

/**
 * HTTP as an intent kind. Everything here is pure: the handler that performs
 * the request is a host's Dispatcher Layer.
 */
export const HttpIntent = defineIntentKind({
  tag: "http",
  dispatch: HttpDispatch,
  summary: HttpSummary,
  outcome: HttpOutcome,
  summarize: (dispatch) => {
    if (!URL.canParse(dispatch.url)) {
      return invalid("url", "expected an absolute http or https URL")
    }
    const url = new URL(dispatch.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return invalid("url", "expected an absolute http or https URL")
    }
    const credential = credentialPosition(dispatch, url)
    if (credential !== undefined) {
      return invalid(
        credential.field,
        `${credential.what} looks like a credential, and requests are stored as sent; ` +
          "have the owner's proxy or the tool implementation add it instead"
      )
    }
    const target = `${url.protocol}//${url.host}${url.pathname}`
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "[redacted]")
    url.hash = ""
    return Result.succeed({
      method: dispatch.method,
      endpoint: url.toString(),
      target,
      headerNames: Object.keys(dispatch.headers).sort((a, b) => a.localeCompare(b)),
      bodyBytes: dispatch.body === undefined ? 0 : encoder.encode(dispatch.body).byteLength
    })
  },
  target: (summary) => summary.target
})
