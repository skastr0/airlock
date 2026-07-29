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
        { kind: "executable", selector: node.executable, right: "execute" },
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
