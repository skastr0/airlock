import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import {
  admit,
  AdmissionPolicy,
  bindAdmissionForUse,
  type ExecutionAuthority
} from "../admission/index.ts"
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
  NativeListEntry,
  NativeMkdirReceipt,
  NativeMoveReceipt,
  NativeStat,
  NativeWriteReceipt
} from "../native/index.ts"
import { OutboxEmission } from "../Outbox.ts"
import { RemoveReceipt } from "../domain.ts"
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
  RuntimeRecoveryEvidence,
  RuntimeRun
} from "../runtime/index.ts"
import {
  ExportedToolAction,
  ToolActionLoweringRequest,
  decodeToolResult,
  exportedToolActionName,
  lowerToolAction
} from "../tools/index.ts"

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

/** Immutable definition facts bound into the request digest and Plan draft. */
export class ProgramToolBinding extends Schema.Class<ProgramToolBinding>("ProgramToolBinding")({
  name: Schema.String,
  definitionId: Schema.String,
  definitionDigest: Digest,
  resultDecoder: Schema.Literal("exit-status", "json-stdout", "json-stderr", "none"),
  outputSchema: Schema.optional(Schema.Unknown)
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
  inlineArtifacts: Schema.Array(InlineArtifact),
  tool: Schema.optional(ProgramToolBinding)
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
  reason: Schema.String,
  runtime: Schema.optional(RuntimeRun)
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
    reason: Schema.String,
    runtime: Schema.optional(RuntimeRun)
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

/**
 * Admission adapter: a bare Plan is deliberately not part of this seam.
 * Grants and resolved handles remain attached through execution.
 */
export class ProgramAdmission extends Context.Tag("airlock/ProgramAdmission")<
  ProgramAdmission,
  {
    readonly admit: (
      draft: PlanDraft
    ) => Effect.Effect<ExecutionAuthority, ProgramActionExecutionFailed>
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
      authority: ExecutionAuthority
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
  phase: ProgramActionExecutionFailed["phase"],
  runtime?: RuntimeRun
) => (cause: unknown) =>
  new ProgramActionExecutionFailed({
    action,
    phase,
    ...(runtime === undefined ? {} : { runtime }),
    ...(causeTag(cause) === undefined ? {} : { causeTag: causeTag(cause) }),
    reason: causeReason(cause)
  })

const runtimeExecutionFailure = (
  action: string,
  runtime: RuntimeRun,
  phase: ProgramActionExecutionFailed["phase"],
  reason: string,
  causeTag?: string
) =>
  new ProgramActionExecutionFailed({
    action,
    phase,
    ...(causeTag === undefined ? {} : { causeTag }),
    reason,
    runtime
  })

/**
 * Admission remains its own typed seam. This layer only adapts the richer
 * Admission error vocabulary to the language-facing execution boundary.
 */
export const ProgramAdmissionLive = (policy: AdmissionPolicy) =>
  Layer.succeed(ProgramAdmission, ProgramAdmission.of({
    admit: (draft) => admit(draft, policy).pipe(
      Effect.flatMap((result) => bindAdmissionForUse(result)),
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
        Effect.flatMap((authority) => runtime.execute(request, authority))
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
const decodeStrictNativeActionCall = Schema.decodeUnknown(NativeActionCall, {
  onExcessProperty: "error"
})

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

const isDurationValue = (
  value: unknown
): value is { readonly kind: "Duration"; readonly value: number; readonly unit: "ms" | "s" | "m" | "h" | "d" } =>
  typeof value === "object" && value !== null &&
  !Array.isArray(value) &&
  (value as { readonly kind?: unknown }).kind === "Duration" &&
  typeof (value as { readonly value?: unknown }).value === "number" &&
  typeof (value as { readonly unit?: unknown }).unit === "string"

const durationMillis = (
  duration: { readonly kind: "Duration"; readonly value: number; readonly unit: "ms" | "s" | "m" | "h" | "d" }
) => {
  const factor: Record<typeof duration.unit, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  }
  return duration.value * factor[duration.unit]
}

const strictNativeAction = (
  action: string,
  value: unknown
): Effect.Effect<NativeActionCallValue, ProgramActionDecodeFailed> =>
  decodeStrictNativeActionCall(value).pipe(
    Effect.mapError((error) => new ProgramActionDecodeFailed({ action, reason: error.message }))
  )

const normalizeProcessRunInput = (
  action: string,
  input: LanguageRecord
): Effect.Effect<Record<string, unknown>, ProgramActionDecodeFailed> =>
  Effect.gen(function* () {
    const { timeout, timeoutMs, stdin, ...rest } = object(input)
    if (timeout !== undefined && timeoutMs !== undefined) {
      return yield* new ProgramActionDecodeFailed({
        action,
        reason: "timeout and timeoutMs are mutually exclusive"
      })
    }
    const normalized: Record<string, unknown> = { ...rest }
    if (stdin !== undefined) normalized.stdin = stdin === null ? "discard" : stdin
    if (timeout !== undefined) {
      if (!isDurationValue(timeout)) {
        return yield* new ProgramActionDecodeFailed({
          action,
          reason: "timeout must be a Duration"
        })
      }
      normalized.timeoutMs = durationMillis(timeout)
    } else if (timeoutMs !== undefined) {
      normalized.timeoutMs = timeoutMs
    }
    return normalized
  })

const normalizeRequestExternalInput = (
  action: string,
  input: LanguageRecord
): Effect.Effect<Record<string, unknown>, ProgramActionDecodeFailed> =>
  Effect.gen(function* () {
    const { hold, holdMillis, body, ...rest } = object(input)
    if (hold !== undefined && holdMillis !== undefined) {
      return yield* new ProgramActionDecodeFailed({
        action,
        reason: "hold and holdMillis are mutually exclusive"
      })
    }
    const normalized: Record<string, unknown> = { ...rest }
    if (hold !== undefined) {
      if (!isDurationValue(hold)) {
        return yield* new ProgramActionDecodeFailed({
          action,
          reason: "hold must be a Duration"
        })
      }
      normalized.holdMillis = durationMillis(hold)
    } else if (holdMillis !== undefined) {
      normalized.holdMillis = holdMillis
    }
    if (body !== undefined) normalized.body = canonical(body)
    return normalized
  })

/** Decode compact language aliases into the canonical native action vocabulary. */
export const decodeProgramAction = (
  action: string,
  args: readonly LanguageValue[]
): Effect.Effect<NativeActionCallValue, UnknownProgramAction | ProgramActionDecodeFailed> =>
  Effect.gen(function* () {
    if (nativeNames.has(action as NativeActionName)) {
      if (args.length !== 1) return yield* new ProgramActionDecodeFailed({ action, reason: "expects exactly one record argument" })
      const input = yield* record(args[0], action)
      return yield* strictNativeAction(action, { ...object(input), action })
    }
    switch (action) {
      case "run": {
        if (args.length === 1) {
          if (typeof args[0] === "string") {
            return yield* strictNativeAction(action, {
              action: "process.run",
              executable: args[0],
              args: []
            })
          }
          const input = yield* record(args[0], action)
          const normalized = yield* normalizeProcessRunInput(action, input)
          return yield* strictNativeAction(action, { ...normalized, action: "process.run" })
        }
        if (args.length < 1 || args.length > 3) {
          return yield* new ProgramActionDecodeFailed({ action, reason: "expects run(executable, args?, options?)" })
        }
        const executable = yield* string(args[0], "executable", action)
        let runArgs: string[] = []
        let options: LanguageRecord | undefined
        if (args[1] !== undefined) {
          if (Array.isArray(args[1])) {
            runArgs = yield* asStringList(args[1], "args", action)
            if (args[2] !== undefined) {
              options = yield* record(args[2], action)
            }
          } else {
            if (args[2] !== undefined) {
              return yield* new ProgramActionDecodeFailed({ action, reason: "expects run(executable, args?, options?)" })
            }
            options = yield* record(args[1], action)
          }
        }
        const normalized = options === undefined
          ? {}
          : yield* normalizeProcessRunInput(action, options)
        return yield* strictNativeAction(action, {
          ...normalized,
          action: "process.run",
          executable,
          args: runArgs
        })
      }
      case "capture": {
        if (args.length !== 1) return yield* new ProgramActionDecodeFailed({ action, reason: "expects capture(path | { path, format? })" })
        if (typeof args[0] === "string") {
          return yield* strictNativeAction(action, { action: "file.read", path: args[0] })
        }
        const input = yield* record(args[0], action)
        return yield* strictNativeAction(action, { ...object(input), action: "file.read" })
      }
      case "apply": {
        if (args.length === 1) {
          const input = yield* record(args[0], action)
          const operation = yield* string(input.operation, "operation", action)
          const { operation: _, ...rest } = object(input)
          return yield* strictNativeAction(action, { ...rest, action: `file.${operation}` })
        }
        if (args.length !== 2) return yield* new ProgramActionDecodeFailed({ action, reason: "expects apply(operation, record)" })
        const operation = yield* string(args[0], "operation", action)
        return yield* strictNativeAction(action, {
          ...object(yield* record(args[1], action)),
          action: `file.${operation}`
        })
      }
      case "request_external": {
        if (args.length !== 1) return yield* new ProgramActionDecodeFailed({ action, reason: "expects one record argument" })
        const input = yield* record(args[0], action)
        const normalized = yield* normalizeRequestExternalInput(action, input)
        return yield* strictNativeAction(action, { ...normalized, action: "http.stage" })
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
  strictNativeAction(action, value)

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
  artifacts: ReadonlyArray<InlineArtifact>,
  tool?: ProgramToolBinding
): Digest =>
  Digest.make(`sha256:${createHash("sha256").update(canonical({
    call,
    ...(tool === undefined ? {} : { tool: {
      name: tool.name,
      definitionId: tool.definitionId,
      definitionDigest: tool.definitionDigest,
      resultDecoder: tool.resultDecoder,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema })
    } }),
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
          descendantExecutables: call.descendantExecutables,
          cwd: call.cwd,
          env: call.env,
          ...(stdinArtifact === undefined ? {} : { stdin: stdinArtifact }),
          stdinDisposition: call.stdin === "inherit" ? "inherit" : "discard",
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

const oneDeclaredExecutable = (
  exported: ExportedToolAction
): Effect.Effect<string, ProgramActionDecodeFailed> => {
  const selectors = [
    ...new Set(
      exported.loaded.definition.executables
        .filter((entry) => entry.role === "root")
        .map((entry) => entry.selector)
    )
  ]
  return selectors.length === 1 && selectors[0]!.startsWith("/")
    ? Effect.succeed(selectors[0]!)
    : Effect.fail(new ProgramActionDecodeFailed({
      action: exportedToolActionName(exported.loaded.definition, exported.action),
      reason: "definition action requires exactly one declared absolute executable"
    }))
}

const draftForToolAction = (
  exported: ExportedToolAction,
  cellProfile: CellProfile,
  args: readonly LanguageValue[],
  sequence: number,
  nowId: string,
  availableArtifacts: ReadonlyArray<InlineArtifact>
): Effect.Effect<ProgramActionRequest, ProgramActionDecodeFailed> =>
  Effect.gen(function* () {
    const name = exportedToolActionName(exported.loaded.definition, exported.action)
    if (args.length !== 1) {
      return yield* new ProgramActionDecodeFailed({ action: name, reason: "expects exactly one record argument" })
    }
    const input = yield* record(args[0], name)
    const executable = yield* oneDeclaredExecutable(exported)
    const lowered = yield* lowerToolAction(new ToolActionLoweringRequest({
      loaded: exported.loaded,
      action: exported.action.name,
      input: object(input),
      executable,
      cellProfile
    })).pipe(Effect.mapError((error) => new ProgramActionDecodeFailed({ action: name, reason: error.message ?? error._tag })))
    const base = yield* draftForAction(lowered.call, sequence, nowId, availableArtifacts)
    const tool = new ProgramToolBinding({
      name,
      definitionId: lowered.definitionId,
      definitionDigest: lowered.definitionDigest,
      resultDecoder: lowered.resultDecoder,
      ...(exported.action.outputSchema === undefined ? {} : { outputSchema: exported.action.outputSchema })
    })
    const callDigest = digestAction(lowered.call, base.inlineArtifacts, tool)
    const draft = new PlanDraft({
      ...base.draft,
      actionReference: `${name}@${callDigest}`,
      definitionDigests: [lowered.definitionDigest]
    })
    return new ProgramActionRequest({
      call: new ProgramActionCall({ action: name, input: lowered.call }),
      callDigest,
      draft,
      inlineArtifacts: base.inlineArtifacts,
      tool
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
const strictDecodedText = new TextDecoder("utf-8", { fatal: true })

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
  const processEvidence = invoke === undefined
    ? undefined
    : run.processes.find((candidate) => candidate.nodeId === invoke.id)
  const byId = new Map(run.artifacts.map((item) => [item.artifact.id, item]))
  const stdout = invoke?.stdoutArtifact === undefined ? undefined : byId.get(invoke.stdoutArtifact)
  const stderr = invoke?.stderrArtifact === undefined ? undefined : byId.get(invoke.stderrArtifact)
  const delta = invoke?.deltaArtifact === undefined ? undefined : byId.get(invoke.deltaArtifact)
  const recovery = Schema.decodeUnknownSync(LanguageValueSchema)(
    Schema.encodeSync(Schema.Array(RuntimeRecoveryEvidence))(run.recovery)
  )
  return {
    state: run.state,
    plan_id: run.planId,
    process_outcome: processEvidence?.outcome ?? null,
    exit_code: processEvidence?.receipt.exitCode ?? null,
    signal: processEvidence?.receipt.signal ?? null,
    stdout: stdout === undefined ? null : decodedText.decode(stdout.bytes),
    stderr: stderr === undefined ? null : decodedText.decode(stderr.bytes),
    stdout_artifact: runtimeArtifactValue(stdout),
    stderr_artifact: runtimeArtifactValue(stderr),
    delta_artifact: runtimeArtifactValue(delta),
    recovery,
    receipts: run.receipts.map((receipt) => ({
      node_id: receipt.nodeId,
      sequence: receipt.sequence,
      state: receipt.state,
      error_tag: receipt.errorTag ?? null,
      output_artifacts: [...receipt.outputArtifacts]
    }))
  }
}

const runtimeArtifact = (
  run: RuntimeRun,
  node: CaptureNode | ApplyNode | RequestExternalNode,
  action: string
): Effect.Effect<RuntimeArtifact, ProgramActionExecutionFailed> => {
  if (node.produces.length !== 1) {
    return Effect.fail(runtimeExecutionFailure(
      action,
      run,
      "contract",
      `${node._tag} ${node.id} must declare exactly one result artifact`,
      "ProgramPlanShapeMismatch"
    ))
  }
  const id = node.produces[0]!
  const matches = run.artifacts.filter((candidate) => candidate.artifact.id === id)
  return matches.length === 1
    ? Effect.succeed(matches[0]!)
    : Effect.fail(runtimeExecutionFailure(
        action,
        run,
        "runtime",
        matches.length === 0
          ? `runtime did not materialize ${id}`
          : `runtime materialized ${id} more than once`,
        "ProgramRuntimeArtifactUnavailable"
      ))
}

const decodeRuntimeJson = <A, I>(
  run: RuntimeRun,
  item: RuntimeArtifact,
  schema: Schema.Schema<A, I, never>,
  action: string
): Effect.Effect<A, ProgramActionExecutionFailed> =>
  Effect.try({
    try: () => strictDecodedText.decode(item.bytes),
    catch: (cause) => executionFailure(action, "contract", run)(cause)
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decode(Schema.parseJson(schema))(json).pipe(
        Effect.mapError(executionFailure(action, "contract", run))
      )
    )
  )

const failedRuntimeReceipt = (run: RuntimeRun) =>
  run.receipts.find((receipt) => receipt.state === "failed")

const requireSuccessfulRuntime = (
  run: RuntimeRun,
  action: string
): Effect.Effect<void, ProgramActionExecutionFailed> => {
  if (run.state === "succeeded") return Effect.void
  const failed = failedRuntimeReceipt(run)
  return Effect.fail(runtimeExecutionFailure(
    action,
    run,
    "runtime",
    failed === undefined
      ? `runtime finished ${run.state} without a failed node receipt`
      : `runtime node ${failed.nodeId} finished ${failed.state}`,
    failed?.errorTag ?? "ProgramRuntimeFailed"
  ))
}

const processEvidence = (
  run: RuntimeRun,
  plan: Plan,
  action: string
) => {
  const invokes = plan.nodes.filter(
    (node): node is InvokeNode => node._tag === "Invoke"
  )
  if (invokes.length !== 1) {
    return Effect.fail(runtimeExecutionFailure(
      action,
      run,
      "contract",
      `expected exactly one Invoke node; found ${invokes.length}`,
      "ProgramPlanShapeMismatch"
    ))
  }
  const matches = run.processes.filter(
    (candidate) => candidate.nodeId === invokes[0]!.id
  )
  return matches.length === 1
    ? Effect.succeed({ invoke: invokes[0]!, evidence: matches[0]! })
    : Effect.fail(runtimeExecutionFailure(
        action,
        run,
        "runtime",
        `expected exactly one process receipt for ${invokes[0]!.id}; found ${matches.length}`,
        "ProgramProcessEvidenceUnavailable"
      ))
}

const toolRuntimeIsDecodable = (
  run: RuntimeRun,
  invoke: InvokeNode
) =>
  run.receipts.every((receipt) =>
    receipt.state === "succeeded" ||
    (
      receipt.nodeId === invoke.id &&
      receipt.state === "failed" &&
      receipt.errorTag === "RuntimeProcessFailure"
    ) ||
    (
      receipt.state === "cancelled" &&
      receipt.errorTag === "RuntimeDependencyFailed"
    )
  )

const validateRuntimeRequest = (
  request: ProgramActionRequest,
  plan: Plan
): Effect.Effect<NativeActionCallValue, ProgramActionExecutionFailed> =>
  Effect.gen(function* () {
    const call = yield* Schema.decodeUnknown(NativeActionCall)(request.call.input).pipe(
      Effect.mapError(executionFailure(request.call.action, "contract"))
    )
    if (request.tool === undefined && request.call.action !== call.action) {
      return yield* new ProgramActionExecutionFailed({
        action: request.call.action,
        phase: "contract",
        causeTag: "ProgramActionMismatch",
        reason: `call tag ${request.call.action} does not match input tag ${call.action}`
      })
    }
    if (request.tool !== undefined && request.call.action !== request.tool.name) {
      return yield* new ProgramActionExecutionFailed({
        action: request.call.action,
        phase: "contract",
        causeTag: "ProgramToolBindingMismatch",
        reason: "the tool action name does not match its bound definition facts"
      })
    }
    const actualDigest = digestAction(call, request.inlineArtifacts, request.tool)
    const expectedReference = `${request.tool?.name ?? call.action}@${actualDigest}`
    if (
      request.callDigest !== actualDigest ||
      request.draft.id !== plan.id ||
      request.draft.actionReference !== expectedReference ||
      plan.actionReference !== expectedReference ||
      (request.tool !== undefined && !plan.definitionDigests.includes(request.tool.definitionDigest))
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
  run: RuntimeRun,
  plan: Plan,
  action: string,
  operation: CaptureNode["operation"]
): Effect.Effect<CaptureNode, ProgramActionExecutionFailed> => {
  const matches = plan.nodes.filter(
    (node): node is CaptureNode => node._tag === "Capture" && node.operation === operation
  )
  return matches.length === 1
    ? Effect.succeed(matches[0]!)
    : Effect.fail(runtimeExecutionFailure(
        action,
        run,
        "contract",
        `expected exactly one Capture.${operation} node; found ${matches.length}`,
        "ProgramPlanShapeMismatch"
      ))
}

const applyFor = (
  run: RuntimeRun,
  plan: Plan,
  action: string,
  operation: ApplyNode["operation"]
): Effect.Effect<ApplyNode, ProgramActionExecutionFailed> => {
  const matches = plan.nodes.filter(
    (node): node is ApplyNode => node._tag === "Apply" && node.operation === operation
  )
  return matches.length === 1
    ? Effect.succeed(matches[0]!)
    : Effect.fail(runtimeExecutionFailure(
        action,
        run,
        "contract",
        `expected exactly one Apply.${operation} node; found ${matches.length}`,
        "ProgramPlanShapeMismatch"
      ))
}

const externalFor = (
  run: RuntimeRun,
  plan: Plan,
  action: string
): Effect.Effect<RequestExternalNode, ProgramActionExecutionFailed> => {
  const matches = plan.nodes.filter(
    (node): node is RequestExternalNode => node._tag === "RequestExternal"
  )
  return matches.length === 1
    ? Effect.succeed(matches[0]!)
    : Effect.fail(runtimeExecutionFailure(
        action,
        run,
        "contract",
        `expected exactly one RequestExternal node; found ${matches.length}`,
        "ProgramPlanShapeMismatch"
      ))
}

/**
 * Trusted Plan adapter. Every native operation and operand is taken from the
 * admitted Plan; the bound ActionCall is used only to select result decoding.
 * Runtime is the sole Plan interpreter and terminal-authority path. This layer
 * has no filesystem, process, Hold, Outbox, or network service.
 */
export const ProgramPlanRuntimeLive = Layer.effect(
  ProgramPlanRuntime,
  Effect.gen(function* () {
    const runtime = yield* Runtime

    return ProgramPlanRuntime.of({
      execute: (request, requestedAuthority) =>
        Effect.gen(function* () {
          const authority = requestedAuthority
          const plan = authority.admission.plan
          const call = yield* validateRuntimeRequest(request, plan)
          const inputs = request.inlineArtifacts.map((input) => new RuntimeInitialArtifact({
            id: input.id,
            bytes: input.bytes,
            mediaType: input.mediaType,
            provenance: input.provenance
          }))
          const run = yield* runtime.execute(authority, inputs).pipe(
            Effect.mapError(executionFailure(call.action, "runtime"))
          )
          const outputs = runtimeInlineArtifacts(run)

          switch (call.action) {
            case "file.inspect":
            case "file.stat": {
              yield* requireSuccessfulRuntime(run, call.action)
              const capture = yield* captureFor(
                run,
                plan,
                call.action,
                call.action === "file.inspect" ? "inspect" : "stat"
              )
              const result = yield* runtimeArtifact(run, capture, call.action)
              const stat = yield* decodeRuntimeJson(run, result, NativeStat, call.action)
              return actionResult(statValue(stat))
            }
            case "file.read": {
              yield* requireSuccessfulRuntime(run, call.action)
              const capture = yield* captureFor(run, plan, call.action, "read")
              const result = yield* runtimeArtifact(run, capture, call.action)
              switch (capture.format) {
                case "text": return actionResult(yield* Effect.try({
                  try: () => strictDecodedText.decode(result.bytes),
                  catch: executionFailure(call.action, "contract", run)
                }))
                case "bytes": return actionResult([...result.bytes])
                case "json": return actionResult(
                  yield* decodeRuntimeJson(run, result, LanguageValueSchema, call.action)
                )
              }
            }
            case "file.list": {
              yield* requireSuccessfulRuntime(run, call.action)
              const capture = yield* captureFor(run, plan, call.action, "list")
              const result = yield* runtimeArtifact(run, capture, call.action)
              const entries = yield* decodeRuntimeJson(
                run,
                result,
                Schema.Array(NativeListEntry),
                call.action
              )
              return actionResult(entries.map(listEntryValue))
            }
            case "file.glob": {
              yield* requireSuccessfulRuntime(run, call.action)
              const capture = yield* captureFor(run, plan, call.action, "glob")
              if (capture.pattern === undefined) {
                return yield* runtimeExecutionFailure(
                  call.action,
                  run,
                  "contract",
                  "Capture.glob has no pattern",
                  "ProgramPlanShapeMismatch"
                )
              }
              const result = yield* runtimeArtifact(run, capture, call.action)
              const matches = yield* decodeRuntimeJson(
                run,
                result,
                Schema.Array(Schema.String),
                call.action
              )
              return actionResult([...matches])
            }
            case "file.write": {
              yield* requireSuccessfulRuntime(run, call.action)
              const apply = yield* applyFor(run, plan, call.action, "write")
              const result = yield* runtimeArtifact(run, apply, call.action)
              const applied = yield* decodeRuntimeJson(
                run,
                result,
                NativeWriteReceipt,
                call.action
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
              yield* requireSuccessfulRuntime(run, call.action)
              const apply = yield* applyFor(run, plan, call.action, "remove")
              const result = yield* runtimeArtifact(run, apply, call.action)
              const removed = yield* decodeRuntimeJson(
                run,
                result,
                RemoveReceipt,
                call.action
              )
              return actionResult({
                state: "applied",
                action: call.action,
                act_id: removed.id,
                target: removed.target,
                kind: removed.kind
              })
            }
            case "file.copy": {
              yield* requireSuccessfulRuntime(run, call.action)
              const apply = yield* applyFor(run, plan, call.action, "copy")
              if (apply.source === undefined) {
                return yield* runtimeExecutionFailure(
                  call.action,
                  run,
                  "contract",
                  "Apply.copy has no source",
                  "ProgramPlanShapeMismatch"
                )
              }
              const result = yield* runtimeArtifact(run, apply, call.action)
              const copied = yield* decodeRuntimeJson(
                run,
                result,
                NativeWriteReceipt,
                call.action
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
              yield* requireSuccessfulRuntime(run, call.action)
              const apply = yield* applyFor(run, plan, call.action, "move")
              if (apply.source === undefined) {
                return yield* runtimeExecutionFailure(
                  call.action,
                  run,
                  "contract",
                  "Apply.move has no source",
                  "ProgramPlanShapeMismatch"
                )
              }
              const result = yield* runtimeArtifact(run, apply, call.action)
              const moved = yield* decodeRuntimeJson(
                run,
                result,
                NativeMoveReceipt,
                call.action
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
              yield* requireSuccessfulRuntime(run, call.action)
              const apply = yield* applyFor(run, plan, call.action, "mkdir")
              const result = yield* runtimeArtifact(run, apply, call.action)
              const made = yield* decodeRuntimeJson(
                run,
                result,
                NativeMkdirReceipt,
                call.action
              )
              return actionResult({
                state: "applied",
                action: call.action,
                path: made.path,
                act_ids: made.installs.map((install) => install.receipt.id)
              })
            }
            case "process.run": {
              if (request.tool !== undefined) {
                const { invoke, evidence } = yield* processEvidence(
                  run,
                  plan,
                  request.tool.name
                )
                if (!toolRuntimeIsDecodable(run, invoke)) {
                  const failed = failedRuntimeReceipt(run)
                  return yield* runtimeExecutionFailure(
                    request.tool.name,
                    run,
                    "runtime",
                    `tool runtime finished ${run.state} outside its process result`,
                    failed?.errorTag ?? "ProgramToolRuntimeFailed"
                  )
                }
                if (evidence.receipt.exitCode === null) {
                  return yield* runtimeExecutionFailure(
                    request.tool.name,
                    run,
                    "runtime",
                    `tool process ended ${evidence.outcome}${
                      evidence.receipt.signal === null
                        ? ""
                        : ` with ${evidence.receipt.signal}`
                    } without an exit code`,
                    "ProgramToolProcessIncomplete"
                  )
                }
                const value = yield* decodeToolResult({
                  definitionId: request.tool.definitionId,
                  actionName: request.tool.name,
                  resultDecoder: request.tool.resultDecoder,
                  ...(request.tool.outputSchema === undefined ? {} : { outputSchema: request.tool.outputSchema })
                }, {
                  exitCode: evidence.receipt.exitCode,
                  stdout: decodedText.decode(evidence.receipt.stdout),
                  stderr: decodedText.decode(evidence.receipt.stderr)
                }).pipe(
                  Effect.mapError(executionFailure(request.tool.name, "contract", run)),
                  Effect.flatMap((decoded) => Schema.decodeUnknown(LanguageValueSchema)(decoded).pipe(
                    Effect.mapError(executionFailure(request.tool!.name, "contract", run))
                  ))
                )
                return actionResult(value, outputs)
              }
              return actionResult(runtimeRunValue(run, plan), outputs)
            }
            case "http.stage": {
              yield* requireSuccessfulRuntime(run, call.action)
              const external = yield* externalFor(run, plan, call.action)
              if (external.bodyArtifact !== undefined) {
                return yield* runtimeExecutionFailure(
                  call.action,
                  run,
                  "contract",
                  "program lowering must freeze the artifact-backed body into RequestExternal.body",
                  "ProgramPlanShapeMismatch"
                )
              }
              const result = yield* runtimeArtifact(run, external, call.action)
              const staged = yield* decodeRuntimeJson(
                run,
                result,
                OutboxEmission,
                call.action
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
 * dependencies remain requirements of Runtime; Program receives exactly one
 * interpreter and cannot acquire a second native authority path.
 */
export const ProgramExecutionLive = (policy: AdmissionPolicy) => {
  const executor = ProgramPlanExecutorLive.pipe(
    Layer.provideMerge(ProgramAdmissionLive(policy)),
    Layer.provideMerge(ProgramPlanRuntimeLive)
  )
  return ProgramRunnerLive.pipe(Layer.provide(executor))
}

export const ProgramExecutionWithToolsLive = (
  policy: AdmissionPolicy,
  actions: ReadonlyMap<string, ExportedToolAction>,
  cellProfile: CellProfile
) => {
  const executor = ProgramPlanExecutorLive.pipe(
    Layer.provideMerge(ProgramAdmissionLive(policy)),
    Layer.provideMerge(ProgramPlanRuntimeLive)
  )
  return ProgramRunnerWithToolsLive(actions, cellProfile).pipe(Layer.provide(executor))
}

const dottedName = (expression: Expression): string | undefined => {
  if (expression.kind === "IdentifierExpression") return expression.name
  if (expression.kind !== "FieldExpression") return undefined
  const prefix = dottedName(expression.object)
  return prefix === undefined ? undefined : `${prefix}.${expression.field}`
}

const normalizeExpression = (expression: Expression, actionNames: ReadonlySet<string>): Expression => {
  switch (expression.kind) {
    case "CallExpression": {
      const dotted = dottedName(expression.callee)
      const callee = dotted !== undefined && actionNames.has(dotted)
        ? { kind: "IdentifierExpression" as const, name: dotted, span: expression.callee.span }
        : normalizeExpression(expression.callee, actionNames)
      return { ...expression, callee, arguments: expression.arguments.map((item) => normalizeExpression(item, actionNames)) }
    }
    case "ListExpression": return { ...expression, items: expression.items.map((item) => normalizeExpression(item, actionNames)) }
    case "RecordExpression": return { ...expression, entries: expression.entries.map((entry) => ({ ...entry, value: normalizeExpression(entry.value, actionNames) })) }
    case "UnaryExpression": return { ...expression, operand: normalizeExpression(expression.operand, actionNames) }
    case "BinaryExpression": return { ...expression, left: normalizeExpression(expression.left, actionNames), right: normalizeExpression(expression.right, actionNames) }
    case "FieldExpression": return { ...expression, object: normalizeExpression(expression.object, actionNames) }
    case "IndexExpression": return { ...expression, object: normalizeExpression(expression.object, actionNames), index: normalizeExpression(expression.index, actionNames) }
    default: return expression
  }
}

const normalizeStatement = (statement: Statement, actionNames: ReadonlySet<string>): Statement => {
  switch (statement.kind) {
    case "LetStatement": return { ...statement, value: normalizeExpression(statement.value, actionNames) }
    case "ExpressionStatement": return { ...statement, expression: normalizeExpression(statement.expression, actionNames) }
    case "ReturnStatement": return { ...statement, ...(statement.value === undefined ? {} : { value: normalizeExpression(statement.value, actionNames) }) }
    case "AssertStatement": return { ...statement, test: normalizeExpression(statement.test, actionNames), ...(statement.message === undefined ? {} : { message: normalizeExpression(statement.message, actionNames) }) }
    case "IfStatement": return { ...statement, test: normalizeExpression(statement.test, actionNames), consequent: statement.consequent.map((item) => normalizeStatement(item, actionNames)), ...(statement.alternate === undefined ? {} : { alternate: statement.alternate.map((item) => normalizeStatement(item, actionNames)) }) }
    case "ForStatement": {
      const body = statement.body.map((item) =>
        normalizeStatement(item, actionNames)
      )
      return statement.iteration === "list"
        ? {
            ...statement,
            source: normalizeExpression(statement.source, actionNames),
            body
          }
        : {
            ...statement,
            from: normalizeExpression(statement.from, actionNames),
            to: normalizeExpression(statement.to, actionNames),
            body
          }
    }
  }
}

/** Supports dotted native verbs without giving the language a reflective call surface. */
export const normalizeProgramActions = (program: Program, extraActions: ReadonlySet<string> = new Set()): Program =>
  ({ ...program, body: program.body.map((statement) => normalizeStatement(statement, new Set([...nativeNames, ...extraActions]))) })

const runProgram = (executor: {
  readonly execute: (request: ProgramActionRequest) => Effect.Effect<ProgramActionResult, ProgramActionExecutionFailed>
}, tools: { readonly actions: ReadonlyMap<string, ExportedToolAction>; readonly cellProfile: CellProfile }) =>
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
            reason: cause.reason,
            ...(cause.runtime === undefined ? {} : { runtime: cause.runtime })
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
          const tool = tools.actions.get(action)
          if (tool !== undefined) {
            const next = yield* draftForToolAction(
              tool,
              tools.cellProfile,
              args,
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
          }
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
      const evaluation = yield* evaluate(normalizeProgramActions(parsed, new Set(tools.actions.keys())), resolver, {
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

const programRunnerLive = (tools: { readonly actions: ReadonlyMap<string, ExportedToolAction>; readonly cellProfile: CellProfile }) => Layer.effect(
  ProgramRunner,
  Effect.gen(function* () {
    const executor = yield* ProgramActionExecutor
    return ProgramRunner.of({
      run: runProgram(executor, tools)
    })
  })
)

/** The default language surface contains only native actions. */
export const ProgramRunnerLive = programRunnerLive({ actions: new Map(), cellProfile: "compatibility" })

/** A caller that loaded definitions may explicitly extend one runner surface. */
export const ProgramRunnerWithToolsLive = (
  actions: ReadonlyMap<string, ExportedToolAction>,
  cellProfile: CellProfile
) => programRunnerLive({ actions, cellProfile })
