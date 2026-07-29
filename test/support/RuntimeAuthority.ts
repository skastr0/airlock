import { DateTime, Effect } from "effect"
import {
  admit,
  AdmissionPolicy,
  AdmissionResult,
  bindAdmissionForUse,
  ExecutionAuthority,
  nodeAuthorityNeeds
} from "../../src/admission/index.ts"
import {
  ApplyNode,
  AuthorityAdmission,
  CaptureNode,
  Digest,
  InvokeNode,
  type PlanNode,
  Plan,
  PlanDraft,
  PlanId,
  RequestExternalNode,
  RequirementId,
  ResourceRequirement
} from "../../src/plan/index.ts"

const timestamp = DateTime.unsafeFromDate(
  new Date("2026-07-29T00:00:00.000Z")
)

const withRequirements = (
  node: PlanNode,
  requires: ReadonlyArray<RequirementId>
): PlanNode => {
  switch (node._tag) {
    case "Capture": return new CaptureNode({ ...node, requires })
    case "Invoke": return new InvokeNode({ ...node, requires })
    case "Apply": return new ApplyNode({ ...node, requires })
    case "RequestExternal": return new RequestExternalNode({ ...node, requires })
  }
}

/**
 * Runtime contract tests enter through the same authority constructor as
 * production. The helper adds only the requirements already implied by each
 * Plan node; it does not mint a test-only Runtime bypass.
 */
export const runtimeAuthority = (
  nodes: ReadonlyArray<PlanNode>,
  options: {
    readonly label?: string
    readonly grantTtlMillis?: number
    readonly admittedAt?: Date
  } = {}
): ExecutionAuthority => {
  const label = options.label ?? `runtime-test-${crypto.randomUUID()}`
  const planId = PlanId.make(`plan/${label}`)
  const requirements: ResourceRequirement[] = []
  const admittedNodes = nodes.map((node) => {
    const ids = nodeAuthorityNeeds(node).map((need) => {
      const id = RequirementId.make(
        `${planId}/requirement/${requirements.length}`
      )
      requirements.push(new ResourceRequirement({
        id,
        kind: need.kind,
        realm: "local",
        selector: need.selector,
        rights: [need.right]
      }))
      return id
    })
    return withRequirements(node, ids)
  })
  const draft = new PlanDraft({
    schemaVersion: "airlock/plan-draft/v1",
    id: planId,
    actionReference: "test.runtime",
    nodes: admittedNodes,
    requirements,
    definitionDigests: []
  })
  const policy = new AdmissionPolicy({
    schemaVersion: "airlock/admission-policy/v1",
    profile: "compatibility",
    principal: "runtime-test",
    realm: "local",
    admittedBy: "runtime-test",
    ...(options.grantTtlMillis === undefined
      ? {}
      : { grantTtlMillis: options.grantTtlMillis }),
    pathAllowlist: [],
    executableAllowlist: [],
    endpointAllowlist: []
  })
  const admittedAt = options.admittedAt ?? DateTime.toDateUtc(timestamp)
  return Effect.runSync(
    admit(draft, policy, admittedAt).pipe(
      Effect.flatMap((result) =>
        bindAdmissionForUse(result, admittedAt)
      )
    )
  )
}

/**
 * Only malformed-Plan preflight tests use this constructor. Runtime validates
 * the Plan before reaching the deliberately invalid authority closure.
 */
export const uncheckedRuntimeAuthority = (
  nodes: ReadonlyArray<PlanNode>,
  label = `runtime-invalid-${crypto.randomUUID()}`
): ExecutionAuthority => {
  const planId = PlanId.make(`plan/${label}`)
  const policyDigest = Digest.make("sha256:unchecked-runtime-test")
  const plan = new Plan({
    schemaVersion: "airlock/plan/v1",
    id: planId,
    actionReference: "test.runtime.invalid",
    nodes,
    handles: [],
    resolutions: [],
    admission: new AuthorityAdmission({
      grantIds: [],
      admittedBy: "runtime-test",
      admittedAt: timestamp,
      policyDigest
    }),
    definitionDigests: [],
    planDigest: Digest.make("sha256:unchecked-runtime-plan")
  })
  return new ExecutionAuthority({
    schemaVersion: "airlock/execution-authority/v1",
    admission: new AdmissionResult({
      plan,
      grants: [],
      policyDigest,
      profile: "compatibility",
      closureDigest: Digest.make("sha256:unchecked-authority")
    }),
    bindings: [],
    boundAt: timestamp
  })
}
