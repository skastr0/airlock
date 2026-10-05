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
    const target = `${url.protocol}//${url.host}${url.pathname}`
    url.username = ""
    url.password = ""
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
