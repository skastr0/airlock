import { createHash } from "node:crypto"
import { posix } from "node:path"
import { DateTime, Effect, Schema } from "effect"
import {
  type Digest,
  Grant,
  GrantId,
  Handle,
  HandleId,
  HandleResolution,
  Plan,
  PlanDraft,
  type PlanValidationError,
  HandleGrantMismatch,
  RequirementUnresolved,
  RequirementId,
  type ResourceRequirement,
  AuthorityAdmission,
  closeExecution,
  orderPlan
} from "../plan/index.ts"

/**
 * Admission is the only candidate that turns inert ResourceRequirements into
 * grants and handles. It deliberately performs no I/O: path identity is a
 * stable, lexical binding, not a claim of symlink-race-safe filesystem
 * identity. A platform Cell must re-bind it before use.
 */

export const AdmissionProfile = Schema.Literal(
  "compatibility",
  "native-contained",
  "vm-enclosed"
)
export type AdmissionProfile = typeof AdmissionProfile.Type

export class AdmissionPolicy extends Schema.Class<AdmissionPolicy>("AdmissionPolicy")({
  schemaVersion: Schema.Literal("airlock/admission-policy/v1"),
  profile: AdmissionProfile,
  principal: Schema.String,
  realm: Schema.String,
  admittedBy: Schema.String,
  /** A positive value issues expiring grants; omission means this policy does not set a TTL. */
  grantTtlMillis: Schema.optional(Schema.Positive),
  /** Explicit native-contained path selectors. Compatibility may bind declared paths directly. */
  pathAllowlist: Schema.Array(Schema.String),
  /** Explicit executable selectors. Entries must be absolute executable paths. */
  executableAllowlist: Schema.Array(Schema.String),
  /** Explicit endpoint selectors. Exact match or a trailing `*` prefix selector. */
  endpointAllowlist: Schema.Array(Schema.String),
  // VM backend discovery belongs to the privileged runtime, not agent-provided
  // policy. This build therefore refuses vm-enclosed unconditionally below.
}) {}

export class AdmissionResult extends Schema.Class<AdmissionResult>("AdmissionResult")({
  plan: Plan,
  grants: Schema.Array(Grant),
  policyDigest: Schema.String.pipe(Schema.brand("Digest")),
  profile: AdmissionProfile
}) {}

export class AdmissionDenied extends Schema.TaggedError<AdmissionDenied>()("AdmissionDenied", {
  requirementId: Schema.String,
  reason: Schema.String
}) {}

export class UndeclaredNodeAuthority extends Schema.TaggedError<UndeclaredNodeAuthority>()(
  "UndeclaredNodeAuthority",
  { nodeId: Schema.String, kind: Schema.String, selector: Schema.String, right: Schema.String }
) {}

export class ProfileUnavailable extends Schema.TaggedError<ProfileUnavailable>()("ProfileUnavailable", {
  profile: AdmissionProfile,
  reason: Schema.String
}) {}

export class HandleNotResolved extends Schema.TaggedError<HandleNotResolved>()("HandleNotResolved", {
  requirementId: Schema.String
}) {}

export class HandleExpired extends Schema.TaggedError<HandleExpired>()("HandleExpired", {
  handleId: Schema.String,
  validUntil: Schema.DateTimeUtc
}) {}

export type AdmissionError =
  | AdmissionDenied
  | UndeclaredNodeAuthority
  | ProfileUnavailable
  | PlanValidationError
  | RequirementUnresolved
  | HandleGrantMismatch

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

const digest = (value: unknown): Digest =>
  `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}` as Digest

const isAbsolutePath = (value: string) => value.startsWith("/")
const lexicalPath = (value: string) => isAbsolutePath(value) ? posix.resolve("/", value) : undefined

/** Lexical containment only. Filesystem identity is intentionally deferred to the Cell. */
const pathContains = (scope: string, selector: string) => {
  const root = lexicalPath(scope.endsWith("/**") ? scope.slice(0, -3) : scope)
  const target = lexicalPath(selector)
  if (root === undefined || target === undefined) return false
  return target === root || target.startsWith(`${root}/`)
}

const endpointAllows = (scope: string, selector: string) =>
  scope.endsWith("*") ? selector.startsWith(scope.slice(0, -1)) : scope === selector

const allowedBy = (policy: AdmissionPolicy, requirement: ResourceRequirement) => {
  if (policy.profile === "compatibility") return true
  switch (requirement.kind) {
    case "path":
      return requirement.realm === policy.realm &&
        policy.pathAllowlist.some((scope) => pathContains(scope, requirement.selector))
    case "executable":
      return requirement.realm === policy.realm &&
        isAbsolutePath(requirement.selector) && policy.executableAllowlist.includes(requirement.selector)
    case "endpoint":
      // Endpoint realms name the remote system, not the local Cell. The
      // explicit endpoint allowlist—not a misleading local-realm check—is
      // the native-contained gate.
      return policy.endpointAllowlist.some((scope) => endpointAllows(scope, requirement.selector))
    default:
      return false
  }
}

const matchingRequirement = (
  requirements: ReadonlyArray<ResourceRequirement>,
  nodeRequirements: ReadonlyArray<RequirementId>,
  kind: ResourceRequirement["kind"],
  selector: string,
  right: ResourceRequirement["rights"][number]
) => requirements.find((requirement) =>
  nodeRequirements.includes(requirement.id) &&
  requirement.kind === kind &&
  requirement.selector === selector &&
  requirement.rights.includes(right)
)

const validateNodeRequirements = (draft: PlanDraft): Effect.Effect<void, UndeclaredNodeAuthority | PlanValidationError> =>
  Effect.gen(function* () {
    yield* orderPlan(draft)
    for (const node of draft.nodes) {
      const required = (() => {
        switch (node._tag) {
          case "Capture":
            return node.source === "file"
              ? { kind: "path" as const, selector: node.locator, right: "read" as const }
              : undefined
          case "Invoke":
            return { kind: "executable" as const, selector: node.executable, right: "execute" as const }
          case "Apply":
            return { kind: "path" as const, selector: node.target, right: "write" as const }
          case "RequestExternal":
            return { kind: "endpoint" as const, selector: node.endpoint, right: "emit" as const }
        }
      })()
      if (required === undefined) continue
      if (required.kind === "executable" && !isAbsolutePath(required.selector)) {
        return yield* new UndeclaredNodeAuthority({
          nodeId: node.id, ...required, right: required.right
        })
      }
      if (!matchingRequirement(draft.requirements, node.requires, required.kind, required.selector, required.right)) {
        return yield* new UndeclaredNodeAuthority({ nodeId: node.id, ...required })
      }
    }
  })

const makeIdentity = (requirement: ResourceRequirement) =>
  `lexical:${requirement.kind}:${requirement.realm}:${
    requirement.kind === "path" || requirement.kind === "executable"
      ? lexicalPath(requirement.selector) ?? requirement.selector
      : requirement.selector
  }`

/**
 * Admits a draft without touching the filesystem, process table, or network.
 * A tool definition is already represented only by `definitionDigests`; it is
 * never an authority source here.
 */
export const admit = (
  draft: PlanDraft,
  policy: AdmissionPolicy,
  now: Date = new Date()
): Effect.Effect<AdmissionResult, AdmissionError> =>
  Effect.gen(function* () {
    if (policy.profile === "vm-enclosed") {
      return yield* new ProfileUnavailable({
        profile: policy.profile,
        reason: "this build has no VM-enclosed backend; Airlock will not downgrade"
      })
    }
    yield* validateNodeRequirements(draft)
    const policyDigest = digest({
      schemaVersion: policy.schemaVersion,
      profile: policy.profile,
      principal: policy.principal,
      realm: policy.realm,
      grantTtlMillis: policy.grantTtlMillis,
      pathAllowlist: policy.pathAllowlist,
      executableAllowlist: policy.executableAllowlist,
      endpointAllowlist: policy.endpointAllowlist
    })
    const validUntil = policy.grantTtlMillis === undefined
      ? undefined
      : DateTime.unsafeFromDate(new Date(now.getTime() + policy.grantTtlMillis))
    for (const requirement of draft.requirements) {
      if (!allowedBy(policy, requirement)) {
        return yield* new AdmissionDenied({
          requirementId: requirement.id,
          reason: `selector ${requirement.selector} or realm ${requirement.realm} is outside the ${policy.profile} allowlist`
        })
      }
      if (requirement.kind === "executable" && !isAbsolutePath(requirement.selector)) {
        return yield* new AdmissionDenied({
          requirementId: requirement.id,
          reason: "executable selectors must be absolute paths"
        })
      }
    }
    const grants = draft.requirements.map((requirement) => new Grant({
      id: GrantId.make(`grant/${draft.id}/${requirement.id}/${policyDigest.slice(-16)}`),
      principal: policy.principal,
      realm: requirement.realm,
      selector: requirement.selector,
      rights: requirement.rights,
      constraints: {
        profile: policy.profile,
        identityBinding: "lexical-only; Cell must rebind before use",
        policyDigest
      },
      issuedBy: policy.admittedBy,
      validUntil
    }))
    const handles: ReadonlyArray<Handle> = draft.requirements.map((requirement, index) => new Handle({
      id: HandleId.make(`handle/${draft.id}/${requirement.id}/${index}`),
      kind: requirement.kind,
      realm: requirement.realm,
      resourceIdentity: makeIdentity(requirement),
      rights: requirement.rights,
      constraints: {
        binding: "lexical-only; Cell must rebind before use",
        selector: requirement.selector
      },
      grantId: grants[index]!.id,
      publicProvenance: `admission:${policy.admittedBy}:${policyDigest}`
    }))
    const resolutions = draft.requirements.map((requirement, index) => new HandleResolution({
      requirementId: requirement.id,
      handleId: handles[index]!.id
    }))
    const admission = new AuthorityAdmission({
      grantIds: grants.map((grant) => grant.id),
      admittedBy: policy.admittedBy,
      admittedAt: DateTime.unsafeFromDate(now),
      policyDigest
    })
    const planDigest = digest({ draft, policyDigest, grants, handles, resolutions })
    const plan = yield* closeExecution(draft, handles, resolutions, grants, admission, planDigest)
    return new AdmissionResult({ plan, grants, policyDigest, profile: policy.profile })
  })

/** Rechecks an admitted handle's grant lifetime before the runtime uses it. */
export const resolveHandle = (
  result: AdmissionResult,
  requirementId: RequirementId,
  now: Date = new Date()
): Effect.Effect<Handle, HandleNotResolved | HandleExpired> =>
  Effect.gen(function* () {
    const resolution = result.plan.resolutions.find((candidate) => candidate.requirementId === requirementId)
    const handle = resolution === undefined
      ? undefined
      : result.plan.handles.find((candidate) => candidate.id === resolution.handleId)
    if (handle === undefined) return yield* new HandleNotResolved({ requirementId })
    const grant = result.grants.find((candidate) => candidate.id === handle.grantId)
    if (grant?.validUntil !== undefined && DateTime.toDateUtc(grant.validUntil).getTime() <= now.getTime()) {
      return yield* new HandleExpired({ handleId: handle.id, validUntil: grant.validUntil })
    }
    return handle
  })
