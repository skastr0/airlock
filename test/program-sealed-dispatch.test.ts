import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  AdmissionPolicyV2,
  EndpointGrantPolicy,
  admit,
  bindAdmissionForUse
} from "../src/admission/index.ts"
import {
  NodeId,
  PlanDraft,
  PlanId,
  RequestExternalNode,
  RequirementId,
  ResourceRequirement
} from "../src/plan/index.ts"
import { supervisorDispatchAuthority } from "../src/program/index.ts"

const endpoint = "https://status.internal.example/v1/health"
const nodeId = NodeId.make("external")
const policy = new AdmissionPolicyV2({
  schemaVersion: "airlock/admission-policy/v2",
  profile: "native-contained",
  principal: "agent/sealed-dispatch-test",
  realm: "local",
  admittedBy: "operator/test",
  pathAllowlist: [],
  executableAllowlist: [],
  endpointGrants: [new EndpointGrantPolicy({
    selector: "https://status.internal.example/v1/*",
    methods: ["GET"],
    class: "read",
    commit: "auto"
  })]
})

const draft = new PlanDraft({
  schemaVersion: "airlock/plan-draft/v1",
  id: PlanId.make("plan/sealed-dispatch"),
  actionReference: "http.stage",
  nodes: [new RequestExternalNode({
    id: nodeId,
    dependsOn: [],
    requires: [RequirementId.make("endpoint/remote")],
    produces: [],
    method: "GET",
    endpoint,
    holdMillis: 0
  })],
  requirements: [new ResourceRequirement({
    id: RequirementId.make("endpoint/remote"),
    kind: "endpoint",
    realm: "remote/status.internal.example",
    selector: endpoint,
    rights: ["connect", "emit"]
  })],
  definitionDigests: []
})

describe("sealed Program dispatch authority", () => {
  it.effect("translates only an admitted read auto-grant into seal-bound staging evidence", () =>
    Effect.gen(function* () {
      const admission = yield* admit(draft, policy)
      const authority = yield* bindAdmissionForUse(admission)
      const sealDigest = `sha256:${"b".repeat(64)}` as const
      const dispatch = supervisorDispatchAuthority(policy, { sealDigest })(authority)

      expect(dispatch).toHaveLength(1)
      expect(dispatch[0]).toMatchObject({
        nodeId,
        commit: "auto",
        dispatchClass: "read",
        endpoint,
        stagedAuthorization: {
          sealDigest,
          dispatchClass: "read",
          endpoint
        }
      })
      expect(supervisorDispatchAuthority(policy, { sealDigest })(
        authority,
        "mutate"
      )).toEqual([])
      expect(supervisorDispatchAuthority(policy)(authority)[0]?.stagedAuthorization)
        .toBeUndefined()
    })
  )
})
