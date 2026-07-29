import { FileSystem, Path } from "@effect/platform"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import * as nodePath from "node:path"
import { Hold } from "../Hold.ts"
import { EmissionRequest } from "../domain.ts"
import { Outbox } from "../Outbox.ts"
import {
  type ArtifactId,
  Artifact,
  type Digest,
  type Handle,
  type NodeId,
  type NodeState,
  type Plan,
  type PlanNode,
  Receipt,
  type ReceiptId
} from "../plan/index.ts"
import { ProcessInputBytes, ProcessRequest, ProcessRunner } from "../process/Process.ts"

/**
 * The first Plan interpreter is a candidate component, not a general shell.
 *
 * It deliberately keeps adapter policy local: Plan shapes currently express
 * text/file observations, argv execution, held text writes/removals, and
 * staged HTTP intents. Missing shape is surfaced as an explicit node receipt;
 * it is never guessed into a shell string or a direct network call.
 */

export const RuntimeProfile = Schema.Literal(
  "compatibility",
  "native-contained",
  "vm-enclosed"
)
export type RuntimeProfile = typeof RuntimeProfile.Type

export class RuntimeConfig extends Schema.Class<RuntimeConfig>("RuntimeConfig")({
  workspace: Schema.String,
  profile: Schema.optionalWith(RuntimeProfile, { default: () => "compatibility" as const }),
  environment: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    default: () => ({})
  })
}) {}

export class RuntimeArtifact extends Schema.Class<RuntimeArtifact>("RuntimeArtifact")({
  artifact: Artifact,
  bytes: Schema.Uint8Array
}) {}

export class RuntimeRun extends Schema.Class<RuntimeRun>("RuntimeRun")({
  planId: Schema.String,
  state: Schema.Literal("succeeded", "failed", "partial"),
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.DateTimeUtc,
  receipts: Schema.Array(Receipt),
  artifacts: Schema.Array(RuntimeArtifact)
}) {}

export class RuntimePlanInvalid extends Schema.TaggedError<RuntimePlanInvalid>()(
  "RuntimePlanInvalid",
  { planId: Schema.String, reason: Schema.String }
) {}

export class RuntimeNodeFailure extends Schema.TaggedError<RuntimeNodeFailure>()(
  "RuntimeNodeFailure",
  { nodeId: Schema.String, operation: Schema.String, reason: Schema.String }
) {}

export class RuntimeUnsupported extends Schema.TaggedError<RuntimeUnsupported>()(
  "RuntimeUnsupported",
  { nodeId: Schema.String, feature: Schema.String, reason: Schema.String }
) {}

export class RuntimeCapabilityDenied extends Schema.TaggedError<RuntimeCapabilityDenied>()(
  "RuntimeCapabilityDenied",
  { nodeId: Schema.String, right: Schema.String, reason: Schema.String }
) {}

export type RuntimeError =
  | RuntimePlanInvalid
  | RuntimeNodeFailure
  | RuntimeUnsupported
  | RuntimeCapabilityDenied

export class Runtime extends Context.Tag("airlock/Runtime")<
  Runtime,
  {
    /** Executes every admitted node or records why it did not execute. */
    readonly execute: (plan: Plan) => Effect.Effect<RuntimeRun, RuntimePlanInvalid>
  }
>() {}

export const RuntimeConfigLive = (config: RuntimeConfig) =>
  Layer.succeed(Context.GenericTag<RuntimeConfig>("airlock/RuntimeConfig"), config)

const RuntimeConfigTag = Context.GenericTag<RuntimeConfig>("airlock/RuntimeConfig")

const digest = (bytes: Uint8Array): Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest

const artifact = (id: ArtifactId, bytes: Uint8Array, provenance: string) =>
  new RuntimeArtifact({
    artifact: new Artifact({
      id,
      digest: digest(bytes),
      mediaType: "application/octet-stream",
      byteLength: bytes.byteLength,
      provenance
    }),
    bytes
  })

const receiptId = (): ReceiptId => `receipt_${crypto.randomUUID()}` as ReceiptId

const text = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

const errorReason = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)

const handleMap = (plan: Plan) => new Map(plan.handles.map((handle) => [handle.id, handle]))

const handlesFor = (plan: Plan, node: PlanNode): ReadonlyArray<Handle> => {
  const byId = handleMap(plan)
  const resolutions = new Map(plan.resolutions.map((resolution) => [resolution.requirementId, resolution.handleId]))
  return node.requires.flatMap((requirement) => {
    const id = resolutions.get(requirement)
    const handle = id === undefined ? undefined : byId.get(id)
    return handle === undefined ? [] : [handle]
  })
}

const validatePlan = (plan: Plan): Effect.Effect<ReadonlyArray<PlanNode>, RuntimePlanInvalid> =>
  Effect.try({
    try: () => {
    const ids = new Set<string>()
    for (const node of plan.nodes) {
      if (ids.has(node.id)) {
        throw new RuntimePlanInvalid({ planId: plan.id, reason: `duplicate node id: ${node.id}` })
      }
      ids.add(node.id)
    }
    const remaining = new Map(plan.nodes.map((node) => [node.id, node.dependsOn.length]))
    const children = new Map(plan.nodes.map((node) => [node.id, [] as Array<NodeId>]))
    for (const node of plan.nodes) {
      for (const dependency of node.dependsOn) {
        if (!ids.has(dependency)) {
          throw new RuntimePlanInvalid({
            planId: plan.id,
            reason: `node ${node.id} depends on unknown node ${dependency}`
          })
        }
        children.get(dependency)!.push(node.id)
      }
    }
    const byId = new Map(plan.nodes.map((node) => [node.id, node]))
    const ready = plan.nodes.filter((node) => remaining.get(node.id) === 0)
    const ordered: Array<PlanNode> = []
    while (ready.length > 0) {
      const next = ready.shift()!
      ordered.push(next)
      for (const child of children.get(next.id) ?? []) {
        const count = (remaining.get(child) ?? 0) - 1
        remaining.set(child, count)
        if (count === 0) ready.push(byId.get(child)!)
      }
    }
    if (ordered.length !== plan.nodes.length) {
      throw new RuntimePlanInvalid({ planId: plan.id, reason: "plan dependency graph is cyclic" })
    }
      return ordered
    },
    catch: (cause) =>
      cause instanceof RuntimePlanInvalid
        ? cause
        : new RuntimePlanInvalid({ planId: plan.id, reason: errorReason(cause) })
  })

const nodeReceipt = (
  plan: Plan,
  node: PlanNode,
  sequence: number,
  state: NodeState,
  artifacts: ReadonlyMap<ArtifactId, RuntimeArtifact>,
  outputArtifacts: ReadonlyArray<ArtifactId>,
  resourceIdentities: ReadonlyArray<string>,
  errorTag?: string
) =>
  Effect.map(DateTime.now, (at) =>
    new Receipt({
      id: receiptId(),
      planId: plan.id,
      nodeId: node.id,
      sequence,
      state,
      at,
      inputDigests: node._tag === "Invoke" && node.stdin !== undefined
        ? [artifacts.get(node.stdin)?.artifact.digest].filter((value): value is Digest => value !== undefined)
        : node._tag === "Apply" && node.sourceArtifact !== undefined
          ? [artifacts.get(node.sourceArtifact)?.artifact.digest].filter((value): value is Digest => value !== undefined)
          : [],
      outputArtifacts,
      resourceIdentities,
      ...(errorTag === undefined ? {} : { errorTag })
    })
  )

const enforce = (config: RuntimeConfig, plan: Plan, node: PlanNode): Effect.Effect<void, RuntimeError> => {
  if (config.profile === "compatibility") return Effect.void
  if (config.profile === "vm-enclosed") {
    return Effect.fail(new RuntimeUnsupported({
      nodeId: node.id,
      feature: "vm-enclosed execution",
      reason: "no macOS VM Cell backend is installed in this runtime"
    }))
  }
  return Effect.fail(new RuntimeUnsupported({
    nodeId: node.id,
    feature: "native-contained execution",
    reason:
      "the macOS Cell adapter is not installed in this interpreter; refusing to silently execute on the host"
  }))
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const config = yield* RuntimeConfigTag
  const process = yield* ProcessRunner
  const hold = yield* Hold
  const outbox = yield* Outbox

  const localPath = (locator: string) =>
    nodePath.isAbsolute(locator) ? locator : path.join(config.workspace, locator)

  const runNode = (
    plan: Plan,
    node: PlanNode,
    artifacts: Map<ArtifactId, RuntimeArtifact>
  ): Effect.Effect<ReadonlyArray<ArtifactId>, RuntimeError> =>
    Effect.gen(function* () {
      yield* enforce(config, plan, node)
      switch (node._tag) {
        case "Capture": {
          let bytes: Uint8Array
          switch (node.source) {
            case "file":
              bytes = yield* fs.readFile(localPath(node.locator)).pipe(
                Effect.mapError((error) => new RuntimeNodeFailure({
                  nodeId: node.id, operation: "read file", reason: errorReason(error)
                }))
              )
              break
            case "environment": {
              const value = config.environment[node.locator]
              if (value === undefined) {
                return yield* new RuntimeNodeFailure({
                  nodeId: node.id, operation: "read environment", reason: `not present: ${node.locator}`
                })
              }
              bytes = text.encode(value)
              break
            }
            case "clock":
              bytes = text.encode((yield* DateTime.now).toString())
              break
            case "process-output":
              return yield* new RuntimeUnsupported({
                nodeId: node.id,
                feature: "process-output Capture",
                reason: "Plan v1 does not identify the source Invoke artifact"
              })
          }
          for (const id of node.produces) artifacts.set(id, artifact(id, bytes, `${node.source}:${node.locator}`))
          return node.produces
        }
        case "Invoke": {
          if (node.cellProfile !== "compatibility") {
            return yield* new RuntimeUnsupported({
              nodeId: node.id,
              feature: `Cell profile ${node.cellProfile}`,
              reason: "only the compatibility Cell is installed in v1 runtime"
            })
          }
          const executable = node.argv[0]
          if (executable === undefined || executable.length === 0) {
            return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "invoke", reason: "argv[0] executable is required" })
          }
          const stdin = node.stdin === undefined ? undefined : artifacts.get(node.stdin)
          if (node.stdin !== undefined && stdin === undefined) {
            return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "invoke", reason: `missing stdin artifact ${node.stdin}` })
          }
          const result = yield* process.run(new ProcessRequest({
            executable,
            argv: node.argv.slice(1),
            cwd: config.workspace,
            env: config.environment,
            ...(stdin === undefined
              ? {}
              : { stdin: new ProcessInputBytes({ _tag: "bytes", bytes: stdin.bytes }) })
          })).pipe(
            Effect.mapError((error) => new RuntimeNodeFailure({
              nodeId: node.id, operation: "invoke", reason: `${error._tag}: ${errorReason(error)}`
            }))
          )
          if (result.exitCode !== 0 || result.signal !== null) {
            return yield* new RuntimeNodeFailure({
              nodeId: node.id,
              operation: "invoke",
              reason: `process exited ${result.exitCode === null ? result.signal : result.exitCode}`
            })
          }
          for (const id of node.produces) artifacts.set(id, artifact(id, result.stdout, `invoke:${executable}`))
          return node.produces
        }
        case "Apply": {
          const target = localPath(node.target)
          switch (node.operation) {
            case "remove":
              yield* hold.remove(target).pipe(
                Effect.mapError((error) => new RuntimeNodeFailure({
                  nodeId: node.id, operation: "hold remove", reason: `${error._tag}: ${errorReason(error)}`
                }))
              )
              return node.produces
            case "write": {
              if (node.sourceArtifact === undefined) {
                return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "hold write", reason: "sourceArtifact is required" })
              }
              const source = artifacts.get(node.sourceArtifact)
              if (source === undefined) {
                return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "hold write", reason: `missing artifact ${node.sourceArtifact}` })
              }
              let content: string
              try {
                content = textDecoder.decode(source.bytes)
              } catch {
                return yield* new RuntimeUnsupported({
                  nodeId: node.id,
                  feature: "binary Apply.write",
                  reason: "Hold v1 accepts text only; no lossy byte conversion is performed"
                })
              }
              yield* hold.overwrite(target, content).pipe(
                Effect.mapError((error) => new RuntimeNodeFailure({
                  nodeId: node.id, operation: "hold write", reason: `${error._tag}: ${errorReason(error)}`
                }))
              )
              return node.produces
            }
            case "move":
              return yield* new RuntimeUnsupported({
                nodeId: node.id,
                feature: "Apply.move",
                reason: "Plan v1 has no source path binding and Hold exposes no move operation"
              })
          }
        }
        case "RequestExternal":
          yield* outbox.stage(new EmissionRequest({ url: node.endpoint, method: node.method }), node.holdMillis).pipe(
            Effect.mapError((error) => new RuntimeNodeFailure({
              nodeId: node.id, operation: "stage external", reason: errorReason(error)
            }))
          )
          return node.produces
      }
    })

  const execute = (plan: Plan): Effect.Effect<RuntimeRun, RuntimePlanInvalid> =>
    Effect.gen(function* () {
      const ordered = yield* validatePlan(plan)
      const startedAt = yield* DateTime.now
      const artifacts = new Map<ArtifactId, RuntimeArtifact>()
      const receipts: Array<Receipt> = []
      const stateByNode = new Map<NodeId, NodeState>()
      let failed = false

      for (const node of ordered) {
        const handles = handlesFor(plan, node)
        const dependenciesSucceeded = node.dependsOn.every((dependency) => stateByNode.get(dependency) === "succeeded")
        if (!dependenciesSucceeded) {
          const receipt = yield* nodeReceipt(plan, node, receipts.length + 1, "cancelled", artifacts, [], handles.map((handle) => handle.resourceIdentity), "RuntimeDependencyFailed")
          receipts.push(receipt)
          stateByNode.set(node.id, "cancelled")
          failed = true
          continue
        }
        const result = yield* runNode(plan, node, artifacts).pipe(Effect.either)
        if (result._tag === "Left") {
          const receipt = yield* nodeReceipt(plan, node, receipts.length + 1, "failed", artifacts, [], handles.map((handle) => handle.resourceIdentity), result.left._tag)
          receipts.push(receipt)
          stateByNode.set(node.id, "failed")
          failed = true
        } else {
          const receipt = yield* nodeReceipt(plan, node, receipts.length + 1, "succeeded", artifacts, result.right, handles.map((handle) => handle.resourceIdentity))
          receipts.push(receipt)
          stateByNode.set(node.id, "succeeded")
        }
      }
      const finishedAt = yield* DateTime.now
      const succeeded = receipts.filter((receipt) => receipt.state === "succeeded").length
      return new RuntimeRun({
        planId: plan.id,
        state: failed ? (succeeded > 0 ? "partial" : "failed") : "succeeded",
        startedAt,
        finishedAt,
        receipts,
        artifacts: [...artifacts.values()]
      })
    })

  return Runtime.of({ execute })
})

/** Candidate composition root: adapters supply filesystem, process, Hold, and Outbox. */
export const RuntimeLive = Layer.effect(Runtime, make)
