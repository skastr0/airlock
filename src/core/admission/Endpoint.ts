import { Result, Schema } from "effect"

export class EndpointNotCanonical extends Schema.TaggedError<EndpointNotCanonical>()(
  "EndpointNotCanonical",
  {
    url: Schema.String,
    reason: Schema.Literals([
      "unparseable",
      "unsupported-scheme",
      "userinfo-present",
      "not-canonical"
    ])
  }
) {}

/**
 * A canonicalized endpoint. `target` is the only value a selector prefix is
 * ever compared against: query and fragment never participate in a match.
 */
export type CanonicalEndpoint = Readonly<{
  readonly scheme: string
  readonly host: string
  readonly path: string
  readonly target: string
  readonly hasQuery: boolean
  readonly hasFragment: boolean
}>

const rawAuthorityAndPath = (raw: string) => {
  const schemeMark = raw.indexOf("://")
  if (schemeMark < 0) return undefined
  const authorityStart = schemeMark + 3
  const authorityEnd = ["/", "?", "#"].reduce((end, mark) => {
    const at = raw.indexOf(mark, authorityStart)
    return at >= 0 && at < end ? at : end
  }, raw.length)
  const rest = raw.slice(authorityEnd)
  const pathEnd = ["?", "#"].reduce((end, mark) => {
    const at = rest.indexOf(mark)
    return at >= 0 && at < end ? at : end
  }, rest.length)
  return {
    authority: raw.slice(authorityStart, authorityEnd),
    path: rest.slice(0, pathEnd)
  }
}

/**
 * A raw string prefix cannot be the load-bearing check for a request:
 * `https://host/v1/../admin` prefix-matches `https://host/v1/*` while `fetch`
 * normalizes it to a different resource. Canonicalization parses the URL,
 * refuses userinfo outright, and refuses any URL whose authority or path text
 * is not already its normalized form.
 */
export const canonicalizeEndpoint = (
  raw: string
): Result.Result<CanonicalEndpoint, EndpointNotCanonical> => {
  const parts = rawAuthorityAndPath(raw)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return Result.fail(new EndpointNotCanonical({ url: raw, reason: "unparseable" }))
  }
  if (parts === undefined) {
    return Result.fail(new EndpointNotCanonical({ url: raw, reason: "unparseable" }))
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Result.fail(new EndpointNotCanonical({ url: raw, reason: "unsupported-scheme" }))
  }
  if (url.username !== "" || url.password !== "" || parts.authority.includes("@")) {
    return Result.fail(new EndpointNotCanonical({ url: raw, reason: "userinfo-present" }))
  }
  const path = parts.path.length === 0 ? "/" : parts.path
  if (url.host !== parts.authority.toLowerCase() || url.pathname !== path) {
    return Result.fail(new EndpointNotCanonical({ url: raw, reason: "not-canonical" }))
  }
  const scheme = url.protocol.slice(0, -1)
  return Result.succeed({
    scheme,
    host: url.host,
    path: url.pathname,
    target: `${scheme}://${url.host}${url.pathname}`,
    hasQuery: url.search.length > 0,
    hasFragment: url.hash.length > 0 || raw.includes("#")
  })
}

type CanonicalSelector = Readonly<{
  readonly target: string
  readonly prefix: boolean
}>

/**
 * Selectors are canonicalized on the same rules as endpoints, and additionally
 * may carry no query or fragment: a selector that named one would silently
 * widen every match computed on the normalized path.
 */
export const canonicalizeEndpointSelector = (
  selector: string
): Result.Result<CanonicalSelector, EndpointNotCanonical> => {
  const prefix = selector.endsWith("*")
  const base = prefix ? selector.slice(0, -1) : selector
  const canonical = canonicalizeEndpoint(base)
  if (Result.isFailure(canonical)) {
    return Result.fail(new EndpointNotCanonical({ url: selector, reason: canonical.failure.reason }))
  }
  if (canonical.success.hasQuery || canonical.success.hasFragment) {
    return Result.fail(new EndpointNotCanonical({ url: selector, reason: "not-canonical" }))
  }
  return Result.succeed({ target: canonical.success.target, prefix })
}
