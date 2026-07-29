import { FileSystem, Path } from "@effect/platform"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import * as nodePath from "node:path"
import { Cell, CellReceipt, CellRequest, WorkspaceDeltaCandidate } from "../cell/index.ts"
import { Hold } from "../Hold.ts"
import { EmissionRequest } from "../domain.ts"
import { Outbox } from "../Outbox.ts"
import {
  ArtifactId,
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
 * Candidate Plan interpreter. Plan, receipt, and Cell contracts are the
 * pristine seam; this file is deliberately the local adapter composition.
 * It never constructs shell text, mutates live state directly, or dispatches
 * an endpoint. The only live writes are delegated to Hold.
 */

export const RuntimeProfile = Schema.Literal("compatibility", "native-contained", "vm-enclosed")
export type RuntimeProfile = typeof RuntimeProfile.Type

export class RuntimeConfig extends Schema.Class<RuntimeConfig>("RuntimeConfig")({
  workspace: Schema.String,
  profile: Schema.optionalWith(RuntimeProfile, { default: () => "compatibility" as const }),
  environment: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    default: () => ({})
  })
}) {}

/** A Cell receipt is carried only by its explicit delta artifact. */
export class RuntimeArtifact extends Schema.Class<RuntimeArtifact>("RuntimeArtifact")({
  artifact: Artifact,
  bytes: Schema.Uint8Array,
  cellReceipt: Schema.optional(CellReceipt)
}) {}

/**
 * Bytes supplied by the trusted caller before execution. This is the explicit
 * boundary for program literals and cross-fragment streams; Runtime never
 * invents a temporary file or reads an ambient path to materialize stdin.
 */
export class RuntimeInitialArtifact extends Schema.Class<RuntimeInitialArtifact>(
  "RuntimeInitialArtifact"
)({
  id: ArtifactId,
  bytes: Schema.Uint8Array,
  mediaType: Schema.String,
  provenance: Schema.String
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

export class RuntimeMergeDrift extends Schema.TaggedError<RuntimeMergeDrift>()(
  "RuntimeMergeDrift",
  { nodeId: Schema.String, paths: Schema.Array(Schema.String), reason: Schema.String }
) {}

export class RuntimeDeltaUnsupported extends Schema.TaggedError<RuntimeDeltaUnsupported>()(
  "RuntimeDeltaUnsupported",
  { nodeId: Schema.String, path: Schema.String, reason: Schema.String }
) {}

export type RuntimeError =
  | RuntimePlanInvalid
  | RuntimeNodeFailure
  | RuntimeUnsupported
  | RuntimeCapabilityDenied
  | RuntimeMergeDrift
  | RuntimeDeltaUnsupported

export class Runtime extends Context.Tag("airlock/Runtime")<
  Runtime,
  {
    readonly execute: (
      plan: Plan,
      initialArtifacts?: ReadonlyArray<RuntimeInitialArtifact>
    ) => Effect.Effect<RuntimeRun, RuntimePlanInvalid>
  }
>() {}

export const RuntimeConfigLive = (config: RuntimeConfig) =>
  Layer.succeed(Context.GenericTag<RuntimeConfig>("airlock/RuntimeConfig"), config)

const RuntimeConfigTag = Context.GenericTag<RuntimeConfig>("airlock/RuntimeConfig")
const text = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

const digest = (bytes: Uint8Array): Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest

const artifact = (id: ArtifactId, bytes: Uint8Array, provenance: string, cellReceipt?: CellReceipt) =>
  new RuntimeArtifact({
    artifact: new Artifact({
      id,
      digest: digest(bytes),
      mediaType: cellReceipt === undefined ? "application/octet-stream" : "application/vnd.airlock.cell-delta+json",
      byteLength: bytes.byteLength,
      provenance
    }),
    bytes,
    ...(cellReceipt === undefined ? {} : { cellReceipt })
  })

export const materializeInitialArtifact = (
  input: RuntimeInitialArtifact
): RuntimeArtifact =>
  new RuntimeArtifact({
    artifact: new Artifact({
      id: input.id,
      digest: digest(input.bytes),
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      provenance: input.provenance
    }),
    bytes: input.bytes
  })

const receiptId = (): ReceiptId => `receipt_${crypto.randomUUID()}` as ReceiptId
const errorReason = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)

const handleMap = (plan: Plan) => new Map(plan.handles.map((handle) => [handle.id, handle]))
const handlesFor = (plan: Plan, node: PlanNode): ReadonlyArray<Handle> => {
  const byId = handleMap(plan)
  const resolutions = new Map(plan.resolutions.map((resolution) => [resolution.requirementId, resolution.handleId]))
  return node.requires.flatMap((requirement) => {
    const handle = resolutions.get(requirement) === undefined ? undefined : byId.get(resolutions.get(requirement)!)
    return handle === undefined ? [] : [handle]
  })
}

const validatePlan = (plan: Plan): Effect.Effect<ReadonlyArray<PlanNode>, RuntimePlanInvalid> =>
  Effect.try({
    try: () => {
      const ids = new Set<string>()
      for (const node of plan.nodes) {
        if (ids.has(node.id)) throw new RuntimePlanInvalid({ planId: plan.id, reason: `duplicate node id: ${node.id}` })
        ids.add(node.id)
      }
      const remaining = new Map(plan.nodes.map((node) => [node.id, node.dependsOn.length]))
      const children = new Map(plan.nodes.map((node) => [node.id, [] as NodeId[]]))
      for (const node of plan.nodes) for (const dependency of node.dependsOn) {
        if (!ids.has(dependency)) throw new RuntimePlanInvalid({ planId: plan.id, reason: `node ${node.id} depends on unknown node ${dependency}` })
        children.get(dependency)!.push(node.id)
      }
      const byId = new Map(plan.nodes.map((node) => [node.id, node]))
      const ready = plan.nodes.filter((node) => remaining.get(node.id) === 0)
      const ordered: PlanNode[] = []
      while (ready.length > 0) {
        const next = ready.shift()!
        ordered.push(next)
        for (const child of children.get(next.id) ?? []) {
          const count = (remaining.get(child) ?? 0) - 1
          remaining.set(child, count)
          if (count === 0) ready.push(byId.get(child)!)
        }
      }
      if (ordered.length !== plan.nodes.length) throw new RuntimePlanInvalid({ planId: plan.id, reason: "plan dependency graph is cyclic" })
      return ordered
    },
    catch: (cause) => cause instanceof RuntimePlanInvalid
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
) => Effect.map(DateTime.now, (at) => new Receipt({
  id: receiptId(), planId: plan.id, nodeId: node.id, sequence, state, at,
  inputDigests: node._tag === "Invoke" && node.stdin !== undefined
    ? [artifacts.get(node.stdin)?.artifact.digest].filter((value): value is Digest => value !== undefined)
    : node._tag === "Apply" && node.sourceArtifact !== undefined
      ? [artifacts.get(node.sourceArtifact)?.artifact.digest].filter((value): value is Digest => value !== undefined)
      : [],
  outputArtifacts, resourceIdentities,
  ...(errorTag === undefined ? {} : { errorTag })
}))

const safeWorkspacePath = (workspace: string, locator: string) => {
  const target = nodePath.resolve(nodePath.isAbsolute(locator) ? locator : nodePath.join(workspace, locator))
  const root = nodePath.resolve(workspace)
  return target === root || target.startsWith(`${root}${nodePath.sep}`) ? target : undefined
}

const relativeTopLevel = (path: string) =>
  path.length > 0 && path !== "." && path !== ".." && !path.includes("/") && !path.includes("\\") && !path.includes("\0")

type ManagedFingerprint = Readonly<{
  readonly exists: boolean
  readonly supported: boolean
  readonly digest: string
  readonly kind?: "file" | "directory"
}>

const fingerprintManagedEntryNative = async (path: string): Promise<ManagedFingerprint> => {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: unknown }).code === "ENOENT") {
      return { exists: false, supported: true, digest: "" }
    }
    throw cause
  }
  const kind = info.isFile() ? "file" as const : info.isDirectory() ? "directory" as const : undefined
  if (kind === undefined) return { exists: true, supported: false, digest: "" }
  const material = kind === "file"
    ? await readFile(path)
    : (await Promise.all((await readdir(path)).sort().map(async (entry) => {
        const child = await fingerprintManagedEntryNative(nodePath.join(path, entry))
        if (!child.exists || !child.supported) throw new Error(`unsupported directory child: ${entry}`)
        return `${entry}\0${child.digest}\0`
      }))).join("")
  return {
    exists: true,
    supported: true,
    kind,
    digest: createHash("sha256").update(`${kind}\0${info.mode}\0${info.size}\0`).update(material).digest("hex")
  }
}

/** Mirrors the Cell's top-level fingerprint algorithm without following links. */
const fingerprintManagedEntry = (path: string) => Effect.tryPromise({
  try: () => fingerprintManagedEntryNative(path),
  catch: (cause) => new RuntimeNodeFailure({ nodeId: "runtime", operation: "fingerprint", reason: errorReason(cause) })
})

const deltaBytes = (receipt: CellReceipt) => text.encode(JSON.stringify({
  sourceWorkspace: receipt.sourceWorkspace,
  privateWorkspace: receipt.privateWorkspace,
  delta: receipt.delta.map((candidate) => ({ path: candidate.path, kind: candidate.kind }))
}))

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const config = yield* RuntimeConfigTag
  const process = yield* ProcessRunner
  const cell = yield* Cell
  const hold = yield* Hold
  const outbox = yield* Outbox
  const workspace = path.resolve(config.workspace)

  const localPath = (locator: string) => nodePath.isAbsolute(locator) ? locator : path.join(workspace, locator)

  const enforce = (node: PlanNode): Effect.Effect<void, RuntimeError> => {
    if (config.profile === "vm-enclosed") {
      return Effect.fail(new RuntimeUnsupported({
        nodeId: node.id, feature: "vm-enclosed execution", reason: "no macOS VM Cell backend is installed in this runtime"
      }))
    }
    if (node._tag !== "Invoke") return Effect.void
    if (node.cellProfile === "vm-enclosed") {
      return Effect.fail(new RuntimeUnsupported({ nodeId: node.id, feature: "vm-enclosed Cell", reason: "no VM Cell backend is installed" }))
    }
    if (config.profile === "native-contained" && node.cellProfile !== "native-contained") {
      return Effect.fail(new RuntimeCapabilityDenied({
        nodeId: node.id, right: "contained execution", reason: "native-contained runtime refuses a compatibility Invoke"
      }))
    }
    return Effect.void
  }

  type MergeEntry = Readonly<{ readonly candidate: WorkspaceDeltaCandidate; readonly target: string; readonly source?: string }>

  const preflightMerge = (nodeId: string, receipt: CellReceipt): Effect.Effect<ReadonlyArray<MergeEntry>, RuntimeError> =>
    Effect.gen(function* () {
      if (receipt.drift.length > 0) {
        return yield* new RuntimeMergeDrift({ nodeId, paths: receipt.drift.map((drift) => drift.path), reason: "live workspace changed while Cell ran" })
      }
      const drift = yield* cell.revalidate(receipt).pipe(
        Effect.mapError((error) => new RuntimeNodeFailure({ nodeId, operation: "revalidate Cell baseline", reason: `${error._tag}: ${errorReason(error)}` }))
      )
      if (drift.length > 0) {
        return yield* new RuntimeMergeDrift({ nodeId, paths: drift.map((entry) => entry.path), reason: "live workspace drifted before Apply" })
      }
      return yield* Effect.forEach(receipt.delta, (candidate) => Effect.gen(function* () {
        if (!relativeTopLevel(candidate.path)) {
          return yield* new RuntimeDeltaUnsupported({ nodeId, path: candidate.path, reason: "only top-level non-symlink paths are mergeable in macOS v1" })
        }
        const expected = candidate.kind === "deleted" ? candidate.baseline : candidate.private
        if (expected === undefined || (expected.kind !== "file" && expected.kind !== "directory")) {
          return yield* new RuntimeDeltaUnsupported({ nodeId, path: candidate.path, reason: "symlink and special-file Cell deltas are not mergeable in macOS v1" })
        }
        const target = nodePath.join(workspace, candidate.path)
        const live = yield* fingerprintManagedEntry(target).pipe(Effect.mapError(() => new RuntimeDeltaUnsupported({
          nodeId, path: candidate.path, reason: "live entry contains a symlink or special filesystem object"
        })))
        if (candidate.kind === "created") {
          if (live.exists && !live.supported) {
            return yield* new RuntimeDeltaUnsupported({ nodeId, path: candidate.path, reason: "created path is occupied by a symlink or special filesystem object" })
          }
          if (live.exists) return yield* new RuntimeMergeDrift({ nodeId, paths: [candidate.path], reason: "created path is now occupied in live workspace" })
        } else if (live.exists && !live.supported) {
          return yield* new RuntimeDeltaUnsupported({ nodeId, path: candidate.path, reason: "live entry is a symlink or special filesystem object" })
        } else if (!live.exists || live.kind !== candidate.baseline?.kind || live.digest !== candidate.baseline?.digest) {
          return yield* new RuntimeMergeDrift({ nodeId, paths: [candidate.path], reason: "live entry no longer matches Cell baseline" })
        }
        if (candidate.kind === "deleted") return { candidate, target } satisfies MergeEntry
        const source = nodePath.join(receipt.privateWorkspace, candidate.path)
        const privateEntry = yield* fingerprintManagedEntry(source).pipe(Effect.mapError(() => new RuntimeDeltaUnsupported({
          nodeId, path: candidate.path, reason: "private Cell output contains a symlink or special filesystem object"
        })))
        if (!privateEntry.exists || !privateEntry.supported || privateEntry.kind !== candidate.private?.kind || privateEntry.digest !== candidate.private?.digest) {
          return yield* new RuntimeDeltaUnsupported({ nodeId, path: candidate.path, reason: "private Cell output no longer matches the proposed managed entry" })
        }
        return { candidate, target, source } satisfies MergeEntry
      }))
    })

  const mergeCellDelta = (node: PlanNode & { readonly _tag: "Apply" }, source: RuntimeArtifact) =>
    Effect.gen(function* () {
      const receipt = source.cellReceipt
      if (receipt === undefined) return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "Apply delta", reason: "source artifact is not a Cell delta" })
      if (node.operation !== "merge" || ![".", workspace].includes(node.target)) {
        return yield* new RuntimeUnsupported({
          nodeId: node.id, feature: "Cell delta Apply", reason: "Cell delta merge requires Apply.merge targeting workspace root (.)"
        })
      }
      const entries = yield* preflightMerge(node.id, receipt)
      // All drift, kind, source, and baseline checks complete above, before
      // the first live mutation. Each following transition is recoverable.
      for (const entry of entries) {
        if (entry.candidate.kind === "deleted") {
          yield* hold.remove(entry.target).pipe(Effect.mapError((error) => new RuntimeNodeFailure({
            nodeId: node.id, operation: "Hold.remove Cell delta", reason: `${error._tag}: ${errorReason(error)}`
          })))
        } else {
          yield* hold.replaceFrom(entry.target, entry.source!).pipe(Effect.mapError((error) => new RuntimeNodeFailure({
            nodeId: node.id, operation: "Hold.replaceFrom Cell delta", reason: `${error._tag}: ${errorReason(error)}`
          })))
        }
      }
    })

  const runInvoke = (node: PlanNode & { readonly _tag: "Invoke" }, artifacts: Map<ArtifactId, RuntimeArtifact>) =>
    Effect.gen(function* () {
      const stdin = node.stdin === undefined ? undefined : artifacts.get(node.stdin)
      if (node.stdin !== undefined && stdin === undefined) {
        return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "invoke", reason: `missing stdin artifact ${node.stdin}` })
      }
      const cwd = node.cwd === undefined ? workspace : localPath(node.cwd)
      const request = new ProcessRequest({
        executable: node.executable,
        args: node.args,
        cwd,
        env: { ...config.environment, ...node.env },
        ...(stdin === undefined ? {} : { stdin: new ProcessInputBytes({ _tag: "bytes", bytes: stdin.bytes }) }),
        stdout: node.stdout,
        stderr: node.stderr,
        outputLimitBytes: node.outputLimitBytes,
        ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs })
      })
      const contained = node.cellProfile === "native-contained"
      if (contained && path.resolve(cwd) !== workspace) {
        return yield* new RuntimeCapabilityDenied({ nodeId: node.id, right: "Cell working directory", reason: "native-contained Invoke cwd must be the admitted workspace" })
      }
      const outcome = contained
        ? yield* cell.run(new CellRequest({
          sourceWorkspace: workspace,
          privateWorkspace: path.join(path.dirname(workspace), `.airlock-cell-${crypto.randomUUID()}`),
          process: request,
          network: "deny"
        })).pipe(Effect.map((receipt) => ({ process: receipt.processReceipt, cell: receipt })))
        : yield* process.run(request).pipe(Effect.map((receipt) => ({ process: receipt, cell: undefined })))
      if (outcome.process.exitCode !== 0 || outcome.process.signal !== null) {
        return yield* new RuntimeNodeFailure({
          nodeId: node.id, operation: "invoke", reason: `process exited ${outcome.process.exitCode === null ? outcome.process.signal : outcome.process.exitCode}`
        })
      }
      const outputs = new Map<ArtifactId, { readonly bytes: Uint8Array; readonly provenance: string; readonly cellReceipt?: CellReceipt }>()
      // Named outputs are explicit bindings, not positional guesses. The Plan
      // decides which stream or delta is exported, and the runtime only fills
      // the ids the Plan declared.
      if (node.stdoutArtifact !== undefined) {
        outputs.set(node.stdoutArtifact, {
          bytes: outcome.process.stdout,
          provenance: `invoke:stdout:${node.executable}`
        })
      }
      if (node.stderrArtifact !== undefined) {
        outputs.set(node.stderrArtifact, {
          bytes: outcome.process.stderr,
          provenance: `invoke:stderr:${node.executable}`
        })
      }
      if (outcome.cell !== undefined) {
        if (node.deltaArtifact === undefined) {
          return yield* new RuntimeNodeFailure({
            nodeId: node.id,
            operation: "record Cell delta",
            reason: "native-contained Invoke requires a declared delta artifact id"
          })
        }
        outputs.set(node.deltaArtifact, {
          bytes: deltaBytes(outcome.cell),
          provenance: `cell-delta:${node.executable}`,
          cellReceipt: outcome.cell
        })
      }
      const produced: ArtifactId[] = []
      for (const id of node.produces) {
        const output = outputs.get(id)
        if (output === undefined) {
          return yield* new RuntimeNodeFailure({
            nodeId: node.id,
            operation: "record Invoke outputs",
            reason: `missing bound output for artifact ${id}`
          })
        }
        artifacts.set(id, artifact(id, output.bytes, output.provenance, output.cellReceipt))
        produced.push(id)
      }
      return produced
    }).pipe(Effect.mapError((error) => error instanceof RuntimeNodeFailure || error instanceof RuntimeCapabilityDenied ? error : new RuntimeNodeFailure({
      nodeId: node.id, operation: "invoke", reason: `${error._tag}: ${errorReason(error)}`
    })))

  const runNode = (plan: Plan, node: PlanNode, artifacts: Map<ArtifactId, RuntimeArtifact>): Effect.Effect<ReadonlyArray<ArtifactId>, RuntimeError> =>
    Effect.gen(function* () {
      yield* enforce(node)
      switch (node._tag) {
        case "Capture": {
          let bytes: Uint8Array
          switch (node.source) {
            case "file": bytes = yield* fs.readFile(localPath(node.locator)).pipe(Effect.mapError((error) => new RuntimeNodeFailure({ nodeId: node.id, operation: "read file", reason: errorReason(error) }))); break
            case "environment": {
              const value = config.environment[node.locator]
              if (value === undefined) return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "read environment", reason: `not present: ${node.locator}` })
              bytes = text.encode(value); break
            }
            case "clock": bytes = text.encode((yield* DateTime.now).toString()); break
            case "process-output": return yield* new RuntimeUnsupported({ nodeId: node.id, feature: "process-output Capture", reason: "use Invoke produces to bind an explicit stream artifact" })
          }
          for (const id of node.produces) artifacts.set(id, artifact(id, bytes, `${node.source}:${node.locator}`))
          return node.produces
        }
        case "Invoke": return yield* runInvoke(node, artifacts)
        case "Apply": {
          const target = localPath(node.target)
          if (node.operation === "remove") {
            yield* hold.remove(target).pipe(Effect.mapError((error) => new RuntimeNodeFailure({ nodeId: node.id, operation: "Hold.remove", reason: `${error._tag}: ${errorReason(error)}` })))
            return node.produces
          }
          if (node.operation === "move") return yield* new RuntimeUnsupported({ nodeId: node.id, feature: "Apply.move", reason: "Plan v1 has no held move contract" })
          if (node.sourceArtifact === undefined) return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: `Apply.${node.operation}`, reason: "sourceArtifact is required" })
          const source = artifacts.get(node.sourceArtifact)
          if (source === undefined) return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: `Apply.${node.operation}`, reason: `missing artifact ${node.sourceArtifact}` })
          if (node.operation === "merge") {
            if (source.cellReceipt === undefined) return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "Apply.merge", reason: "source artifact is not a Cell delta" })
            yield* mergeCellDelta(node, source)
            return node.produces
          }
          if (source.cellReceipt !== undefined) return yield* new RuntimeUnsupported({ nodeId: node.id, feature: `Apply.${node.operation}`, reason: "a Cell delta is consumable only by Apply.merge" })
          let content: string
          try { content = textDecoder.decode(source.bytes) } catch {
            return yield* new RuntimeUnsupported({ nodeId: node.id, feature: "binary Apply.write", reason: "Hold text write refuses lossy byte conversion" })
          }
          yield* hold.overwrite(target, content).pipe(Effect.mapError((error) => new RuntimeNodeFailure({ nodeId: node.id, operation: "Hold.overwrite", reason: `${error._tag}: ${errorReason(error)}` })))
          return node.produces
        }
        case "RequestExternal":
          yield* outbox.stage(new EmissionRequest({ url: node.endpoint, method: node.method }), node.holdMillis).pipe(Effect.mapError((error) => new RuntimeNodeFailure({ nodeId: node.id, operation: "stage external", reason: `${error._tag}: ${errorReason(error)}` })))
          return node.produces
      }
    })

  const execute = (
    plan: Plan,
    initialArtifacts: ReadonlyArray<RuntimeInitialArtifact> = []
  ): Effect.Effect<RuntimeRun, RuntimePlanInvalid> => Effect.gen(function* () {
    const ordered = yield* validatePlan(plan)
    const startedAt = yield* DateTime.now
    const producedIds = new Set(ordered.flatMap((node) => node.produces))
    const inputIds = initialArtifacts.map((input) => input.id)
    const duplicateInput = inputIds.find((id, index) => inputIds.indexOf(id) !== index)
    if (duplicateInput !== undefined) {
      return yield* new RuntimePlanInvalid({
        planId: plan.id,
        reason: `duplicate initial artifact id: ${duplicateInput}`
      })
    }
    const collidingInput = inputIds.find((id) => producedIds.has(id))
    if (collidingInput !== undefined) {
      return yield* new RuntimePlanInvalid({
        planId: plan.id,
        reason: `initial artifact is also produced by a node: ${collidingInput}`
      })
    }
    const artifacts = new Map<ArtifactId, RuntimeArtifact>(
      initialArtifacts.map((input) => [input.id, materializeInitialArtifact(input)])
    )
    const receipts: Receipt[] = []
    const stateByNode = new Map<NodeId, NodeState>()
    let failed = false
    for (const node of ordered) {
      const handles = handlesFor(plan, node)
      const dependenciesSucceeded = node.dependsOn.every((dependency) => stateByNode.get(dependency) === "succeeded")
      if (!dependenciesSucceeded) {
        receipts.push(yield* nodeReceipt(plan, node, receipts.length + 1, "cancelled", artifacts, [], handles.map((handle) => handle.resourceIdentity), "RuntimeDependencyFailed"))
        stateByNode.set(node.id, "cancelled"); failed = true; continue
      }
      const result = yield* runNode(plan, node, artifacts).pipe(Effect.either)
      if (result._tag === "Left") {
        receipts.push(yield* nodeReceipt(plan, node, receipts.length + 1, "failed", artifacts, [], handles.map((handle) => handle.resourceIdentity), result.left._tag))
        stateByNode.set(node.id, "failed"); failed = true
      } else {
        receipts.push(yield* nodeReceipt(plan, node, receipts.length + 1, "succeeded", artifacts, result.right, handles.map((handle) => handle.resourceIdentity)))
        stateByNode.set(node.id, "succeeded")
      }
    }
    const finishedAt = yield* DateTime.now
    const succeeded = receipts.filter((receipt) => receipt.state === "succeeded").length
    return new RuntimeRun({ planId: plan.id, state: failed ? (succeeded > 0 ? "partial" : "failed") : "succeeded", startedAt, finishedAt, receipts, artifacts: [...artifacts.values()] })
  })

  return Runtime.of({ execute })
})

/** Adapter composition root. A VM Cell is deliberately not substituted here. */
export const RuntimeLive = Layer.effect(Runtime, make)
