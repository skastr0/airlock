#!/usr/bin/env bun
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { Cause, Console, Crypto, Effect, Exit, FileSystem, Layer, ManagedRuntime, Option, Runtime as EffectRuntime, Schema } from "effect"
import * as nodePath from "node:path"
import * as nodeOs from "node:os"
import { createInterface } from "node:readline"
import {
  AdmissionPolicy,
  type BoxGrantVerb,
  admit
} from "./core/admission/index.ts"
import {
  NativeActionCatalog,
  type NativeActionCall as NativeActionCallValue,
  type NativeActionName,
  mapNativeActionPathSelectors,
  nativeActionSchema
} from "./core/actions/index.ts"
import { AirlockHome, layerFromEnv } from "./AirlockHome.ts"
import { ActId, ScopeEscape } from "./core/domain.ts"
import { Hold } from "./Hold.ts"
import { HoldLive } from "./HoldLive.ts"
import { Change, ChangeLive } from "./change/Change.ts"
import { formatContent, formatInventory, formatReview } from "./change-view.ts"
import {
  type LanguageValue,
  LanguageValueSchema
} from "./core/language/evaluator.ts"
import { FileLedger, FileLedgerLive } from "./host/FileLedger.ts"
import { Cell, CellLive, CellRequest } from "./cell/index.ts"
import { LinuxPlatform, LinuxPlatformLive } from "./platform/linux/index.ts"
import { MacosPlatform, MacosPlatformLive } from "./platform/macos/index.ts"
import {
  NativeFileSystemLive,
  NativeFilesystemConfig,
  bindPhysicalPathSelector
} from "./native/index.ts"
import { ProcessRequest, ProcessRunner, ProcessRunnerLive } from "./process/Process.ts"
import { Outbox, OutboxLive } from "./Outbox.ts"
import { Canonical, DispatchProvenance, EmissionId, IdempotencyKey } from "./core/index.ts"
import {
  checkDaemonSocket,
  runDaemon,
  runDaemonHealthServer
} from "./daemon/index.ts"
import {
  ProgramActionDecodeFailed,
  ProgramExecutionWithToolsLive,
  ProgramRequest,
  ProgramRunner,
  type ProgramPathSelectorBinder,
  canonicalizeProgramAction,
  draftForAction,
  nativeActionResultSchema,
  unchangedProgramPathSelector
} from "./program/index.ts"
import {
  ToolDefinitionDirectories,
  type ExportedToolAction,
  exportToolActions,
  loadKnownToolDefinitions
} from "./core/tools/index.ts"
import { makeFileToolDefinitionReader } from "./tools/FileReader.ts"
import {
  makeFileRuntimeRunJournal,
  RuntimeConfig,
  RuntimeConfigLive,
  RuntimeLive
} from "./runtime/index.ts"
import { AIRLOCK_VERSION } from "./version.ts"
import {
  type SealContext,
  SealVerificationFailed,
  loadStartupSeal,
  sealedTools,
  verifyInstalledReadiness
} from "./seal/index.ts"
import { describeFailure, reasonOf } from "./FailureText.ts"

/**
 * CLI is deliberately an adapter: it parses agent-facing atoms, invokes typed
 * services, and renders receipts. It never owns filesystem mutation, process
 * spawning, or external dispatch authority.
 */

export class CliInputError extends Schema.TaggedError<CliInputError>()(
  "CliInputError",
  { field: Schema.String, reason: Schema.String }
) {}

const emit = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const rendered = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  format?: (value: A) => string
) =>
  effect.pipe(
    Effect.flatMap(value => format === undefined ? emit(value) : Console.log(format(value))),
    Effect.catch((error) =>
      Console.error(JSON.stringify(error)).pipe(
        Effect.andThen(Effect.sync(() => {
          process.exitCode = 1
        }))
      )
    )
  )

const renderedProgram = <A extends {
  readonly result: {
    readonly state: string
  }
}, E, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.tap((value) => emit(value)),
    Effect.tap((value) =>
      value.result.state === "succeeded"
        ? Effect.void
        : Effect.sync(() => {
            process.exitCode = 1
          })
    ),
    Effect.catch((error) =>
      Console.error(JSON.stringify(error)).pipe(
        Effect.andThen(Effect.sync(() => {
          process.exitCode = 1
        }))
      )
    )
  )

const projectInlineArtifact = (artifact: {
  readonly id: string
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly provenance: string
}) => ({
  id: artifact.id,
  mediaType: artifact.mediaType,
  byteLength: artifact.bytes.byteLength,
  provenance: artifact.provenance
})

const projectPlan = (plan: {
  readonly id: string
  readonly actionReference: string
  readonly nodes: ReadonlyArray<{
    readonly id: string
    readonly _tag: string
    readonly dependsOn: ReadonlyArray<string>
  }>
}) => ({
  id: plan.id,
  actionReference: plan.actionReference,
  nodes: plan.nodes.map((node) => ({
    id: node.id,
    kind: node._tag,
    dependsOn: [...node.dependsOn]
  }))
})

const projectProgramRun = (run: {
  readonly state: string
  readonly result: LanguageValue
  readonly plans: ReadonlyArray<{
    readonly id: string
    readonly actionReference: string
    readonly nodes: ReadonlyArray<{
      readonly id: string
      readonly _tag: string
      readonly dependsOn: ReadonlyArray<string>
    }>
  }>
  readonly actions: ReadonlyArray<{
    readonly request: {
      readonly call: {
        readonly action: string
        readonly input: unknown
      }
      readonly callDigest: string
      readonly draft: {
        readonly id: string
        readonly actionReference: string
        readonly nodes: ReadonlyArray<{
          readonly id: string
          readonly _tag: string
          readonly dependsOn: ReadonlyArray<string>
        }>
      }
      readonly inlineArtifacts: ReadonlyArray<{
        readonly id: string
        readonly bytes: Uint8Array
        readonly mediaType: string
        readonly provenance: string
      }>
    }
    readonly result: {
      readonly value: unknown
      readonly artifacts: ReadonlyArray<{
        readonly id: string
        readonly bytes: Uint8Array
        readonly mediaType: string
        readonly provenance: string
      }>
    }
  }>
  readonly artifacts: ReadonlyArray<{
    readonly id: string
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly provenance: string
  }>
  readonly failure?: {
    readonly action: string
    readonly phase: string
    readonly causeTag?: string
    readonly reason: string
  }
}) => ({
  state: run.state,
  result: run.result,
  plans: run.plans.map(projectPlan),
  actions: run.actions.map((record) => ({
    request: {
      call: record.request.call,
      callDigest: record.request.callDigest,
      draft: projectPlan(record.request.draft),
      inlineArtifacts: record.request.inlineArtifacts.map(projectInlineArtifact)
    },
    result: {
      value: record.result.value,
      artifacts: record.result.artifacts.map(projectInlineArtifact)
    }
  })),
  artifacts: run.artifacts.map(projectInlineArtifact),
  ...(run.failure === undefined ? {} : { failure: run.failure })
})

const projectCompactProgramRun = (
  run: Parameters<typeof projectProgramRun>[0]
) => ({
  state: run.state,
  result: run.result,
  plans: run.plans.map((plan) => ({
    id: plan.id,
    actionReference: plan.actionReference,
    nodeCount: plan.nodes.length
  })),
  counts: {
    plans: run.plans.length,
    actions: run.actions.length,
    artifacts: run.artifacts.length
  },
  artifacts: run.artifacts.map(projectInlineArtifact),
  ...(run.failure === undefined ? {} : { failure: run.failure })
})

const failInput = (field: string, reason: string) =>
  Effect.fail(new CliInputError({ field, reason }))

/**
 * Parsing removes every ungranted verb from a sealed command graph. This is a
 * final handler-boundary defense against a stale graph, not the user-visible
 * denial path: denied verbs deliberately fail as ordinary command mismatches.
 */
const requireVerb = (
  seal: SealContext,
  verb: BoxGrantVerb
): Effect.Effect<void, CliInputError> =>
  seal._tag === "UnsealedSeal" || seal.grant.verbs.includes(verb)
    ? Effect.void
    : failInput("verb", `the verified seal does not grant ${verb}`)

const allowedNativeActions = (seal: SealContext): ReadonlySet<NativeActionName> =>
  seal._tag === "UnsealedSeal"
    ? new Set(NativeActionCatalog.map((action) => action.name))
    : new Set(seal.grant.nativeActions)

/** Like requireVerb, this is defense after sealed root construction. */
const requireNativeAction = (
  seal: SealContext,
  action: NativeActionName
): Effect.Effect<void, CliInputError> =>
  allowedNativeActions(seal).has(action)
    ? Effect.void
    : failInput(
        "native-action",
        `the verified seal does not grant ${action}`
      )

/**
 * The compatibility profile is Bash parity, so it preserves the supervisor's
 * process environment. Contained profiles never call this helper: their
 * environment remains an explicit capability supplied by the admitted Plan.
 */
const compatibilityEnvironment = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )

const parseDuration = (field: string, raw: string): Effect.Effect<number, CliInputError> => {
  const match = raw.match(/^(\d+)(ms|s|m|h|d)$/)
  if (match === null) return failInput(field, "must be an integer duration such as 250ms, 30s, 5m, 1h, or 7d")
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Effect.succeed(Number(match[1]) * units[match[2] as keyof typeof units])
}

const duration = (name: string, fallback: string) =>
  Flag.String(name).pipe(Flag.withDefault(fallback))

const daemonSocketPath = (): Effect.Effect<string, CliInputError> => {
  const value = process.env["AIRLOCK_DAEMON_SOCKET"]
  return value !== undefined && value.trim().length > 0 && nodePath.isAbsolute(value)
    ? Effect.succeed(value)
    : failInput("AIRLOCK_DAEMON_SOCKET", "an absolute daemon socket path is required in sealed mode")
}

const requireSealedDaemon = (seal: SealContext) =>
  seal._tag === "VerifiedSeal" && seal.grant.daemonOps.length > 0
  ? daemonSocketPath().pipe(
      Effect.flatMap((socketPath) => checkDaemonSocket(
        socketPath,
        seal.grantDigest
      )),
      Effect.mapError((error) => new CliInputError({
        field: "daemon",
        reason: reasonOf(error)
      })),
      Effect.asVoid
    )
  : Effect.void

const scopeOption = Flag.String("scope").pipe(Flag.withDefault("/"))

const profileOption = Flag.Literals("profile", [
  "compatibility",
  "native-contained",
  "vm-enclosed"
]).pipe(Flag.withDefault("compatibility" as const))

type ProgramProfile = "compatibility" | "native-contained" | "vm-enclosed"

const isProgramProfile = (value: string): value is ProgramProfile =>
  value === "compatibility" ||
  value === "native-contained" ||
  value === "vm-enclosed"

/**
 * The reduced harness binary does not accept a profile option from the agent.
 * A supervisor may pin it in the process environment; omission retains the
 * compatibility default required by the ratchet law.
 */
const agentProgramProfile = Effect.suspend(() => {
  const requested = process.env["AIRLOCK_AGENT_PROFILE"] ?? "compatibility"
  return isProgramProfile(requested)
    ? Effect.succeed(requested)
    : failInput(
        "AIRLOCK_AGENT_PROFILE",
        "expected compatibility, native-contained, or vm-enclosed"
      )
})

const resolveWithin = (
  scope: string,
  raw: string
): Effect.Effect<string, ScopeEscape> => {
  const resolvedScope = nodePath.resolve(scope)
  const resolved = nodePath.resolve(raw)
  return resolved === resolvedScope ||
    resolvedScope === "/" ||
    resolved.startsWith(`${resolvedScope}/`)
    ? Effect.succeed(resolved)
    : Effect.fail(new ScopeEscape({ requested: resolved, scope: resolvedScope }))
}

const parseBindings = (raw: Option.Option<string>): Effect.Effect<Readonly<Record<string, LanguageValue>>, CliInputError> => {
  if (Option.isNone(raw)) return Effect.succeed({})
  return Effect.try({
    try: () => {
      const value: unknown = JSON.parse(raw.value)
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new Error("must be a JSON object")
      }
      return value
    },
    catch: (cause) => new CliInputError({
      field: "bindings",
      reason: reasonOf(cause)
    })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, LanguageValueSchema)
    )),
    Effect.mapError((cause) => new CliInputError({
      field: "bindings",
      reason: reasonOf(cause)
    }))
  )
}

const compatibilityPolicy = (workspace: string) => new AdmissionPolicy({
  schemaVersion: "airlock/admission-policy/v2",
  profile: "compatibility",
  principal: "airlock-cli-agent",
  realm: "local",
  admittedBy: "airlock-cli compatibility supervisor",
  pathAllowlist: [workspace],
  executableAllowlist: [],
  executableEdges: [],
  endpointGrants: []
})

/** Fixed, immediate, optional locations; definitions never recursively load code. */
const definitionDirectories = (workspace: string) => new ToolDefinitionDirectories({
  builtin: nodePath.join(import.meta.dir, "..", "tool-definitions"),
  installed: nodePath.join(process.env["AIRLOCK_HOME"] ?? nodePath.join(nodeOs.homedir(), ".airlock"), "tools"),
  user: nodePath.join(nodeOs.homedir(), ".config", "airlock", "tools"),
  project: nodePath.join(workspace, ".airlock", "tools")
})

const toolDefinitionFailure = (error: { readonly _tag: string }): CliInputError =>
  new CliInputError({
    field: "tool-definitions",
    reason: "message" in error && typeof error.message === "string" && error.message !== ""
      ? error.message
      : "reason" in error && typeof error.reason === "string"
        ? error.reason
        : error._tag
  })

const discoveredTools = (
  seal: SealContext,
  workspace: string
): Effect.Effect<ReadonlyArray<ExportedToolAction>, CliInputError> => {
  if (seal._tag === "VerifiedSeal") {
    return sealedTools(seal, workspace).pipe(
      Effect.mapError(toolDefinitionFailure)
    )
  }
  return loadKnownToolDefinitions(
    makeFileToolDefinitionReader(),
    definitionDirectories(workspace)
  ).pipe(
    Effect.flatMap((registry) => exportToolActions(
      registry,
      new Set(NativeActionCatalog.map((action) => action.name))
    )),
    Effect.mapError(toolDefinitionFailure)
  )
}

const bindPolicyPathScopes = (
  policy: AdmissionPolicy
): Effect.Effect<AdmissionPolicy, never, FileSystem.FileSystem> => {
  if (policy.profile !== "native-contained") return Effect.succeed(policy)

  return Effect.gen(function* () {
    const pathAllowlist = yield* Effect.forEach(
      policy.pathAllowlist,
      (scope) => {
        const recursive = scope.endsWith("/**")
        const rawRoot = recursive ? scope.slice(0, -3) : scope
        const root = rawRoot.length === 0 ? nodePath.parse(scope).root : rawRoot
        if (!nodePath.isAbsolute(root)) return Effect.succeed(scope)
        return bindPhysicalPathSelector("/", root, {
          rejectSymlinksWithinWorkspace: false
        }).pipe(
          Effect.map((canonical) =>
            recursive
              ? canonical === nodePath.parse(canonical).root
                ? `${canonical}**`
                : `${canonical}/**`
              : canonical
          ),
          // A future or otherwise unusable trusted scope remains an inert
          // lexical policy spelling; it never becomes requested authority.
          Effect.catch(() => Effect.succeed(scope))
        )
      },
      { concurrency: 1 }
    )
    return new AdmissionPolicy({ ...policy, pathAllowlist })
  })
}

const sealedAdmissionFailure = (
  action: NativeActionName,
  cause: unknown
) => new CliInputError({
  field: "admission",
  reason: `${action}: ${reasonOf(cause)}`
})

/**
 * Raw compatibility verbs keep their direct adapters, but a sealed
 * route first constructs and admits the equivalent native-action Plan. Thus a
 * second CLI spelling can never bypass the signed path or endpoint policy.
 * The decoded, bound call is returned so direct raw physics uses exactly the
 * operand admission checked.
 */
const admitSealedNativeAction = (
  seal: SealContext,
  action: NativeActionName,
  input: unknown,
  workspace: string = process.cwd()
): Effect.Effect<
  NativeActionCallValue | undefined,
  CliInputError,
  FileSystem.FileSystem | Crypto.Crypto
> => {
  // The ratchet: no decode, binding, or stricter validation is introduced
  // on the zero-config compatibility route.
  if (seal._tag === "UnsealedSeal") return Effect.succeed(undefined)
  return Effect.gen(function* () {
    const policy = yield* bindPolicyPathScopes(seal.grant.admission)
    const decoded = yield* canonicalizeProgramAction(action, input).pipe(
      Effect.mapError((cause) => sealedAdmissionFailure(action, cause))
    )
    const call = seal.grant.admission.profile === "native-contained"
      ? yield* mapNativeActionPathSelectors(
          decoded,
          (selector) => bindPhysicalPathSelector(workspace, selector)
        ).pipe(Effect.mapError((cause) => sealedAdmissionFailure(action, cause)))
      : decoded
    const request = yield* draftForAction(call, 0).pipe(
      Effect.mapError((cause) => sealedAdmissionFailure(action, cause))
    )
    yield* admit(request.draft, policy).pipe(
      Effect.mapError((cause) => sealedAdmissionFailure(action, cause))
    )
    return call
  })
}

/**
 * Policies are supervisor input, never inferred from an action request. The
 * compatibility policy is deliberately broad under the ratchet; contained
 * execution requires an independently supplied, schema-decoded policy.
 */
const supervisorPolicy = (
  profile: "compatibility" | "native-contained" | "vm-enclosed",
  workspace: string
): Effect.Effect<AdmissionPolicy, CliInputError, FileSystem.FileSystem> => {
  if (profile === "vm-enclosed") {
    return failInput("profile", "vm-enclosed has no bundled VM Cell backend; refusing fallback")
  }
  const policyFile = process.env["AIRLOCK_POLICY_FILE"]
  if (policyFile === undefined || policyFile.trim().length === 0) {
    return profile === "compatibility"
      ? Effect.succeed(compatibilityPolicy(workspace))
      : failInput("AIRLOCK_POLICY_FILE", "is required for native-contained program execution")
  }
  return Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(policyFile).pipe(
    Effect.mapError((error) => new CliInputError({ field: "AIRLOCK_POLICY_FILE", reason: describeFailure(error) })),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AdmissionPolicy))),
    Effect.mapError((error) => new CliInputError({ field: "AIRLOCK_POLICY_FILE", reason: reasonOf(error) })),
    Effect.flatMap((policy) => policy.profile === profile
      ? Effect.succeed(policy)
      : failInput("AIRLOCK_POLICY_FILE", `policy profile ${policy.profile} does not match selected ${profile}`)
    )
  ))
}

/**
 * Native containment must give every downstream authority seam the same
 * physical workspace name. In particular, resolving only lexically would let
 * an agent select an allowed path whose ancestor is a symlink to a directory
 * outside the supervisor's policy.
 *
 * Compatibility intentionally retains its existing lexical behavior. This is
 * an opt-in containment check, not a new zero-config restriction.
 */
const bindProgramWorkspace = (
  profile: ProgramProfile,
  requestedWorkspace: string
): Effect.Effect<string, CliInputError, FileSystem.FileSystem> => {
  const requested = nodePath.resolve(requestedWorkspace)
  if (profile !== "native-contained") return Effect.succeed(requested)

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspace = yield* fs.realPath(requested).pipe(
      Effect.mapError((cause) =>
        new CliInputError({
          field: "workspace",
          reason: `cannot resolve native-contained workspace ${requested}: ${describeFailure(cause)}`
        })
      )
    )
    const info = yield* fs.stat(workspace).pipe(
      Effect.mapError((cause) =>
        new CliInputError({
          field: "workspace",
          reason: `cannot inspect native-contained workspace ${workspace}: ${describeFailure(cause)}`
        })
      )
    )
    if (info.type !== "Directory") {
      return yield* failInput(
        "workspace",
        `native-contained workspace must resolve to a directory; found ${info.type} at ${workspace}`
      )
    }
    return workspace
  })
}

// ── reviewed local changes ──────────────────────────────────────────────────

const renderedChangeOutcome = <A extends { readonly state: string }, E, R>(
  effect: Effect.Effect<A, E, R>,
  successfulStates: ReadonlyArray<string> = ["installed", "undone"]
) => rendered(effect.pipe(
  Effect.tap((outcome) => Effect.sync(() => {
    if (!successfulStates.includes(outcome.state)) {
      process.exitCode = 1
    }
  }))
))

const confirmChange = () => Effect.callback<boolean>((resume) => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  terminal.once("line", answer => {
    resume(Effect.succeed(answer === "APPLY"))
    terminal.close()
  })
  terminal.once("close", () => resume(Effect.succeed(false)))
  terminal.once("SIGINT", () => terminal.close())
  terminal.setPrompt("Approve exactly this frozen proposal? Type APPLY, or anything else to leave it staged: ")
  terminal.prompt()
  return Effect.sync(() => terminal.close())
})

/** Local proposals do not inherit sealed grants or program execution authority. */
const makeChange = (seal: SealContext, agent = false) => {
  const local = seal._tag === "VerifiedSeal"
    ? failInput("change", "reviewed changes are unavailable in sealed installations")
    : Effect.void
  const id = Argument.String("proposal-id")
  const commands: Array<AnyCliCommand> = [
    Command.make("inbox", { human: Flag.Boolean("human").pipe(Flag.withDefault(false)) }, ({ human }) => rendered(local.pipe(
      Effect.andThen(Effect.flatMap(Change, change => change.inventory()))
    ), human ? formatInventory : undefined)).pipe(Command.withDescription("Discover proposals, operation outcomes, and retained storage")),
    Command.make("stage", {
      source: Flag.String("source"),
      target: Flag.String("target")
    }, (request) => rendered(local.pipe(
      Effect.andThen(Effect.flatMap(Change, (change) => change.stage(request)))
    ))).pipe(Command.withDescription("Snapshot a target-specific replacement without changing the target")),
    Command.make("review", {
      id,
      diff: Flag.Boolean("diff").pipe(Flag.withDefault(false)),
      human: Flag.Boolean("human").pipe(Flag.withDefault(false))
    }, ({ id, diff, human }) => rendered(local.pipe(
      Effect.andThen(Effect.flatMap(Change, (change) => change.review(id, { diff: diff || human })))
    ), human ? formatReview : undefined)).pipe(Command.withDescription("Inspect the frozen proposal; --human renders safe text, --diff adds JSON previews")),
    Command.make("content", {
      id,
      side: Flag.Literals("side", ["before", "after"]),
      path: Flag.String("path"),
      offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
      limit: Flag.Int("limit").pipe(Flag.withDefault(8192)),
      human: Flag.Boolean("human").pipe(Flag.withDefault(false))
    }, ({ human, ...request }) => rendered(local.pipe(
      Effect.andThen(Effect.flatMap(Change, change => change.content(request)))
    ), human ? formatContent : undefined)).pipe(Command.withDescription("Read a bounded page of frozen file bytes; root file uses --path ''")),
    Command.make("status", { id }, ({ id }) => rendered(local.pipe(
      Effect.andThen(Effect.flatMap(Change, (change) => change.status(id)))
    ))).pipe(Command.withDescription("Read durable proposal and recovery status"))
  ]
  if (!agent) commands.push(
    Command.make("approve", { id }, ({ id }) => rendered(local.pipe(Effect.andThen(Effect.gen(function* () {
      if (!process.stdin.isTTY || !process.stderr.isTTY) return yield* failInput("approve", "interactive terminal required; automation must use apply with an explicitly reviewed full digest")
      const change = yield* Change
      const review = yield* change.review(id, { diff: true })
      yield* Console.error(formatReview(review))
      if (!(yield* confirmChange())) return { version: "change-approval/v1", id: review.id, state: "not-approved", proposalDigest: review.proposalDigest }
      // Bind approval to the review already displayed; never refresh its digest.
      const outcome = yield* change.apply({ id: review.id, expectedDigest: review.proposalDigest })
      if (outcome.state !== "installed") yield* Effect.sync(() => { process.exitCode = 1 })
      return outcome
    }))))).pipe(Command.withDescription("Review and approve the displayed digest on an interactive supervisor terminal")),
    Command.make("retire", { id, expectedDigest: Flag.String("expect-digest") }, request => renderedChangeOutcome(local.pipe(
      Effect.andThen(Effect.flatMap(Change, change => change.retire(request)))
    ), ["retired", "collected"])).pipe(Command.withDescription("Retire eligible review snapshots using the inbox retirement digest, preserving undo payloads")),
    Command.make("collect", { id }, ({ id }) => renderedChangeOutcome(local.pipe(
      Effect.andThen(Effect.flatMap(Change, change => change.collect(id)))
    ), ["collected"])).pipe(Command.withDescription("Irreversibly reap only this proposal's retired snapshots; keep receipts and undo payloads")),
    Command.make("apply", {
      id,
      expectedDigest: Flag.String("expect-digest")
    }, (request) => renderedChangeOutcome(local.pipe(
      Effect.andThen(Effect.flatMap(Change, (change) => change.apply(request)))
    ))).pipe(Command.withDescription("Approve and apply this exact digest once, refusing baseline drift")),
    Command.make("undo", {
      receiptId: Argument.String("receipt-id")
    }, ({ receiptId }) => renderedChangeOutcome(local.pipe(
      Effect.andThen(Effect.flatMap(Change, (change) => change.undo(receiptId)))
    ))).pipe(Command.withDescription("Restore one exact apply receipt, refusing changes made since installation")),
    Command.make("cancel", { id }, ({ id }) => rendered(local.pipe(
      Effect.andThen(Effect.flatMap(Change, (change) => change.cancel(id)))
    ))).pipe(Command.withDescription("Cancel an unclaimed proposal; snapshots remain retained")),
    Command.make("recover", {
      id,
      restore: Flag.Boolean("restore").pipe(Flag.withDefault(false))
    }, ({ id, restore }) => renderedChangeOutcome(local.pipe(
      Effect.andThen(Effect.flatMap(Change, (change) => change.recover(id, { restore })))
    ), ["staged", "cancelled", "installed", "undone", "rolled-back"]))
      .pipe(Command.withDescription("Reconcile evidence; --restore restores retained prior state into an absent target, never retries installation"))
  )
  return makeRoot("change", commands).pipe(Command.withDescription(
    agent
      ? "Stage and inspect consequential local replacements for supervisor approval"
      : "Prepare with Bash or Python; review, apply, and recover consequential local replacements"
  ))
}

const makeAgentChange = (seal: SealContext) => makeChange(seal, true)

// ── mutation verbs ──────────────────────────────────────────────────────────

const makeRm = (seal: SealContext) => Command.make(
  "rm",
  { target: Argument.String("target"), scope: scopeOption },
  ({ scope, target }) => rendered(
    requireVerb(seal, "rm").pipe(
      Effect.andThen(requireNativeAction(seal, "file.remove")),
      Effect.flatMap(() => resolveWithin(scope, target)),
      Effect.flatMap((resolved) => admitSealedNativeAction(
        seal,
        "file.remove",
        { action: "file.remove", path: resolved }
      ).pipe(
        Effect.flatMap((call) => Effect.flatMap(Hold, (hold) =>
          hold.remove(
            call?.action === "file.remove" ? call.path : resolved
          )
        ))
      ))
    )
  )
).pipe(Command.withDescription("Recursive remove — staged, recoverable via undo"))

const makeWrite = (seal: SealContext) => Command.make(
  "write",
  { target: Argument.String("target"), content: Argument.String("content"), scope: scopeOption },
  ({ content, scope, target }) => rendered(
    requireVerb(seal, "write").pipe(
      Effect.andThen(requireNativeAction(seal, "file.write")),
      Effect.flatMap(() => resolveWithin(scope, target)),
      Effect.flatMap((resolved) => admitSealedNativeAction(
        seal,
        "file.write",
        { action: "file.write", path: resolved, content }
      ).pipe(
        Effect.flatMap((call) => Effect.flatMap(Hold, (hold) =>
          hold.overwrite(
            call?.action === "file.write" ? call.path : resolved,
            content
          )
        ))
      ))
    )
  )
).pipe(Command.withDescription("Overwrite — previous version held, recoverable"))

const makeUndo = (seal: SealContext) => Command.make(
  "undo",
  { id: Argument.String("act-id").pipe(Argument.optional) },
  ({ id }) =>
    rendered(Effect.gen(function* () {
      yield* requireVerb(seal, "undo")
      const hold = yield* Hold
      if (Option.isNone(id)) return yield* hold.undoLast
      const actId = yield* Schema.decodeUnknownEffect(ActId)(id.value).pipe(
        Effect.mapError((cause) =>
          new CliInputError({
            field: "act-id",
            reason: reasonOf(cause)
          })
        )
      )
      return yield* hold.undo(actId)
    }))
).pipe(Command.withDescription("Restore a held act (defaults to the most recent)"))

const makeHeld = (seal: SealContext) => Command.make("held", {}, () =>
  rendered(
    requireVerb(seal, "held").pipe(
      Effect.andThen(Effect.flatMap(Hold, (hold) => hold.held))
    )
  )
).pipe(Command.withDescription("List held (recoverable) mutations"))

const makeReap = (seal: SealContext) => Command.make(
  "reap",
  { olderThan: duration("older-than", "7d") },
  ({ olderThan }) => rendered(
    requireVerb(seal, "reap").pipe(
      Effect.andThen(parseDuration("older-than", olderThan)),
      Effect.flatMap((millis) => Effect.flatMap(Hold, (hold) => hold.reap(millis)))
    )
  )
).pipe(Command.withDescription("Reclaim held bytes — the second phase, the only unlink"))

// ── emission verbs ──────────────────────────────────────────────────────────

const methodOption = Flag.Literals("method", ["GET", "POST", "PUT", "PATCH", "DELETE"])
  .pipe(Flag.withDefault("POST" as const))

const makeSend = (seal: SealContext) => Command.make(
  "send",
  {
    url: Argument.String("url"),
    method: methodOption,
    body: Flag.String("body").pipe(Flag.optional),
    hold: duration("hold", "30s")
  },
  ({ body, hold, method, url }) => rendered(
    requireVerb(seal, "send").pipe(
      Effect.andThen(requireNativeAction(seal, "http.stage")),
      Effect.flatMap(() => parseDuration("hold", hold)),
      Effect.flatMap((millis) => {
        const bodyValue = Option.getOrUndefined(body)
        return admitSealedNativeAction(
          seal,
          "http.stage",
          {
            action: "http.stage",
            endpoint: url,
            method,
            ...(bodyValue === undefined ? {} : { body: bodyValue }),
            holdMillis: millis
          }
        ).pipe(
          // Each `send` is a new act: a fresh key, so nothing is replayed.
          Effect.andThen(Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4)),
          Effect.flatMap((uuid) => Effect.flatMap(Outbox, (outbox) => outbox.stage({
            key: IdempotencyKey.make(`cli-send:${uuid}`),
            intent: {
              kind: "http",
              dispatch: {
                url,
                method,
                headers: {},
                ...(bodyValue === undefined ? {} : { body: bodyValue })
              }
            },
            holdMillis: millis
          })))
        )
      })
    )
  )
).pipe(Command.withDescription("Stage an external request — nothing is sent yet"))

const makePending = (seal: SealContext) => Command.make("pending", {}, () =>
  rendered(
    requireVerb(seal, "pending").pipe(
      Effect.andThen(Effect.flatMap(Outbox, (outbox) => outbox.pending))
    )
  )
).pipe(Command.withDescription("List staged emissions"))

/** An id the kernel could have issued, or a usage error; never a defect. */
const emissionIdArgument = (raw: string) =>
  Schema.decodeUnknownEffect(EmissionId)(raw).pipe(
    Effect.mapError(() => new CliInputError({
      field: "emission-id",
      reason: "expected an emission id such as emi_<32 hex digits>"
    }))
  )

const makeCommit = (seal: SealContext) => Command.make(
  "commit",
  { id: Argument.String("emission-id") },
  ({ id }) => rendered(
    requireVerb(seal, "commit").pipe(
      Effect.andThen(emissionIdArgument(id)),
      Effect.flatMap((emissionId) => Effect.flatMap(Outbox, (outbox) => outbox.commit(
        emissionId,
        new DispatchProvenance({ committedBy: "supervisor" })
      )))
    )
  )
).pipe(Command.withDescription("Approve and send a staged emission now"))

const makeCancel = (seal: SealContext) => Command.make(
  "cancel",
  { id: Argument.String("emission-id") },
  ({ id }) => rendered(
    requireVerb(seal, "cancel").pipe(
      Effect.andThen(emissionIdArgument(id)),
      Effect.flatMap((emissionId) => Effect.flatMap(Outbox, (outbox) => outbox.cancel(emissionId)))
    )
  )
).pipe(Command.withDescription("Cancel a staged emission — it was never sent"))

const makeFlush = (seal: SealContext) => Command.make("flush", {}, () =>
  rendered(
    requireVerb(seal, "flush").pipe(
      Effect.andThen(Effect.flatMap(Outbox, (outbox) => outbox.flush))
    )
  )
).pipe(Command.withDescription("Send every staged emission whose hold expired"))

// ── discovery + structured computation ──────────────────────────────────────

const compatibilityCapability = {
  available: true,
  guarantee: "bash-parity; no containment claim"
} as const

const macosCapabilityPayload = Effect.flatMap(MacosPlatform, (macos) =>
  macos.capabilityReport.pipe(
    Effect.map((report) => ({
      version: AIRLOCK_VERSION,
      platform: process.platform,
      profiles: {
        compatibility: compatibilityCapability,
        "native-contained": {
          available:
            report.nativeContainment.seatbelt.posture === "enforced" &&
            report.nativeContainment.privateWritableView.posture === "enforced" &&
            report.nativeContainment.liveWorkspaceWriteFence.posture === "enforced" &&
            report.nativeContainment.deniedNetworkFence.posture === "enforced",
          guarantee: "native Cell: private workspace, live-workspace write denial, network denial, and exact executable paths; not VM-equivalent"
        },
        "vm-enclosed": {
          available: report.vmEnclosure.backend.posture === "enforced",
          reason: report.vmEnclosure.backend.caveats.join("; ")
        }
      },
      macos: report
    }))
  )
)

const linuxCapabilityPayload = Effect.flatMap(LinuxPlatform, (linux) =>
  linux.capabilityReport.pipe(
    Effect.map((report) => ({
      version: AIRLOCK_VERSION,
      platform: process.platform,
      profiles: {
        compatibility: compatibilityCapability,
        "native-contained": {
          available:
            report.cloneOrCopyWorkspace.posture === "enforced" &&
            report.nativeContainment.namespaces.posture === "enforced" &&
            report.nativeContainment.privateWritableView.posture === "enforced" &&
            report.nativeContainment.liveWorkspaceWriteFence.posture === "enforced" &&
            report.nativeContainment.deniedNetworkFence.posture === "enforced" &&
            report.nativeContainment.executableObjectFence.posture === "enforced" &&
            report.nativeContainment.bootstrapEnvironment.posture === "enforced",
          guarantee: "native Cell: private workspace, live-workspace write denial, all-socket denial, and admitted executable-object fencing; ambient reads and runtime-loader caveat remain"
        },
        "vm-enclosed": {
          available: report.vmEnclosure.backend.posture === "enforced",
          reason: report.vmEnclosure.backend.caveats.join("; ")
        }
      },
      linux: report
    }))
  )
)

const capabilityPayload = Effect.suspend(
  (): Effect.Effect<unknown, unknown, LinuxPlatform | MacosPlatform> =>
    process.platform === "linux"
      ? linuxCapabilityPayload
      : macosCapabilityPayload
)

const makeDoctor = (seal: SealContext) => Command.make("doctor", {}, () =>
  rendered(
    requireVerb(seal, "doctor").pipe(Effect.andThen(capabilityPayload))
  )
).pipe(Command.withDescription("Report the exact host enforcement envelope"))

const makeCapabilities = (seal: SealContext) => Command.make("capabilities", {}, () =>
  rendered(
    requireVerb(seal, "capabilities").pipe(Effect.andThen(capabilityPayload))
  )
).pipe(Command.withDescription("Machine-readable alias for doctor"))

const visibleNativeActions = (seal: SealContext) => {
  const allowed = allowedNativeActions(seal)
  return NativeActionCatalog.filter((action) => allowed.has(action.name))
}

const definitionActionIsVisible = (
  lowering: "invoke" | "enqueue",
  nativeActions: ReadonlySet<NativeActionName>
) => lowering === "invoke"
  ? nativeActions.has("process.run")
  : nativeActions.has("http.stage")

const makeActions = (seal: SealContext) => Command.make("actions", {
  workspace: Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))
}, ({ workspace }) => rendered(
  requireVerb(seal, "actions").pipe(
    Effect.andThen(discoveredTools(seal, nodePath.resolve(workspace))),
    Effect.map((tools) => {
      const nativeActions = allowedNativeActions(seal)
      return {
        schemaVersion: "airlock/actions/v1",
        actions: visibleNativeActions(seal),
        definitions: tools
          .filter((tool) => definitionActionIsVisible(tool.action.lowering, nativeActions))
          .map((tool) => ({
            name: tool.name,
            definitionId: tool.loaded.definition.id,
            version: tool.loaded.definition.version,
            executable: tool.loaded.definition.executables.map((item) => item.selector),
            resultDecoder: tool.action.resultDecoder
          }))
      }
    })
  )
)).pipe(Command.withDescription("List built-in actions plus inert discovered tool definitions"))

/**
 * Draft 2020-12 JSON Schema for one discovery contract. Unmodeled properties
 * are rejected, matching the decoder the CLI applies to action input.
 */
const discoveryJsonSchema = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error"
  })
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(Object.keys(document.definitions).length === 0
      ? {}
      : { $defs: document.definitions }),
    ...document.schema
  }
}

const nativeActionInputSchema = (
  name: (typeof NativeActionCatalog)[number]["name"]
) => {
  const canonical = discoveryJsonSchema(nativeActionSchema(name))
  if (!("properties" in canonical)) return canonical
  const { action: _discriminator, ...properties } = canonical.properties as Record<string, unknown>
  return {
    ...canonical,
    required: ((canonical as { readonly required?: ReadonlyArray<string> }).required ?? []).filter((field) => field !== "action"),
    properties
  }
}

const nativeActionResultJsonSchema = (
  name: (typeof NativeActionCatalog)[number]["name"]
) => discoveryJsonSchema(nativeActionResultSchema(name))

const nativeActionDiscoveryDescriptor = (
  action: (typeof NativeActionCatalog)[number]
) => ({
  ...action,
  resultSchema: nativeActionResultJsonSchema(action.name)
})

const makeSchema = (seal: SealContext) => Command.make(
  "schema",
  { subject: Argument.String("subject").pipe(Argument.optional) },
  ({ subject }) => rendered(Effect.gen(function* () {
    yield* requireVerb(seal, "schema")
    const requested = Option.getOrElse(subject, () => "all")
    const nativeActions = visibleNativeActions(seal)
    const native = nativeActions.find((action) => action.name === requested)
    if (native !== undefined) {
      return {
        schemaVersion: "airlock/discovery/v1",
        action: {
          ...nativeActionDiscoveryDescriptor(native),
          inputSchema: nativeActionInputSchema(native.name)
        }
      }
    }
    if (!(["all", "actions", "plan", "language"] as const).includes(requested as "all" | "actions" | "plan" | "language")) {
      return yield* failInput("subject", "expected actions, plan, language, all, or a native action name")
    }
    return {
      schemaVersion: "airlock/discovery/v1",
      ...(requested === "all" || requested === "actions" ? {
        actions: nativeActions.map(nativeActionDiscoveryDescriptor)
      } : {}),
      ...(requested === "all" || requested === "plan" ? {
        plan: {
          schemaVersion: "airlock/plan/v1",
          nodes: ["Capture", "Invoke", "Apply", "RequestExternal"],
          invoke: {
            executable: "absolute path",
            args: "string[]",
            descendantExecutables: "additional absolute executable paths",
            commandString: false
          }
        }
      } : {}),
      ...(requested === "all" || requested === "language" ? {
        language: {
          syntax: "airlock",
          effects: "identifier ActionResolver calls only",
          control: [
            "let",
            "if",
            "for finite range",
            "for captured list",
            "return",
            "assert"
          ]
        }
      } : {})
    }
  }))
).pipe(Command.withDescription("Discover versioned action, Plan, and language contracts"))

type RawExecInput = {
  readonly executable: string
  readonly arg: ReadonlyArray<string>
  readonly descendantExecutable: ReadonlyArray<string>
  readonly cwd: string
  readonly privateWorkspace: Option.Option<string>
  readonly timeout: Option.Option<string>
  readonly outputLimitBytes: number
}

const executeRawProcess = (
  input: RawExecInput,
  profile: ProgramProfile
) => Effect.gen(function* () {
  const timeoutMs: number | undefined = yield* (
    Option.isNone(input.timeout)
      ? Effect.succeed<number | undefined>(undefined)
      : parseDuration("timeout", input.timeout.value)
  )
  const request = new ProcessRequest({
    executable: input.executable,
    args: input.arg,
    cwd: input.cwd,
    env: profile === "compatibility" ? compatibilityEnvironment() : {},
    stdout: "capture",
    stderr: "capture",
    outputLimitBytes: input.outputLimitBytes,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  })
  if (profile === "compatibility") {
    const runner = yield* ProcessRunner
    const receipt = yield* runner.run(request)
    return {
      schemaVersion: "airlock/process-receipt/v1",
      profile,
      ...receipt,
      stdout: new TextDecoder().decode(receipt.stdout),
      stderr: new TextDecoder().decode(receipt.stderr)
    }
  }
  if (profile === "native-contained") {
    if (Option.isNone(input.privateWorkspace)) {
      return yield* failInput(
        "private-workspace",
        "is required for native-contained execution and must not already exist"
      )
    }
    const cell = yield* Cell
    const receipt = yield* cell.run(new CellRequest({
      sourceWorkspace: input.cwd,
      privateWorkspace: input.privateWorkspace.value,
      process: request,
      descendantExecutables: input.descendantExecutable,
      network: "deny"
    }))
    return {
      schemaVersion: "airlock/cell-receipt/v1",
      profile,
      ...receipt,
      processReceipt: {
        ...receipt.processReceipt,
        stdout: new TextDecoder().decode(receipt.processReceipt.stdout),
        stderr: new TextDecoder().decode(receipt.processReceipt.stderr)
      }
    }
  }
  return yield* failInput(
    "profile",
    "vm-enclosed has no bundled VM Cell backend; refusing host fallback"
  )
})

/** Raw sealed exec must honor the exact root and descendant executable edges. */
const requireSealedExecAdmission = (
  policy: AdmissionPolicy,
  executable: string,
  descendants: ReadonlyArray<string>
): Effect.Effect<void, CliInputError> => {
  if (
    !nodePath.isAbsolute(executable) ||
    executable.includes("\0") ||
    !policy.executableAllowlist.includes(executable)
  ) {
    return failInput(
      "executable",
      `${executable} is outside the sealed admission executable allowlist`
    )
  }
  if (descendants.length === 0) return Effect.void
  const edge = policy.executableEdges.find((candidate) =>
    candidate.root === executable
  )
  const denied = descendants.find((descendant) =>
    !nodePath.isAbsolute(descendant) ||
    descendant.includes("\0") ||
    !edge?.descendants.includes(descendant)
  )
  return denied === undefined
    ? Effect.void
    : failInput(
        "descendant-executable",
        `${denied} is outside the sealed admission executable edge for ${executable}`
      )
}

const makeExec = (seal: SealContext) => Command.make(
  "exec",
  {
    executable: Flag.String("executable"),
    arg: Flag.String("arg").pipe(Flag.atLeast(0)),
    descendantExecutable: Flag.String("descendant-executable").pipe(
      Flag.atLeast(0)
    ),
    cwd: Flag.String("cwd"),
    profile: profileOption,
    privateWorkspace: Flag.String("private-workspace").pipe(Flag.optional),
    timeout: Flag.String("timeout").pipe(Flag.optional),
    outputLimitBytes: Flag.Int("output-limit-bytes").pipe(Flag.withDefault(1_048_576))
  },
  ({ profile, ...input }) => rendered(
    requireVerb(seal, "exec").pipe(
      Effect.andThen(requireNativeAction(seal, "process.run")),
      Effect.flatMap(() => executeRawProcess(input, profile))
    )
  )
).pipe(Command.withDescription("Run an absolute executable with argv atoms; no command-string form exists"))

const makeSealedExec = (seal: SealContext) => Command.make(
  "exec",
  {
    executable: Flag.String("executable"),
    arg: Flag.String("arg").pipe(Flag.atLeast(0)),
    descendantExecutable: Flag.String("descendant-executable").pipe(
      Flag.atLeast(0)
    ),
    cwd: Flag.String("cwd"),
    privateWorkspace: Flag.String("private-workspace").pipe(Flag.optional),
    timeout: Flag.String("timeout").pipe(Flag.optional),
    outputLimitBytes: Flag.Int("output-limit-bytes").pipe(Flag.withDefault(1_048_576))
  },
  (input) => rendered(Effect.gen(function* () {
    yield* requireVerb(seal, "exec")
    yield* requireNativeAction(seal, "process.run")
    if (seal._tag !== "VerifiedSeal") {
      return yield* failInput("seal", "sealed exec reached an unsealed command graph")
    }
    const policy = yield* bindPolicyPathScopes(seal.grant.admission)
    yield* requireSealedExecAdmission(
      policy,
      input.executable,
      input.descendantExecutable
    )
    const call = yield* admitSealedNativeAction(seal, "process.run", {
      action: "process.run",
      executable: input.executable,
      args: input.arg,
      descendantExecutables: input.descendantExecutable,
      cwd: input.cwd,
      env: {},
      cellProfile: seal.grant.admission.profile,
      stdout: "capture",
      stderr: "capture",
      outputLimitBytes: input.outputLimitBytes
    })
    if (call?.action !== "process.run") {
      return yield* failInput("admission", "sealed exec did not bind process.run")
    }
    return yield* executeRawProcess(
      { ...input, cwd: call.cwd },
      seal.grant.admission.profile
    )
  }))
).pipe(Command.withDescription("Run an admitted absolute executable with argv atoms; no command-string form exists"))

const executeProgram = (
  seal: SealContext,
  source: string,
  rawBindings: Option.Option<string>,
  selectedProfile: ProgramProfile,
  requestedWorkspace: string,
  compact = false
) =>
  Effect.gen(function* () {
    const profile = seal._tag === "VerifiedSeal"
      ? seal.grant.admission.profile
      : selectedProfile
    yield* requireSealedDaemon(seal)
    const home = yield* AirlockHome
    const fs = yield* FileSystem.FileSystem
    const workspace = yield* bindProgramWorkspace(profile, requestedWorkspace)
    const policy = yield* (
      seal._tag === "VerifiedSeal"
        ? bindPolicyPathScopes(seal.grant.admission)
        : supervisorPolicy(profile, workspace).pipe(
            Effect.flatMap(bindPolicyPathScopes)
          )
    )
    const tools = yield* discoveredTools(seal, workspace)
    const parsedBindings = yield* parseBindings(rawBindings)
    const bindingsValue = profile === "native-contained"
      ? { ...parsedBindings, workspace }
      : parsedBindings
    const runtimeLayer = RuntimeLive.pipe(
      Layer.provideMerge(RuntimeConfigLive(new RuntimeConfig({
        workspace,
        profile,
        runJournalDirectory: nodePath.join(home.home, "runs"),
        environment: profile === "compatibility" ? compatibilityEnvironment() : {}
      }))),
      Layer.provideMerge(
        NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))
      )
    )
    const toolActions = new Map(tools.map((tool) => [tool.name, tool]))
    const bindPath: ProgramPathSelectorBinder = profile === "native-contained"
      ? (action, selector) => bindPhysicalPathSelector(workspace, selector).pipe(
          Effect.mapError((cause) => new ProgramActionDecodeFailed({
            action,
            reason: reasonOf(cause)
          })),
          Effect.provideService(FileSystem.FileSystem, fs)
        )
      : unchangedProgramPathSelector
    const programLayer = seal._tag === "VerifiedSeal"
      ? ProgramExecutionWithToolsLive(
          policy,
          toolActions,
          profile,
          new Set(seal.grant.nativeActions),
          { sealDigest: seal.grantDigest },
          bindPath
        )
      : ProgramExecutionWithToolsLive(
          policy,
          toolActions,
          profile,
          undefined,
          undefined,
          bindPath
        )
    const runner = yield* ProgramRunner.pipe(
      Effect.provide(programLayer.pipe(Layer.provideMerge(runtimeLayer)))
    )
    const result = yield* runner.run(new ProgramRequest({ source, bindings: bindingsValue }))
    return {
      schemaVersion: "airlock/program-run/v1",
      profile,
      workspace,
      result: compact
        ? projectCompactProgramRun(result)
        : projectProgramRun(result)
    }
  })

const makeRun = (seal: SealContext) => Command.make(
  "run",
  {
    program: Argument.File("program.air"),
    bindings: Flag.String("bindings").pipe(Flag.optional),
    profile: profileOption,
    workspace: Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))
  },
  ({ program, bindings, profile, workspace: requestedWorkspace }) =>
    renderedProgram(Effect.gen(function* () {
      yield* requireVerb(seal, "run")
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString(program).pipe(
        Effect.mapError((error) => new CliInputError({ field: "program.air", reason: describeFailure(error) }))
      )
      return yield* executeProgram(
        seal,
        source,
        bindings,
        profile,
        requestedWorkspace
      )
    }))
).pipe(Command.withDescription("Run an Airlock program through explicit admission, runtime, Hold, and Outbox seams"))

const makeEvalProgram = (seal: SealContext) => Command.make(
  "eval",
  {
    source: Flag.String("source"),
    bindings: Flag.String("bindings").pipe(Flag.optional),
    profile: profileOption,
    workspace: Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))
  },
  ({ source, bindings, profile, workspace }) =>
    renderedProgram(
      requireVerb(seal, "eval").pipe(
        Effect.andThen(executeProgram(
          seal,
          source,
          bindings,
          profile,
          workspace
        ))
      )
    )
).pipe(Command.withDescription("Run Airlock source supplied as one structured argument by an agent harness"))

const makeAgentRun = (seal: SealContext) => Command.make(
  "run",
  {
    program: Argument.File("program.air"),
    bindings: Flag.String("bindings").pipe(Flag.optional),
    compact: Flag.Boolean("compact").pipe(Flag.withDefault(false)),
    workspace: Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))
  },
  ({ program, bindings, compact, workspace: requestedWorkspace }) =>
    renderedProgram(Effect.gen(function* () {
      yield* requireVerb(seal, "run")
      const profile = yield* agentProgramProfile
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString(program).pipe(
        Effect.mapError((error) =>
          new CliInputError({
            field: "program.air",
            reason: describeFailure(error)
          })
        )
      )
      return yield* executeProgram(
        seal,
        source,
        bindings,
        profile,
        requestedWorkspace,
        compact
      )
    }))
).pipe(
  Command.withDescription(
    "Run an Airlock program under the supervisor-pinned agent profile"
  )
)

const makeAgentEvalProgram = (seal: SealContext) => Command.make(
  "eval",
  {
    source: Flag.String("source"),
    bindings: Flag.String("bindings").pipe(Flag.optional),
    compact: Flag.Boolean("compact").pipe(Flag.withDefault(false)),
    workspace: Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))
  },
  ({ source, bindings, compact, workspace }) =>
    renderedProgram(Effect.gen(function* () {
      yield* requireVerb(seal, "eval")
      const profile = yield* agentProgramProfile
      return yield* executeProgram(
        seal,
        source,
        bindings,
        profile,
        workspace,
        compact
      )
    }))
).pipe(
  Command.withDescription(
    "Run supplied Airlock source under the supervisor-pinned agent profile"
  )
)

/** Sealed program commands expose no profile selector on either binary alias. */
const makeSealedRun = (seal: SealContext) => Command.make(
  "run",
  {
    program: Argument.File("program.air"),
    bindings: Flag.String("bindings").pipe(Flag.optional),
    compact: Flag.Boolean("compact").pipe(Flag.withDefault(false)),
    workspace: Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))
  },
  ({ program, bindings, compact, workspace: requestedWorkspace }) =>
    renderedProgram(Effect.gen(function* () {
      yield* requireVerb(seal, "run")
      if (seal._tag !== "VerifiedSeal") {
        return yield* failInput("seal", "sealed run reached an unsealed command graph")
      }
      const profile = seal.grant.admission.profile
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString(program).pipe(
        Effect.mapError((error) =>
          new CliInputError({ field: "program.air", reason: describeFailure(error) })
        )
      )
      return yield* executeProgram(
        seal,
        source,
        bindings,
        profile,
        requestedWorkspace,
        compact
      )
    }))
).pipe(Command.withDescription("Run an Airlock program under the signed sealed admission"))

const makeSealedEvalProgram = (seal: SealContext) => Command.make(
  "eval",
  {
    source: Flag.String("source"),
    bindings: Flag.String("bindings").pipe(Flag.optional),
    compact: Flag.Boolean("compact").pipe(Flag.withDefault(false)),
    workspace: Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))
  },
  ({ source, bindings, compact, workspace }) =>
    renderedProgram(Effect.gen(function* () {
      yield* requireVerb(seal, "eval")
      if (seal._tag !== "VerifiedSeal") {
        return yield* failInput("seal", "sealed eval reached an unsealed command graph")
      }
      const profile = seal.grant.admission.profile
      return yield* executeProgram(
        seal,
        source,
        bindings,
        profile,
        workspace,
        compact
      )
    }))
).pipe(Command.withDescription("Run supplied Airlock source under the signed sealed admission"))

// ── ledger ──────────────────────────────────────────────────────────────────

const makeLedger = (seal: SealContext) => Command.make("ledger", {}, () =>
  rendered(
    requireVerb(seal, "ledger").pipe(
      Effect.andThen(Effect.flatMap(FileLedger, (ledger) => ledger.entries))
    )
  )
).pipe(Command.withDescription("The append-only record of every act"))

const recentRunLimit = Flag.Int("limit").pipe(
  Flag.withDefault(10),
  Flag.withDescription("Latest Runtime Plans to return (1-100)")
)

const makeRuns = (seal: SealContext) => Command.make(
  "runs",
  { limit: recentRunLimit },
  ({ limit }) => rendered(Effect.gen(function* () {
    yield* requireVerb(seal, "runs")
    if (limit < 1 || limit > 100) {
      return yield* failInput("limit", "must be an integer from 1 through 100")
    }
    const home = yield* AirlockHome
    const recent = yield* makeFileRuntimeRunJournal(
      nodePath.join(home.home, "runs")
    ).recent
    return recent.slice(0, limit)
  }))
).pipe(
  Command.withDescription(
    "List the latest redacted durable receipt for each Runtime Plan"
  )
)

const makeRunReceipt = (seal: SealContext) => Command.make(
  "run-receipt",
  {
    planId: Flag.String("plan-id")
  },
  ({ planId }) => rendered(Effect.gen(function* () {
    yield* requireVerb(seal, "run-receipt")
    const home = yield* AirlockHome
    return yield* makeFileRuntimeRunJournal(
      nodePath.join(home.home, "runs")
    ).inspect(planId)
  }))
).pipe(
  Command.withDescription(
    "Inspect the latest durable Runtime receipt for one Plan id"
  )
)


const makeServe = (seal: SealContext) => Command.make(
  "serve",
  {
    interval: duration("interval", "1s"),
    reapOlderThan: Flag.String("reap-older-than").pipe(Flag.optional)
  },
  ({ interval, reapOlderThan }) => rendered(Effect.gen(function* () {
    yield* requireVerb(seal, "serve")
    if (seal._tag !== "VerifiedSeal") {
      return yield* failInput("seal", "airlock serve requires a verified seal")
    }
    const requiredDaemonUid = process.env["AIRLOCK_DAEMON_UID_INTERNAL"]
    if (requiredDaemonUid !== undefined && (
      typeof process.getuid !== "function" ||
      String(process.getuid()) !== requiredDaemonUid
    )) {
      return yield* failInput("principal", "airlock serve requires the installed daemon UID")
    }
    const intervalMillis = yield* parseDuration("interval", interval)
    const reapOlderThanMillis = Option.isSome(reapOlderThan)
      ? yield* parseDuration("reap-older-than", reapOlderThan.value)
      : undefined
    const socketPath = yield* daemonSocketPath()
    return yield* Effect.raceFirst(
      runDaemon({
        seal,
        intervalMillis,
        ...(reapOlderThanMillis === undefined ? {} : { reapOlderThanMillis })
      }),
      runDaemonHealthServer({
        socketPath,
        state: { grantDigest: seal.grantDigest, ready: true }
      })
    )
  }))
).pipe(Command.withDescription(
  "Run the sealed supervisor loop and health-only local socket"
))

type CurrentCommandVerb = BoxGrantVerb | "change"
type AnyCliCommand = Command.Command<any, any, any, any, any>
type CommandFactory = (seal: SealContext) => AnyCliCommand

type CurrentCommandDescriptor = Readonly<{
  verb: CurrentCommandVerb
  supervisor: CommandFactory
  agent?: CommandFactory
  sealed?: CommandFactory
  nativeAction?: NativeActionName
  sealedOnly?: boolean
}>

/**
 * One construction table owns the complete graph. `serve` is sealed-only;
 * `change` is local-only and its agent factory omits terminal authority.
 */
const commandDescriptors: ReadonlyArray<CurrentCommandDescriptor> = [
  { verb: "rm", supervisor: makeRm, nativeAction: "file.remove" },
  { verb: "write", supervisor: makeWrite, nativeAction: "file.write" },
  { verb: "undo", supervisor: makeUndo },
  { verb: "held", supervisor: makeHeld },
  { verb: "reap", supervisor: makeReap },
  { verb: "send", supervisor: makeSend, nativeAction: "http.stage" },
  { verb: "pending", supervisor: makePending },
  { verb: "commit", supervisor: makeCommit },
  { verb: "cancel", supervisor: makeCancel },
  { verb: "flush", supervisor: makeFlush },
  { verb: "doctor", supervisor: makeDoctor },
  { verb: "capabilities", supervisor: makeCapabilities },
  { verb: "actions", supervisor: makeActions },
  { verb: "schema", supervisor: makeSchema },
  { verb: "exec", supervisor: makeExec, sealed: makeSealedExec, nativeAction: "process.run" },
  { verb: "run", supervisor: makeRun, agent: makeAgentRun, sealed: makeSealedRun },
  { verb: "eval", supervisor: makeEvalProgram, agent: makeAgentEvalProgram, sealed: makeSealedEvalProgram },
  { verb: "ledger", supervisor: makeLedger },
  { verb: "runs", supervisor: makeRuns },
  { verb: "run-receipt", supervisor: makeRunReceipt },
  { verb: "serve", supervisor: makeServe, sealedOnly: true },
  { verb: "change", supervisor: makeChange, agent: makeAgentChange }
]

const unsealedAgentVerbOrder: ReadonlyArray<CurrentCommandVerb> = [
  "doctor",
  "capabilities",
  "actions",
  "schema",
  "run",
  "eval",
  "held",
  "pending",
  "ledger",
  "runs",
  "run-receipt",
  "change"
]

/** A zero-grant root has no subcommands; every candidate is refused by parsing. */
const makeRoot = (
  name: string,
  subcommands: ReadonlyArray<AnyCliCommand>
): AnyCliCommand => Command.make(name).pipe(Command.withSubcommands(subcommands))

const makeUnsealedSupervisorRoot = (seal: SealContext) => makeRoot(
  "airlock",
  commandDescriptors
    .filter((descriptor) => descriptor.sealedOnly !== true)
    .map((descriptor) => descriptor.supervisor(seal))
)

/**
 * The unsealed harness surface remains deliberately reduced and retains its
 * supervisor-environment profile pin.
 */
const makeUnsealedAgentRoot = (seal: SealContext) => makeRoot(
  "airlock-agent",
  unsealedAgentVerbOrder.map((verb) => {
    const descriptor = commandDescriptors.find((item) => item.verb === verb)!
    return (descriptor.agent ?? descriptor.supervisor)(seal)
  })
)

const sealedDescriptorIsEligible = (
  seal: SealContext,
  descriptor: CurrentCommandDescriptor
) => seal._tag === "VerifiedSeal" &&
  descriptor.verb !== "change" &&
  seal.grant.verbs.includes(descriptor.verb) &&
  (descriptor.nativeAction === undefined ||
    seal.grant.nativeActions.includes(descriptor.nativeAction))

/** Both installed aliases consume this same grant-filtered command graph. */
const makeSealedRoot = (seal: SealContext, name: string) => makeRoot(
  name,
  commandDescriptors
    .filter((descriptor) =>
      sealedDescriptorIsEligible(seal, descriptor) &&
      !(name === "airlock-agent" && descriptor.verb === "serve")
    )
    .map((descriptor) =>
      (descriptor.sealed ?? descriptor.supervisor)(seal)
    )
)

/**
 * Seal verification is the process bootstrap boundary. A present, invalid seal
 * exits before AirlockHome, FileLedger, Hold, Outbox, Runtime, or any command
 * handler is constructed. Only an actually absent AIRLOCK_SEAL selects the
 * unchanged compatibility path.
 */
const startupSeal = async (): Promise<SealContext | undefined> => {
  const rawOperatorKeyDigest = process.env[
    "AIRLOCK_OPERATOR_KEY_SHA256_INTERNAL"
  ]
  const expectedOperatorKeyDigest = rawOperatorKeyDigest === undefined
    ? undefined
    : Schema.decodeUnknownOption(Canonical.Sha256Digest)(rawOperatorKeyDigest)
  // A pinned operator key that is not a digest can match no key: refuse to
  // start rather than verify against nothing.
  if (expectedOperatorKeyDigest !== undefined && Option.isNone(expectedOperatorKeyDigest)) {
    console.error(JSON.stringify(new SealVerificationFailed({
      phase: "environment",
      path: "AIRLOCK_OPERATOR_KEY_SHA256_INTERNAL",
      reason: "operator-key-mismatch"
    })))
    process.exitCode = 78
    return undefined
  }
  const readinessPath = process.env["AIRLOCK_GENERATION_READINESS_INTERNAL"]
  const generationMode = process.env["AIRLOCK_GENERATION_MODE_INTERNAL"]
  const startup = loadStartupSeal(
    expectedOperatorKeyDigest === undefined
      ? {}
      : { expectedOperatorKeyDigest: expectedOperatorKeyDigest.value }
  ).pipe(
    Effect.flatMap((seal) =>
      readinessPath !== undefined && seal._tag === "VerifiedSeal"
        ? verifyInstalledReadiness(seal, readinessPath, generationMode).pipe(
            Effect.as(seal)
          )
        : Effect.succeed(seal)
    )
  )
  const result = await Effect.runPromiseExit(startup)
  if (Exit.isSuccess(result)) return result.value
  const failureOption = Cause.findErrorOption(result.cause)
  const failure = Option.isSome(failureOption) &&
      failureOption.value instanceof SealVerificationFailed
    ? failureOption.value
    : new SealVerificationFailed({
        phase: "seal",
        path: process.env["AIRLOCK_SEAL"] ?? "AIRLOCK_SEAL",
        reason: "read-failed"
      })
  console.error(JSON.stringify(failure))
  process.exitCode = 78
  return undefined
}

/** One composition root. Pristine components retain authority; CLI is glue. */
const runCli = async (seal: SealContext): Promise<void> => {
  const agentSurface = process.env["AIRLOCK_AGENT_SURFACE"] === "1" ||
    nodePath.basename(process.argv[0] ?? process.execPath) === "airlock-agent"
  const commandName = agentSurface ? "airlock-agent" : "airlock"
  const root = seal._tag === "VerifiedSeal"
    ? makeSealedRoot(seal, commandName)
    : agentSurface
      ? makeUnsealedAgentRoot(seal)
      : makeUnsealedSupervisorRoot(seal)

  const PlatformAndHomeLayer = layerFromEnv.pipe(
    Layer.provideMerge(BunServices.layer)
  )
  const LedgerLayer = FileLedgerLive.pipe(
    Layer.provideMerge(PlatformAndHomeLayer)
  )
  const StateLayer = Layer.mergeAll(
    LedgerLayer,
    HoldLive.pipe(Layer.provideMerge(LedgerLayer)),
    OutboxLive.pipe(Layer.provideMerge(LedgerLayer))
  )
  const ChangeStateLayer = ChangeLive.pipe(Layer.provideMerge(StateLayer))

  const HostExecutionLayer = Layer.mergeAll(
    ProcessRunnerLive,
    LinuxPlatformLive,
    MacosPlatformLive
  )
  const NativeFileSystemLayer = NativeFileSystemLive(
    new NativeFilesystemConfig({ workspace: process.cwd() })
  ).pipe(Layer.provideMerge(ChangeStateLayer))
  const ExecutionDependencies = Layer.mergeAll(
    NativeFileSystemLayer,
    HostExecutionLayer
  )
  const MainLayer = CellLive.pipe(Layer.provideMerge(ExecutionDependencies))

  // stdout carries results. The command runner prints help through Console
  // for refused invocations too, so its output is collected and routed once
  // the outcome is known; handlers keep the real console.
  const runnerOutput: Array<readonly ["log" | "error", string]> = []
  const collect = (stream: "log" | "error") =>
    (...args: ReadonlyArray<unknown>) => {
      runnerOutput.push([stream, `${args.join(" ")}\n`])
    }
  const runnerConsole: Console.Console = Object.assign(
    Object.create(globalThis.console),
    { log: collect("log"), error: collect("error") }
  )
  const writeRunnerOutput = (refused: boolean) => {
    for (const [stream, text] of runnerOutput) {
      (refused || stream === "error" ? process.stderr : process.stdout).write(text)
    }
  }
  const main = Command.runWith(
    Command.provideSync(root, Console.Console, globalThis.console),
    { version: AIRLOCK_VERSION }
  )(process.argv.slice(2)).pipe(
    Effect.provideService(Console.Console, runnerConsole)
  )

  const runtime = ManagedRuntime.make(MainLayer)
  try {
    const exit = await runtime.runPromiseExit(main)
    if (Exit.isSuccess(exit)) return writeRunnerOutput(false)
    const failure = Cause.squash(exit.cause)
    // Usage errors are reported by the command runner; only the exit status
    // remains. Anything else is a defect and stays loud.
    if (!CliError.isCliError(failure)) throw failure
    const requestedHelp = failure._tag === "ShowHelp" && failure.errors.length === 0
    writeRunnerOutput(!requestedHelp)
    process.exitCode = failure._tag === "ShowHelp"
      ? failure[EffectRuntime.errorExitCode]
      : 1
  } finally {
    await runtime.dispose()
  }
}

const seal = await startupSeal()
if (seal !== undefined) await runCli(seal)
