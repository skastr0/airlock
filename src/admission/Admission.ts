import { createHash } from "node:crypto"
import { posix } from "node:path"
import { DateTime, Effect, Either, Schema } from "effect"
import {
  type Digest,
  Grant,
  GrantId,
  Handle,
  HandleId,
  HandleResolution,
  NodeId,
  Plan,
  PlanDraft,
  type PlanNode,
  type PlanValidationError,
  HandleGrantMismatch,
  RequirementUnresolved,
  RequirementId,
  type ResourceRequirement,
  AuthorityAdmission,
  closeExecution,
  orderPlan
} from "../plan/index.ts"
import {
  type DispatchDecision,
  EndpointGrantPolicy,
  type StagedIntentFacts,
  canonicalizeEndpoint,
  dispatchDecision,
  endpointGrantBodyFits,
  endpointGrantHoldFits,
  endpointGrantMethodFits,
  fittingEndpointGrants,
  validateEndpointGrants
} from "./DispatchPolicy.ts"

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

export const ExecutableEdgePolicy = Schema.Struct({
  /** A selector separately admitted as the root of an Invoke. */
  root: Schema.String,
  /** Exact executable identities this root may spawn as descendants. */
  descendants: Schema.Array(Schema.String)
})
export type ExecutableEdgePolicy = typeof ExecutableEdgePolicy.Type

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
  /**
   * Executables admitted only as descendants of a separately admitted root.
   * Keeping this distinct prevents a helper grant from becoming a new root
   * Invoke authority in a later agent-authored Plan.
   */
  executableEdges: Schema.optionalWith(
    Schema.Array(ExecutableEdgePolicy),
    { default: () => [] }
  ),
  /** Explicit endpoint selectors. Exact match or a trailing `*` prefix selector. */
  endpointAllowlist: Schema.Array(Schema.String),
  // VM backend discovery belongs to the privileged runtime, not agent-provided
  // policy. This build therefore refuses vm-enclosed unconditionally below.
}) {}

/**
 * Admission policy v2. Every v1 field carries over unchanged except the flat
 * `endpointAllowlist`, which is superseded (not aliased) by structured
 * endpoint grants carrying a supervisor dispatch class and commit mode.
 *
 * A grant that names neither behaves exactly as a v1 allowlist entry does: an
 * irreversible-send floor that stays staged until an explicit supervisor
 * commit. The one deliberate difference is matching — v2 selectors and intents
 * are canonicalized (§ `canonicalizeEndpoint`) because a raw string prefix
 * cannot be the sole load-bearing check once auto-commit removes the human.
 */
export class AdmissionPolicyV2 extends Schema.Class<AdmissionPolicyV2>("AdmissionPolicyV2")({
  schemaVersion: Schema.Literal("airlock/admission-policy/v2"),
  profile: AdmissionProfile,
  principal: Schema.String,
  realm: Schema.String,
  admittedBy: Schema.String,
  grantTtlMillis: Schema.optional(Schema.Positive),
  pathAllowlist: Schema.Array(Schema.String),
  executableAllowlist: Schema.Array(Schema.String),
  executableEdges: Schema.optionalWith(
    Schema.Array(ExecutableEdgePolicy),
    { default: () => [] }
  ),
  /** Structured endpoint grants. Classes live here and nowhere else. */
  endpointGrants: Schema.Array(EndpointGrantPolicy)
}) {}

/**
 * Either supervisor policy version. v1 documents keep decoding unchanged; the
 * union discriminates on the `schemaVersion` literal.
 */
export const AdmissionPolicyDocument = Schema.Union(AdmissionPolicy, AdmissionPolicyV2)
export type AdmissionPolicyDocument = typeof AdmissionPolicyDocument.Type

export const isAdmissionPolicyV2 = (
  policy: AdmissionPolicyDocument
): policy is AdmissionPolicyV2 =>
  policy.schemaVersion === "airlock/admission-policy/v2"

/**
 * The endpoint grants a policy carries. A v1 document carries none: it has no
 * class vocabulary, so every one of its staged intents awaits a supervisor
 * commit exactly as today.
 */
export const endpointGrantsOf = (
  policy: AdmissionPolicyDocument
): ReadonlyArray<EndpointGrantPolicy> =>
  isAdmissionPolicyV2(policy) ? policy.endpointGrants : []

/**
 * Whether a durably staged intent is eligible for a supervisor-policy
 * auto-commit under this policy. The caller acting on `AutoCommit` calls the
 * ordinary `Outbox.commit`; this decision adds no dispatch path of its own.
 */
export const policyDispatchDecision = (
  policy: AdmissionPolicyDocument,
  intent: StagedIntentFacts
): DispatchDecision => dispatchDecision(endpointGrantsOf(policy), intent)

export class AdmissionResult extends Schema.Class<AdmissionResult>("AdmissionResult")({
  plan: Plan,
  grants: Schema.Array(Grant),
  policyDigest: Schema.String.pipe(Schema.brand("Digest")),
  profile: AdmissionProfile,
  /**
   * Detects accidental mutation between admission and use. This is not a
   * signature and must never be accepted from an untrusted wire as proof of
   * admission; the in-process Admission capability remains the authority.
   */
  closureDigest: Schema.String.pipe(Schema.brand("Digest"))
}) {}

export class NodeAuthorityBinding extends Schema.Class<NodeAuthorityBinding>(
  "NodeAuthorityBinding"
)({
  nodeId: NodeId,
  handles: Schema.Array(Handle),
  boundAt: Schema.DateTimeUtc
}) {}

/**
 * The only value the program/runtime handoff may execute. It keeps the grants
 * beside the closed Plan instead of erasing them to a bare Plan after
 * admission.
 */
export class ExecutionAuthority extends Schema.Class<ExecutionAuthority>(
  "ExecutionAuthority"
)({
  schemaVersion: Schema.Literal("airlock/execution-authority/v1"),
  admission: AdmissionResult,
  bindings: Schema.Array(NodeAuthorityBinding),
  boundAt: Schema.DateTimeUtc
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

export class AdmissionContractInvalid extends Schema.TaggedError<AdmissionContractInvalid>()(
  "AdmissionContractInvalid",
  {
    planId: Schema.String,
    field: Schema.String,
    reason: Schema.String
  }
) {}

export type AdmissionError =
  | AdmissionDenied
  | UndeclaredNodeAuthority
  | ProfileUnavailable
  | AdmissionContractInvalid
  | PlanValidationError
  | RequirementUnresolved
  | HandleGrantMismatch

export type ExecutionAuthorityError =
  | AdmissionContractInvalid
  | HandleNotResolved
  | HandleExpired
  | UndeclaredNodeAuthority

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

/**
 * v1 keeps its raw string prefix verbatim. v2 matches on the canonical
 * `scheme://host/path`, so a selector can never be satisfied by a URL that
 * `fetch` would normalize to a different resource.
 */
const endpointAdmitted = (policy: AdmissionPolicyDocument, selector: string) => {
  if (!isAdmissionPolicyV2(policy)) {
    return policy.endpointAllowlist.some((scope) => endpointAllows(scope, selector))
  }
  const canonical = canonicalizeEndpoint(selector)
  if (Either.isLeft(canonical)) return false
  return fittingEndpointGrants(policy.endpointGrants, canonical.right).length > 0
}

const allowedBy = (policy: AdmissionPolicyDocument, requirement: ResourceRequirement) => {
  if (policy.profile === "compatibility") return true
  switch (requirement.kind) {
    case "path":
      return requirement.realm === policy.realm &&
        policy.pathAllowlist.some((scope) => pathContains(scope, requirement.selector))
    case "executable":
      return requirement.realm === policy.realm &&
        isAbsolutePath(requirement.selector) &&
        requirement.rights.every((right) =>
          right === "invoke"
            ? policy.executableAllowlist.includes(requirement.selector)
            : right === "execute"
              ? policy.executableEdges.some(
                  (edge) =>
                    edge.descendants.includes(requirement.selector)
                )
              : false
        )
    case "endpoint":
      // Endpoint realms name the remote system, not the local Cell. The
      // explicit endpoint allowlist—not a misleading local-realm check—is
      // the native-contained gate.
      return endpointAdmitted(policy, requirement.selector)
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

type NodeAuthorityNeed = Readonly<{
  readonly kind: ResourceRequirement["kind"]
  readonly selector: string
  readonly right: ResourceRequirement["rights"][number]
}>

/**
 * Authority-bearing operands in the closed Plan algebra. This list is kept
 * independent of native action names so definitions and adapters cannot
 * silently change what admission means.
 */
export const nodeAuthorityNeeds = (node: PlanNode): ReadonlyArray<NodeAuthorityNeed> => {
  switch (node._tag) {
    case "Capture":
      return node.source === "file"
        ? [{ kind: "path", selector: node.locator, right: "read" }]
        : []
    case "Invoke":
      return [
        {
          kind: "executable",
          selector: node.executable,
          right: "invoke"
        },
        ...node.descendantExecutables.map((selector) => ({
          kind: "executable" as const,
          selector,
          right: "execute" as const
        })),
        ...(node.cwd === undefined
          ? []
          : [{ kind: "path" as const, selector: node.cwd, right: "read" as const }])
      ]
    case "Apply":
      return [
        { kind: "path", selector: node.target, right: "write" },
        ...(node.source === undefined
          ? []
          : node.operation === "move"
            ? [
                { kind: "path" as const, selector: node.source, right: "read" as const },
                { kind: "path" as const, selector: node.source, right: "write" as const }
              ]
            : [{ kind: "path" as const, selector: node.source, right: "read" as const }])
      ]
    case "RequestExternal":
      return [
        { kind: "endpoint", selector: node.endpoint, right: "connect" },
        { kind: "endpoint", selector: node.endpoint, right: "emit" }
      ]
  }
}

const contractInvalid = (
  planId: string,
  field: string,
  reason: string
) => new AdmissionContractInvalid({ planId, field, reason })

const duplicates = (values: ReadonlyArray<string>) =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  left.every((value) => right.includes(value))

const validateNodeRequirements = (
  draft: PlanDraft
): Effect.Effect<
  void,
  UndeclaredNodeAuthority | AdmissionContractInvalid | PlanValidationError
> =>
  Effect.gen(function* () {
    yield* orderPlan(draft)
    const referencedRequirements = new Set(
      draft.nodes.flatMap((node) => node.requires)
    )
    for (const requirement of draft.requirements) {
      if (requirement.rights.length === 0) {
        return yield* contractInvalid(
          draft.id,
          `requirements.${requirement.id}.rights`,
          "must declare at least one right"
        )
      }
      if (duplicates(requirement.rights).length > 0) {
        return yield* contractInvalid(
          draft.id,
          `requirements.${requirement.id}.rights`,
          "must not contain duplicate rights"
        )
      }
    }
    for (const node of draft.nodes) {
      if (duplicates(node.requires).length > 0) {
        return yield* contractInvalid(
          draft.id,
          `nodes.${node.id}.requires`,
          "must not contain duplicate requirement ids"
        )
      }
      for (const required of nodeAuthorityNeeds(node)) {
        if (required.kind === "executable" && !isAbsolutePath(required.selector)) {
          return yield* new UndeclaredNodeAuthority({
            nodeId: node.id, ...required, right: required.right
          })
        }
        if (!matchingRequirement(
          draft.requirements,
          node.requires,
          required.kind,
          required.selector,
          required.right
        )) {
          return yield* new UndeclaredNodeAuthority({ nodeId: node.id, ...required })
        }
      }
      if (node._tag === "Invoke") {
        const expectedExecutableNeeds = nodeAuthorityNeeds(node).filter(
          (need) => need.kind === "executable"
        )
        const executableRequirements = draft.requirements.filter(
          (requirement) =>
            node.requires.includes(requirement.id) &&
            requirement.kind === "executable"
        )
        for (const requirement of executableRequirements) {
          const expected = expectedExecutableNeeds.find(
            (need) => need.selector === requirement.selector
          )
          if (
            expected === undefined ||
            requirement.rights.length !== 1 ||
            requirement.rights[0] !== expected.right
          ) {
            return yield* contractInvalid(
              draft.id,
              `nodes.${node.id}.requires`,
              `executable ${requirement.selector} must match exactly one declared root or descendant role`
            )
          }
        }
        if (executableRequirements.length !== expectedExecutableNeeds.length) {
          return yield* contractInvalid(
            draft.id,
            `nodes.${node.id}.requires`,
            "executable requirements must exactly match the declared executable edge set"
          )
        }
      }
    }
    for (const requirement of draft.requirements) {
      if (!referencedRequirements.has(requirement.id)) {
        return yield* contractInvalid(
          draft.id,
          `requirements.${requirement.id}`,
          "unused requirements cannot become ambient execution authority"
        )
      }
    }
  })

const endpointRequirementId = (draft: PlanDraft, node: PlanNode, selector: string) =>
  draft.requirements.find(
    (candidate) =>
      node.requires.includes(candidate.id) &&
      candidate.kind === "endpoint" &&
      candidate.selector === selector
  )?.id ?? `${node.id}/endpoint`

/**
 * Method, hold window, and inline body bytes are node-level facts, so grant
 * fit for them is checked here rather than in the requirement loop. Every
 * failure is a denial: a class or budget mismatch is never a
 * downgrade-and-proceed.
 */
const validateEndpointGrantFit = (
  draft: PlanDraft,
  grants: ReadonlyArray<EndpointGrantPolicy>
): Effect.Effect<void, AdmissionDenied> =>
  Effect.gen(function* () {
    for (const node of draft.nodes) {
      if (node._tag !== "RequestExternal") continue
      const requirementId = endpointRequirementId(draft, node, node.endpoint)
      const canonical = canonicalizeEndpoint(node.endpoint)
      if (Either.isLeft(canonical)) {
        return yield* new AdmissionDenied({
          requirementId,
          reason: `endpoint ${node.endpoint} is not canonical (${canonical.left.reason}) and fits no endpoint grant`
        })
      }
      const fitting = fittingEndpointGrants(grants, canonical.right)
      if (fitting.length === 0) {
        return yield* new AdmissionDenied({
          requirementId,
          reason: `endpoint ${canonical.right.target} fits no endpoint grant`
        })
      }
      const withMethod = fitting.filter((grant) =>
        endpointGrantMethodFits(grant, node.method)
      )
      if (withMethod.length === 0) {
        return yield* new AdmissionDenied({
          requirementId,
          reason: `method ${node.method} is not granted for endpoint ${canonical.right.target}`
        })
      }
      const withHold = withMethod.filter((grant) =>
        endpointGrantHoldFits(grant, node.holdMillis)
      )
      if (withHold.length === 0) {
        return yield* new AdmissionDenied({
          requirementId,
          reason: `hold ${node.holdMillis}ms is outside the granted hold policy for ${canonical.right.target}`
        })
      }
      const bodyBytes = node.body === undefined
        ? undefined
        : new TextEncoder().encode(node.body).byteLength
      if (!withHold.some((grant) => endpointGrantBodyFits(grant, bodyBytes))) {
        return yield* new AdmissionDenied({
          requirementId,
          reason: `inline body of ${bodyBytes ?? 0} bytes exceeds the granted budget for ${canonical.right.target}`
        })
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
  policy: AdmissionPolicyDocument,
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
    if (isAdmissionPolicyV2(policy)) {
      const rejection = validateEndpointGrants(policy.endpointGrants)
      if (rejection !== undefined) {
        return yield* contractInvalid(draft.id, rejection.field, rejection.reason)
      }
    }
    if (policy.profile !== "compatibility") {
      const duplicateRoot = duplicates(
        policy.executableEdges.map((edge) => edge.root)
      )[0]
      if (duplicateRoot !== undefined) {
        return yield* contractInvalid(
          draft.id,
          "policy.executableEdges",
          `root ${duplicateRoot} must appear exactly once`
        )
      }
      for (
        const [index, edge] of policy.executableEdges.entries()
      ) {
        if (
          !isAbsolutePath(edge.root) ||
          edge.root.includes("\0")
        ) {
          return yield* contractInvalid(
            draft.id,
            `policy.executableEdges[${index}].root`,
            "must be an absolute executable path without NUL"
          )
        }
        if (!policy.executableAllowlist.includes(edge.root)) {
          return yield* contractInvalid(
            draft.id,
            `policy.executableEdges[${index}].root`,
            "must also be admitted as an Invoke root"
          )
        }
        const duplicateDescendant = duplicates(edge.descendants)[0]
        if (duplicateDescendant !== undefined) {
          return yield* contractInvalid(
            draft.id,
            `policy.executableEdges[${index}].descendants`,
            `descendant ${duplicateDescendant} must appear exactly once`
          )
        }
        for (
          const [descendantIndex, descendant] of
            edge.descendants.entries()
        ) {
          if (
            !isAbsolutePath(descendant) ||
            descendant.includes("\0") ||
            descendant === edge.root
          ) {
            return yield* contractInvalid(
              draft.id,
              `policy.executableEdges[${index}].descendants[${descendantIndex}]`,
              "must be an absolute non-root executable path without NUL"
            )
          }
        }
      }
    }
    const policyDigest = digest({
      schemaVersion: policy.schemaVersion,
      profile: policy.profile,
      principal: policy.principal,
      realm: policy.realm,
      grantTtlMillis: policy.grantTtlMillis,
      pathAllowlist: policy.pathAllowlist,
      executableAllowlist: policy.executableAllowlist,
      executableEdges: policy.executableEdges,
      // v1 digests stay byte-identical: the endpoint field a policy actually
      // carries is the one that enters its digest.
      ...(isAdmissionPolicyV2(policy)
        ? { endpointGrants: policy.endpointGrants }
        : { endpointAllowlist: policy.endpointAllowlist })
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
    if (policy.profile !== "compatibility" && isAdmissionPolicyV2(policy)) {
      yield* validateEndpointGrantFit(draft, policy.endpointGrants)
    }
    if (policy.profile !== "compatibility") {
      for (const node of draft.nodes) {
        if (
          node._tag !== "Invoke" ||
          node.descendantExecutables.length === 0
        ) {
          continue
        }
        const edge = policy.executableEdges.find(
          (candidate) => candidate.root === node.executable
        )
        for (const descendant of node.descendantExecutables) {
          if (edge?.descendants.includes(descendant)) continue
          const requirement = draft.requirements.find(
            (candidate) =>
              node.requires.includes(candidate.id) &&
              candidate.kind === "executable" &&
              candidate.selector === descendant &&
              candidate.rights.includes("execute")
          )
          return yield* new AdmissionDenied({
            requirementId:
              requirement?.id ?? `${node.id}/executable-edge`,
            reason:
              `descendant ${descendant} is not admitted for root ` +
              node.executable
          })
        }
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
        ...(requirement.kind === "executable"
          ? {
              executionRole: requirement.rights.includes("invoke")
                ? "root"
                : "descendant"
            }
          : {}),
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
        selector: requirement.selector,
        ...(requirement.kind === "executable"
          ? {
              executionRole: requirement.rights.includes("invoke")
                ? "root"
                : "descendant"
            }
          : {})
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
    const closureDigest = digest({ plan, grants, policyDigest, profile: policy.profile })
    return new AdmissionResult({
      plan,
      grants,
      policyDigest,
      profile: policy.profile,
      closureDigest
    })
  })

const validateClosure = (
  result: AdmissionResult,
  now: Date
): Effect.Effect<void, AdmissionContractInvalid | HandleExpired> =>
  Effect.gen(function* () {
    const { plan } = result
    const expectedDigest = digest({
      plan,
      grants: result.grants,
      policyDigest: result.policyDigest,
      profile: result.profile
    })
    if (expectedDigest !== result.closureDigest) {
      return yield* contractInvalid(
        plan.id,
        "closureDigest",
        "Plan, grants, or admission metadata changed after admission"
      )
    }
    if (plan.admission.policyDigest !== result.policyDigest) {
      return yield* contractInvalid(
        plan.id,
        "policyDigest",
        "closed Plan and admission result disagree"
      )
    }

    const grantIds = result.grants.map((grant) => grant.id)
    const handleIds = plan.handles.map((handle) => handle.id)
    const resolutionRequirements = plan.resolutions.map(
      (resolution) => resolution.requirementId
    )
    const resolutionHandles = plan.resolutions.map(
      (resolution) => resolution.handleId
    )
    const referencedRequirements = plan.nodes.flatMap((node) => node.requires)
    const usedGrantIds = plan.handles.map((handle) => handle.grantId)

    for (const [field, values] of [
      ["grants", grantIds],
      ["handles", handleIds],
      ["resolutions.requirementId", resolutionRequirements],
      ["resolutions.handleId", resolutionHandles],
      ["admission.grantIds", plan.admission.grantIds]
    ] as const) {
      if (duplicates(values).length > 0) {
        return yield* contractInvalid(
          plan.id,
          field,
          "authority closure must not contain duplicate identities"
        )
      }
    }
    for (const node of plan.nodes) {
      if (duplicates(node.requires).length > 0) {
        return yield* contractInvalid(
          plan.id,
          `nodes.${node.id}.requires`,
          "must not contain duplicate requirement ids"
        )
      }
    }
    if (!sameSet(resolutionRequirements, [...new Set(referencedRequirements)])) {
      return yield* contractInvalid(
        plan.id,
        "resolutions",
        "must resolve exactly the requirements referenced by Plan nodes"
      )
    }
    if (!sameSet(resolutionHandles, handleIds)) {
      return yield* contractInvalid(
        plan.id,
        "handles",
        "every handle must resolve exactly one requirement"
      )
    }
    if (
      !sameSet(grantIds, plan.admission.grantIds) ||
      !sameSet(grantIds, usedGrantIds)
    ) {
      return yield* contractInvalid(
        plan.id,
        "grants",
        "Plan admission, handles, and retained grants must form one exact closure"
      )
    }

    const grantsById = new Map(result.grants.map((grant) => [grant.id, grant]))
    for (const handle of plan.handles) {
      const grant = grantsById.get(handle.grantId)
      if (grant === undefined) {
        return yield* contractInvalid(
          plan.id,
          `handles.${handle.id}.grantId`,
          "does not identify a retained grant"
        )
      }
      if (
        handle.realm !== grant.realm ||
        handle.constraints.selector !== grant.selector ||
        !sameSet(handle.rights, grant.rights)
      ) {
        return yield* contractInvalid(
          plan.id,
          `handles.${handle.id}`,
          "handle resource and rights must exactly match its grant"
        )
      }
      if (
        grant.constraints.profile !== result.profile ||
        grant.constraints.policyDigest !== result.policyDigest ||
        grant.issuedBy !== plan.admission.admittedBy
      ) {
        return yield* contractInvalid(
          plan.id,
          `grants.${grant.id}.constraints`,
          "grant is not bound to this profile, policy, and admitting authority"
        )
      }
      if (
        grant.validUntil !== undefined &&
        DateTime.toDateUtc(grant.validUntil).getTime() <= now.getTime()
      ) {
        return yield* new HandleExpired({
          handleId: handle.id,
          validUntil: grant.validUntil
        })
      }
    }
  })

const bindNode = (
  result: AdmissionResult,
  node: PlanNode,
  now: Date
): Effect.Effect<
  NodeAuthorityBinding,
  AdmissionContractInvalid | HandleNotResolved | UndeclaredNodeAuthority
> =>
  Effect.gen(function* () {
    const handles = yield* Effect.forEach(node.requires, (requirementId) => {
      const resolution = result.plan.resolutions.find(
        (candidate) => candidate.requirementId === requirementId
      )
      const handle = resolution === undefined
        ? undefined
        : result.plan.handles.find(
            (candidate) => candidate.id === resolution.handleId
          )
      return handle === undefined
        ? Effect.fail(new HandleNotResolved({ requirementId }))
        : Effect.succeed(handle)
    }, { concurrency: 1 })
    for (const required of nodeAuthorityNeeds(node)) {
      if (!handles.some(
        (handle) =>
          handle.kind === required.kind &&
          handle.constraints.selector === required.selector &&
          handle.rights.includes(required.right)
      )) {
        return yield* new UndeclaredNodeAuthority({
          nodeId: node.id,
          kind: required.kind,
          selector: required.selector,
          right: required.right
        })
      }
    }
    return new NodeAuthorityBinding({
      nodeId: node.id,
      handles,
      boundAt: DateTime.unsafeFromDate(now)
    })
  })

/**
 * Revalidates the complete authority closure immediately before it crosses
 * into the runtime plane. A runtime should additionally call
 * `revalidateNodeAuthority` at each node boundary so TTL remains meaningful
 * for long-running plans.
 */
export const bindAdmissionForUse = (
  result: AdmissionResult,
  now: Date = new Date()
): Effect.Effect<ExecutionAuthority, ExecutionAuthorityError> =>
  Effect.gen(function* () {
    yield* validateClosure(result, now)
    const bindings = yield* Effect.forEach(
      result.plan.nodes,
      (node) => bindNode(result, node, now),
      { concurrency: 1 }
    )
    return new ExecutionAuthority({
      schemaVersion: "airlock/execution-authority/v1",
      admission: result,
      bindings,
      boundAt: DateTime.unsafeFromDate(now)
    })
  })

/** Rechecks closure and grant lifetime at the exact node-use boundary. */
export const revalidateNodeAuthority = (
  authority: ExecutionAuthority,
  nodeId: NodeId,
  now: Date = new Date()
): Effect.Effect<NodeAuthorityBinding, ExecutionAuthorityError> =>
  Effect.gen(function* () {
    yield* validateClosure(authority.admission, now)
    const node = authority.admission.plan.nodes.find(
      (candidate) => candidate.id === nodeId
    )
    if (node === undefined) {
      return yield* contractInvalid(
        authority.admission.plan.id,
        `nodes.${nodeId}`,
        "node does not belong to the admitted Plan"
      )
    }
    return yield* bindNode(authority.admission, node, now)
  })

/** Rechecks one legacy requirement lookup against the retained grant closure. */
export const resolveHandle = (
  result: AdmissionResult,
  requirementId: RequirementId,
  now: Date = new Date()
): Effect.Effect<
  Handle,
  HandleNotResolved | HandleExpired | AdmissionContractInvalid
> =>
  Effect.gen(function* () {
    yield* validateClosure(result, now)
    const resolution = result.plan.resolutions.find(
      (candidate) => candidate.requirementId === requirementId
    )
    const handle = resolution === undefined
      ? undefined
      : result.plan.handles.find(
          (candidate) => candidate.id === resolution.handleId
        )
    if (handle === undefined) return yield* new HandleNotResolved({ requirementId })
    return handle
  })
