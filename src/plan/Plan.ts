import { Effect, Schema } from "effect"

// The canonical, adapter-free planning boundary. Locators are inert data;
// authority enters only as Grants and runtime-minted Handles.

export const PlanId = Schema.String.pipe(Schema.brand("PlanId"))
export type PlanId = typeof PlanId.Type
export const NodeId = Schema.String.pipe(Schema.brand("NodeId"))
export type NodeId = typeof NodeId.Type
export const RequirementId = Schema.String.pipe(Schema.brand("RequirementId"))
export type RequirementId = typeof RequirementId.Type
export const GrantId = Schema.String.pipe(Schema.brand("GrantId"))
export type GrantId = typeof GrantId.Type
export const HandleId = Schema.String.pipe(Schema.brand("HandleId"))
export type HandleId = typeof HandleId.Type
export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type
export const ReceiptId = Schema.String.pipe(Schema.brand("ReceiptId"))
export type ReceiptId = typeof ReceiptId.Type
export const Digest = Schema.String.pipe(Schema.brand("Digest"))
export type Digest = typeof Digest.Type

export const Right = Schema.Literal("read", "write", "execute", "connect", "emit")
export type Right = typeof Right.Type

export const HandleKind = Schema.Literal(
  "path",
  "executable",
  "endpoint",
  "artifact",
  "secret",
  "stream"
)
export type HandleKind = typeof HandleKind.Type

/**
 * The Cell selected for an invocation. Compatibility preserves the ratchet;
 * the contained profiles are explicit authority reductions.
 */
export const CellProfile = Schema.Literal(
  "compatibility",
  "native-contained",
  "vm-enclosed"
)
export type CellProfile = typeof CellProfile.Type

/** Stream disposition is part of the admitted process contract, never shell syntax. */
export const StreamDisposition = Schema.Literal("capture", "inherit", "discard")
export type StreamDisposition = typeof StreamDisposition.Type

export class Grant extends Schema.Class<Grant>("Grant")({
  id: GrantId,
  principal: Schema.String,
  realm: Schema.String,
  selector: Schema.String,
  rights: Schema.Array(Right),
  constraints: Schema.Record({ key: Schema.String, value: Schema.String }),
  issuedBy: Schema.String,
  validUntil: Schema.optional(Schema.DateTimeUtc)
}) {}

export class Handle extends Schema.Class<Handle>("Handle")({
  id: HandleId,
  kind: HandleKind,
  realm: Schema.String,
  resourceIdentity: Schema.String,
  rights: Schema.Array(Right),
  constraints: Schema.Record({ key: Schema.String, value: Schema.String }),
  grantId: GrantId,
  publicProvenance: Schema.String
}) {}

export class ResourceRequirement extends Schema.Class<ResourceRequirement>("ResourceRequirement")({
  id: RequirementId,
  kind: HandleKind,
  realm: Schema.String,
  selector: Schema.String,
  rights: Schema.Array(Right)
}) {}

const NodeBase = {
  id: NodeId,
  dependsOn: Schema.Array(NodeId),
  requires: Schema.Array(RequirementId),
  produces: Schema.Array(ArtifactId)
}

export class CaptureNode extends Schema.TaggedClass<CaptureNode>("CaptureNode")("Capture", {
  ...NodeBase,
  source: Schema.Literal("file", "environment", "clock", "process-output"),
  locator: Schema.String
}) {}

export class InvokeNode extends Schema.TaggedClass<InvokeNode>("InvokeNode")("Invoke", {
  ...NodeBase,
  /** Always an absolute executable identity in Plan v1; executable handles bind via requirements. */
  executable: Schema.String,
  /** Individual argument atoms. The executable is never embedded here. */
  args: Schema.Array(Schema.String),
  /** Omitted means the Cell's admitted working directory. */
  cwd: Schema.optional(Schema.String),
  /** An explicit environment overlay; no inherited ambient environment is implied. */
  env: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    default: () => ({})
  }),
  /** Stdin can only be a previously captured/staged artifact in Plan v1. */
  stdin: Schema.optional(ArtifactId),
  /**
   * Captured process streams are named artifacts when later Plan nodes need
   * them. They are deliberately not inferred from their position in
   * `produces`: a Cell receipt can always describe the streams it observed,
   * while the Plan declares only the streams it exports as dataflow.
   */
  stdoutArtifact: Schema.optional(ArtifactId),
  stderrArtifact: Schema.optional(ArtifactId),
  /** A private Cell workspace delta, consumable only by Apply.merge. */
  deltaArtifact: Schema.optional(ArtifactId),
  stdout: Schema.optionalWith(StreamDisposition, { default: () => "capture" as const }),
  stderr: Schema.optionalWith(StreamDisposition, { default: () => "capture" as const }),
  outputLimitBytes: Schema.optionalWith(Schema.Number, { default: () => 1_048_576 }),
  timeoutMs: Schema.optional(Schema.Number),
  cellProfile: CellProfile
}) {}

export class ApplyNode extends Schema.TaggedClass<ApplyNode>("ApplyNode")("Apply", {
  ...NodeBase,
  /**
   * `merge` applies an opaque private-Cell delta to the target workspace.
   * It remains Apply physics: the runtime must still transition live state
   * through Hold rather than installing the delta directly.
   */
  operation: Schema.Literal("write", "remove", "move", "merge"),
  target: Schema.String,
  sourceArtifact: Schema.optional(ArtifactId)
}) {}

// RequestExternal is intent only. Its adapter must stage through Outbox before
// it can cross the network boundary.
export class RequestExternalNode extends Schema.TaggedClass<RequestExternalNode>(
  "RequestExternalNode"
)("RequestExternal", {
  ...NodeBase,
  method: Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE"),
  endpoint: Schema.String,
  holdMillis: Schema.Number
}) {}

export const PlanNode = Schema.Union(
  CaptureNode,
  InvokeNode,
  ApplyNode,
  RequestExternalNode
)
export type PlanNode = typeof PlanNode.Type

export class PlanDraft extends Schema.Class<PlanDraft>("PlanDraft")({
  schemaVersion: Schema.Literal("airlock/plan-draft/v1"),
  id: PlanId,
  actionReference: Schema.String,
  nodes: Schema.Array(PlanNode),
  requirements: Schema.Array(ResourceRequirement),
  policyDigest: Schema.optional(Digest),
  definitionDigests: Schema.Array(Digest)
}) {}

export class AuthorityAdmission extends Schema.Class<AuthorityAdmission>("AuthorityAdmission")({
  grantIds: Schema.Array(GrantId),
  admittedBy: Schema.String,
  admittedAt: Schema.DateTimeUtc,
  policyDigest: Schema.optional(Digest)
}) {}

export class HandleResolution extends Schema.Class<HandleResolution>("HandleResolution")({
  requirementId: RequirementId,
  handleId: HandleId
}) {}

export class Plan extends Schema.Class<Plan>("Plan")({
  schemaVersion: Schema.Literal("airlock/plan/v1"),
  id: PlanId,
  actionReference: Schema.String,
  nodes: Schema.Array(PlanNode),
  handles: Schema.Array(Handle),
  resolutions: Schema.Array(HandleResolution),
  admission: AuthorityAdmission,
  definitionDigests: Schema.Array(Digest),
  planDigest: Digest
}) {}

export const PlanState = Schema.Literal(
  "draft",
  "admitted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "partial",
  "uncertain",
  "recovery-required"
)
export type PlanState = typeof PlanState.Type

export const NodeState = Schema.Literal(
  "planned",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "drifted",
  "conflicted",
  "uncertain",
  "recovery-required"
)
export type NodeState = typeof NodeState.Type

export class PlanRuntime extends Schema.Class<PlanRuntime>("PlanRuntime")({
  planId: PlanId,
  state: PlanState,
  nodeStates: Schema.Array(Schema.Tuple(NodeId, NodeState)),
  sequence: Schema.Number
}) {}

export class Artifact extends Schema.Class<Artifact>("Artifact")({
  id: ArtifactId,
  digest: Digest,
  mediaType: Schema.String,
  byteLength: Schema.Number,
  provenance: Schema.String
}) {}

export class Receipt extends Schema.Class<Receipt>("Receipt")({
  id: ReceiptId,
  planId: PlanId,
  nodeId: NodeId,
  sequence: Schema.Number,
  state: NodeState,
  at: Schema.DateTimeUtc,
  inputDigests: Schema.Array(Digest),
  outputArtifacts: Schema.Array(ArtifactId),
  resourceIdentities: Schema.Array(Schema.String),
  errorTag: Schema.optional(Schema.String)
}) {}

// These codecs are the sole persistence/wire representation of Plan v1. They
// intentionally preserve the declared array order (including canonical DAG
// order after admission) instead of hiding it behind an object map.
export const encodePlanDraftJson = Schema.encode(Schema.parseJson(PlanDraft))
export const decodePlanDraftJson = Schema.decode(Schema.parseJson(PlanDraft))
export const encodePlanJson = Schema.encode(Schema.parseJson(Plan))
export const decodePlanJson = Schema.decode(Schema.parseJson(Plan))
export const encodeReceiptJson = Schema.encode(Schema.parseJson(Receipt))
export const decodeReceiptJson = Schema.decode(Schema.parseJson(Receipt))

export class DuplicateNodeId extends Schema.TaggedError<DuplicateNodeId>()(
  "DuplicateNodeId",
  { id: Schema.String }
) {}
export class UnknownDependency extends Schema.TaggedError<UnknownDependency>()(
  "UnknownDependency",
  { nodeId: Schema.String, dependency: Schema.String }
) {}
export class CyclicPlan extends Schema.TaggedError<CyclicPlan>()("CyclicPlan", {
  nodeIds: Schema.Array(Schema.String)
}) {}
export class UnknownRequirement extends Schema.TaggedError<UnknownRequirement>()(
  "UnknownRequirement",
  { nodeId: Schema.String, requirement: Schema.String }
) {}
export class DuplicateRequirementId extends Schema.TaggedError<DuplicateRequirementId>()(
  "DuplicateRequirementId",
  { id: Schema.String }
) {}
export class InvalidInvokeContract extends Schema.TaggedError<InvalidInvokeContract>()(
  "InvalidInvokeContract",
  { nodeId: Schema.String, field: Schema.String, reason: Schema.String }
) {}
export class InvalidApplyContract extends Schema.TaggedError<InvalidApplyContract>()(
  "InvalidApplyContract",
  { nodeId: Schema.String, field: Schema.String, reason: Schema.String }
) {}
export class RequirementUnresolved extends Schema.TaggedError<RequirementUnresolved>()(
  "RequirementUnresolved",
  { requirement: Schema.String }
) {}
export class HandleGrantMismatch extends Schema.TaggedError<HandleGrantMismatch>()(
  "HandleGrantMismatch",
  { handleId: Schema.String, grantId: Schema.String }
) {}
export class InvalidPlanTransition extends Schema.TaggedError<InvalidPlanTransition>()(
  "InvalidPlanTransition",
  { from: PlanState, to: PlanState }
) {}
export class InvalidNodeTransition extends Schema.TaggedError<InvalidNodeTransition>()(
  "InvalidNodeTransition",
  { nodeId: Schema.String, from: NodeState, to: NodeState }
) {}

export type PlanValidationError =
  | DuplicateNodeId
  | UnknownDependency
  | CyclicPlan
  | UnknownRequirement
  | DuplicateRequirementId
  | InvalidInvokeContract
  | InvalidApplyContract

const duplicates = (values: ReadonlyArray<string>) =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort()

const invalidInvoke = (node: InvokeNode, field: string, reason: string) =>
  new InvalidInvokeContract({ nodeId: node.id, field, reason })

const invalidApply = (node: ApplyNode, field: string, reason: string) =>
  new InvalidApplyContract({ nodeId: node.id, field, reason })

/**
 * Checks the facts Schema cannot cheaply express and keeps the process
 * boundary honest before authority admission. This intentionally validates
 * atoms only: Airlock composes existing programs, it does not parse their
 * command-line grammars.
 */
const validateInvoke = (node: InvokeNode): InvalidInvokeContract | undefined => {
  if (!node.executable.startsWith("/")) {
    return invalidInvoke(node, "executable", "must be an absolute executable identity")
  }
  if (node.executable.includes("\0")) {
    return invalidInvoke(node, "executable", "must not contain NUL")
  }
  if (node.cwd !== undefined && (!node.cwd.startsWith("/") || node.cwd.includes("\0"))) {
    return invalidInvoke(node, "cwd", "must be an absolute path without NUL when provided")
  }
  for (const [index, argument] of node.args.entries()) {
    if (argument.includes("\0")) return invalidInvoke(node, `args[${index}]`, "must not contain NUL")
  }
  for (const [key, value] of Object.entries(node.env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      return invalidInvoke(node, "env", "keys must be non-empty without = or NUL; values must not contain NUL")
    }
  }
  if (!Number.isSafeInteger(node.outputLimitBytes) || node.outputLimitBytes < 0) {
    return invalidInvoke(node, "outputLimitBytes", "must be a non-negative safe integer")
  }
  if (node.timeoutMs !== undefined && (!Number.isSafeInteger(node.timeoutMs) || node.timeoutMs <= 0)) {
    return invalidInvoke(node, "timeoutMs", "must be a positive safe integer when provided")
  }

  const namedArtifacts: ReadonlyArray<readonly ["stdoutArtifact" | "stderrArtifact" | "deltaArtifact", ArtifactId | undefined]> = [
    ["stdoutArtifact", node.stdoutArtifact],
    ["stderrArtifact", node.stderrArtifact],
    ["deltaArtifact", node.deltaArtifact]
  ]
  for (const [field, artifact] of namedArtifacts) {
    if (artifact !== undefined) {
      const declarations = node.produces.filter((produced) => produced === artifact).length
      if (declarations !== 1) {
        return invalidInvoke(node, field, "must be declared exactly once in produces")
      }
    }
  }
  const outputIds = namedArtifacts.flatMap(([, artifact]) => artifact === undefined ? [] : [artifact])
  const duplicateOutput = duplicates(outputIds)[0]
  if (duplicateOutput !== undefined) {
    return invalidInvoke(node, "produces", `named output artifact ${duplicateOutput} must be unique`)
  }
  const unnamedOutput = node.produces.find((produced) => !outputIds.includes(produced))
  if (unnamedOutput !== undefined) {
    return invalidInvoke(
      node,
      "produces",
      `artifact ${unnamedOutput} must be bound as stdoutArtifact, stderrArtifact, or deltaArtifact`
    )
  }
  if (node.stdoutArtifact !== undefined && node.stdout !== "capture") {
    return invalidInvoke(node, "stdoutArtifact", "requires stdout disposition capture")
  }
  if (node.stderrArtifact !== undefined && node.stderr !== "capture") {
    return invalidInvoke(node, "stderrArtifact", "requires stderr disposition capture")
  }
  if (node.deltaArtifact !== undefined && node.cellProfile === "compatibility") {
    return invalidInvoke(node, "deltaArtifact", "requires a contained Cell profile")
  }
  return undefined
}

const dependencyClosure = (nodes: ReadonlyArray<PlanNode>, node: PlanNode): ReadonlySet<NodeId> => {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  const reachable = new Set<NodeId>()
  const visit = (id: NodeId): void => {
    if (reachable.has(id)) return
    reachable.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
  }
  for (const dependency of node.dependsOn) visit(dependency)
  return reachable
}

/**
 * A merge never receives arbitrary bytes: only a delta produced by a contained
 * Cell can cross from Invoke to Apply. This makes the process/commit boundary
 * explicit without creating a fifth Plan node.
 */
const validateApply = (
  node: ApplyNode,
  nodes: ReadonlyArray<PlanNode>
): InvalidApplyContract | undefined => {
  if (node.operation !== "merge") return undefined
  if (node.sourceArtifact === undefined) {
    return invalidApply(node, "sourceArtifact", "merge requires a Cell delta artifact")
  }
  const producers = nodes.filter(
    (candidate): candidate is InvokeNode =>
      candidate._tag === "Invoke" && candidate.deltaArtifact === node.sourceArtifact
  )
  if (producers.length !== 1) {
    return invalidApply(
      node,
      "sourceArtifact",
      producers.length === 0
        ? "must name exactly one contained Invoke delta artifact"
        : "is ambiguous across multiple Invoke delta artifacts"
    )
  }
  const producer = producers[0]!
  if (!dependencyClosure(nodes, node).has(producer.id)) {
    return invalidApply(node, "dependsOn", "must depend on the Invoke that produced its delta artifact")
  }
  return undefined
}

/** Validates the inert draft and returns stable topological order. */
export const orderPlan = (
  draft: PlanDraft
): Effect.Effect<ReadonlyArray<PlanNode>, PlanValidationError> =>
  Effect.gen(function* () {
    const nodeIds = draft.nodes.map((node) => node.id)
    const duplicateNode = duplicates(nodeIds)[0]
    if (duplicateNode !== undefined) return yield* new DuplicateNodeId({ id: duplicateNode })

    const requirementIds = draft.requirements.map((requirement) => requirement.id)
    const duplicateRequirement = duplicates(requirementIds)[0]
    if (duplicateRequirement !== undefined) {
      return yield* new DuplicateRequirementId({ id: duplicateRequirement })
    }

    const knownNodes = new Set(nodeIds)
    const knownRequirements = new Set(requirementIds)
    for (const node of draft.nodes) {
      if (node._tag === "Invoke") {
        const invalid = validateInvoke(node)
        if (invalid !== undefined) return yield* invalid
      }
      if (node._tag === "Apply") {
        const invalid = validateApply(node, draft.nodes)
        if (invalid !== undefined) return yield* invalid
      }
      for (const dependency of node.dependsOn) {
        if (!knownNodes.has(dependency)) {
          return yield* new UnknownDependency({ nodeId: node.id, dependency })
        }
      }
      for (const requirement of node.requires) {
        if (!knownRequirements.has(requirement)) {
          return yield* new UnknownRequirement({ nodeId: node.id, requirement })
        }
      }
    }

    // Kahn's algorithm with draft position as the tie breaker makes execution
    // order stable without imposing a lexicographic policy on user node ids.
    const byId = new Map(draft.nodes.map((node) => [node.id, node]))
    const indegree = new Map(nodeIds.map((id) => [id, 0]))
    const children = new Map(nodeIds.map((id) => [id, [] as Array<NodeId>]))
    for (const node of draft.nodes) {
      for (const dependency of node.dependsOn) {
        indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1)
        children.get(dependency)?.push(node.id)
      }
    }
    const ready = draft.nodes.filter((node) => indegree.get(node.id) === 0)
    const ordered: Array<PlanNode> = []
    while (ready.length > 0) {
      const node = ready.shift()
      if (node === undefined) break
      ordered.push(node)
      for (const childId of children.get(node.id) ?? []) {
        const remaining = (indegree.get(childId) ?? 0) - 1
        indegree.set(childId, remaining)
        if (remaining === 0) ready.push(byId.get(childId)!)
      }
    }
    if (ordered.length !== draft.nodes.length) {
      return yield* new CyclicPlan({
        nodeIds: draft.nodes
          .filter((node) => (indegree.get(node.id) ?? 0) > 0)
          .map((node) => node.id)
          .sort()
      })
    }
    return ordered
  })

export const closeExecution = (
  draft: PlanDraft,
  handles: ReadonlyArray<Handle>,
  resolutions: ReadonlyArray<HandleResolution>,
  grants: ReadonlyArray<Grant>,
  admission: AuthorityAdmission,
  planDigest: Digest
): Effect.Effect<Plan, PlanValidationError | RequirementUnresolved | HandleGrantMismatch> =>
  Effect.gen(function* () {
    const ordered = yield* orderPlan(draft)
    const handlesById = new Map(handles.map((handle) => [handle.id, handle]))
    const resolutionByRequirement = new Map(
      resolutions.map((resolution) => [resolution.requirementId, resolution.handleId])
    )
    const grantsById = new Map(grants.map((grant) => [grant.id, grant]))
    for (const requirement of draft.requirements) {
      const handle = handlesById.get(resolutionByRequirement.get(requirement.id)!)
      if (handle === undefined) return yield* new RequirementUnresolved({ requirement: requirement.id })
      if (!grantsById.has(handle.grantId) || !admission.grantIds.includes(handle.grantId)) {
        return yield* new HandleGrantMismatch({ handleId: handle.id, grantId: handle.grantId })
      }
      if (
        handle.kind !== requirement.kind ||
        handle.realm !== requirement.realm ||
        !requirement.rights.every((right) => handle.rights.includes(right))
      ) {
        return yield* new RequirementUnresolved({ requirement: requirement.id })
      }
    }
    return new Plan({
      schemaVersion: "airlock/plan/v1",
      id: draft.id,
      actionReference: draft.actionReference,
      nodes: ordered,
      handles,
      resolutions,
      admission,
      definitionDigests: draft.definitionDigests,
      planDigest
    })
  })

const planTransitions: Readonly<Record<PlanState, ReadonlyArray<PlanState>>> = {
  draft: ["admitted", "cancelled"],
  admitted: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "partial", "uncertain", "recovery-required"],
  succeeded: [], failed: [], cancelled: [], partial: [], uncertain: [], "recovery-required": []
}
const nodeTransitions: Readonly<Record<NodeState, ReadonlyArray<NodeState>>> = {
  planned: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "drifted", "conflicted", "uncertain", "recovery-required"],
  succeeded: [], failed: [], cancelled: [], drifted: [], conflicted: [], uncertain: [], "recovery-required": []
}

export const transitionPlan = (runtime: PlanRuntime, to: PlanState) =>
  planTransitions[runtime.state].includes(to)
    ? Effect.succeed(new PlanRuntime({ ...runtime, state: to, sequence: runtime.sequence + 1 }))
    : Effect.fail(new InvalidPlanTransition({ from: runtime.state, to }))

export const transitionNode = (runtime: PlanRuntime, nodeId: NodeId, to: NodeState) => {
  const current = runtime.nodeStates.find(([id]) => id === nodeId)?.[1]
  if (current === undefined || !nodeTransitions[current].includes(to)) {
    return Effect.fail(new InvalidNodeTransition({ nodeId, from: current ?? "planned", to }))
  }
  return Effect.succeed(
    new PlanRuntime({
      ...runtime,
      nodeStates: runtime.nodeStates.map(([id, state]) => [id, id === nodeId ? to : state] as const),
      sequence: runtime.sequence + 1
    })
  )
}
