import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  AdmissionDenied,
  AdmissionPolicy,
  HandleExpired,
  ProfileUnavailable,
  UndeclaredNodeAuthority,
  admit,
  resolveHandle
} from "../src/admission/index.ts"
import {
  ApplyNode,
  ArtifactId,
  InvokeNode,
  NodeId,
  PlanNode,
  PlanDraft,
  PlanId,
  RequestExternalNode,
  RequirementId,
  ResourceRequirement
} from "../src/plan/index.ts"

const id = (value: string) => NodeId.make(value)
const req = (value: string) => RequirementId.make(value)

const policy = (overrides: Partial<ConstructorParameters<typeof AdmissionPolicy>[0]> = {}) =>
  new AdmissionPolicy({
    schemaVersion: "airlock/admission-policy/v1",
    profile: "native-contained",
    principal: "agent/test",
    realm: "macos/local",
    admittedBy: "operator/test",
    pathAllowlist: ["/workspace/**"],
    executableAllowlist: ["/usr/bin/rg"],
    endpointAllowlist: ["https://api.example.test/*"],
    ...overrides
  })

const draft = (requirements: ReadonlyArray<ResourceRequirement>, node: PlanNode) =>
  new PlanDraft({
    schemaVersion: "airlock/plan-draft/v1",
    id: PlanId.make("plan/admission"),
    actionReference: "test.admission",
    nodes: [node],
    requirements,
    definitionDigests: []
  })

const executable = new ResourceRequirement({
  id: req("exec/rg"), kind: "executable", realm: "macos/local", selector: "/usr/bin/rg", rights: ["execute"]
})

const invoke = new InvokeNode({
  id: id("invoke"), dependsOn: [], requires: [executable.id], produces: [ArtifactId.make("stdout")],
  executable: "/usr/bin/rg", args: ["Airlock"], stdoutArtifact: ArtifactId.make("stdout"), cellProfile: "native-contained"
})

describe("Admission candidate", () => {
  it.effect("mints grants and lexical handles only from explicit declared requirements", () =>
    Effect.gen(function* () {
      const admitted = yield* admit(draft([executable], invoke), policy())
      expect(admitted.plan.handles).toHaveLength(1)
      expect(admitted.plan.handles[0]?.resourceIdentity).toBe("lexical:executable:macos/local:/usr/bin/rg")
      expect(admitted.grants[0]?.constraints.identityBinding).toContain("Cell must rebind")
      expect(yield* resolveHandle(admitted, executable.id)).toEqual(admitted.plan.handles[0])
      expect(admitted.plan.admission.policyDigest).toBe(admitted.policyDigest)
    })
  )

  it.effect("compatibility binds only declared requirements, while contained scopes reject extras", () =>
    Effect.gen(function* () {
      const outside = new ApplyNode({
        id: id("apply"), dependsOn: [], requires: [req("write/outside")], produces: [],
        operation: "write", target: "/outside/file", sourceArtifact: ArtifactId.make("new")
      })
      const write = new ResourceRequirement({
        id: req("write/outside"), kind: "path", realm: "macos/local", selector: "/outside/file", rights: ["write"]
      })
      const denied = yield* admit(draft([write], outside), policy()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(AdmissionDenied)

      const traversal = new ApplyNode({ ...outside, target: "/workspace/../etc/airlock" })
      const traversalRequirement = new ResourceRequirement({ ...write, selector: traversal.target })
      const traversalDenied = yield* admit(draft([traversalRequirement], traversal), policy()).pipe(Effect.flip)
      expect(traversalDenied).toBeInstanceOf(AdmissionDenied)

      const compatible = yield* admit(
        draft([write], outside),
        policy({ profile: "compatibility", pathAllowlist: [], executableAllowlist: [], endpointAllowlist: [] })
      )
      expect(compatible.plan.handles).toHaveLength(1)
      expect(compatible.grants[0]?.selector).toBe("/outside/file")

      const external = new RequestExternalNode({
        id: id("external"), dependsOn: [], requires: [req("endpoint/remote")], produces: [],
        method: "POST", endpoint: "https://api.example.test/v1/send", holdMillis: 5_000
      })
      const remoteEndpoint = new ResourceRequirement({
        id: req("endpoint/remote"), kind: "endpoint", realm: "remote/api.example.test",
        selector: external.endpoint, rights: ["emit"]
      })
      const remote = yield* admit(draft([remoteEndpoint], external), policy())
      expect(remote.plan.handles[0]?.realm).toBe("remote/api.example.test")
    })
  )

  it.effect("rejects undeclared or non-absolute executable authority before binding", () =>
    Effect.gen(function* () {
      const undeclared = new InvokeNode({ ...invoke, requires: [] })
      const missing = yield* admit(draft([executable], undeclared), policy()).pipe(Effect.flip)
      expect(missing).toBeInstanceOf(UndeclaredNodeAuthority)

      const relative = new InvokeNode({ ...invoke, executable: "rg" })
      const relativeRequirement = new ResourceRequirement({ ...executable, selector: "rg" })
      const rejected = yield* admit(draft([relativeRequirement], relative), policy()).pipe(Effect.flip)
      // The Plan kernel rejects this earlier than Admission can bind it. Both
      // paths are intentionally fail-closed: relative executable authority
      // can never receive a grant.
      expect(rejected._tag).toBe("InvalidInvokeContract")
    })
  )

  it.effect("has stable policy digests, rechecks expiry, and never downgrades unavailable VM containment", () =>
    Effect.gen(function* () {
      const at = new Date("2026-07-29T00:00:00.000Z")
      const first = yield* admit(draft([executable], invoke), policy({ grantTtlMillis: 10 }), at)
      const second = yield* admit(draft([executable], invoke), policy({ grantTtlMillis: 10 }), at)
      expect(first.policyDigest).toBe(second.policyDigest)
      const expired = yield* resolveHandle(first, executable.id, new Date(at.getTime() + 10)).pipe(Effect.flip)
      expect(expired).toBeInstanceOf(HandleExpired)

      const unavailable = yield* admit(
        draft([executable], invoke), policy({ profile: "vm-enclosed" })
      ).pipe(Effect.flip)
      expect(unavailable).toBeInstanceOf(ProfileUnavailable)
    })
  )
})
