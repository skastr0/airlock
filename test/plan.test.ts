import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import {
  ApplyNode,
  ArtifactId,
  AuthorityAdmission,
  CaptureNode,
  CyclicPlan,
  Digest,
  DuplicateNodeId,
  Grant,
  GrantId,
  Handle,
  HandleId,
  HandleResolution,
  NodeId,
  PlanDraft,
  PlanId,
  PlanRuntime,
  RequirementId,
  ResourceRequirement,
  UnknownDependency,
  closeExecution,
  decodePlanJson,
  encodePlanJson,
  orderPlan,
  transitionNode,
  transitionPlan
} from "../src/plan/index.ts"

const id = (value: string) => NodeId.make(value)
const req = (value: string) => RequirementId.make(value)
const digest = (value: string) => Digest.make(value)

const requirement = new ResourceRequirement({
  id: req("workspace"), kind: "path", realm: "local", selector: "workspace/**", rights: ["write"]
})

const capture = new CaptureNode({
  id: id("capture"), dependsOn: [], requires: [], produces: [ArtifactId.make("artifact/input")],
  source: "file", locator: "README.md"
})
const apply = new ApplyNode({
  id: id("apply"), dependsOn: [id("capture")], requires: [req("workspace")], produces: [],
  operation: "write", target: "README.md", sourceArtifact: ArtifactId.make("artifact/input")
})

const draft = (nodes = [capture, apply]) => new PlanDraft({
  schemaVersion: "airlock/plan-draft/v1", id: PlanId.make("plan/test"), actionReference: "test.action",
  nodes, requirements: [requirement], definitionDigests: [digest("sha256/definition")]
})

describe("Plan v1 kernel", () => {
  it.effect("orders an admissible DAG by dependencies then draft position", () =>
    Effect.gen(function* () {
      const ordered = yield* orderPlan(draft())
      expect(ordered.map((node) => node.id)).toEqual([id("capture"), id("apply")])
    })
  )

  it.effect("rejects duplicate nodes, missing dependencies, and cycles with tagged errors", () =>
    Effect.gen(function* () {
      const duplicate = yield* orderPlan(draft([capture, capture])).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(DuplicateNodeId)

      const missing = new ApplyNode({ ...apply, dependsOn: [id("not-present")] })
      const unknown = yield* orderPlan(draft([missing])).pipe(Effect.flip)
      expect(unknown).toBeInstanceOf(UnknownDependency)

      const left = new CaptureNode({ ...capture, id: id("left"), dependsOn: [id("right")] })
      const right = new CaptureNode({ ...capture, id: id("right"), dependsOn: [id("left")] })
      const cycle = yield* orderPlan(draft([left, right])).pipe(Effect.flip)
      expect(cycle).toBeInstanceOf(CyclicPlan)
      expect(cycle._tag).toBe("CyclicPlan")
      if (cycle._tag === "CyclicPlan") expect(cycle.nodeIds).toEqual(["left", "right"])
    })
  )

  it.effect("closes only when every requirement resolves to an admitted compatible handle", () =>
    Effect.gen(function* () {
      const grant = new Grant({
        id: GrantId.make("grant/operator"), principal: "agent", realm: "local", selector: "workspace/**",
        rights: ["write"], constraints: {}, issuedBy: "operator"
      })
      const handle = new Handle({
        id: HandleId.make("handle/workspace"), kind: "path", realm: "local", resourceIdentity: "file:///workspace",
        rights: ["read", "write"], constraints: {}, grantId: grant.id, publicProvenance: "operator grant"
      })
      const admission = new AuthorityAdmission({
        grantIds: [grant.id], admittedBy: "runner", admittedAt: yield* DateTime.now
      })
      const plan = yield* closeExecution(
        draft(), [handle], [new HandleResolution({ requirementId: requirement.id, handleId: handle.id })], [grant], admission, digest("sha256/plan")
      )
      expect(plan.nodes.map((node) => node.id)).toEqual([id("capture"), id("apply")])
      expect(yield* encodePlanJson(plan).pipe(Effect.flatMap(decodePlanJson))).toEqual(plan)
    })
  )

  it.effect("accepts only explicit runtime state transitions", () =>
    Effect.gen(function* () {
      const runtime = new PlanRuntime({
        planId: PlanId.make("plan/runtime"), state: "draft", sequence: 0,
        nodeStates: [[id("capture"), "planned"]]
      })
      const admitted = yield* transitionPlan(runtime, "admitted")
      expect(admitted.sequence).toBe(1)
      const invalid = yield* transitionPlan(admitted, "succeeded").pipe(Effect.flip)
      expect(invalid._tag).toBe("InvalidPlanTransition")
      const running = yield* transitionNode(admitted, id("capture"), "running")
      expect(running.nodeStates).toEqual([[id("capture"), "running"]])
    })
  )
})
