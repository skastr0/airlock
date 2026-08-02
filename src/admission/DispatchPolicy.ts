import { Either, Schema } from "effect"

/**
 * Dispatch classes are supervisor-grant-side facts. They exist only inside a
 * supervisor policy document: no Plan node, program text, tool definition, or
 * third-party annotation carries this vocabulary, and none of them can select
 * or widen a class. `refuseGrantAssertion` is the typed refusal for any
 * agent-side text that tries.
 *
 * Nothing here dispatches. This module decides *whether a staged intent is
 * eligible for a policy auto-commit*; the auto-commit itself is an ordinary
 * call to `Outbox.commit`, which remains the single wire-capable site.
 */

/**
 * The supervisor's judgment about the consequence envelope of dispatching an
 * admitted intent.
 *
 * - `read` — the supervisor asserts the endpoint treats the declared
 *   method/route as an idempotent observation.
 * - `mutate` — remote state may change under a provider-claimed compensation.
 *   Compensation is a provider claim, never an Airlock guarantee.
 * - `irreversible-send` — the default and the floor.
 */
export const DispatchClass = Schema.Literal("read", "mutate", "irreversible-send")
export type DispatchClass = typeof DispatchClass.Type

const strictness: Record<DispatchClass, number> = {
  read: 0,
  mutate: 1,
  "irreversible-send": 2
}

/** Ordering is `read < mutate < irreversible-send`; the stricter side always wins. */
export const stricterDispatchClass = (
  left: DispatchClass,
  right: DispatchClass
): DispatchClass => (strictness[left] >= strictness[right] ? left : right)

/**
 * Who may turn a durably staged intent into a dispatch. `auto` never skips
 * staging and never adds a second wire-capable call site: it authorises the
 * trusted runtime to call the ordinary `Outbox.commit` once `StageExternal`
 * has durably completed.
 */
export const CommitMode = Schema.Literal("auto", "supervisor")
export type CommitMode = typeof CommitMode.Type

export const EndpointMethod = Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE")
export type EndpointMethod = typeof EndpointMethod.Type

/** Grant-side bounds on the staged hold window a `RequestExternal` may declare. */
export const EndpointHoldPolicy = Schema.Struct({
  minMillis: Schema.optional(Schema.NonNegativeInt),
  maxMillis: Schema.optional(Schema.NonNegativeInt)
})
export type EndpointHoldPolicy = typeof EndpointHoldPolicy.Type

export const EndpointBudget = Schema.Struct({
  /**
   * A per-run dispatch counter owned by the supervisor dispatch engine.
   * Admission does not count runs and therefore does not enforce this field.
   */
  maxDispatchesPerRun: Schema.optional(Schema.NonNegativeInt),
  /**
   * Enforced by admission against inline `RequestExternal` bodies only.
   * Artifact-backed bodies are unknown until staging resolves them.
   */
  maxBodyBytes: Schema.optional(Schema.NonNegativeInt)
})
export type EndpointBudget = typeof EndpointBudget.Type

/**
 * One endpoint grant entry. Omitting `class` and `commit` reproduces the v1
 * posture exactly: an irreversible-send floor that stays staged until an
 * explicit supervisor commit.
 */
export class EndpointGrantPolicy extends Schema.Class<EndpointGrantPolicy>(
  "EndpointGrantPolicy"
)({
  /** Exact endpoint or a trailing `*` prefix, matched after canonicalization. */
  selector: Schema.String,
  /** Omitted means method-agnostic, as in v1. `commit: "auto"` requires an explicit list. */
  methods: Schema.optional(Schema.Array(EndpointMethod)),
  class: Schema.optionalWith(DispatchClass, {
    default: (): DispatchClass => "irreversible-send"
  }),
  commit: Schema.optionalWith(CommitMode, {
    default: (): CommitMode => "supervisor"
  }),
  hold: Schema.optional(EndpointHoldPolicy),
  budget: Schema.optional(EndpointBudget)
}) {}

export class EndpointNotCanonical extends Schema.TaggedError<EndpointNotCanonical>()(
  "EndpointNotCanonical",
  {
    url: Schema.String,
    reason: Schema.Literal(
      "unparseable",
      "unsupported-scheme",
      "userinfo-present",
      "not-canonical"
    )
  }
) {}

export class DispatchClassAssertionRejected
  extends Schema.TaggedError<DispatchClassAssertionRejected>()(
    "DispatchClassAssertionRejected",
    { field: Schema.String, reason: Schema.String }
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
 * A raw string prefix cannot be the load-bearing check for an unattended
 * dispatch: `https://host/v1/../admin` prefix-matches `https://host/v1/*`
 * while `fetch` normalizes it to a different resource. Canonicalization parses
 * the URL, refuses userinfo outright, and refuses any URL whose authority or
 * path text is not already its normalized form.
 */
export const canonicalizeEndpoint = (
  raw: string
): Either.Either<CanonicalEndpoint, EndpointNotCanonical> => {
  const parts = rawAuthorityAndPath(raw)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return Either.left(new EndpointNotCanonical({ url: raw, reason: "unparseable" }))
  }
  if (parts === undefined) {
    return Either.left(new EndpointNotCanonical({ url: raw, reason: "unparseable" }))
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Either.left(new EndpointNotCanonical({ url: raw, reason: "unsupported-scheme" }))
  }
  if (url.username !== "" || url.password !== "" || parts.authority.includes("@")) {
    return Either.left(new EndpointNotCanonical({ url: raw, reason: "userinfo-present" }))
  }
  const path = parts.path.length === 0 ? "/" : parts.path
  if (url.host !== parts.authority.toLowerCase() || url.pathname !== path) {
    return Either.left(new EndpointNotCanonical({ url: raw, reason: "not-canonical" }))
  }
  const scheme = url.protocol.slice(0, -1)
  return Either.right({
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
 * Selectors are canonicalized on the same rules as intents, and additionally
 * may carry no query or fragment: a selector that named one would silently
 * widen every match computed on the normalized path.
 */
export const canonicalizeEndpointSelector = (
  selector: string
): Either.Either<CanonicalSelector, EndpointNotCanonical> => {
  const prefix = selector.endsWith("*")
  const base = prefix ? selector.slice(0, -1) : selector
  const canonical = canonicalizeEndpoint(base)
  if (Either.isLeft(canonical)) {
    return Either.left(new EndpointNotCanonical({ url: selector, reason: canonical.left.reason }))
  }
  if (canonical.right.hasQuery || canonical.right.hasFragment) {
    return Either.left(new EndpointNotCanonical({ url: selector, reason: "not-canonical" }))
  }
  return Either.right({ target: canonical.right.target, prefix })
}

/** Selector fit on the canonical `scheme://host/path` only. */
export const endpointGrantSelectorFits = (
  grant: EndpointGrantPolicy,
  endpoint: CanonicalEndpoint
): boolean => {
  const selector = canonicalizeEndpointSelector(grant.selector)
  if (Either.isLeft(selector)) return false
  return selector.right.prefix
    ? endpoint.target.startsWith(selector.right.target)
    : endpoint.target === selector.right.target
}

export const endpointGrantMethodFits = (
  grant: EndpointGrantPolicy,
  method: EndpointMethod
): boolean => grant.methods === undefined || grant.methods.includes(method)

export const endpointGrantHoldFits = (
  grant: EndpointGrantPolicy,
  holdMillis: number
): boolean => {
  const hold = grant.hold
  if (hold === undefined) return true
  if (hold.minMillis !== undefined && holdMillis < hold.minMillis) return false
  if (hold.maxMillis !== undefined && holdMillis > hold.maxMillis) return false
  return true
}

export const endpointGrantBodyFits = (
  grant: EndpointGrantPolicy,
  bodyBytes: number | undefined
): boolean => {
  const maxBodyBytes = grant.budget?.maxBodyBytes
  if (maxBodyBytes === undefined || bodyBytes === undefined) return true
  return bodyBytes <= maxBodyBytes
}

/** Every grant whose canonical selector covers this endpoint. */
export const fittingEndpointGrants = (
  grants: ReadonlyArray<EndpointGrantPolicy>,
  endpoint: CanonicalEndpoint
): ReadonlyArray<EndpointGrantPolicy> =>
  grants.filter((grant) => endpointGrantSelectorFits(grant, endpoint))

/**
 * A grant entry rejected before it can bind anything. Reported through
 * `AdmissionContractInvalid` at admission so the admission error union is
 * unchanged.
 */
export type EndpointGrantRejection = Readonly<{
  readonly field: string
  readonly reason: string
}>

const duplicated = (values: ReadonlyArray<string>) =>
  values.find((value, index) => values.indexOf(value) !== index)

/**
 * Grant-side validation. `commit: "auto"` is legal only on `class: "read"`
 * and only with an explicitly declared method list — an implicit
 * method-agnostic auto-commit would let one grant pre-authorize a PUT.
 */
export const validateEndpointGrants = (
  grants: ReadonlyArray<EndpointGrantPolicy>
): EndpointGrantRejection | undefined => {
  const duplicateSelector = duplicated(grants.map((grant) => grant.selector))
  if (duplicateSelector !== undefined) {
    return {
      field: "policy.endpointGrants",
      reason: `selector ${duplicateSelector} must appear exactly once`
    }
  }
  for (const [index, grant] of grants.entries()) {
    const at = `policy.endpointGrants[${index}]`
    const selector = canonicalizeEndpointSelector(grant.selector)
    if (Either.isLeft(selector)) {
      return {
        field: `${at}.selector`,
        reason: `must be a canonical http(s) endpoint selector without userinfo, query, or fragment (${selector.left.reason})`
      }
    }
    if (grant.methods !== undefined) {
      if (grant.methods.length === 0) {
        return { field: `${at}.methods`, reason: "must declare at least one method" }
      }
      const duplicateMethod = duplicated(grant.methods)
      if (duplicateMethod !== undefined) {
        return {
          field: `${at}.methods`,
          reason: `method ${duplicateMethod} must appear exactly once`
        }
      }
    }
    if (grant.commit === "auto") {
      if (grant.class !== "read") {
        return {
          field: `${at}.commit`,
          reason: `commit "auto" is legal only on class "read"; this grant is classed ${grant.class}`
        }
      }
      if (grant.methods === undefined) {
        return {
          field: `${at}.methods`,
          reason: 'commit "auto" requires an explicit method list'
        }
      }
    }
    const hold = grant.hold
    if (
      hold?.minMillis !== undefined &&
      hold.maxMillis !== undefined &&
      hold.minMillis > hold.maxMillis
    ) {
      return { field: `${at}.hold`, reason: "minMillis must not exceed maxMillis" }
    }
  }
  return undefined
}

/** The staged intent a dispatch decision is computed for. */
export type StagedIntentFacts = Readonly<{
  readonly url: string
  readonly method: EndpointMethod
  /**
   * The originating tool definition's declared `emissionEffect`. It is an
   * untrusted description that can only narrow: the effective class is the
   * stricter of it and the grant's class.
   */
  readonly declaredEmissionEffect?: DispatchClass
}>

/**
 * Two outcomes, never a third. `AwaitSupervisor` is the fail-closed default:
 * every path that is not an unambiguous read-class auto-commit lands here and
 * the intent stays staged.
 */
export type DispatchDecision =
  | Readonly<{
    readonly _tag: "AutoCommit"
    readonly selector: string
    readonly effectiveClass: DispatchClass
  }>
  | Readonly<{ readonly _tag: "AwaitSupervisor"; readonly reason: string }>

const awaitSupervisor = (reason: string): DispatchDecision => ({
  _tag: "AwaitSupervisor",
  reason
})

/**
 * Decides whether a durably staged intent is eligible for policy auto-commit.
 * This never dispatches and never stages: a caller acting on `AutoCommit`
 * calls the ordinary `Outbox.commit` after `StageExternal` has completed.
 */
export const dispatchDecision = (
  grants: ReadonlyArray<EndpointGrantPolicy>,
  intent: StagedIntentFacts
): DispatchDecision => {
  if (validateEndpointGrants(grants) !== undefined) {
    return awaitSupervisor("policy endpoint grants are invalid")
  }
  const canonical = canonicalizeEndpoint(intent.url)
  if (Either.isLeft(canonical)) {
    return awaitSupervisor(`endpoint is not canonical: ${canonical.left.reason}`)
  }
  if (canonical.right.hasQuery || canonical.right.hasFragment) {
    return awaitSupervisor(
      "query and fragment never participate in a grant match; this intent awaits a supervisor commit"
    )
  }
  const fitting = fittingEndpointGrants(grants, canonical.right).filter((grant) =>
    endpointGrantMethodFits(grant, intent.method)
  )
  if (fitting.length === 0) {
    return awaitSupervisor("no endpoint grant fits this method and canonical endpoint")
  }
  if (
    !fitting.every((grant) =>
      grant.commit === "auto" && grant.class === "read" && grant.methods !== undefined
    )
  ) {
    return awaitSupervisor("a fitting grant does not pre-authorize commit")
  }
  const granted = fitting.reduce<DispatchClass>(
    (strictest, grant) => stricterDispatchClass(strictest, grant.class),
    "read"
  )
  const effectiveClass = intent.declaredEmissionEffect === undefined
    ? granted
    : stricterDispatchClass(granted, intent.declaredEmissionEffect)
  if (effectiveClass !== "read") {
    return awaitSupervisor(
      `effective class ${effectiveClass} is narrower than read; this intent awaits a supervisor commit`
    )
  }
  return {
    _tag: "AutoCommit",
    selector: fitting[0]!.selector,
    effectiveClass
  }
}

/**
 * Grant-side vocabulary an agent-side document may never name. Keeping the
 * refusal beside the classes means every lane that ingests agent text
 * (definitions, lowering, program input) refuses the same words.
 */
export const grantAssertionKeys: ReadonlyArray<string> = [
  "class",
  "dispatchClass",
  "dispatchClasses",
  "commit",
  "commitMode",
  "autoCommit",
  "endpointGrant",
  "endpointGrants"
]

const scanForGrantAssertion = (
  value: unknown,
  at: string,
  depth: number
): DispatchClassAssertionRejected | undefined => {
  if (depth > 32 || value === null || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = scanForGrantAssertion(entry, `${at}[${index}]`, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (grantAssertionKeys.includes(key)) {
      return new DispatchClassAssertionRejected({
        field: `${at}.${key}`,
        reason: "dispatch classes are supervisor-grant-side; agent-side documents cannot name one"
      })
    }
    const found = scanForGrantAssertion(entry, `${at}.${key}`, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Refuses any agent-side document that tries to name or widen a dispatch
 * class. Narrowing has a separate, non-textual mechanism: the effective-class
 * computation in `dispatchDecision`.
 */
export const refuseGrantAssertion = (
  source: unknown,
  at: string
): Either.Either<void, DispatchClassAssertionRejected> => {
  const found = scanForGrantAssertion(source, at, 0)
  return found === undefined ? Either.right(undefined) : Either.left(found)
}
