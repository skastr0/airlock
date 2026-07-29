import { Path } from "@effect/platform"
import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename
} from "node:fs/promises"
import * as nodePath from "node:path"
import {
  type ExecutionAuthority,
  type NodeAuthorityBinding,
  revalidateNodeAuthority
} from "../admission/index.ts"
import {
  Cell,
  CellExecutableBinding,
  CellReceipt,
  CellRequest,
  WorkspaceDeltaCandidate
} from "../cell/index.ts"
import { Hold, HoldRecoveryRequired } from "../Hold.ts"
import { ActId, EmissionRequest, RemoveReceipt } from "../domain.ts"
import {
  NativeFileSystem,
  NativeListEntry,
  NativeMkdirPartiallyApplied,
  NativeMkdirReceipt,
  NativeMovePartiallyApplied,
  NativeMoveReceipt,
  NativeStat,
  NativeWriteReceipt
} from "../native/index.ts"
import {
  Outbox,
  OutboxEmission,
  OutboxRecoveryRequired
} from "../Outbox.ts"
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
import {
  ProcessInputBytes,
  ProcessCancelled,
  ProcessOutputLimitExceeded,
  ProcessReceipt,
  ProcessRequest,
  ProcessRunner,
  ProcessTimedOut
} from "../process/Process.ts"

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
  runJournalDirectory: Schema.optional(Schema.String),
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

export class RuntimeCellWorkspaceHeld extends Schema.TaggedClass<RuntimeCellWorkspaceHeld>()(
  "RuntimeCellWorkspaceHeld",
  {
    state: Schema.Literal("held"),
    nodeId: Schema.String,
    privateWorkspace: Schema.String,
    actId: ActId,
    at: Schema.DateTimeUtc
  }
) {}

export class RuntimeCellWorkspaceAbsent extends Schema.TaggedClass<RuntimeCellWorkspaceAbsent>()(
  "RuntimeCellWorkspaceAbsent",
  {
    state: Schema.Literal("absent"),
    nodeId: Schema.String,
    privateWorkspace: Schema.String,
    at: Schema.DateTimeUtc
  }
) {}

export class RuntimeCellWorkspaceRetentionFailed extends Schema.TaggedClass<RuntimeCellWorkspaceRetentionFailed>()(
  "RuntimeCellWorkspaceRetentionFailed",
  {
    state: Schema.Literal("failed"),
    nodeId: Schema.String,
    privateWorkspace: Schema.String,
    errorTag: Schema.String,
    reason: Schema.String,
    at: Schema.DateTimeUtc
  }
) {}

export const RuntimeLifecycleReceipt = Schema.Union(
  RuntimeCellWorkspaceHeld,
  RuntimeCellWorkspaceAbsent,
  RuntimeCellWorkspaceRetentionFailed
)
export type RuntimeLifecycleReceipt = typeof RuntimeLifecycleReceipt.Type

export const RuntimeProcessOutcome = Schema.Literal(
  "exited",
  "timed-out",
  "output-limit",
  "cancelled"
)
export type RuntimeProcessOutcome = typeof RuntimeProcessOutcome.Type

/**
 * Process execution evidence is independent of node success. A nonzero exit,
 * timeout, output overflow, or cancellation may still carry decisive stdout,
 * stderr, timing, pid, and termination evidence.
 */
export class RuntimeProcessEvidence extends Schema.Class<RuntimeProcessEvidence>(
  "RuntimeProcessEvidence"
)({
  nodeId: Schema.String,
  outcome: RuntimeProcessOutcome,
  receipt: ProcessReceipt,
  executableBindings: Schema.optionalWith(
    Schema.Array(CellExecutableBinding),
    { default: () => [] }
  )
}) {}

export class RuntimeMergeEvidence extends Schema.Class<RuntimeMergeEvidence>(
  "RuntimeMergeEvidence"
)({
  target: Schema.String,
  paths: Schema.Array(Schema.String)
}) {}

/**
 * Durable recovery evidence belongs to the Runtime integration receipt rather
 * than being flattened into an error string. Each variant preserves the
 * pristine component's exact recovery handle so a supervisor can inspect,
 * cancel, undo, or reconcile the already-observed world state.
 */
export class RuntimeHoldRecoveryEvidence extends Schema.TaggedClass<RuntimeHoldRecoveryEvidence>()(
  "RuntimeHoldRecoveryEvidence",
  {
    nodeId: Schema.String,
    operation: Schema.String,
    recovery: HoldRecoveryRequired
  }
) {}

export class RuntimeMoveRecoveryEvidence extends Schema.TaggedClass<RuntimeMoveRecoveryEvidence>()(
  "RuntimeMoveRecoveryEvidence",
  {
    nodeId: Schema.String,
    operation: Schema.String,
    recovery: NativeMovePartiallyApplied
  }
) {}

export class RuntimeMkdirRecoveryEvidence extends Schema.TaggedClass<RuntimeMkdirRecoveryEvidence>()(
  "RuntimeMkdirRecoveryEvidence",
  {
    nodeId: Schema.String,
    operation: Schema.String,
    recovery: NativeMkdirPartiallyApplied
  }
) {}

export class RuntimeOutboxRecoveryEvidence extends Schema.TaggedClass<RuntimeOutboxRecoveryEvidence>()(
  "RuntimeOutboxRecoveryEvidence",
  {
    nodeId: Schema.String,
    operation: Schema.String,
    recovery: OutboxRecoveryRequired
  }
) {}

export const RuntimeRecoveryEvidence = Schema.Union(
  RuntimeHoldRecoveryEvidence,
  RuntimeMoveRecoveryEvidence,
  RuntimeMkdirRecoveryEvidence,
  RuntimeOutboxRecoveryEvidence
)
export type RuntimeRecoveryEvidence = typeof RuntimeRecoveryEvidence.Type

export class RuntimeRun extends Schema.Class<RuntimeRun>("RuntimeRun")({
  schemaVersion: Schema.optionalWith(
    Schema.Literal("airlock/runtime-run/v1"),
    { default: () => "airlock/runtime-run/v1" as const }
  ),
  planId: Schema.String,
  state: Schema.Literal("succeeded", "failed", "partial"),
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.DateTimeUtc,
  receipts: Schema.Array(Receipt),
  artifacts: Schema.Array(RuntimeArtifact),
  processes: Schema.optionalWith(Schema.Array(RuntimeProcessEvidence), {
    default: () => []
  }),
  lifecycle: Schema.optionalWith(Schema.Array(RuntimeLifecycleReceipt), {
    default: () => []
  }),
  recovery: Schema.optionalWith(Schema.Array(RuntimeRecoveryEvidence), {
    default: () => []
  })
}) {}

export class RuntimeRunSnapshot extends Schema.Class<RuntimeRunSnapshot>(
  "RuntimeRunSnapshot"
)({
  schemaVersion: Schema.Literal("airlock/runtime-run-snapshot/v1"),
  planId: Schema.String,
  state: Schema.Literal(
    "running",
    "finalizing",
    "succeeded",
    "failed",
    "partial",
    "cancelled"
  ),
  startedAt: Schema.DateTimeUtc,
  observedAt: Schema.DateTimeUtc,
  sequence: Schema.Number,
  receipts: Schema.Array(Receipt),
  artifacts: Schema.Array(Artifact),
  lifecycle: Schema.Array(RuntimeLifecycleReceipt),
  recovery: Schema.Array(RuntimeRecoveryEvidence)
}) {}

export class RuntimeRunJournalError extends Schema.TaggedError<RuntimeRunJournalError>()(
  "RuntimeRunJournalError",
  {
    operation: Schema.Literal("record", "inspect", "list", "decode"),
    path: Schema.String,
    reason: Schema.String
  }
) {}

export class RuntimeRunNotFound extends Schema.TaggedError<RuntimeRunNotFound>()(
  "RuntimeRunNotFound",
  { planId: Schema.String }
) {}

export class RuntimeRunJournal extends Context.Tag("airlock/RuntimeRunJournal")<
  RuntimeRunJournal,
  {
    readonly record: (
      snapshot: RuntimeRunSnapshot
    ) => Effect.Effect<void, RuntimeRunJournalError>
    readonly inspect: (
      planId: string
    ) => Effect.Effect<RuntimeRunSnapshot, RuntimeRunJournalError | RuntimeRunNotFound>
    readonly recent: Effect.Effect<
      ReadonlyArray<RuntimeRunSnapshot>,
      RuntimeRunJournalError
    >
  }
>() {}

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

export class RuntimeLifecycleFailure extends Schema.TaggedError<RuntimeLifecycleFailure>()(
  "RuntimeLifecycleFailure",
  {
    planId: Schema.String,
    privateWorkspaces: Schema.Array(Schema.String),
    reason: Schema.String
  }
) {}

export class RuntimeProcessFailure extends Schema.TaggedError<RuntimeProcessFailure>()(
  "RuntimeProcessFailure",
  {
    nodeId: Schema.String,
    outcome: Schema.Literal(
      "nonzero-exit",
      "signal",
      "timed-out",
      "output-limit",
      "cancelled"
    ),
    receipt: ProcessReceipt,
    outputArtifacts: Schema.Array(ArtifactId)
  }
) {}

export class RuntimeArtifactClaimMismatch extends Schema.TaggedError<RuntimeArtifactClaimMismatch>()(
  "RuntimeArtifactClaimMismatch",
  {
    nodeId: Schema.String,
    claimed: Schema.Array(ArtifactId),
    materialized: Schema.Array(ArtifactId)
  }
) {}

export class RuntimeRecoveryRequired extends Schema.TaggedError<RuntimeRecoveryRequired>()(
  "RuntimeRecoveryRequired",
  {
    nodeId: Schema.String,
    operation: Schema.String,
    causeTag: Schema.String,
    reason: Schema.String
  }
) {}

export class RuntimeAuthorityInvalid extends Schema.TaggedError<RuntimeAuthorityInvalid>()(
  "RuntimeAuthorityInvalid",
  {
    nodeId: Schema.String,
    causeTag: Schema.String,
    reason: Schema.String
  }
) {}

export type RuntimeError =
  | RuntimePlanInvalid
  | RuntimeNodeFailure
  | RuntimeUnsupported
  | RuntimeCapabilityDenied
  | RuntimeMergeDrift
  | RuntimeDeltaUnsupported
  | RuntimeProcessFailure
  | RuntimeAuthorityInvalid
  | RuntimeArtifactClaimMismatch
  | RuntimeRecoveryRequired

export class Runtime extends Context.Tag("airlock/Runtime")<
  Runtime,
  {
    readonly execute: (
      authority: ExecutionAuthority,
      initialArtifacts?: ReadonlyArray<RuntimeInitialArtifact>
    ) => Effect.Effect<RuntimeRun, RuntimePlanInvalid | RuntimeLifecycleFailure>
    readonly inspect: (
      planId: string
    ) => Effect.Effect<RuntimeRunSnapshot, RuntimeRunJournalError | RuntimeRunNotFound>
    readonly recent: Effect.Effect<
      ReadonlyArray<RuntimeRunSnapshot>,
      RuntimeRunJournalError
    >
  }
>() {}

export const RuntimeConfigLive = (config: RuntimeConfig) =>
  Layer.succeed(Context.GenericTag<RuntimeConfig>("airlock/RuntimeConfig"), config)

const RuntimeConfigTag = Context.GenericTag<RuntimeConfig>("airlock/RuntimeConfig")
const text = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })
const encodeRunSnapshot = Schema.encode(
  Schema.parseJson(RuntimeRunSnapshot)
)
const decodeRunSnapshot = Schema.decode(
  Schema.parseJson(RuntimeRunSnapshot)
)

const journalReason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

const journalPathMissing = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT"

const runJournalDirectory = (root: string, planId: string) =>
  nodePath.join(
    root,
    createHash("sha256").update(planId).digest("hex")
  )

type RuntimeRunSnapshotCandidate = Readonly<{
  readonly file: string
  readonly snapshot: RuntimeRunSnapshot
}>

const readRunSnapshot = (
  file: string,
  operation: "inspect" | "list"
): Effect.Effect<RuntimeRunSnapshotCandidate, RuntimeRunJournalError> =>
  Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (cause) =>
      new RuntimeRunJournalError({
        operation,
        path: file,
        reason: journalReason(cause)
      })
  }).pipe(
    Effect.flatMap((encoded) =>
      decodeRunSnapshot(encoded).pipe(
        Effect.mapError((cause) =>
          new RuntimeRunJournalError({
            operation: "decode",
            path: file,
            reason: String(cause)
          })
        ),
        Effect.map((snapshot) => ({ file, snapshot }))
      )
    )
  )

const selectLatestRunSnapshot = (
  directory: string,
  candidates: ReadonlyArray<RuntimeRunSnapshotCandidate>
): Effect.Effect<RuntimeRunSnapshot | undefined, RuntimeRunJournalError> => {
  if (candidates.length === 0) return Effect.succeed(undefined)
  const greatestSequence = Math.max(
    ...candidates.map(({ snapshot }) => snapshot.sequence)
  )
  const latest = candidates.filter(
    ({ snapshot }) => snapshot.sequence === greatestSequence
  )
  if (latest.length > 1) {
    const first = JSON.stringify(latest[0]!.snapshot)
    if (latest.some(({ snapshot }) => JSON.stringify(snapshot) !== first)) {
      return Effect.fail(
        new RuntimeRunJournalError({
          operation: "decode",
          path: directory,
          reason: `ambiguous snapshots at sequence ${greatestSequence}`
        })
      )
    }
  }
  return Effect.succeed(latest[0]!.snapshot)
}

const latestSnapshotInDirectory = (
  root: string,
  directory: string,
  entries: ReadonlyArray<string>,
  operation: "inspect" | "list",
  expectedPlanId?: string
) =>
  Effect.forEach(
    entries.filter((entry) => entry.endsWith(".json")),
    (entry) => readRunSnapshot(nodePath.join(directory, entry), operation),
    { concurrency: 8 }
  ).pipe(
    Effect.flatMap((candidates) =>
      Effect.forEach(
        candidates,
        (candidate) => {
          const { snapshot } = candidate
          if (
            expectedPlanId !== undefined &&
            snapshot.planId !== expectedPlanId
          ) {
            return Effect.fail(
              new RuntimeRunJournalError({
                operation: "decode",
                path: candidate.file,
                reason:
                  "snapshot Plan identity does not match its journal directory"
              })
            )
          }
          if (
            runJournalDirectory(root, snapshot.planId) !== directory
          ) {
            return Effect.fail(
              new RuntimeRunJournalError({
                operation: "decode",
                path: candidate.file,
                reason:
                  "snapshot Plan identity does not match its journal directory"
              })
            )
          }
          return Effect.succeed(candidate)
        },
        { concurrency: 1 }
      )
    ),
    Effect.flatMap((candidates) =>
      selectLatestRunSnapshot(directory, candidates)
    )
  )

const latestRunSnapshot = (
  root: string,
  planId: string
): Effect.Effect<
  RuntimeRunSnapshot,
  RuntimeRunJournalError | RuntimeRunNotFound
> =>
  Effect.gen(function* () {
    const directory = runJournalDirectory(root, planId)
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (
        cause
      ): RuntimeRunNotFound | RuntimeRunJournalError =>
        journalPathMissing(cause)
          ? new RuntimeRunNotFound({ planId })
          : new RuntimeRunJournalError({
              operation: "inspect",
              path: directory,
              reason: journalReason(cause)
            })
    })
    const latest = yield* latestSnapshotInDirectory(
      root,
      directory,
      entries,
      "inspect",
      planId
    )
    if (latest === undefined) {
      return yield* new RuntimeRunNotFound({ planId })
    }
    return latest
  })

export const makeFileRuntimeRunJournal = (root: string) => {
    const record = (snapshot: RuntimeRunSnapshot) =>
      encodeRunSnapshot(snapshot).pipe(
        Effect.mapError((cause) =>
          new RuntimeRunJournalError({
            operation: "record",
            path: root,
            reason: String(cause)
          })
        ),
        Effect.flatMap((encoded) =>
          Effect.tryPromise({
            try: async () => {
              const directory = runJournalDirectory(root, snapshot.planId)
              await mkdir(directory, { recursive: true, mode: 0o700 })
              const sequence = String(snapshot.sequence).padStart(16, "0")
              const observedAt = String(
                DateTime.toEpochMillis(snapshot.observedAt)
              ).padStart(16, "0")
              const identity =
                `${sequence}-${observedAt}-${crypto.randomUUID()}`
              const temporary = nodePath.join(directory, `.${identity}.next`)
              const published = nodePath.join(directory, `${identity}.json`)
              const handle = await open(temporary, "wx", 0o600)
              try {
                await handle.writeFile(encoded, "utf8")
                await handle.sync()
              } finally {
                await handle.close()
              }
              await rename(temporary, published)
              const directoryHandle = await open(directory, "r")
              try {
                await directoryHandle.sync()
              } finally {
                await directoryHandle.close()
              }
            },
            catch: (cause) =>
              new RuntimeRunJournalError({
                operation: "record",
                path: runJournalDirectory(root, snapshot.planId),
                reason: journalReason(cause)
              })
          })
        )
      )

    const recent = Effect.tryPromise({
      try: async () => {
        await mkdir(root, { recursive: true, mode: 0o700 })
        return readdir(root, { withFileTypes: true })
      },
      catch: (cause) =>
        new RuntimeRunJournalError({
          operation: "list",
          path: root,
          reason: journalReason(cause)
        })
    }).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries.filter((entry) => entry.isDirectory()),
          (entry) =>
            Effect.tryPromise({
              try: () => readdir(nodePath.join(root, entry.name)),
              catch: (cause) =>
                new RuntimeRunJournalError({
                  operation: "list",
                  path: nodePath.join(root, entry.name),
                  reason: journalReason(cause)
                })
            }).pipe(
              Effect.flatMap((files) => {
                const directory = nodePath.join(root, entry.name)
                return latestSnapshotInDirectory(
                  root,
                  directory,
                  files,
                  "list"
                )
              })
            ),
          { concurrency: 8 }
        )
      ),
      Effect.map((snapshots) =>
        snapshots
          .filter(
            (snapshot): snapshot is RuntimeRunSnapshot =>
              snapshot !== undefined
          )
          .sort(
            (a, b) =>
              DateTime.toEpochMillis(b.observedAt) -
              DateTime.toEpochMillis(a.observedAt)
          )
      )
    )

  return RuntimeRunJournal.of({
    record,
    inspect: (planId) => latestRunSnapshot(root, planId),
    recent
  })
}

const makeMemoryRuntimeRunJournal = () => {
  const snapshots = new Map<string, RuntimeRunSnapshot>()
  return RuntimeRunJournal.of({
    record: (snapshot) => {
      const previous = snapshots.get(snapshot.planId)
      if (
        previous !== undefined &&
        snapshot.sequence < previous.sequence
      ) {
        return Effect.fail(
          new RuntimeRunJournalError({
            operation: "record",
            path: "memory",
            reason:
              `snapshot sequence ${snapshot.sequence} precedes ${previous.sequence}`
          })
        )
      }
      if (
        previous !== undefined &&
        snapshot.sequence === previous.sequence &&
        JSON.stringify(snapshot) !== JSON.stringify(previous)
      ) {
        return Effect.fail(
          new RuntimeRunJournalError({
            operation: "record",
            path: "memory",
            reason: `ambiguous snapshots at sequence ${snapshot.sequence}`
          })
        )
      }
      return Effect.sync(() => {
        snapshots.set(snapshot.planId, snapshot)
      })
    },
    inspect: (planId) => {
      const snapshot = snapshots.get(planId)
      return snapshot === undefined
        ? Effect.fail(new RuntimeRunNotFound({ planId }))
        : Effect.succeed(snapshot)
    },
    recent: Effect.sync(() =>
      [...snapshots.values()].sort(
        (a, b) =>
          DateTime.toEpochMillis(b.observedAt) -
          DateTime.toEpochMillis(a.observedAt)
      )
    )
  })
}

const digest = (bytes: Uint8Array): Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest

const artifact = (
  id: ArtifactId,
  bytes: Uint8Array,
  provenance: string,
  options: {
    readonly cellReceipt?: CellReceipt
    readonly mediaType?: string
  } = {}
) =>
  new RuntimeArtifact({
    artifact: new Artifact({
      id,
      digest: digest(bytes),
      mediaType: options.mediaType ??
        (options.cellReceipt === undefined
          ? "application/octet-stream"
          : "application/vnd.airlock.cell-delta+json"),
      byteLength: bytes.byteLength,
      provenance
    }),
    bytes,
    ...(options.cellReceipt === undefined ? {} : { cellReceipt: options.cellReceipt })
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

const encodeStructured = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: A,
  nodeId: NodeId,
  operation: string
) =>
  Schema.encode(Schema.parseJson(schema))(value).pipe(
    Effect.map((json) => text.encode(json)),
    Effect.mapError((cause) => new RuntimeNodeFailure({
      nodeId,
      operation,
      reason: String(cause)
    }))
  )

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

const retainedBindingFor = (
  authority: ExecutionAuthority,
  node: PlanNode
): Effect.Effect<NodeAuthorityBinding, RuntimeAuthorityInvalid> => {
  const matches = authority.bindings.filter(
    (binding) => binding.nodeId === node.id
  )
  if (matches.length !== 1) {
    return Effect.fail(new RuntimeAuthorityInvalid({
      nodeId: node.id,
      causeTag: "AdmissionContractInvalid",
      reason: `expected exactly one retained node binding; found ${matches.length}`
    }))
  }
  const binding = matches[0]!
  const expected = handlesFor(authority.admission.plan, node)
  const sameHandles =
    binding.handles.length === expected.length &&
    binding.handles.every((handle, index) =>
      JSON.stringify(handle) === JSON.stringify(expected[index])
    )
  return sameHandles
    ? Effect.succeed(binding)
    : Effect.fail(new RuntimeAuthorityInvalid({
        nodeId: node.id,
        causeTag: "AdmissionContractInvalid",
        reason: "retained node binding does not match the admitted handle closure"
      }))
}

const planInvalid = (plan: Plan, reason: string) =>
  new RuntimePlanInvalid({ planId: plan.id, reason })

const duplicate = (values: ReadonlyArray<string>) =>
  values.find((value, index) => values.indexOf(value) !== index)

const runtimeNodeContractFailure = (
  plan: Plan,
  node: PlanNode,
  profile: RuntimeProfile,
  workspace: string
): RuntimePlanInvalid | undefined => {
  const repeatedOutput = duplicate(node.produces)
  if (repeatedOutput !== undefined) {
    return planInvalid(
      plan,
      `node ${node.id} declares output artifact ${repeatedOutput} more than once`
    )
  }

  switch (node._tag) {
    case "Capture": {
      if (node.produces.length !== 1) {
        return planInvalid(plan, `Capture ${node.id} must produce exactly one materialized artifact`)
      }
      if (node.locator.length === 0 || node.locator.includes("\0")) {
        return planInvalid(
          plan,
          `Capture ${node.id} locator must be non-empty and contain no NUL`
        )
      }
      if (node.source === "process-output") {
        return planInvalid(
          plan,
          `Capture ${node.id} process-output is not a runtime operation; bind an Invoke stream artifact`
        )
      }
      if (node.source !== "file" && node.operation !== "read") {
        return planInvalid(
          plan,
          `Capture ${node.id} operation ${node.operation} requires source file`
        )
      }
      if (
        node.operation === "glob" &&
        (node.pattern === undefined || node.pattern.length === 0)
      ) {
        return planInvalid(plan, `Capture ${node.id} file.glob requires pattern`)
      }
      if (node.operation !== "glob" && node.pattern !== undefined) {
        return planInvalid(plan, `Capture ${node.id} pattern is valid only for file.glob`)
      }
      if (node.operation !== "read" && node.format !== "bytes") {
        return planInvalid(plan, `Capture ${node.id} format is valid only for file.read`)
      }
      return undefined
    }
    case "Invoke": {
      if (!node.executable.startsWith("/") || node.executable.includes("\0")) {
        return planInvalid(plan, `Invoke ${node.id} executable must be an absolute path without NUL`)
      }
      if (
        node.cwd !== undefined &&
        (!node.cwd.startsWith("/") || node.cwd.includes("\0"))
      ) {
        return planInvalid(plan, `Invoke ${node.id} cwd must be an absolute path without NUL`)
      }
      if (node.args.some((argument) => argument.includes("\0"))) {
        return planInvalid(plan, `Invoke ${node.id} arguments must not contain NUL`)
      }
      if (
        Object.entries(node.env).some(
          ([key, value]) =>
            key.length === 0 ||
            key.includes("=") ||
            key.includes("\0") ||
            value.includes("\0")
        )
      ) {
        return planInvalid(
          plan,
          `Invoke ${node.id} environment keys and values must be explicit valid atoms`
        )
      }
      if (!Number.isSafeInteger(node.outputLimitBytes) || node.outputLimitBytes < 0) {
        return planInvalid(plan, `Invoke ${node.id} outputLimitBytes must be a non-negative safe integer`)
      }
      if (
        node.timeoutMs !== undefined &&
        (!Number.isSafeInteger(node.timeoutMs) || node.timeoutMs <= 0)
      ) {
        return planInvalid(plan, `Invoke ${node.id} timeoutMs must be a positive safe integer`)
      }
      if (node.cellProfile === "vm-enclosed") {
        return planInvalid(plan, `Invoke ${node.id} requests unavailable vm-enclosed execution`)
      }
      if (profile === "vm-enclosed") {
        return planInvalid(plan, "runtime profile vm-enclosed is unavailable")
      }
      if (profile === "native-contained" && node.cellProfile !== "native-contained") {
        return planInvalid(
          plan,
          `Invoke ${node.id} cannot widen native-contained runtime authority`
        )
      }
      if (
        node.cellProfile === "native-contained" &&
        (
          node.stdinDisposition === "inherit" ||
          node.stdout === "inherit" ||
          node.stderr === "inherit"
        )
      ) {
        return planInvalid(
          plan,
          `Invoke ${node.id} native-contained execution forbids inherited stdin, stdout, and stderr descriptors`
        )
      }
      if (node.stdin !== undefined && node.stdinDisposition === "inherit") {
        return planInvalid(
          plan,
          `Invoke ${node.id} cannot combine artifact stdin with inherited stdin`
        )
      }
      const named = [
        node.stdoutArtifact,
        node.stderrArtifact,
        node.deltaArtifact
      ].filter((id): id is ArtifactId => id !== undefined)
      const repeatedBinding = duplicate(named)
      if (repeatedBinding !== undefined) {
        return planInvalid(plan, `Invoke ${node.id} binds artifact ${repeatedBinding} more than once`)
      }
      if (
        node.produces.length !== named.length ||
        node.produces.some((id) => !named.includes(id))
      ) {
        return planInvalid(
          plan,
          `Invoke ${node.id} produces must exactly match its named stream and delta artifacts`
        )
      }
      if (node.stdoutArtifact !== undefined && node.stdout !== "capture") {
        return planInvalid(plan, `Invoke ${node.id} stdoutArtifact requires captured stdout`)
      }
      if (node.stderrArtifact !== undefined && node.stderr !== "capture") {
        return planInvalid(plan, `Invoke ${node.id} stderrArtifact requires captured stderr`)
      }
      if (node.cellProfile === "native-contained" && node.deltaArtifact === undefined) {
        return planInvalid(
          plan,
          `Invoke ${node.id} native-contained execution requires a delta artifact`
        )
      }
      if (node.cellProfile === "compatibility" && node.deltaArtifact !== undefined) {
        return planInvalid(
          plan,
          `Invoke ${node.id} compatibility execution cannot produce a Cell delta`
        )
      }
      return undefined
    }
    case "Apply": {
      if (node.produces.length > 1) {
        return planInvalid(plan, `Apply ${node.id} may produce at most one receipt artifact`)
      }
      if (node.target.length === 0 || node.target.includes("\0")) {
        return planInvalid(
          plan,
          `Apply ${node.id} target must be non-empty and contain no NUL`
        )
      }
      if (node.operation !== "mkdir" && node.parents) {
        return planInvalid(
          plan,
          `Apply ${node.id} parents is valid only for mkdir`
        )
      }
      if (node.operation === "write") {
        return node.sourceArtifact === undefined || node.source !== undefined
          ? planInvalid(plan, `Apply ${node.id} write requires only sourceArtifact`)
          : undefined
      }
      if (node.operation === "copy" || node.operation === "move") {
        return node.source === undefined ||
            node.source.length === 0 ||
            node.source.includes("\0") ||
            node.sourceArtifact !== undefined
          ? planInvalid(
              plan,
              `Apply ${node.id} ${node.operation} requires only a non-empty source path without NUL`
            )
          : undefined
      }
      if (node.operation === "remove" || node.operation === "mkdir") {
        return node.source !== undefined || node.sourceArtifact !== undefined
          ? planInvalid(plan, `Apply ${node.id} ${node.operation} accepts no source`)
          : undefined
      }
      if (node.sourceArtifact === undefined || node.source !== undefined) {
        return planInvalid(plan, `Apply ${node.id} merge requires only a Cell delta artifact`)
      }
      if (![workspace, "."].includes(node.target)) {
        return planInvalid(plan, `Apply ${node.id} merge must target the admitted workspace root`)
      }
      return undefined
    }
    case "RequestExternal": {
      if (node.produces.length > 1) {
        return planInvalid(
          plan,
          `RequestExternal ${node.id} may produce at most one staged-intent artifact`
        )
      }
      if (node.endpoint.length === 0 || node.endpoint.includes("\0")) {
        return planInvalid(
          plan,
          `RequestExternal ${node.id} endpoint must be non-empty and contain no NUL`
        )
      }
      if (
        !Number.isSafeInteger(node.holdMillis) ||
        node.holdMillis < 0
      ) {
        return planInvalid(
          plan,
          `RequestExternal ${node.id} holdMillis must be a non-negative safe integer`
        )
      }
      if (node.body !== undefined && node.bodyArtifact !== undefined) {
        return planInvalid(plan, `RequestExternal ${node.id} has two body sources`)
      }
      return undefined
    }
  }
}

const validatePlan = (
  plan: Plan,
  profile: RuntimeProfile,
  workspace: string
): Effect.Effect<ReadonlyArray<PlanNode>, RuntimePlanInvalid> =>
  Effect.gen(function* () {
    const ids = plan.nodes.map((node) => node.id)
    const repeatedNode = duplicate(ids)
    if (repeatedNode !== undefined) {
      return yield* planInvalid(plan, `duplicate node id: ${repeatedNode}`)
    }
    const declaredArtifacts = plan.nodes.flatMap((node) => node.produces)
    const repeatedArtifact = duplicate(declaredArtifacts)
    if (repeatedArtifact !== undefined) {
      return yield* planInvalid(
        plan,
        `artifact ${repeatedArtifact} has more than one Plan producer`
      )
    }
    const known = new Set(ids)
    for (const node of plan.nodes) {
      const contractFailure = runtimeNodeContractFailure(
        plan,
        node,
        profile,
        workspace
      )
      if (contractFailure !== undefined) return yield* contractFailure
      for (const dependency of node.dependsOn) {
        if (!known.has(dependency)) {
          return yield* planInvalid(
            plan,
            `node ${node.id} depends on unknown node ${dependency}`
          )
        }
      }
    }

    const remaining = new Map(
      plan.nodes.map((node) => [node.id, node.dependsOn.length])
    )
    const children = new Map(
      plan.nodes.map((node) => [node.id, [] as NodeId[]])
    )
    for (const node of plan.nodes) {
      for (const dependency of node.dependsOn) {
        children.get(dependency)!.push(node.id)
      }
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
    return ordered.length === plan.nodes.length
      ? ordered
      : yield* planInvalid(plan, "plan dependency graph is cyclic")
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
      : node._tag === "RequestExternal" && node.bodyArtifact !== undefined
        ? [artifacts.get(node.bodyArtifact)?.artifact.digest].filter(
            (value): value is Digest => value !== undefined
          )
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

const materializeNodeArtifact = (
  node: PlanNode,
  artifacts: Map<ArtifactId, RuntimeArtifact>,
  bytes: Uint8Array,
  provenance: string,
  mediaType: string
): ReadonlyArray<ArtifactId> => {
  const id = node.produces[0]
  if (id === undefined) return []
  artifacts.set(id, artifact(id, bytes, provenance, { mediaType }))
  return [id]
}

type RuntimeCellWorkspace = {
  readonly nodeId: NodeId
  readonly requestedWorkspace: string
  privateWorkspace: string
}

const make = Effect.gen(function* () {
  const path = yield* Path.Path
  const config = yield* RuntimeConfigTag
  const process = yield* ProcessRunner
  const cell = yield* Cell
  const hold = yield* Hold
  const native = yield* NativeFileSystem
  const outbox = yield* Outbox
  const runJournal = config.runJournalDirectory === undefined
    ? makeMemoryRuntimeRunJournal()
    : makeFileRuntimeRunJournal(config.runJournalDirectory)
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

  const bindCellWorkspaceIdentity = (
    nodeId: NodeId,
    registration: RuntimeCellWorkspace,
    receipt: CellReceipt
  ) =>
    Effect.tryPromise({
      try: async () => {
        const [requested, reported] = await Promise.all([
          lstat(registration.requestedWorkspace),
          lstat(receipt.privateWorkspace)
        ])
        if (
          !requested.isDirectory() ||
          !reported.isDirectory() ||
          requested.dev !== reported.dev ||
          requested.ino !== reported.ino
        ) {
          throw new Error("Cell receipt does not identify the runtime-created private workspace")
        }
        registration.privateWorkspace = receipt.privateWorkspace
      },
      catch: (cause) => new RuntimeNodeFailure({
        nodeId,
        operation: "bind Cell workspace identity",
        reason: errorReason(cause)
      })
    })

  const materializeInvokeOutputs = (
    node: PlanNode & { readonly _tag: "Invoke" },
    receipt: ProcessReceipt,
    cellReceipt: CellReceipt | undefined,
    artifacts: Map<ArtifactId, RuntimeArtifact>
  ): ReadonlyArray<ArtifactId> => {
    const produced: ArtifactId[] = []
    if (node.stdoutArtifact !== undefined) {
      artifacts.set(node.stdoutArtifact, artifact(
        node.stdoutArtifact,
        receipt.stdout,
        `invoke:stdout:${node.executable}`
      ))
      produced.push(node.stdoutArtifact)
    }
    if (node.stderrArtifact !== undefined) {
      artifacts.set(node.stderrArtifact, artifact(
        node.stderrArtifact,
        receipt.stderr,
        `invoke:stderr:${node.executable}`
      ))
      produced.push(node.stderrArtifact)
    }
    if (cellReceipt !== undefined && node.deltaArtifact !== undefined) {
      artifacts.set(node.deltaArtifact, artifact(
        node.deltaArtifact,
        deltaBytes(cellReceipt),
        `cell-delta:${node.executable}`,
        { cellReceipt }
      ))
      produced.push(node.deltaArtifact)
    }
    return produced
  }

  const evidencedProcessFailure = (
    error: unknown
  ): {
    readonly evidence: RuntimeProcessOutcome
    readonly failure: RuntimeProcessFailure["outcome"]
    readonly receipt: ProcessReceipt
  } | undefined =>
    error instanceof ProcessTimedOut
      ? {
          evidence: "timed-out",
          failure: "timed-out",
          receipt: error.receipt
        }
      : error instanceof ProcessOutputLimitExceeded
        ? {
            evidence: "output-limit",
            failure: "output-limit",
            receipt: error.receipt
          }
        : error instanceof ProcessCancelled
          ? {
              evidence: "cancelled",
              failure: "cancelled",
              receipt: error.receipt
            }
          : undefined

  const runInvoke = (
    node: PlanNode & { readonly _tag: "Invoke" },
    artifacts: Map<ArtifactId, RuntimeArtifact>,
    cellWorkspaces: Map<NodeId, RuntimeCellWorkspace>,
    processes: Map<NodeId, RuntimeProcessEvidence>,
    handles: ReadonlyArray<Handle>
  ): Effect.Effect<ReadonlyArray<ArtifactId>, RuntimeError> =>
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
        stdin: stdin === undefined
          ? node.stdinDisposition
          : new ProcessInputBytes({ _tag: "bytes", bytes: stdin.bytes }),
        stdout: node.stdout,
        stderr: node.stderr,
        outputLimitBytes: node.outputLimitBytes,
        ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs })
      })
      const contained = node.cellProfile === "native-contained"
      if (contained && path.resolve(cwd) !== workspace) {
        return yield* new RuntimeCapabilityDenied({ nodeId: node.id, right: "Cell working directory", reason: "native-contained Invoke cwd must be the admitted workspace" })
      }
      let execution: Effect.Effect<{
        readonly process: ProcessReceipt
        readonly cell: CellReceipt | undefined
      }, unknown>
      if (contained) {
        const privateWorkspace = path.resolve(
          path.join(path.dirname(workspace), `.airlock-cell-${crypto.randomUUID()}`)
        )
        const registration: RuntimeCellWorkspace = {
          nodeId: node.id,
          requestedWorkspace: privateWorkspace,
          privateWorkspace
        }
        // Register before invoking the Cell: preparation or process failure may
        // occur after the private workspace has already been created.
        cellWorkspaces.set(node.id, registration)
        execution = cell.run(new CellRequest({
          sourceWorkspace: workspace,
          privateWorkspace,
          process: request,
          descendantExecutables: handles
            .filter(
              (handle) =>
                handle.kind === "executable" &&
                handle.rights.includes("execute")
            )
            .map((handle) => handle.constraints.selector)
            .filter((selector): selector is string =>
              selector !== undefined
            ),
          network: "deny"
        })).pipe(
          Effect.map((receipt) => ({
            process: receipt.processReceipt,
            cell: receipt
          }))
        )
      } else {
        execution = process.run(request).pipe(
          Effect.map((receipt) => ({
            process: receipt,
            cell: undefined
          }))
        )
      }

      const executed = yield* execution.pipe(Effect.either)
      if (executed._tag === "Left") {
        const evidenced = evidencedProcessFailure(executed.left)
        if (evidenced !== undefined) {
          processes.set(node.id, new RuntimeProcessEvidence({
            nodeId: node.id,
            outcome: evidenced.evidence,
            receipt: evidenced.receipt
          }))
          const outputArtifacts = materializeInvokeOutputs(
            node,
            evidenced.receipt,
            undefined,
            artifacts
          )
          return yield* new RuntimeProcessFailure({
            nodeId: node.id,
            outcome: evidenced.failure,
            receipt: evidenced.receipt,
            outputArtifacts
          })
        }
        const tag = typeof executed.left === "object" &&
            executed.left !== null &&
            "_tag" in executed.left
          ? String(executed.left._tag)
          : "ProcessExecutionFailed"
        return yield* new RuntimeNodeFailure({
          nodeId: node.id,
          operation: "invoke",
          reason: `${tag}: ${errorReason(executed.left)}`
        })
      }

      const outcome = executed.right
      processes.set(node.id, new RuntimeProcessEvidence({
        nodeId: node.id,
        outcome: "exited",
        receipt: outcome.process,
        executableBindings: outcome.cell?.executableBindings ?? []
      }))
      if (outcome.cell !== undefined) {
        yield* bindCellWorkspaceIdentity(
          node.id,
          cellWorkspaces.get(node.id)!,
          outcome.cell
        )
      }
      const outputArtifacts = materializeInvokeOutputs(
        node,
        outcome.process,
        outcome.cell,
        artifacts
      )
      if (outcome.process.signal !== null) {
        return yield* new RuntimeProcessFailure({
          nodeId: node.id,
          outcome: "signal",
          receipt: outcome.process,
          outputArtifacts
        })
      }
      if (outcome.process.exitCode !== 0) {
        return yield* new RuntimeProcessFailure({
          nodeId: node.id,
          outcome: "nonzero-exit",
          receipt: outcome.process,
          outputArtifacts
        })
      }
      return outputArtifacts
    })

  const materializeStructuredResult = <A, I>(
    node: PlanNode,
    artifacts: Map<ArtifactId, RuntimeArtifact>,
    schema: Schema.Schema<A, I, never>,
    value: A,
    provenance: string
  ) =>
    node.produces.length === 0
      ? Effect.succeed([])
      : encodeStructured(
          schema,
          value,
          node.id,
          `encode ${provenance} artifact`
        ).pipe(
          Effect.map((bytes) => materializeNodeArtifact(
            node,
            artifacts,
            bytes,
            provenance,
            "application/json"
          ))
        )

  const nativeNodeFailure = (
    node: PlanNode,
    operation: string,
    recovery: Array<RuntimeRecoveryEvidence>
  ) =>
    (error: { readonly _tag: string }) => {
      switch (error._tag) {
        case "HoldRecoveryRequired": {
          const preserved = error as HoldRecoveryRequired
          recovery.push(new RuntimeHoldRecoveryEvidence({
            nodeId: node.id,
            operation,
            recovery: preserved
          }))
          return new RuntimeRecoveryRequired({
            nodeId: node.id,
            operation,
            causeTag: error._tag,
            reason: errorReason(error)
          })
        }
        case "NativeMovePartiallyApplied": {
          const preserved = error as NativeMovePartiallyApplied
          recovery.push(new RuntimeMoveRecoveryEvidence({
            nodeId: node.id,
            operation,
            recovery: preserved
          }))
          return new RuntimeRecoveryRequired({
            nodeId: node.id,
            operation,
            causeTag: error._tag,
            reason: errorReason(error)
          })
        }
        case "NativeMkdirPartiallyApplied": {
          const preserved = error as NativeMkdirPartiallyApplied
          recovery.push(new RuntimeMkdirRecoveryEvidence({
            nodeId: node.id,
            operation,
            recovery: preserved
          }))
          return new RuntimeRecoveryRequired({
            nodeId: node.id,
            operation,
            causeTag: error._tag,
            reason: errorReason(error)
          })
        }
        default:
          return new RuntimeNodeFailure({
            nodeId: node.id,
            operation,
            reason: `${error._tag}: ${errorReason(error)}`
          })
      }
    }

  const runNode = (
    plan: Plan,
    node: PlanNode,
    artifacts: Map<ArtifactId, RuntimeArtifact>,
    cellWorkspaces: Map<NodeId, RuntimeCellWorkspace>,
    processes: Map<NodeId, RuntimeProcessEvidence>,
    recovery: Array<RuntimeRecoveryEvidence>,
    handles: ReadonlyArray<Handle>
  ): Effect.Effect<ReadonlyArray<ArtifactId>, RuntimeError> =>
    Effect.gen(function* () {
      yield* enforce(node)
      switch (node._tag) {
        case "Capture": {
          switch (node.source) {
            case "file":
              switch (node.operation) {
                case "read": {
                  const bytes = yield* native.readBytes(node.locator).pipe(
                    Effect.mapError(nativeNodeFailure(node, "Capture.file.read", recovery))
                  )
                  const mediaType = node.format === "text"
                    ? "text/plain; charset=utf-8"
                    : node.format === "json"
                      ? "application/json"
                      : "application/octet-stream"
                  return materializeNodeArtifact(
                    node,
                    artifacts,
                    bytes,
                    `capture:file.read:${node.locator}`,
                    mediaType
                  )
                }
                case "inspect": {
                  const result = yield* native.inspect(node.locator).pipe(
                    Effect.mapError(nativeNodeFailure(node, "Capture.file.inspect", recovery))
                  )
                  return yield* materializeStructuredResult(
                    node,
                    artifacts,
                    NativeStat,
                    result,
                    `capture:file.inspect:${node.locator}`
                  )
                }
                case "stat": {
                  const result = yield* native.stat(node.locator).pipe(
                    Effect.mapError(nativeNodeFailure(node, "Capture.file.stat", recovery))
                  )
                  return yield* materializeStructuredResult(
                    node,
                    artifacts,
                    NativeStat,
                    result,
                    `capture:file.stat:${node.locator}`
                  )
                }
                case "list": {
                  const result = yield* native.list(node.locator).pipe(
                    Effect.mapError(nativeNodeFailure(node, "Capture.file.list", recovery))
                  )
                  return yield* materializeStructuredResult(
                    node,
                    artifacts,
                    Schema.Array(NativeListEntry),
                    result,
                    `capture:file.list:${node.locator}`
                  )
                }
                case "glob": {
                  const result = yield* native.glob(
                    node.locator,
                    node.pattern!
                  ).pipe(
                    Effect.mapError(nativeNodeFailure(node, "Capture.file.glob", recovery))
                  )
                  return yield* materializeStructuredResult(
                    node,
                    artifacts,
                    Schema.Array(Schema.String),
                    result,
                    `capture:file.glob:${node.locator}`
                  )
                }
              }
            case "environment": {
              const value = config.environment[node.locator]
              if (value === undefined) return yield* new RuntimeNodeFailure({ nodeId: node.id, operation: "read environment", reason: `not present: ${node.locator}` })
              return materializeNodeArtifact(
                node,
                artifacts,
                text.encode(value),
                `capture:environment:${node.locator}`,
                "text/plain; charset=utf-8"
              )
            }
            case "clock":
              return materializeNodeArtifact(
                node,
                artifacts,
                text.encode((yield* DateTime.now).toString()),
                `capture:clock:${node.locator}`,
                "text/plain; charset=utf-8"
              )
            case "process-output": return yield* new RuntimeUnsupported({ nodeId: node.id, feature: "process-output Capture", reason: "use Invoke produces to bind an explicit stream artifact" })
          }
        }
        case "Invoke":
          return yield* runInvoke(
            node,
            artifacts,
            cellWorkspaces,
            processes,
            handles
          )
        case "Apply": {
          switch (node.operation) {
            case "write": {
              const source = artifacts.get(node.sourceArtifact!)
              if (source === undefined) {
                return yield* new RuntimeNodeFailure({
                  nodeId: node.id,
                  operation: "Apply.write",
                  reason: `missing artifact ${node.sourceArtifact}`
                })
              }
              if (source.cellReceipt !== undefined) {
                return yield* new RuntimeUnsupported({
                  nodeId: node.id,
                  feature: "Apply.write",
                  reason: "a Cell delta is consumable only by Apply.merge"
                })
              }
              const result = yield* native.writeBytes(
                node.target,
                source.bytes
              ).pipe(Effect.mapError(nativeNodeFailure(node, "Apply.write", recovery)))
              return yield* materializeStructuredResult(
                node,
                artifacts,
                NativeWriteReceipt,
                result,
                `apply:write:${node.target}`
              )
            }
            case "remove": {
              const result = yield* native.remove(node.target).pipe(
                Effect.mapError(nativeNodeFailure(node, "Apply.remove", recovery))
              )
              return yield* materializeStructuredResult(
                node,
                artifacts,
                RemoveReceipt,
                result,
                `apply:remove:${node.target}`
              )
            }
            case "copy": {
              const result = yield* native.copy(
                node.source!,
                node.target
              ).pipe(Effect.mapError(nativeNodeFailure(node, "Apply.copy", recovery)))
              return yield* materializeStructuredResult(
                node,
                artifacts,
                NativeWriteReceipt,
                result,
                `apply:copy:${node.target}`
              )
            }
            case "move": {
              const result = yield* native.move(
                node.source!,
                node.target
              ).pipe(Effect.mapError(nativeNodeFailure(node, "Apply.move", recovery)))
              return yield* materializeStructuredResult(
                node,
                artifacts,
                NativeMoveReceipt,
                result,
                `apply:move:${node.target}`
              )
            }
            case "mkdir": {
              const result = yield* native.mkdir(node.target, {
                parents: node.parents
              }).pipe(Effect.mapError(nativeNodeFailure(node, "Apply.mkdir", recovery)))
              return yield* materializeStructuredResult(
                node,
                artifacts,
                NativeMkdirReceipt,
                result,
                `apply:mkdir:${node.target}`
              )
            }
            case "merge": {
              const source = artifacts.get(node.sourceArtifact!)
              if (source === undefined) {
                return yield* new RuntimeNodeFailure({
                  nodeId: node.id,
                  operation: "Apply.merge",
                  reason: `missing artifact ${node.sourceArtifact}`
                })
              }
              if (source.cellReceipt === undefined) {
                return yield* new RuntimeNodeFailure({
                  nodeId: node.id,
                  operation: "Apply.merge",
                  reason: "source artifact is not a Cell delta"
                })
              }
              yield* mergeCellDelta(node, source)
              return yield* materializeStructuredResult(
                node,
                artifacts,
                RuntimeMergeEvidence,
                new RuntimeMergeEvidence({
                  target: node.target,
                  paths: source.cellReceipt.delta.map((entry) => entry.path)
                }),
                `apply:merge:${node.target}`
              )
            }
          }
        }
        case "RequestExternal": {
          const bodyArtifact = node.bodyArtifact === undefined
            ? undefined
            : artifacts.get(node.bodyArtifact)
          if (node.bodyArtifact !== undefined && bodyArtifact === undefined) {
            return yield* new RuntimeNodeFailure({
              nodeId: node.id,
              operation: "stage external",
              reason: `missing body artifact ${node.bodyArtifact}`
            })
          }
          let body = node.body
          if (bodyArtifact !== undefined) {
            body = yield* Effect.try({
              try: () => textDecoder.decode(bodyArtifact.bytes),
              catch: () => new RuntimeUnsupported({
                nodeId: node.id,
                feature: "binary RequestExternal body",
                reason: "HTTP Outbox v1 accepts text bodies; artifact bytes are not valid UTF-8"
              })
            })
          }
          const stagedResult = yield* outbox.stage(new EmissionRequest({
            url: node.endpoint,
            method: node.method,
            headers: node.headers,
            ...(body === undefined ? {} : { body })
          }), node.holdMillis).pipe(Effect.either)
          if (stagedResult._tag === "Left") {
            if (stagedResult.left._tag === "OutboxRecoveryRequired") {
              recovery.push(new RuntimeOutboxRecoveryEvidence({
                nodeId: node.id,
                operation: "stage external",
                recovery: stagedResult.left
              }))
              return yield* new RuntimeRecoveryRequired({
                nodeId: node.id,
                operation: "stage external",
                causeTag: stagedResult.left._tag,
                reason: stagedResult.left.reason
              })
            }
            return yield* new RuntimeNodeFailure({
              nodeId: node.id,
              operation: "stage external",
              reason: `${stagedResult.left._tag}: ${errorReason(stagedResult.left)}`
            })
          }
          const staged = stagedResult.right
          return yield* materializeStructuredResult(
            node,
            artifacts,
            OutboxEmission,
            staged,
            `request-external:${node.endpoint}`
          )
        }
      }
    })

  const retainCellWorkspaces = (
    cellWorkspaces: ReadonlyMap<NodeId, RuntimeCellWorkspace>
  ): Effect.Effect<ReadonlyArray<RuntimeLifecycleReceipt>> =>
    Effect.forEach(
      cellWorkspaces.values(),
      (registration) =>
        hold.retireRuntimePrivate(registration.privateWorkspace).pipe(
          Effect.either,
          Effect.flatMap((result) => {
            if (result._tag === "Right") {
              return Effect.succeed(new RuntimeCellWorkspaceHeld({
                state: "held",
                nodeId: registration.nodeId,
                privateWorkspace: registration.privateWorkspace,
                actId: result.right.id,
                at: result.right.at
              }))
            }
            return DateTime.now.pipe(
              Effect.map((at): RuntimeLifecycleReceipt =>
                result.left._tag === "TargetNotFound"
                  ? new RuntimeCellWorkspaceAbsent({
                      state: "absent",
                      nodeId: registration.nodeId,
                      privateWorkspace: registration.privateWorkspace,
                      at
                    })
                  : new RuntimeCellWorkspaceRetentionFailed({
                      state: "failed",
                      nodeId: registration.nodeId,
                      privateWorkspace: registration.privateWorkspace,
                      errorTag: result.left._tag,
                      reason: errorReason(result.left),
                      at
                    })
              )
            )
          })
        ),
      { concurrency: 1 }
    )

  const execute = (
    authority: ExecutionAuthority,
    initialArtifacts: ReadonlyArray<RuntimeInitialArtifact> = []
  ): Effect.Effect<RuntimeRun, RuntimePlanInvalid | RuntimeLifecycleFailure> => {
    const plan = authority.admission.plan
    const cellWorkspaces = new Map<NodeId, RuntimeCellWorkspace>()
    let ordered: ReadonlyArray<PlanNode> = []
    let startedAt: DateTime.Utc | undefined
    const artifacts = new Map<ArtifactId, RuntimeArtifact>()
    const receipts: Receipt[] = []
    const stateByNode = new Map<NodeId, NodeState>()
    const processes = new Map<NodeId, RuntimeProcessEvidence>()
    const recovery: RuntimeRecoveryEvidence[] = []
    let currentNode: PlanNode | undefined
    let failed = false
    let snapshotSequence = 0
    const persistSnapshot = (
      state: RuntimeRunSnapshot["state"],
      lifecycle: ReadonlyArray<RuntimeLifecycleReceipt> = []
    ) => {
      const beganAt = startedAt
      return beganAt === undefined
        ? Effect.void
        : DateTime.now.pipe(
            Effect.flatMap((observedAt) =>
              runJournal.record(new RuntimeRunSnapshot({
                schemaVersion: "airlock/runtime-run-snapshot/v1",
                planId: plan.id,
                state,
                startedAt: beganAt,
                observedAt,
                sequence: ++snapshotSequence,
                receipts,
                artifacts: [...artifacts.values()].map(
                  (item) => item.artifact
                ),
                lifecycle,
                recovery
              }))
            ),
            Effect.mapError((error) =>
              new RuntimeLifecycleFailure({
                planId: plan.id,
                privateWorkspaces: [...cellWorkspaces.values()].map(
                  (item) => item.privateWorkspace
                ),
                reason: `${error._tag}: ${error.reason}`
              })
            ),
            Effect.uninterruptible
          )
    }

    const runPlan = Effect.gen(function* () {
      ordered = yield* validatePlan(plan, config.profile, workspace)
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
      for (const input of initialArtifacts) {
        artifacts.set(input.id, materializeInitialArtifact(input))
      }
      snapshotSequence = yield* runJournal.inspect(plan.id).pipe(
        Effect.map((snapshot) => snapshot.sequence),
        Effect.catchTag("RuntimeRunNotFound", () => Effect.succeed(0)),
        Effect.mapError(
          (error) =>
            new RuntimeLifecycleFailure({
              planId: plan.id,
              privateWorkspaces: [],
              reason: `${error._tag}: ${error.reason}`
            })
        )
      )
      const beganAt = yield* DateTime.now
      startedAt = beganAt
      yield* persistSnapshot("running")
      for (const node of ordered) {
        currentNode = node
        const retainedBinding = yield* retainedBindingFor(
          authority,
          node
        ).pipe(Effect.either)
        if (retainedBinding._tag === "Left") {
          receipts.push(yield* nodeReceipt(
            plan,
            node,
            receipts.length + 1,
            "failed",
            artifacts,
            [],
            [],
            retainedBinding.left._tag
          ))
          stateByNode.set(node.id, "failed")
          failed = true
          currentNode = undefined
          yield* persistSnapshot("running")
          continue
        }
        const dependenciesSucceeded = node.dependsOn.every(
          (dependency) => stateByNode.get(dependency) === "succeeded"
        )
        if (!dependenciesSucceeded) {
          receipts.push(yield* nodeReceipt(
            plan,
            node,
            receipts.length + 1,
            "cancelled",
            artifacts,
            [],
            retainedBinding.right.handles.map(
              (handle) => handle.resourceIdentity
            ),
            "RuntimeDependencyFailed"
          ))
          stateByNode.set(node.id, "cancelled")
          failed = true
          currentNode = undefined
          yield* persistSnapshot("running")
          continue
        }
        const artifactsBefore = new Set(artifacts.keys())
        const revalidated = yield* revalidateNodeAuthority(
          authority,
          node.id
        ).pipe(
          Effect.mapError((error) => new RuntimeAuthorityInvalid({
            nodeId: node.id,
            causeTag: error._tag,
            reason: errorReason(error)
          })),
          Effect.either
        )
        const handles = revalidated._tag === "Right"
          ? revalidated.right.handles
          : []
        const result = revalidated._tag === "Left"
          ? revalidated
          : yield* runNode(
            plan,
            node,
            artifacts,
            cellWorkspaces,
            processes,
            recovery,
            handles
          ).pipe(Effect.either)
        const materialized = [...artifacts.keys()].filter(
          (id) => !artifactsBefore.has(id)
        )
        const claimed = result._tag === "Right"
          ? result.right
          : result.left instanceof RuntimeProcessFailure
            ? result.left.outputArtifacts
            : []
        const claimMatches =
          claimed.length === materialized.length &&
          claimed.every((id) => materialized.includes(id))
        if (!claimMatches) {
          const mismatch = new RuntimeArtifactClaimMismatch({
            nodeId: node.id,
            claimed,
            materialized
          })
          receipts.push(yield* nodeReceipt(
            plan,
            node,
            receipts.length + 1,
            "failed",
            artifacts,
            materialized,
            handles.map((handle) => handle.resourceIdentity),
            mismatch._tag
          ))
          stateByNode.set(node.id, "failed")
          failed = true
        } else if (result._tag === "Left") {
          receipts.push(yield* nodeReceipt(
            plan,
            node,
            receipts.length + 1,
            "failed",
            artifacts,
            claimed,
            handles.map((handle) => handle.resourceIdentity),
            result.left instanceof RuntimeRecoveryRequired
              ? result.left.causeTag
              : result.left._tag
          ))
          stateByNode.set(node.id, "failed")
          failed = true
        } else {
          receipts.push(yield* nodeReceipt(
            plan,
            node,
            receipts.length + 1,
            "succeeded",
            artifacts,
            result.right,
            handles.map((handle) => handle.resourceIdentity)
          ))
          stateByNode.set(node.id, "succeeded")
        }
        currentNode = undefined
        yield* persistSnapshot("running")
      }
      const finishedAt = yield* DateTime.now
      const succeeded = receipts.filter(
        (receipt) => receipt.state === "succeeded"
      ).length
      const run = new RuntimeRun({
        planId: plan.id,
        state: failed
          ? succeeded > 0
            ? "partial"
            : "failed"
          : "succeeded",
        startedAt: beganAt,
        finishedAt,
        receipts,
        artifacts: [...artifacts.values()],
        processes: [...processes.values()],
        recovery
      })
      yield* persistSnapshot("finalizing")
      return run
    })

    /*
     * Cancellation remains enabled while Plan nodes execute. Once that phase
     * exits (success, typed failure, defect, or interruption), finalization is
     * uninterruptible so a second cancellation cannot strand a known Cell
     * workspace before Hold either accepts it or records why it could not.
     */
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runExit = yield* restore(runPlan).pipe(Effect.exit)
        const lifecycle = yield* retainCellWorkspaces(cellWorkspaces)
        const retentionFailures = lifecycle.filter(
          (receipt): receipt is RuntimeCellWorkspaceRetentionFailed =>
            receipt.state === "failed"
        )
        if (Exit.isFailure(runExit)) {
          if (
            Cause.isInterruptedOnly(runExit.cause) &&
            startedAt !== undefined
          ) {
            for (const node of ordered) {
              if (stateByNode.has(node.id)) continue
              const materialized = node.produces.filter((id) =>
                artifacts.has(id)
              )
              receipts.push(yield* nodeReceipt(
                plan,
                node,
                receipts.length + 1,
                "cancelled",
                artifacts,
                materialized,
                handlesFor(plan, node).map(
                  (handle) => handle.resourceIdentity
                ),
                node.id === currentNode?.id
                  ? "RuntimeInterrupted"
                  : "RuntimeDependencyCancelled"
              ))
              stateByNode.set(node.id, "cancelled")
            }
            const finishedAt = yield* DateTime.now
            const succeeded = receipts.some(
              (receipt) => receipt.state === "succeeded"
            )
            yield* persistSnapshot(
              succeeded || recovery.length > 0
                ? "partial"
                : "cancelled",
              lifecycle
            )
            return new RuntimeRun({
              planId: plan.id,
              state:
                succeeded || recovery.length > 0
                  ? "partial"
                  : "failed",
              startedAt,
              finishedAt,
              receipts,
              artifacts: [...artifacts.values()],
              processes: [...processes.values()],
              lifecycle,
              recovery
            })
          }
          if (retentionFailures.length === 0) {
            return yield* Effect.failCause(runExit.cause)
          }
          return yield* Effect.failCause(Cause.sequential(
            runExit.cause,
            Cause.fail(new RuntimeLifecycleFailure({
              planId: plan.id,
              privateWorkspaces: retentionFailures.map(
                (receipt) => receipt.privateWorkspace
              ),
              reason: retentionFailures.map(
                (receipt) => `${receipt.errorTag}: ${receipt.reason}`
              ).join("; ")
            }))
          ))
        }
        const run = runExit.value
        const finishedAt = yield* DateTime.now
        const succeeded = run.receipts.some((receipt) => receipt.state === "succeeded")
        const state = retentionFailures.length === 0
          ? run.state
          : succeeded
            ? "partial" as const
            : "failed" as const
        const finalized = new RuntimeRun({
          ...run,
          state,
          finishedAt,
          lifecycle
        })
        yield* persistSnapshot(state, lifecycle)
        return finalized
      })
    )
  }

  return Runtime.of({
    execute,
    inspect: runJournal.inspect,
    recent: runJournal.recent
  })
})

/** Adapter composition root. A VM Cell is deliberately not substituted here. */
export const RuntimeLive = Layer.effect(Runtime, make)
