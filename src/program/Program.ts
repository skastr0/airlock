import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { admit, AdmissionPolicy } from "../admission/index.ts"
import { parse, type Program, type Statement, type Expression } from "../language/index.ts"
import { LanguageDiagnostic } from "../language/lexer.ts"
import {
  type ActionResolver,
  evaluate,
  type EvaluationError,
  type EvaluationResult,
  type LanguageRecord,
  type LanguageValue,
  LanguageValueSchema
} from "../language/evaluator.ts"
import {
  NativeActionCall,
  type NativeActionCall as NativeActionCallValue,
  NativeActionCatalog,
  type NativeActionName,
  lowerNativeAction,
  ResourceNeed
} from "../actions/index.ts"
import {
  NativeFileSystem,
  type NativeListEntry,
  type NativeStat
} from "../native/index.ts"
import { HttpExternalIntent, Outbox } from "../Outbox.ts"
import {
  ApplyNode,
  ArtifactId,
  type CellProfile,
  CaptureNode,
  Digest,
  InvokeNode,
  NodeId,
  PlanDraft,
  PlanId,
  Plan,
  RequestExternalNode,
  RequirementId,
  ResourceRequirement
} from "../plan/index.ts"
import {
  Runtime,
  RuntimeInitialArtifact,
  type RuntimeArtifact,
  type RuntimeRun
} from "../runtime/index.ts"

/**
 * Program is the candidate bridge from the pure Airlock language to plans.
 * It owns only argument decoding and inert PlanDraft construction.  Admission,
 * filesystem access, process invocation, and endpoint dispatch remain behind
 * the supplied executor seam.
 */

export class ProgramActionCall extends Schema.Class<ProgramActionCall>("ProgramActionCall")({
  action: Schema.String,
  input: Schema.Unknown
}) {}

export class InlineArtifact extends Schema.Class<InlineArtifact>("InlineArtifact")({
  id: ArtifactId,
  bytes: Schema.Uint8Array,
  mediaType: Schema.String,
  provenance: Schema.String
}) {}

export class ProgramRequest extends Schema.Class<ProgramRequest>("ProgramRequest")({
  source: Schema.String,
  bindings: Schema.optionalWith(Schema.Record({ key: Schema.String, value: LanguageValueSchema }), {
    default: () => ({})
  }),
  artifacts: Schema.optionalWith(Schema.Array(InlineArtifact), { default: () => [] }),
  maxLoopIterations: Schema.optional(Schema.Number)
}) {}

export class ProgramActionRequest extends Schema.Class<ProgramActionRequest>("ProgramActionRequest")({
  call: ProgramActionCall,
  /** Bound into draft.actionReference so admission covers call and input bytes. */
  callDigest: Schema.String.pipe(Schema.brand("Digest")),
  draft: PlanDraft,
  inlineArtifacts: Schema.Array(InlineArtifact)
}) {}

export class ProgramActionResult extends Schema.Class<ProgramActionResult>("ProgramActionResult")({
  value: LanguageValueSchema,
  artifacts: Schema.Array(InlineArtifact)
}) {}

export class ProgramActionRecord extends Schema.Class<ProgramActionRecord>("ProgramActionRecord")({
  request: ProgramActionRequest,
  result: ProgramActionResult
}) {}

export class ProgramRunFailure extends Schema.Class<ProgramRunFailure>("ProgramRunFailure")({
  action: Schema.String,
  phase: Schema.Literal("language", "admission", "native-filesystem", "runtime", "outbox", "contract"),
  causeTag: Schema.optional(Schema.String),
  reason: Schema.String
}) {}

export class ProgramRunResult extends Schema.Class<ProgramRunResult>("ProgramRunResult")({
  state: Schema.Literal("succeeded", "failed", "partial"),
  result: LanguageValueSchema,
  plans: Schema.Array(PlanDraft),
  actions: Schema.Array(ProgramActionRecord),
  artifacts: Schema.Array(InlineArtifact),
  failure: Schema.optional(ProgramRunFailure)
}) {}

export class UnknownProgramAction extends Schema.TaggedError<UnknownProgramAction>()(
  "UnknownProgramAction",
  { action: Schema.String }
) {}

export class ProgramActionDecodeFailed extends Schema.TaggedError<ProgramActionDecodeFailed>()(
  "ProgramActionDecodeFailed",
  { action: Schema.String, reason: Schema.String }
) {}

export class ProgramActionExecutionFailed extends Schema.TaggedError<ProgramActionExecutionFailed>()(
  "ProgramActionExecutionFailed",
  {
    action: Schema.String,
    phase: Schema.optionalWith(
      Schema.Literal("admission", "native-filesystem", "runtime", "outbox", "contract"),
      { default: () => "runtime" as const }
    ),
    causeTag: Schema.optional(Schema.String),
    reason: Schema.String
  }
) {}

export type ProgramError =
  | LanguageDiagnostic
  | EvaluationError
  | UnknownProgramAction
  | ProgramActionDecodeFailed
  | ProgramActionExecutionFailed

/**
 * The only world-facing seam used by ProgramRunner. A concrete implementation
 * must admit the draft and run it through Runtime or a native action adapter;
 * this service deliberately cannot expose raw filesystem/process/network APIs.
 */
export class ProgramActionExecutor extends Context.Tag("airlock/ProgramActionExecutor")<
  ProgramActionExecutor,
  {
    readonly execute: (
      request: ProgramActionRequest
    ) => Effect.Effect<ProgramActionResult, ProgramActionExecutionFailed>
  }
>() {}

/** Admission adapter: this is deliberately narrower than the admission policy component. */
export class ProgramAdmission extends Context.Tag("airlock/ProgramAdmission")<
  ProgramAdmission,
  {
    readonly admit: (draft: PlanDraft) => Effect.Effect<Plan, ProgramActionExecutionFailed>
  }
>() {}

/**
 * Runtime/native-filesystem adapter. Inline artifacts make text writes and
 * future process stdin explicit; the adapter is the only place allowed to
 * materialize them for a concrete Runtime implementation.
 */
export class ProgramPlanRuntime extends Context.Tag("airlock/ProgramPlanRuntime")<
  ProgramPlanRuntime,
  {
    readonly execute: (
      request: ProgramActionRequest,
      plan: Plan
    ) => Effect.Effect<ProgramActionResult, ProgramActionExecutionFailed>
  }
>() {}

const causeTag = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "_tag" in cause &&
  typeof (cause as { readonly _tag?: unknown })._tag === "string"
    ? (cause as { readonly _tag: string })._tag
    : undefined

const causeReason = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : causeTag(cause) ?? "operation failed"

const executionFailure = (
  action: string,
  phase: ProgramActionExecutionFailed["phase"]
) => (cause: unknown) =>
  new ProgramActionExecutionFailed({
    action,
    phase,
    ...(causeTag(cause) === undefined ? {} : { causeTag: causeTag(cause) }),
    reason: causeReason(cause)
  })

/**
 * Admission remains its own typed seam. This layer only adapts the richer
 * Admission error vocabulary to the language-facing execution boundary.
 */
export const ProgramAdmissionLive = (policy: AdmissionPolicy) =>
  Layer.succeed(ProgramAdmission, ProgramAdmission.of({
    admit: (draft) => admit(draft, policy).pipe(
      Effect.map((result) => result.plan),
      Effect.mapError(executionFailure(draft.actionReference, "admission"))
    )
  }))

/**
 * Candidate composition bridge: action → draft → admission → runtime. It has
 * no fallback operation, so a missing contained/runtime adapter cannot become
 * ambient host authority by accident.
 */
export const ProgramPlanExecutorLive = Layer.effect(
  ProgramActionExecutor,
  Effect.gen(function* () {
    const admission = yield* ProgramAdmission
    const runtime = yield* ProgramPlanRuntime
    return ProgramActionExecutor.of({
      execute: (request) => admission.admit(request.draft).pipe(
        Effect.flatMap((plan) => runtime.execute(request, plan))
      )
    })
  })
)

export class ProgramRunner extends Context.Tag("airlock/ProgramRunner")<
  ProgramRunner,
  {
    readonly run: (request: ProgramRequest) => Effect.Effect<ProgramRunResult, ProgramError>
  }
>() {}

const nativeNames = new Set<NativeActionName>(NativeActionCatalog.map((action) => action.name))
const encoder = new TextEncoder()

const isRecord = (value: LanguageValue | undefined): value is LanguageRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !("kind" in value && value.kind === "Duration")

const string = (value: LanguageValue | undefined, field: string, action: string): Effect.Effect<string, ProgramActionDecodeFailed> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new ProgramActionDecodeFailed({ action, reason: `${field} must be a string` }))

const record = (value: LanguageValue | undefined, action: string): Effect.Effect<LanguageRecord, ProgramActionDecodeFailed> =>
  isRecord(value)
    ? Effect.succeed(value)
    : Effect.fail(new ProgramActionDecodeFailed({ action, reason: "expects one record argument" }))

const unknown = (action: string): Effect.Effect<never, UnknownProgramAction> =>
  Effect.fail(new UnknownProgramAction({ action }))

const asStringList = (value: LanguageValue | undefined, field: string, action: string) => {
  if (value === undefined) return Effect.succeed([] as string[])
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return Effect.succeed([...value] as string[])
  return Effect.fail(new ProgramActionDecodeFailed({ action, reason: `${field} must be a list of strings` }))
}

const object = (value: LanguageRecord): Record<string, unknown> => ({ ...value })

/** Decode compact language aliases into the canonical native action vocabulary. */
export const decodeProgramAction = (
  action: string,
  args: readonly LanguageValue[]
): Effect.Effect<NativeActionCallValue, UnknownProgramAction | ProgramActionDecodeFailed> =>
  Effect.gen(function* () {
    if (nativeNames.has(action as NativeActionName)) {
      if (args.length !== 1) return yield* new ProgramActionDecodeFailed({ action, reason: "expects exactly one record argument" })
      const input = yield* record(args[0], action)
      return { action, ...object(input) } as unknown as NativeActionCallValue
    }
    switch (action) {
      case "run": {
        if (args.length === 1) {
          const input = yield* record(args[0], action)
          return { action: "process.run", ...object(input) } as unknown as NativeActionCallValue
        }
        if (args.length < 1 || args.length > 3) {
          return yield* new ProgramActionDecodeFailed({ action, reason: "expects run(executable, args?, options?)" })
        }
        const executable = yield* string(args[0], "executable", action)
        const runArgs = yield* asStringList(args[1], "args", action)
        const options = args[2] === undefined ? {} : object(yield* record(args[2], action))
        return { action: "process.run", executable, args: runArgs, ...options } as unknown as NativeActionCallValue
      }
      case "capture": {
        if (args.length !== 1) return yield* new ProgramActionDecodeFailed({ action, reason: "expects capture(path | { path, format? })" })
        if (typeof args[0] === "string") return { action: "file.read", path: args[0] } as unknown as NativeActionCallValue
        return { action: "file.read", ...object(yield* record(args[0], action)) } as unknown as NativeActionCallValue
      }
      case "apply": {
        if (args.length === 1) {
          const input = yield* record(args[0], action)
          const operation = yield* string(input.operation, "operation", action)
          const { operation: _, ...rest } = object(input)
          return { action: `file.${operation}`, ...rest } as unknown as NativeActionCallValue
        }
        if (args.length !== 2) return yield* new ProgramActionDecodeFailed({ action, reason: "expects apply(operation, record)" })
        const operation = yield* string(args[0], "operation", action)
        return { action: `file.${operation}`, ...object(yield* record(args[1], action)) } as unknown as NativeActionCallValue
      }
      case "request_external": {
        if (args.length !== 1) return yield* new ProgramActionDecodeFailed({ action, reason: "expects one record argument" })
        return { action: "http.stage", ...object(yield* record(args[0], action)) } as unknown as NativeActionCallValue
      }
      default:
        return yield* unknown(action)
    }
  })

/** Schema decoding applies native defaults before a draft enters admission. */
export const canonicalizeProgramAction = (
  action: string,
  value: unknown
): Effect.Effect<NativeActionCallValue, ProgramActionDecodeFailed> =>
  Schema.decodeUnknown(NativeActionCall)(value).pipe(
    Effect.mapError((error) => new ProgramActionDecodeFailed({ action, reason: error.message }))
  )

const requirement = (planId: PlanId, index: number, need: ResourceNeed) =>
  new ResourceRequirement({
    id: RequirementId.make(`${planId}/requirement/${index}`),
    kind: need.kind,
    realm: need.realm,
    selector: need.selector,
    rights: need.rights
  })

const nodeId = (planId: PlanId, index: number) => NodeId.make(`${planId}/node/${index}`)
const artifactId = (planId: PlanId, index: number) => ArtifactId.make(`${planId}/artifact/${index}`)
const inputArtifactId = (planId: PlanId, name: string) => ArtifactId.make(`${planId}/input/${name}`)

const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const object = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`
}

const bytesDigest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const digestAction = (
  call: NativeActionCallValue,
  artifacts: ReadonlyArray<InlineArtifact>
): Digest =>
  Digest.make(`sha256:${createHash("sha256").update(canonical({
    call,
    artifacts: artifacts
      .map((artifact) => ({
        id: artifact.id,
        digest: bytesDigest(artifact.bytes),
        mediaType: artifact.mediaType,
        provenance: artifact.provenance
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  })).digest("hex")}`)

const actionReference = (call: NativeActionCallValue, callDigest: Digest) =>
  `${call.action}@${callDigest}`

const needKey = (need: ResourceNeed) =>
  `${need.kind}\0${need.realm}\0${need.selector}\0${[...need.rights].sort().join(",")}`

const isCellProfile = (value: string): value is CellProfile =>
  value === "compatibility" || value === "native-contained" || value === "vm-enclosed"

/**
 * Builds one small, inert draft per action call. Inline content is explicit
 * data accompanying the draft; it is not written by the runner and can only
 * reach live state through the executor's admitted Apply implementation.
 */
export const draftForAction = (
  call: NativeActionCallValue,
  sequence: number,
  nowId: string = crypto.randomUUID(),
  availableArtifacts: ReadonlyArray<InlineArtifact> = []
): Effect.Effect<ProgramActionRequest, ProgramActionDecodeFailed> =>
  Effect.gen(function* () {
    const id = PlanId.make(`program/${nowId}/${sequence}`)
    const lowered = yield* lowerNativeAction(call).pipe(
      Effect.mapError((error) => new ProgramActionDecodeFailed({
        action: call.action,
        reason: `${error.field}: ${error.reason}`
      }))
    )
    const baseNeeds = lowered.nodes.flatMap((node) => node.requirements)
    const allNeeds = [...baseNeeds]
    let mergeNeed: ResourceNeed | undefined
    if (call.action === "process.run" && call.cellProfile !== "compatibility") {
      if (!isCellProfile(call.cellProfile)) {
        return yield* new ProgramActionDecodeFailed({
          action: call.action,
          reason: `cellProfile must be compatibility, native-contained, or vm-enclosed`
        })
      }
      // The current contained backend merges a whole private workspace delta.
      // Its Apply authority must therefore name that whole workspace honestly.
      mergeNeed = new ResourceNeed({
        kind: "path",
        realm: call.realm,
        selector: call.cwd,
        rights: ["write"]
      })
      allNeeds.push(mergeNeed)
    }

    const requirements: ResourceRequirement[] = []
    const byNeed = new Map<string, RequirementId>()
    const require = (need: ResourceNeed) => {
      const key = needKey(need)
      const existing = byNeed.get(key)
      if (existing !== undefined) return existing
      const item = requirement(id, requirements.length, need)
      requirements.push(item)
      byNeed.set(key, item.id)
      return item.id
    }
    for (const need of allNeeds) require(need)
    const baseRequirementIds = baseNeeds.map(require)
    const inlineArtifacts: InlineArtifact[] = []
    const nodes: Array<CaptureNode | ApplyNode | InvokeNode | RequestExternalNode> = []

    switch (call.action) {
      case "file.inspect":
      case "file.read":
      case "file.list":
      case "file.glob":
      case "file.stat": {
        const locator = call.action === "file.glob" ? call.root : call.path
        const operation =
          call.action === "file.inspect" ? "inspect" as const
            : call.action === "file.stat" ? "stat" as const
              : call.action === "file.list" ? "list" as const
                : call.action === "file.glob" ? "glob" as const
                  : "read" as const
        nodes.push(new CaptureNode({
          id: nodeId(id, 0),
          dependsOn: [],
          requires: baseRequirementIds,
          produces: [artifactId(id, 0)],
          source: "file",
          locator,
          operation,
          ...(call.action === "file.read" ? { format: call.format } : {}),
          ...(call.action === "file.glob" ? { pattern: call.pattern } : {})
        }))
        break
      }
      case "file.write": {
        const sourceArtifact = call.sourceArtifact ?? inputArtifactId(id, "content")
        if (call.content !== undefined) {
          inlineArtifacts.push(new InlineArtifact({
            id: sourceArtifact,
            bytes: encoder.encode(call.content),
            mediaType: "text/plain; charset=utf-8",
            provenance: "program:inline-content"
          }))
        }
        nodes.push(new ApplyNode({
          id: nodeId(id, 0),
          dependsOn: [],
          requires: baseRequirementIds,
          produces: [artifactId(id, 0)],
          operation: "write",
          target: call.path,
          sourceArtifact
        }))
        break
      }
      case "file.remove":
        nodes.push(new ApplyNode({
          id: nodeId(id, 0),
          dependsOn: [],
          requires: baseRequirementIds,
          produces: [artifactId(id, 0)],
          operation: "remove",
          target: call.path
        }))
        break
      case "file.move":
      case "file.copy":
      case "file.mkdir": {
        const target = call.action === "file.mkdir" ? call.path : call.destination
        nodes.push(new ApplyNode({
          id: nodeId(id, 0),
          dependsOn: [],
          requires: baseRequirementIds,
          produces: [artifactId(id, 0)],
          operation:
            call.action === "file.move" ? "move"
              : call.action === "file.copy" ? "copy"
                : "mkdir",
          target,
          ...(call.action === "file.mkdir"
            ? { parents: call.parents }
            : { source: call.source })
        }))
        break
      }
      case "process.run": {
        if (!isCellProfile(call.cellProfile)) {
          return yield* new ProgramActionDecodeFailed({
            action: call.action,
            reason: "cellProfile must be compatibility, native-contained, or vm-enclosed"
          })
        }
        const produces: ArtifactId[] = []
        const stdoutArtifact = call.stdout === "capture" ? artifactId(id, produces.length) : undefined
        if (stdoutArtifact !== undefined) produces.push(stdoutArtifact)
        const stderrArtifact = call.stderr === "capture" ? artifactId(id, produces.length) : undefined
        if (stderrArtifact !== undefined) produces.push(stderrArtifact)
        const contained = call.cellProfile !== "compatibility"
        const deltaArtifact = contained ? artifactId(id, produces.length) : undefined
        if (deltaArtifact !== undefined) produces.push(deltaArtifact)
        const stdinArtifact =
          call.stdin === "discard" || call.stdin === "inherit"
            ? undefined
            : call.stdin.kind === "artifact"
              ? call.stdin.id
              : inputArtifactId(id, "stdin")
        if (call.stdin !== "discard" && call.stdin !== "inherit" && call.stdin.kind === "text") {
          inlineArtifacts.push(new InlineArtifact({
            id: stdinArtifact!,
            bytes: encoder.encode(call.stdin.value),
            mediaType: "text/plain; charset=utf-8",
            provenance: "program:inline-stdin"
          }))
        }
        const invokeId = nodeId(id, 0)
        nodes.push(new InvokeNode({
          id: invokeId,
          dependsOn: [],
          requires: baseRequirementIds,
          produces,
          executable: call.executable,
          args: call.args,
          cwd: call.cwd,
          env: call.env,
          ...(stdinArtifact === undefined ? {} : { stdin: stdinArtifact }),
          ...(stdoutArtifact === undefined ? {} : { stdoutArtifact }),
          ...(stderrArtifact === undefined ? {} : { stderrArtifact }),
          ...(deltaArtifact === undefined ? {} : { deltaArtifact }),
          stdout: call.stdout,
          stderr: call.stderr,
          outputLimitBytes: call.outputLimitBytes,
          ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
          cellProfile: call.cellProfile
        }))
        if (contained && deltaArtifact !== undefined && mergeNeed !== undefined) {
          nodes.push(new ApplyNode({
            id: nodeId(id, 1),
            dependsOn: [invokeId],
            requires: [require(mergeNeed)],
            produces: [],
            operation: "merge",
            target: call.cwd,
            sourceArtifact: deltaArtifact
          }))
        }
        break
      }
      case "http.stage": {
        let plannedBody = call.body
        if (call.bodyArtifact !== undefined) {
          const matches = availableArtifacts.filter(
            (artifact) => artifact.id === call.bodyArtifact
          )
          if (matches.length !== 1) {
            return yield* new ProgramActionDecodeFailed({
              action: call.action,
              reason: matches.length === 0
                ? `artifact ${call.bodyArtifact} is unavailable in this program run`
                : `artifact ${call.bodyArtifact} is ambiguous in this program run`
            })
          }
          plannedBody = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(matches[0]!.bytes),
            catch: () => new ProgramActionDecodeFailed({
              action: call.action,
              reason: `artifact ${call.bodyArtifact} is not valid UTF-8 for HTTP Outbox v1`
            })
          })
        }
        nodes.push(new RequestExternalNode({
          id: nodeId(id, 0),
          dependsOn: [],
          requires: baseRequirementIds,
          produces: [artifactId(id, 0)],
          method: call.method,
          endpoint: call.endpoint,
          headers: call.headers,
          ...(plannedBody === undefined ? {} : { body: plannedBody }),
          holdMillis: call.holdMillis
        }))
        break
      }
    }
    const referencedIds: ReadonlyArray<ArtifactId> =
      call.action === "file.write" && call.sourceArtifact !== undefined
        ? [call.sourceArtifact]
        : call.action === "process.run" && call.stdin !== "discard" &&
          call.stdin !== "inherit" && call.stdin.kind === "artifact"
          ? [call.stdin.id]
          : call.action === "http.stage" && call.bodyArtifact !== undefined
            ? [call.bodyArtifact]
            : []
    for (const referencedId of referencedIds) {
      if (inlineArtifacts.some((artifact) => artifact.id === referencedId)) continue
      const matches = availableArtifacts.filter((artifact) => artifact.id === referencedId)
      if (matches.length !== 1) {
        return yield* new ProgramActionDecodeFailed({
          action: call.action,
          reason: matches.length === 0
            ? `artifact ${referencedId} is unavailable in this program run`
            : `artifact ${referencedId} is ambiguous in this program run`
        })
      }
      inlineArtifacts.push(matches[0]!)
    }
    const callDigest = digestAction(call, inlineArtifacts)
    const draft = new PlanDraft({
      schemaVersion: "airlock/plan-draft/v1",
      id,
      actionReference: actionReference(call, callDigest),
      nodes,
      requirements,
      definitionDigests: [] as Digest[]
    })
    return new ProgramActionRequest({
      call: new ProgramActionCall({ action: call.action, input: call }),
      callDigest,
      draft,
      inlineArtifacts
    })
  })

const statValue = (stat: NativeStat): LanguageRecord => ({
  path: stat.path,
  kind: stat.kind,
  bytes: stat.bytes,
  mode: stat.mode,
  device: stat.device,
  inode: stat.inode
})

const listEntryValue = (entry: NativeListEntry): LanguageRecord => ({
  name: entry.name,
  stat: statValue(entry.stat)
})

const runtimeArtifactValue = (item: RuntimeArtifact | undefined): LanguageValue =>
  item === undefined
    ? null
    : {
        id: item.artifact.id,
        digest: item.artifact.digest,
        media_type: item.artifact.mediaType,
        byte_length: item.artifact.byteLength,
        provenance: item.artifact.provenance
      }

const decodedText = new TextDecoder()

const actionResult = (
  value: LanguageValue,
  artifacts: ReadonlyArray<InlineArtifact> = []
) => new ProgramActionResult({ value, artifacts: [...artifacts] })

const actionRecord = (
  request: ProgramActionRequest,
  result: ProgramActionResult
) => new ProgramActionRecord({ request, result })

const runtimeInlineArtifacts = (
  run: RuntimeRun
): ReadonlyArray<InlineArtifact> =>
  run.artifacts.map((item) => new InlineArtifact({
    id: item.artifact.id,
    bytes: item.bytes,
    mediaType: item.artifact.mediaType,
    provenance: item.artifact.provenance
  }))

const runtimeRunValue = (
  run: RuntimeRun,
  plan: Plan
): LanguageRecord => {
  const invoke = plan.nodes.find((node): node is InvokeNode => node._tag === "Invoke")
  const byId = new Map(run.artifacts.map((item) => [item.artifact.id, item]))
  const stdout = invoke?.stdoutArtifact === undefined ? undefined : byId.get(invoke.stdoutArtifact)
  const stderr = invoke?.stderrArtifact === undefined ? undefined : byId.get(invoke.stderrArtifact)
  const delta = invoke?.deltaArtifact === undefined ? undefined : byId.get(invoke.deltaArtifact)
  return {
    state: run.state,
    plan_id: run.planId,
    stdout: stdout === undefined ? null : decodedText.decode(stdout.bytes),
    stderr: stderr === undefined ? null : decodedText.decode(stderr.bytes),
    stdout_artifact: runtimeArtifactValue(stdout),
    stderr_artifact: runtimeArtifactValue(stderr),
    delta_artifact: runtimeArtifactValue(delta),
    receipts: run.receipts.map((receipt) => ({
      node_id: receipt.nodeId,
      sequence: receipt.sequence,
      state: receipt.state,
      error_tag: receipt.errorTag ?? null,
      output_artifacts: [...receipt.outputArtifacts]
    }))
  }
}

const inlineArtifact = (
  request: ProgramActionRequest,
  id: ArtifactId
): Effect.Effect<InlineArtifact, ProgramActionExecutionFailed> => {
  const matches = request.inlineArtifacts.filter((candidate) => candidate.id === id)
  if (matches.length !== 1) {
    return Effect.fail(new ProgramActionExecutionFailed({
      action: request.call.action,
      phase: "contract",
      causeTag: "ProgramArtifactUnavailable",
      reason: matches.length === 0
        ? `inline artifact ${id} is unavailable`
        : `inline artifact ${id} is ambiguous`
    }))
  }
  return Effect.succeed(matches[0]!)
}

const validateRuntimeRequest = (
  request: ProgramActionRequest,
  plan: Plan
): Effect.Effect<NativeActionCallValue, ProgramActionExecutionFailed> =>
  Effect.gen(function* () {
    const call = yield* Schema.decodeUnknown(NativeActionCall)(request.call.input).pipe(
      Effect.mapError(executionFailure(request.call.action, "contract"))
    )
    if (request.call.action !== call.action) {
      return yield* new ProgramActionExecutionFailed({
        action: request.call.action,
        phase: "contract",
        causeTag: "ProgramActionMismatch",
        reason: `call tag ${request.call.action} does not match input tag ${call.action}`
      })
    }
    const actualDigest = digestAction(call, request.inlineArtifacts)
    const expectedReference = actionReference(call, actualDigest)
    if (
      request.callDigest !== actualDigest ||
      request.draft.id !== plan.id ||
      request.draft.actionReference !== expectedReference ||
      plan.actionReference !== expectedReference
    ) {
      return yield* new ProgramActionExecutionFailed({
        action: call.action,
        phase: "contract",
        causeTag: "ProgramActionBindingMismatch",
        reason: "the ActionCall is not the call bound into the admitted Plan"
      })
    }
    return call
  })

const captureFor = (
  plan: Plan,
  action: string,
  operation: CaptureNode["operation"]
): Effect.Effect<CaptureNode, ProgramActionExecutionFailed> => {
  const matches = plan.nodes.filter(
    (node): node is CaptureNode => node._tag === "Capture" && node.operation === operation
  )
  return matches.length === 1
    ? Effect.succeed(matches[0]!)
    : Effect.fail(new ProgramActionExecutionFailed({
        action,
        phase: "contract",
        causeTag: "ProgramPlanShapeMismatch",
        reason: `expected exactly one Capture.${operation} node; found ${matches.length}`
      }))
}

const applyFor = (
  plan: Plan,
  action: string,
  operation: ApplyNode["operation"]
): Effect.Effect<ApplyNode, ProgramActionExecutionFailed> => {
  const matches = plan.nodes.filter(
    (node): node is ApplyNode => node._tag === "Apply" && node.operation === operation
  )
  return matches.length === 1
    ? Effect.succeed(matches[0]!)
    : Effect.fail(new ProgramActionExecutionFailed({
        action,
        phase: "contract",
        causeTag: "ProgramPlanShapeMismatch",
        reason: `expected exactly one Apply.${operation} node; found ${matches.length}`
      }))
}

const externalFor = (
  plan: Plan,
  action: string
): Effect.Effect<RequestExternalNode, ProgramActionExecutionFailed> => {
  const matches = plan.nodes.filter(
    (node): node is RequestExternalNode => node._tag === "RequestExternal"
  )
  return matches.length === 1
    ? Effect.succeed(matches[0]!)
    : Effect.fail(new ProgramActionExecutionFailed({
        action,
        phase: "contract",
        causeTag: "ProgramPlanShapeMismatch",
        reason: `expected exactly one RequestExternal node; found ${matches.length}`
      }))
}

/**
 * Trusted Plan adapter. Every native operation and operand is taken from the
 * admitted Plan; the bound ActionCall is used only to select result decoding.
 * Filesystem effects cross NativeFileSystem/Hold, while Invoke and
 * RequestExternal cross the core Runtime. This layer has no direct host I/O.
 */
export const ProgramPlanRuntimeLive = Layer.effect(
  ProgramPlanRuntime,
  Effect.gen(function* () {
    const native = yield* NativeFileSystem
    const runtime = yield* Runtime
    const outbox = yield* Outbox

    const nativeFailure = (action: string) => executionFailure(action, "native-filesystem")

    return ProgramPlanRuntime.of({
      execute: (request, plan) =>
        Effect.gen(function* () {
          const call = yield* validateRuntimeRequest(request, plan)
          switch (call.action) {
            case "file.inspect":
            case "file.stat": {
              const capture = yield* captureFor(
                plan,
                call.action,
                call.action === "file.inspect" ? "inspect" : "stat"
              )
              const stat = yield* native.stat(capture.locator).pipe(Effect.mapError(nativeFailure(call.action)))
              return actionResult(statValue(stat))
            }
            case "file.read": {
              const capture = yield* captureFor(plan, call.action, "read")
              switch (capture.format) {
                case "text":
                  return actionResult(yield* native.readText(capture.locator).pipe(Effect.mapError(nativeFailure(call.action))))
                case "bytes": {
                  const bytes = yield* native.readBytes(capture.locator).pipe(Effect.mapError(nativeFailure(call.action)))
                  return actionResult([...bytes])
                }
                case "json": {
                  const json = yield* native.readJson(capture.locator).pipe(Effect.mapError(nativeFailure(call.action)))
                  const value = yield* Schema.decodeUnknown(LanguageValueSchema)(json).pipe(
                    Effect.mapError(executionFailure(call.action, "contract"))
                  )
                  return actionResult(value)
                }
              }
            }
            case "file.list": {
              const capture = yield* captureFor(plan, call.action, "list")
              const entries = yield* native.list(capture.locator).pipe(Effect.mapError(nativeFailure(call.action)))
              return actionResult(entries.map(listEntryValue))
            }
            case "file.glob": {
              const capture = yield* captureFor(plan, call.action, "glob")
              if (capture.pattern === undefined) {
                return yield* new ProgramActionExecutionFailed({
                  action: call.action,
                  phase: "contract",
                  causeTag: "ProgramPlanShapeMismatch",
                  reason: "Capture.glob has no pattern"
                })
              }
              const matches = yield* native.glob(capture.locator, capture.pattern).pipe(Effect.mapError(nativeFailure(call.action)))
              return actionResult([...matches])
            }
            case "file.write": {
              const apply = yield* applyFor(plan, call.action, "write")
              const sourceId = apply.sourceArtifact
              if (sourceId === undefined) {
                return yield* new ProgramActionExecutionFailed({
                  action: call.action,
                  phase: "contract",
                  causeTag: "ProgramArtifactUnavailable",
                  reason: "file.write has no source artifact"
                })
              }
              const source = yield* inlineArtifact(request, sourceId)
              const applied = yield* native.writeBytes(apply.target, source.bytes).pipe(
                Effect.mapError(nativeFailure(call.action))
              )
              return actionResult({
                state: "applied",
                action: call.action,
                act_id: applied.receipt.id,
                target: applied.receipt.target,
                previous_held: applied.receipt.previousHeld,
                bytes: applied.bytes
              })
            }
            case "file.remove": {
              const apply = yield* applyFor(plan, call.action, "remove")
              const removed = yield* native.remove(apply.target).pipe(Effect.mapError(nativeFailure(call.action)))
              return actionResult({
                state: "applied",
                action: call.action,
                act_id: removed.id,
                target: removed.target,
                kind: removed.kind
              })
            }
            case "file.copy": {
              const apply = yield* applyFor(plan, call.action, "copy")
              if (apply.source === undefined) {
                return yield* new ProgramActionExecutionFailed({
                  action: call.action,
                  phase: "contract",
                  causeTag: "ProgramPlanShapeMismatch",
                  reason: "Apply.copy has no source"
                })
              }
              const copied = yield* native.copy(apply.source, apply.target).pipe(
                Effect.mapError(nativeFailure(call.action))
              )
              return actionResult({
                state: "applied",
                action: call.action,
                act_id: copied.receipt.id,
                source: apply.source,
                target: copied.receipt.target,
                previous_held: copied.receipt.previousHeld,
                bytes: copied.bytes
              })
            }
            case "file.move": {
              const apply = yield* applyFor(plan, call.action, "move")
              if (apply.source === undefined) {
                return yield* new ProgramActionExecutionFailed({
                  action: call.action,
                  phase: "contract",
                  causeTag: "ProgramPlanShapeMismatch",
                  reason: "Apply.move has no source"
                })
              }
              const moved = yield* native.move(apply.source, apply.target).pipe(
                Effect.mapError(nativeFailure(call.action))
              )
              return actionResult({
                state: "applied",
                action: call.action,
                install_act_id: moved.install.receipt.id,
                remove_act_id: moved.sourceRemoval.id,
                source: moved.sourceRemoval.target,
                target: moved.install.receipt.target
              })
            }
            case "file.mkdir": {
              const apply = yield* applyFor(plan, call.action, "mkdir")
              const made = yield* native.mkdir(apply.target, { parents: apply.parents }).pipe(
                Effect.mapError(nativeFailure(call.action))
              )
              return actionResult({
                state: "applied",
                action: call.action,
                path: made.path,
                act_ids: made.installs.map((install) => install.receipt.id)
              })
            }
            case "process.run": {
              const inputs = request.inlineArtifacts.map((input) => new RuntimeInitialArtifact({
                id: input.id,
                bytes: input.bytes,
                mediaType: input.mediaType,
                provenance: input.provenance
              }))
              const run = yield* runtime.execute(plan, inputs).pipe(
                Effect.mapError(executionFailure(call.action, "runtime"))
              )
              const outputs = runtimeInlineArtifacts(run)
              return actionResult(runtimeRunValue(run, plan), outputs)
            }
            case "http.stage": {
              const external = yield* externalFor(plan, call.action)
              if (external.bodyArtifact !== undefined) {
                return yield* new ProgramActionExecutionFailed({
                  action: call.action,
                  phase: "contract",
                  causeTag: "ProgramPlanShapeMismatch",
                  reason: "program lowering must freeze the artifact-backed body into RequestExternal.body"
                })
              }
              const staged = yield* outbox.stage(new HttpExternalIntent({
                url: external.endpoint,
                method: external.method,
                headers: external.headers,
                ...(external.body === undefined ? {} : { body: external.body })
              }), external.holdMillis).pipe(
                Effect.mapError(executionFailure(call.action, "outbox"))
              )
              return actionResult({
                state: staged.status,
                action: call.action,
                emission_id: staged.id,
                method: external.method,
                endpoint: external.endpoint,
                hold_millis: external.holdMillis,
              })
            }
          }
        })
    })
  })
)

/**
 * Convenience composition for one managed application runtime. Platform
 * dependencies remain requirements of this layer; callers provide exactly one
 * NativeFileSystem, Runtime, and Outbox implementation.
 */
export const ProgramExecutionLive = (policy: AdmissionPolicy) => {
  const executor = ProgramPlanExecutorLive.pipe(
    Layer.provideMerge(ProgramAdmissionLive(policy)),
    Layer.provideMerge(ProgramPlanRuntimeLive)
  )
  return ProgramRunnerLive.pipe(Layer.provide(executor))
}

const dottedName = (expression: Expression): string | undefined => {
  if (expression.kind === "IdentifierExpression") return expression.name
  if (expression.kind !== "FieldExpression") return undefined
  const prefix = dottedName(expression.object)
  return prefix === undefined ? undefined : `${prefix}.${expression.field}`
}

const normalizeExpression = (expression: Expression): Expression => {
  switch (expression.kind) {
    case "CallExpression": {
      const dotted = dottedName(expression.callee)
      const callee = dotted !== undefined && nativeNames.has(dotted as NativeActionName)
        ? { kind: "IdentifierExpression" as const, name: dotted, span: expression.callee.span }
        : normalizeExpression(expression.callee)
      return { ...expression, callee, arguments: expression.arguments.map(normalizeExpression) }
    }
    case "ListExpression": return { ...expression, items: expression.items.map(normalizeExpression) }
    case "RecordExpression": return { ...expression, entries: expression.entries.map((entry) => ({ ...entry, value: normalizeExpression(entry.value) })) }
    case "UnaryExpression": return { ...expression, operand: normalizeExpression(expression.operand) }
    case "BinaryExpression": return { ...expression, left: normalizeExpression(expression.left), right: normalizeExpression(expression.right) }
    case "FieldExpression": return { ...expression, object: normalizeExpression(expression.object) }
    case "IndexExpression": return { ...expression, object: normalizeExpression(expression.object), index: normalizeExpression(expression.index) }
    default: return expression
  }
}

const normalizeStatement = (statement: Statement): Statement => {
  switch (statement.kind) {
    case "LetStatement": return { ...statement, value: normalizeExpression(statement.value) }
    case "ExpressionStatement": return { ...statement, expression: normalizeExpression(statement.expression) }
    case "ReturnStatement": return { ...statement, ...(statement.value === undefined ? {} : { value: normalizeExpression(statement.value) }) }
    case "AssertStatement": return { ...statement, test: normalizeExpression(statement.test), ...(statement.message === undefined ? {} : { message: normalizeExpression(statement.message) }) }
    case "IfStatement": return { ...statement, test: normalizeExpression(statement.test), consequent: statement.consequent.map(normalizeStatement), ...(statement.alternate === undefined ? {} : { alternate: statement.alternate.map(normalizeStatement) }) }
    case "ForStatement": return { ...statement, from: normalizeExpression(statement.from), to: normalizeExpression(statement.to), body: statement.body.map(normalizeStatement) }
  }
}

/** Supports dotted native verbs without giving the language a reflective call surface. */
export const normalizeProgramActions = (program: Program): Program => ({ ...program, body: program.body.map(normalizeStatement) })

const runProgram = (executor: {
  readonly execute: (request: ProgramActionRequest) => Effect.Effect<ProgramActionResult, ProgramActionExecutionFailed>
}) =>
  (request: ProgramRequest): Effect.Effect<ProgramRunResult, ProgramError> =>
    Effect.gen(function* () {
      const parsed = yield* parse(request.source)
      const plans: PlanDraft[] = []
      const artifacts = new Map<ArtifactId, InlineArtifact>()
      for (const input of request.artifacts) {
        if (artifacts.has(input.id)) {
          return yield* new ProgramActionDecodeFailed({
            action: "program",
            reason: `duplicate input artifact ${input.id}`
          })
        }
        artifacts.set(input.id, input)
      }
      let sequence = 0
      const actions: ProgramActionRecord[] = []
      const failureFromCause = (cause: unknown): ProgramRunFailure => {
        if (cause instanceof ProgramActionExecutionFailed) {
          return new ProgramRunFailure({
            action: cause.action,
            phase: cause.phase,
            ...(cause.causeTag === undefined ? {} : { causeTag: cause.causeTag }),
            reason: cause.reason
          })
        }
        if (cause instanceof ProgramActionDecodeFailed) {
          return new ProgramRunFailure({
            action: cause.action,
            phase: "contract",
            causeTag: cause._tag,
            reason: cause.reason
          })
        }
        if (cause instanceof UnknownProgramAction) {
          return new ProgramRunFailure({
            action: cause.action,
            phase: "contract",
            causeTag: cause._tag,
            reason: `unknown action ${cause.action}`
          })
        }
        if (cause instanceof LanguageDiagnostic) {
          return new ProgramRunFailure({
            action: "program",
            phase: "language",
            causeTag: cause._tag,
            reason: cause.detail
          })
        }
        const tag = causeTag(cause)
        return new ProgramRunFailure({
          action: "program",
          phase: "language",
          ...(tag === undefined ? {} : { causeTag: tag }),
          reason: causeReason(cause)
        })
      }
      const resolver: ActionResolver<never, UnknownProgramAction | ProgramActionDecodeFailed | ProgramActionExecutionFailed> = {
        resolve: (action, args) => Effect.gen(function* () {
          const decoded = yield* decodeProgramAction(action, args)
          const call = yield* canonicalizeProgramAction(action, decoded)
          const next = yield* draftForAction(
            call,
            sequence++,
            crypto.randomUUID(),
            [...artifacts.values()]
          )
          plans.push(next.draft)
          for (const input of next.inlineArtifacts) artifacts.set(input.id, input)
          const executed = yield* executor.execute(next)
          for (const output of executed.artifacts) artifacts.set(output.id, output)
          actions.push(actionRecord(next, executed))
          return executed.value
        })
      }
      const evaluation = yield* evaluate(normalizeProgramActions(parsed), resolver, {
        ...(request.maxLoopIterations === undefined ? {} : { maxLoopIterations: request.maxLoopIterations }),
        bindings: request.bindings
      }).pipe(Effect.either)
      if (evaluation._tag === "Left") {
        const failure = failureFromCause(evaluation.left)
        return new ProgramRunResult({
          state: actions.length > 0 ? "partial" : "failed",
          result: null,
          plans,
          actions,
          artifacts: [...artifacts.values()],
          failure
        })
      }
      return new ProgramRunResult({
        state: "succeeded",
        result: evaluation.right.value,
        plans,
        actions,
        artifacts: [...artifacts.values()]
      })
    })

export const ProgramRunnerLive = Layer.effect(
  ProgramRunner,
  Effect.gen(function* () {
    const executor = yield* ProgramActionExecutor
    return ProgramRunner.of({
      run: runProgram(executor)
    })
  })
)
