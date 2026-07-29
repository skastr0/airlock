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
  InvalidApplyContract,
  InvalidInvokeContract,
  InvalidRequestExternalContract,
  InvokeNode,
  NodeId,
  type PlanNode,
  PlanDraft,
  PlanId,
  PlanRuntime,
  RequestExternalNode,
  RequirementId,
  ResourceRequirement,
  UnknownDependency,
  closeExecution,
  decodePlanDraftJson,
  decodePlanJson,
  encodePlanDraftJson,
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
const invoke = new InvokeNode({
  id: id("format"), dependsOn: [capture.id], requires: [], produces: [
    ArtifactId.make("artifact/format-stdout"),
    ArtifactId.make("artifact/format-delta")
  ],
  executable: "/usr/bin/true", args: ["--version"], cwd: "/workspace",
  env: { LANG: "C" }, stdout: "capture", stderr: "discard",
  stdoutArtifact: ArtifactId.make("artifact/format-stdout"),
  deltaArtifact: ArtifactId.make("artifact/format-delta"),
  outputLimitBytes: 4096, timeoutMs: 2_000, cellProfile: "native-contained"
})

const draft = (nodes: ReadonlyArray<PlanNode> = [capture, apply]) => new PlanDraft({
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

  it.effect("keeps structured invocation separate from executable identity and validates atoms before admission", () =>
    Effect.gen(function* () {
      const invokeDraft = draft([capture, invoke])
      const ordered = yield* orderPlan(invokeDraft)
      const admittedInvoke = ordered[1]
      expect(admittedInvoke).toMatchObject({
        _tag: "Invoke",
        executable: "/usr/bin/true",
        args: ["--version"],
        cwd: "/workspace",
        env: { LANG: "C" },
        stdout: "capture",
        stderr: "discard",
        stdoutArtifact: ArtifactId.make("artifact/format-stdout"),
        deltaArtifact: ArtifactId.make("artifact/format-delta"),
        outputLimitBytes: 4096,
        timeoutMs: 2_000,
        cellProfile: "native-contained"
      })
      expect(admittedInvoke).not.toHaveProperty("argv")

      const invalidExecutable = new InvokeNode({ ...invoke, id: id("invalid-executable"), executable: "python3" })
      const executableFailure = yield* orderPlan(draft([invalidExecutable])).pipe(Effect.flip)
      expect(executableFailure).toBeInstanceOf(InvalidInvokeContract)
      expect(executableFailure).toMatchObject({ _tag: "InvalidInvokeContract", field: "executable" })

      const invalidTimeout = new InvokeNode({ ...invoke, id: id("invalid-timeout"), timeoutMs: 0 })
      const timeoutFailure = yield* orderPlan(draft([invalidTimeout])).pipe(Effect.flip)
      expect(timeoutFailure).toMatchObject({ _tag: "InvalidInvokeContract", field: "timeoutMs" })

      const streamWithoutCapture = new InvokeNode({
        ...invoke, id: id("invalid-stream"), stdout: "discard"
      })
      const streamFailure = yield* orderPlan(draft([streamWithoutCapture])).pipe(Effect.flip)
      expect(streamFailure).toMatchObject({ _tag: "InvalidInvokeContract", field: "stdoutArtifact" })

      const outputOutsideProduces = new InvokeNode({
        ...invoke, id: id("missing-output"), stdoutArtifact: ArtifactId.make("artifact/not-declared")
      })
      const missingOutput = yield* orderPlan(draft([outputOutsideProduces])).pipe(Effect.flip)
      expect(missingOutput).toMatchObject({ _tag: "InvalidInvokeContract", field: "stdoutArtifact" })

      const repeatedInProduces = new InvokeNode({
        ...invoke, id: id("repeated-output"), produces: [
          ArtifactId.make("artifact/format-stdout"),
          ArtifactId.make("artifact/format-stdout"),
          ArtifactId.make("artifact/format-delta")
        ]
      })
      const repeatedFailure = yield* orderPlan(draft([repeatedInProduces])).pipe(Effect.flip)
      expect(repeatedFailure).toMatchObject({ _tag: "InvalidInvokeContract", field: "stdoutArtifact" })

      const duplicateOutput = new InvokeNode({
        ...invoke, id: id("duplicate-output"), stderr: "capture", stderrArtifact: invoke.stdoutArtifact
      })
      const duplicateFailure = yield* orderPlan(draft([duplicateOutput])).pipe(Effect.flip)
      expect(duplicateFailure).toMatchObject({ _tag: "InvalidInvokeContract", field: "produces" })

      const unnamedOutput = new InvokeNode({
        ...invoke,
        id: id("unnamed-output"),
        produces: [...invoke.produces, ArtifactId.make("artifact/unnamed")]
      })
      const unnamedFailure = yield* orderPlan(draft([unnamedOutput])).pipe(Effect.flip)
      expect(unnamedFailure).toMatchObject({ _tag: "InvalidInvokeContract", field: "produces" })

      const compatibilityDelta = new InvokeNode({ ...invoke, id: id("compatibility-delta"), cellProfile: "compatibility" })
      const deltaFailure = yield* orderPlan(draft([compatibilityDelta])).pipe(Effect.flip)
      expect(deltaFailure).toMatchObject({ _tag: "InvalidInvokeContract", field: "deltaArtifact" })

      const conflictingStdin = new InvokeNode({
        ...invoke,
        id: id("conflicting-stdin"),
        stdin: ArtifactId.make("artifact/input"),
        stdinDisposition: "inherit"
      })
      const stdinFailure = yield* orderPlan(draft([conflictingStdin])).pipe(Effect.flip)
      expect(stdinFailure).toMatchObject({
        _tag: "InvalidInvokeContract",
        field: "stdin/stdinDisposition"
      })
    })
  )

  it.effect("treats a contained Cell delta as an explicit Apply.merge input", () =>
    Effect.gen(function* () {
      const merge = new ApplyNode({
        id: id("merge"), dependsOn: [invoke.id], requires: [req("workspace")], produces: [],
        operation: "merge", target: "/workspace", sourceArtifact: invoke.deltaArtifact
      })
      const ordered = yield* orderPlan(draft([capture, invoke, merge]))
      expect(ordered.map((node) => node.id)).toEqual([capture.id, invoke.id, merge.id])

      const missingInput = new ApplyNode({ ...merge, id: id("merge-missing"), sourceArtifact: undefined })
      const missingFailure = yield* orderPlan(draft([capture, invoke, missingInput])).pipe(Effect.flip)
      expect(missingFailure).toBeInstanceOf(InvalidApplyContract)
      expect(missingFailure).toMatchObject({ field: "sourceArtifact" })

      const unrelated = new ApplyNode({ ...merge, id: id("merge-unrelated"), dependsOn: [capture.id] })
      const dependencyFailure = yield* orderPlan(draft([capture, invoke, unrelated])).pipe(Effect.flip)
      expect(dependencyFailure).toMatchObject({ _tag: "InvalidApplyContract", field: "dependsOn" })
    })
  )

  it.effect("keeps external request bytes explicit and dependency-bound while staging only intent", () =>
    Effect.gen(function* () {
      const inline = new RequestExternalNode({
        id: id("external-inline"),
        dependsOn: [],
        requires: [],
        produces: [],
        method: "POST",
        endpoint: "https://api.example.test/jobs",
        headers: { "content-type": "application/json", "x-trace": "plan-test" },
        body: "{\"job\":\"check\"}",
        holdMillis: 30_000
      })
      const decoded = yield* encodePlanDraftJson(draft([inline])).pipe(
        Effect.flatMap(decodePlanDraftJson)
      )
      expect(decoded.nodes[0]).toMatchObject({
        _tag: "RequestExternal",
        headers: { "content-type": "application/json", "x-trace": "plan-test" },
        body: "{\"job\":\"check\"}"
      })

      const artifactBacked = new RequestExternalNode({
        ...inline,
        id: id("external-artifact"),
        dependsOn: [capture.id],
        body: undefined,
        bodyArtifact: capture.produces[0]
      })
      expect((yield* orderPlan(draft([capture, artifactBacked]))).map((node) => node.id))
        .toEqual([capture.id, artifactBacked.id])

      const ambiguous = new RequestExternalNode({
        ...inline,
        id: id("external-ambiguous"),
        bodyArtifact: capture.produces[0]
      })
      const ambiguousFailure = yield* orderPlan(draft([capture, ambiguous])).pipe(Effect.flip)
      expect(ambiguousFailure).toBeInstanceOf(InvalidRequestExternalContract)
      expect(ambiguousFailure).toMatchObject({
        field: "body/bodyArtifact"
      })

      const missingArtifact = new RequestExternalNode({
        ...artifactBacked,
        id: id("external-missing-artifact"),
        bodyArtifact: ArtifactId.make("artifact/not-produced")
      })
      const missingFailure = yield* orderPlan(draft([capture, missingArtifact])).pipe(Effect.flip)
      expect(missingFailure).toMatchObject({
        _tag: "InvalidRequestExternalContract",
        field: "bodyArtifact"
      })

      const unrelated = new RequestExternalNode({
        ...artifactBacked,
        id: id("external-unrelated"),
        dependsOn: []
      })
      const dependencyFailure = yield* orderPlan(draft([capture, unrelated])).pipe(Effect.flip)
      expect(dependencyFailure).toMatchObject({
        _tag: "InvalidRequestExternalContract",
        field: "dependsOn"
      })

      const duplicateProducer = new CaptureNode({
        ...capture,
        id: id("duplicate-body-producer")
      })
      const duplicateFailure = yield* orderPlan(
        draft([capture, duplicateProducer, artifactBacked])
      ).pipe(Effect.flip)
      expect(duplicateFailure).toMatchObject({
        _tag: "InvalidRequestExternalContract",
        field: "bodyArtifact"
      })
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
