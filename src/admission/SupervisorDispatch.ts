import { Either, Schema } from "effect"
import { NodeId } from "../plan/index.ts"
import {
  type AdmissionPolicyDocument,
  type ExecutionAuthority,
  policyDispatchDecision
} from "./Admission.ts"
import { type DispatchClass, canonicalizeEndpoint } from "./DispatchPolicy.ts"

/**
 * The supervisor plane's auto-commit decision, kept beside the policy it reads.
 *
 * The dispatch-class vocabulary lives in this directory and nowhere else: a
 * program-side module that could spell a class would be a second place to
 * select one from. So this module answers the only question the rest of the
 * system needs — *which staged nodes did the supervisor already authorize to
 * commit* — and answers it in a shape that names no class the caller could
 * widen.
 *
 * Nothing here stages, dispatches, or touches the Outbox. Acting on the
 * result is an ordinary call to `Outbox.commit`, which remains the single
 * wire-capable site.
 */

/**
 * One pre-authorization. `effectiveClass` is fixed to `read` by type: a
 * `mutate` or `irreversible-send` intent has no representation here at all,
 * so no caller can construct an authorization for one.
 */
export class SupervisorAutoCommit extends Schema.Class<SupervisorAutoCommit>(
  "SupervisorAutoCommit"
)({
  nodeId: NodeId,
  /** Grant identity from the admitted authority; the receipt names it. */
  grantId: Schema.String,
  /** The policy selector that matched, verbatim from the supervisor policy file. */
  grantSelector: Schema.String,
  effectiveClass: Schema.Literal("read"),
  /** Canonical `scheme://host/path` the grant matched — the endpoint actually dispatched to. */
  endpoint: Schema.String
}) {}

/**
 * Compute the pre-authorizations a policy grants for one admitted authority.
 *
 * Every gate belongs to the policy engine already: `policyDispatchDecision`
 * owns canonicalization, selector and method fit, the `read`-class
 * `commit: "auto"` requirement, and the stricter-of narrowing against the
 * originating definition's declared effect. This function adds exactly two
 * refusals of its own, both fail-closed: an endpoint that does not canonicalize
 * and a node with no matching admitted grant are simply not authorized, and
 * therefore stay staged.
 *
 * `declaredEmissionEffect` is the untrusted description a tool definition
 * carried forward. It can only narrow — it is fed to the policy engine, which
 * takes the stricter of it and the grant's class. It is a single value because
 * one action lowers to one draft: a plan carrying several `RequestExternal`
 * nodes from several definitions would need the declaration per node, and this
 * signature would have to change before that is true.
 */
export const supervisorAutoCommits = (
  policy: AdmissionPolicyDocument,
  authority: ExecutionAuthority,
  declaredEmissionEffect?: DispatchClass
): ReadonlyArray<SupervisorAutoCommit> => {
  const authorized: Array<SupervisorAutoCommit> = []
  for (const node of authority.admission.plan.nodes) {
    if (node._tag !== "RequestExternal") continue
    const decision = policyDispatchDecision(policy, {
      url: node.endpoint,
      method: node.method,
      ...(declaredEmissionEffect === undefined
        ? {}
        : { declaredEmissionEffect })
    })
    if (decision._tag !== "AutoCommit") continue
    if (decision.effectiveClass !== "read") continue
    const canonical = canonicalizeEndpoint(node.endpoint)
    if (Either.isLeft(canonical)) continue
    const grant = authority.admission.grants.find(
      (candidate) => candidate.selector === node.endpoint
    )
    if (grant === undefined) continue
    authorized.push(new SupervisorAutoCommit({
      nodeId: node.id,
      grantId: grant.id,
      grantSelector: decision.selector,
      effectiveClass: "read",
      endpoint: canonical.right.target
    }))
  }
  return authorized
}
