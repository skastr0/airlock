#!/usr/bin/env bun
import { Args, Command, HelpDoc, Options, ValidationError } from "@effect/cli"
import { BunContext } from "@effect/platform-bun"
import { FileSystem } from "@effect/platform"
import { Console, Effect, JSONSchema, Layer, ManagedRuntime, Option, Schema } from "effect"
import * as nodePath from "node:path"
import * as nodeOs from "node:os"
import {
  AdmissionPolicy,
  AdmissionPolicyDocument,
  AdmissionPolicyV2,
  type BoxGrantVerb,
  admit,
  isAdmissionPolicyV2
} from "./admission/index.ts"
import {
  NativeActionCatalog,
  type NativeActionName,
  nativeActionSchema
} from "./actions/index.ts"
import { AirlockHome, layerFromEnv } from "./AirlockHome.ts"
import { ActId, EmissionId, EmissionRequest, ScopeEscape } from "./domain.ts"
import { Hold } from "./Hold.ts"
import { HoldLive } from "./HoldLive.ts"
import {
  type LanguageValue,
  LanguageValueSchema
} from "./language/evaluator.ts"
import { Ledger, LedgerLive } from "./Ledger.ts"
import { Cell, CellLive, CellRequest } from "./cell/index.ts"
import { MacosPlatform, MacosPlatformLive } from "./platform/macos/index.ts"
import { NativeFileSystemLive, NativeFilesystemConfig } from "./native/index.ts"
import { ProcessRequest, ProcessRunner, ProcessRunnerLive } from "./process/Process.ts"
import { Outbox, OutboxLive } from "./Outbox.ts"
import {
  checkDaemonSocket,
  runDaemon,
  runDaemonHealthServer
} from "./daemon/index.ts"
import {
  ProgramExecutionWithToolsLive,
  ProgramRequest,
  ProgramRunner,
  canonicalizeProgramAction,
  draftForAction
} from "./program/index.ts"
import {
  ToolDefinitionDirectories,
  type ExportedToolAction,
  exportToolActions,
  loadKnownToolDefinitions,
  makeFileToolDefinitionReader
} from "./tools/index.ts"
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
  sealedTools
} from "./seal/index.ts"

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
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.flatMap(emit),
    Effect.catchAll((error) =>
      Console.error(JSON.stringify(error)).pipe(
        Effect.zipRight(Effect.sync(() => {
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
    Effect.catchAll((error) =>
      Console.error(JSON.stringify(error)).pipe(
        Effect.zipRight(Effect.sync(() => {
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
 * Compatibility is the migration posture, so it preserves the supervisor's
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
  Options.text(name).pipe(Options.withDefault(fallback))

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
        reason: error instanceof Error ? error.message : String(error)
      })),
      Effect.asVoid
    )
  : Effect.void

const scopeOption = Options.text("scope").pipe(Options.withDefault("/"))

const profileOption = Options.choice("profile", [
  "compatibility",
  "native-contained",
  "vm-enclosed"
]).pipe(Options.withDefault("compatibility" as const))

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
      reason: cause instanceof Error ? cause.message : String(cause)
    })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(
      Schema.Record({ key: Schema.String, value: LanguageValueSchema })
    )),
    Effect.mapError((cause) => new CliInputError({
      field: "bindings",
      reason: cause instanceof Error ? cause.message : String(cause)
    }))
  )
}

const compatibilityPolicy = (workspace: string) => new AdmissionPolicy({
  schemaVersion: "airlock/admission-policy/v1",
  profile: "compatibility",
  principal: "airlock-cli-agent",
  realm: "local",
  admittedBy: "airlock-cli compatibility supervisor",
  pathAllowlist: [workspace],
  executableAllowlist: [],
  endpointAllowlist: []
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
    reason: "message" in error && typeof error.message === "string"
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
  policy: AdmissionPolicyDocument
): Effect.Effect<AdmissionPolicyDocument, never, FileSystem.FileSystem> => {
  if (policy.profile !== "native-contained") return Effect.succeed(policy)

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathAllowlist = yield* Effect.forEach(
      policy.pathAllowlist,
      (scope) => {
        const recursive = scope.endsWith("/**")
        const rawRoot = recursive ? scope.slice(0, -3) : scope
        const root = rawRoot.length === 0 ? nodePath.parse(scope).root : rawRoot
        if (!nodePath.isAbsolute(root)) return Effect.succeed(scope)
        return fs.realPath(nodePath.resolve(root)).pipe(
          Effect.map((canonical) =>
            recursive
              ? canonical === nodePath.parse(canonical).root
                ? `${canonical}**`
                : `${canonical}/**`
              : canonical
          ),
          // Policies may name a future path. Keep that selector inert and
          // lexical; admission will still fail closed if it does not match the
          // canonical workspace or a requested resource.
          Effect.catchAll(() => Effect.succeed(scope))
        )
      },
      { concurrency: 1 }
    )
    return isAdmissionPolicyV2(policy)
      ? new AdmissionPolicyV2({ ...policy, pathAllowlist })
      : new AdmissionPolicy({ ...policy, pathAllowlist })
  })
}

const sealedAdmissionFailure = (
  action: NativeActionName,
  cause: unknown
) => new CliInputError({
  field: "admission",
  reason: `${action}: ${
    cause instanceof Error
      ? cause.message
      : typeof cause === "object" && cause !== null && "_tag" in cause
        ? String(cause._tag)
        : String(cause)
  }`
})

/**
 * Raw compatibility verbs retain their historical adapters, but a sealed
 * route first constructs and admits the equivalent native-action Plan. Thus a
 * second CLI spelling can never bypass the signed path or endpoint policy.
 */
const bindSealedMutationPath = (
  seal: SealContext,
  path: string
): Effect.Effect<string, CliInputError, FileSystem.FileSystem> => {
  if (
    seal._tag === "UnsealedSeal" ||
    seal.grant.admission.profile !== "native-contained"
  ) return Effect.succeed(path)

  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.realPath(nodePath.dirname(path)).pipe(
      Effect.map((parent) => nodePath.join(parent, nodePath.basename(path))),
      Effect.mapError((cause) => new CliInputError({
        field: "target",
        reason: `cannot bind sealed mutation parent for ${path}: ${String(cause)}`
      }))
    )
  )
}

const admitSealedNativeAction = (
  seal: SealContext,
  action: NativeActionName,
  input: unknown
): Effect.Effect<void, CliInputError, FileSystem.FileSystem> => {
  if (seal._tag === "UnsealedSeal") return Effect.void
  return Effect.gen(function* () {
    const policy = yield* bindPolicyPathScopes(seal.grant.admission)
    const call = yield* canonicalizeProgramAction(action, input).pipe(
      Effect.mapError((cause) => sealedAdmissionFailure(action, cause))
    )
    const request = yield* draftForAction(call, 0).pipe(
      Effect.mapError((cause) => sealedAdmissionFailure(action, cause))
    )
    yield* admit(request.draft, policy).pipe(
      Effect.mapError((cause) => sealedAdmissionFailure(action, cause))
    )
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
): Effect.Effect<AdmissionPolicyDocument, CliInputError, FileSystem.FileSystem> => {
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
    Effect.mapError((error) => new CliInputError({ field: "AIRLOCK_POLICY_FILE", reason: String(error) })),
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(AdmissionPolicyDocument))),
    Effect.mapError((error) => new CliInputError({ field: "AIRLOCK_POLICY_FILE", reason: error.message })),
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
          reason: `cannot resolve native-contained workspace ${requested}: ${String(cause)}`
        })
      )
    )
    const info = yield* fs.stat(workspace).pipe(
      Effect.mapError((cause) =>
        new CliInputError({
          field: "workspace",
          reason: `cannot inspect native-contained workspace ${workspace}: ${String(cause)}`
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

// ── mutation verbs ──────────────────────────────────────────────────────────

const makeRm = (seal: SealContext) => Command.make(
  "rm",
  { target: Args.text({ name: "target" }), scope: scopeOption },
  ({ scope, target }) => rendered(
    requireVerb(seal, "rm").pipe(
      Effect.zipRight(requireNativeAction(seal, "file.remove")),
      Effect.flatMap(() => resolveWithin(scope, target)),
      Effect.flatMap((resolved) => bindSealedMutationPath(seal, resolved)),
      Effect.flatMap((resolved) => admitSealedNativeAction(
        seal,
        "file.remove",
        { action: "file.remove", path: resolved }
      ).pipe(
        Effect.zipRight(Effect.flatMap(Hold, (hold) => hold.remove(resolved)))
      ))
    )
  )
).pipe(Command.withDescription("Recursive remove — staged, recoverable via undo"))

const makeWrite = (seal: SealContext) => Command.make(
  "write",
  { target: Args.text({ name: "target" }), content: Args.text({ name: "content" }), scope: scopeOption },
  ({ content, scope, target }) => rendered(
    requireVerb(seal, "write").pipe(
      Effect.zipRight(requireNativeAction(seal, "file.write")),
      Effect.flatMap(() => resolveWithin(scope, target)),
      Effect.flatMap((resolved) => bindSealedMutationPath(seal, resolved)),
      Effect.flatMap((resolved) => admitSealedNativeAction(
        seal,
        "file.write",
        { action: "file.write", path: resolved, content }
      ).pipe(
        Effect.zipRight(
          Effect.flatMap(Hold, (hold) => hold.overwrite(resolved, content))
        )
      ))
    )
  )
).pipe(Command.withDescription("Overwrite — previous version held, recoverable"))

const makeUndo = (seal: SealContext) => Command.make(
  "undo",
  { id: Args.text({ name: "act-id" }).pipe(Args.optional) },
  ({ id }) =>
    rendered(Effect.gen(function* () {
      yield* requireVerb(seal, "undo")
      const hold = yield* Hold
      if (Option.isNone(id)) return yield* hold.undoLast
      const actId = yield* Schema.decodeUnknown(ActId)(id.value).pipe(
        Effect.mapError((cause) =>
          new CliInputError({
            field: "act-id",
            reason: cause.message
          })
        )
      )
      return yield* hold.undo(actId)
    }))
).pipe(Command.withDescription("Restore a held act (defaults to the most recent)"))

const makeHeld = (seal: SealContext) => Command.make("held", {}, () =>
  rendered(
    requireVerb(seal, "held").pipe(
      Effect.zipRight(Effect.flatMap(Hold, (hold) => hold.held))
    )
  )
).pipe(Command.withDescription("List held (recoverable) mutations"))

const makeReap = (seal: SealContext) => Command.make(
  "reap",
  { olderThan: duration("older-than", "7d") },
  ({ olderThan }) => rendered(
    requireVerb(seal, "reap").pipe(
      Effect.zipRight(parseDuration("older-than", olderThan)),
      Effect.flatMap((millis) => Effect.flatMap(Hold, (hold) => hold.reap(millis)))
    )
  )
).pipe(Command.withDescription("Reclaim held bytes — the second phase, the only unlink"))

// ── emission verbs ──────────────────────────────────────────────────────────

const methodOption = Options.choice("method", ["GET", "POST", "PUT", "PATCH", "DELETE"])
  .pipe(Options.withDefault("POST" as const))

const makeSend = (seal: SealContext) => Command.make(
  "send",
  {
    url: Args.text({ name: "url" }),
    method: methodOption,
    body: Options.text("body").pipe(Options.optional),
    hold: duration("hold", "30s")
  },
  ({ body, hold, method, url }) => rendered(
    requireVerb(seal, "send").pipe(
      Effect.zipRight(requireNativeAction(seal, "http.stage")),
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
          Effect.zipRight(Effect.flatMap(Outbox, (outbox) => outbox.stage(
            new EmissionRequest({ url, method, body: bodyValue }),
            millis
          )))
        )
      })
    )
  )
).pipe(Command.withDescription("Stage an external request — nothing is sent yet"))

const makePending = (seal: SealContext) => Command.make("pending", {}, () =>
  rendered(
    requireVerb(seal, "pending").pipe(
      Effect.zipRight(Effect.flatMap(Outbox, (outbox) => outbox.pending))
    )
  )
).pipe(Command.withDescription("List staged emissions"))

const makeCommit = (seal: SealContext) => Command.make(
  "commit",
  { id: Args.text({ name: "emission-id" }) },
  ({ id }) => rendered(
    requireVerb(seal, "commit").pipe(
      Effect.zipRight(Effect.flatMap(Outbox, (outbox) => outbox.commit(EmissionId.make(id))))
    )
  )
).pipe(Command.withDescription("Approve and send a staged emission now"))

const makeCancel = (seal: SealContext) => Command.make(
  "cancel",
  { id: Args.text({ name: "emission-id" }) },
  ({ id }) => rendered(
    requireVerb(seal, "cancel").pipe(
      Effect.zipRight(Effect.flatMap(Outbox, (outbox) => outbox.cancel(EmissionId.make(id))))
    )
  )
).pipe(Command.withDescription("Cancel a staged emission — it was never sent"))

const makeFlush = (seal: SealContext) => Command.make("flush", {}, () =>
  rendered(
    requireVerb(seal, "flush").pipe(
      Effect.zipRight(Effect.flatMap(Outbox, (outbox) => outbox.flush))
    )
  )
).pipe(Command.withDescription("Send every staged emission whose hold expired"))

// ── discovery + structured computation ──────────────────────────────────────

const capabilityPayload = Effect.flatMap(MacosPlatform, (macos) =>
  macos.capabilityReport.pipe(
    Effect.map((macosReport) => ({
      version: AIRLOCK_VERSION,
      platform: process.platform,
      profiles: {
        compatibility: { available: true, guarantee: "bash-parity; no containment claim" },
        "native-contained": {
          available:
            macosReport.nativeContainment.seatbelt.posture === "enforced" &&
            macosReport.nativeContainment.privateWritableView.posture === "enforced" &&
            macosReport.nativeContainment.liveWorkspaceWriteFence.posture === "enforced" &&
            macosReport.nativeContainment.deniedNetworkFence.posture === "enforced",
          guarantee: "native Cell: private workspace, live-workspace write denial, and opt-in network denial; not VM-equivalent"
        },
        "vm-enclosed": {
          available: macosReport.vmEnclosure.backend.posture === "enforced",
          reason: macosReport.vmEnclosure.backend.caveats.join("; ")
        }
      },
      macos: macosReport
    }))
  )
)

const makeDoctor = (seal: SealContext) => Command.make("doctor", {}, () =>
  rendered(
    requireVerb(seal, "doctor").pipe(Effect.zipRight(capabilityPayload))
  )
).pipe(Command.withDescription("Report the exact macOS enforcement envelope"))

const makeCapabilities = (seal: SealContext) => Command.make("capabilities", {}, () =>
  rendered(
    requireVerb(seal, "capabilities").pipe(Effect.zipRight(capabilityPayload))
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
  workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
}, ({ workspace }) => rendered(
  requireVerb(seal, "actions").pipe(
    Effect.zipRight(discoveredTools(seal, nodePath.resolve(workspace))),
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

const nativeActionInputSchema = (
  name: (typeof NativeActionCatalog)[number]["name"]
) => {
  const canonical = JSONSchema.make(nativeActionSchema(name) as Schema.Schema.Any, {
    target: "jsonSchema2020-12"
  })
  if (!("properties" in canonical)) return canonical
  const { action: _discriminator, ...properties } = canonical.properties
  return {
    ...canonical,
    required: canonical.required.filter((field) => field !== "action"),
    properties
  }
}

const makeSchema = (seal: SealContext) => Command.make(
  "schema",
  { subject: Args.text({ name: "subject" }).pipe(Args.optional) },
  ({ subject }) => rendered(Effect.gen(function* () {
    yield* requireVerb(seal, "schema")
    const requested = Option.getOrElse(subject, () => "all")
    const nativeActions = visibleNativeActions(seal)
    const native = nativeActions.find((action) => action.name === requested)
    if (native !== undefined) {
      return {
        schemaVersion: "airlock/discovery/v1",
        action: {
          ...native,
          inputSchema: nativeActionInputSchema(native.name)
        }
      }
    }
    if (!(["all", "actions", "plan", "language"] as const).includes(requested as "all" | "actions" | "plan" | "language")) {
      return yield* failInput("subject", "expected actions, plan, language, all, or a native action name")
    }
    return {
      schemaVersion: "airlock/discovery/v1",
      ...(requested === "all" || requested === "actions" ? { actions: nativeActions } : {}),
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
  policy: AdmissionPolicyDocument,
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
    executable: Options.text("executable"),
    arg: Options.text("arg").pipe(Options.repeated),
    descendantExecutable: Options.text("descendant-executable").pipe(
      Options.repeated
    ),
    cwd: Options.text("cwd"),
    profile: profileOption,
    privateWorkspace: Options.text("private-workspace").pipe(Options.optional),
    timeout: Options.text("timeout").pipe(Options.optional),
    outputLimitBytes: Options.integer("output-limit-bytes").pipe(Options.withDefault(1_048_576))
  },
  ({ profile, ...input }) => rendered(
    requireVerb(seal, "exec").pipe(
      Effect.zipRight(requireNativeAction(seal, "process.run")),
      Effect.flatMap(() => executeRawProcess(input, profile))
    )
  )
).pipe(Command.withDescription("Run an absolute executable with argv atoms; no command-string form exists"))

const makeSealedExec = (seal: SealContext) => Command.make(
  "exec",
  {
    executable: Options.text("executable"),
    arg: Options.text("arg").pipe(Options.repeated),
    descendantExecutable: Options.text("descendant-executable").pipe(
      Options.repeated
    ),
    cwd: Options.text("cwd"),
    privateWorkspace: Options.text("private-workspace").pipe(Options.optional),
    timeout: Options.text("timeout").pipe(Options.optional),
    outputLimitBytes: Options.integer("output-limit-bytes").pipe(Options.withDefault(1_048_576))
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
    return yield* executeRawProcess(input, seal.grant.admission.profile)
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
    const programLayer = seal._tag === "VerifiedSeal"
      ? ProgramExecutionWithToolsLive(
          policy,
          toolActions,
          profile,
          new Set(seal.grant.nativeActions),
          { sealDigest: seal.grantDigest as `sha256:${string}` }
        )
      : ProgramExecutionWithToolsLive(policy, toolActions, profile)
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
    program: Args.file({ name: "program.air" }),
    bindings: Options.text("bindings").pipe(Options.optional),
    profile: profileOption,
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
  },
  ({ program, bindings, profile, workspace: requestedWorkspace }) =>
    renderedProgram(Effect.gen(function* () {
      yield* requireVerb(seal, "run")
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString(program).pipe(
        Effect.mapError((error) => new CliInputError({ field: "program.air", reason: String(error) }))
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
    source: Options.text("source"),
    bindings: Options.text("bindings").pipe(Options.optional),
    profile: profileOption,
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
  },
  ({ source, bindings, profile, workspace }) =>
    renderedProgram(
      requireVerb(seal, "eval").pipe(
        Effect.zipRight(executeProgram(
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
    program: Args.file({ name: "program.air" }),
    bindings: Options.text("bindings").pipe(Options.optional),
    compact: Options.boolean("compact"),
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
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
            reason: String(error)
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
    source: Options.text("source"),
    bindings: Options.text("bindings").pipe(Options.optional),
    compact: Options.boolean("compact"),
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
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
    program: Args.file({ name: "program.air" }),
    bindings: Options.text("bindings").pipe(Options.optional),
    compact: Options.boolean("compact"),
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
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
          new CliInputError({ field: "program.air", reason: String(error) })
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
    source: Options.text("source"),
    bindings: Options.text("bindings").pipe(Options.optional),
    compact: Options.boolean("compact"),
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
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
      Effect.zipRight(Effect.flatMap(Ledger, (ledger) => ledger.entries))
    )
  )
).pipe(Command.withDescription("The append-only record of every act"))

const recentRunLimit = Options.integer("limit").pipe(
  Options.withDefault(10),
  Options.withDescription("Latest Runtime Plans to return (1-100)")
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
    planId: Options.text("plan-id")
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
    reapOlderThan: Options.text("reap-older-than").pipe(Options.optional)
  },
  ({ interval, reapOlderThan }) => rendered(Effect.gen(function* () {
    yield* requireVerb(seal, "serve")
    if (seal._tag !== "VerifiedSeal") {
      return yield* failInput("seal", "airlock serve requires a verified seal")
    }
    const intervalMillis = yield* parseDuration("interval", interval)
    const reapOlderThanMillis = Option.isSome(reapOlderThan)
      ? yield* parseDuration("reap-older-than", reapOlderThan.value)
      : undefined
    const socketPath = yield* daemonSocketPath()
    return yield* Effect.scoped(Effect.gen(function* () {
      yield* Effect.forkScoped(runDaemon({
        seal,
        intervalMillis,
        ...(reapOlderThanMillis === undefined ? {} : { reapOlderThanMillis })
      }))
      return yield* runDaemonHealthServer({
        socketPath,
        state: { grantDigest: seal.grantDigest, ready: true }
      })
    }))
  }))
).pipe(Command.withDescription(
  "Run the sealed supervisor loop and health-only local socket"
))

type CurrentCommandVerb = BoxGrantVerb
type AnyCliCommand = Command.Command<any, any, any, any>
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
 * zero-configuration supervisor and agent graphs remain unchanged.
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
  { verb: "serve", supervisor: makeServe, sealedOnly: true }
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
  "run-receipt"
]

/**
 * `withSubcommands([])` violates @effect/cli's runtime contract. A zero-grant
 * root consumes one candidate only to return the same CommandMismatch for
 * every spelling; its help has no subcommand descriptor to advertise.
 */
const makeEmptyRoot = (name: string): AnyCliCommand => Command.make(
  name,
  { unavailable: Args.text({ name: "subcommand" }) },
  () => Effect.fail(ValidationError.commandMismatch(
    HelpDoc.p(`Invalid subcommand for ${name} - no subcommands are granted`)
  ))
)

const makeRoot = (
  name: string,
  subcommands: ReadonlyArray<AnyCliCommand>
): AnyCliCommand => subcommands.length === 0
  ? makeEmptyRoot(name)
  : Command.make(name).pipe(
      Command.withSubcommands(
        subcommands as unknown as readonly [AnyCliCommand, ...Array<AnyCliCommand>]
      )
    )

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
  seal.grant.verbs.includes(descriptor.verb) &&
  (descriptor.nativeAction === undefined ||
    seal.grant.nativeActions.includes(descriptor.nativeAction))

/** Both installed aliases consume this same grant-filtered command graph. */
const makeSealedRoot = (seal: SealContext, name: string) => makeRoot(
  name,
  commandDescriptors
    .filter((descriptor) => sealedDescriptorIsEligible(seal, descriptor))
    .map((descriptor) =>
      (descriptor.sealed ?? descriptor.supervisor)(seal)
    )
)

/**
 * Seal verification is the process bootstrap boundary. A present, invalid seal
 * exits before AirlockHome, Ledger, Hold, Outbox, Runtime, or any command
 * handler is constructed. Only an actually absent AIRLOCK_SEAL selects the
 * unchanged compatibility path.
 */
const startupSeal = async (): Promise<SealContext | undefined> => {
  try {
    return await Effect.runPromise(loadStartupSeal())
  } catch (cause) {
    const failure = cause instanceof SealVerificationFailed
      ? cause
      : new SealVerificationFailed({
          phase: "seal",
          path: process.env["AIRLOCK_SEAL"] ?? "AIRLOCK_SEAL",
          reason: "read-failed"
        })
    console.error(JSON.stringify(failure))
    process.exitCode = 78
    return undefined
  }
}

/** One composition root. Pristine components retain authority; CLI is glue. */
const runCli = async (seal: SealContext): Promise<void> => {
  const agentSurface = process.env["AIRLOCK_AGENT_SURFACE"] === "1"
  const commandName = agentSurface ? "airlock-agent" : "airlock"
  const root = seal._tag === "VerifiedSeal"
    ? makeSealedRoot(seal, commandName)
    : agentSurface
      ? makeUnsealedAgentRoot(seal)
      : makeUnsealedSupervisorRoot(seal)

  const PlatformAndHomeLayer = layerFromEnv.pipe(
    Layer.provideMerge(BunContext.layer)
  )
  const LedgerLayer = LedgerLive.pipe(
    Layer.provideMerge(PlatformAndHomeLayer)
  )
  const StateLayer = Layer.mergeAll(
    LedgerLayer,
    HoldLive.pipe(Layer.provideMerge(LedgerLayer)),
    OutboxLive.pipe(Layer.provideMerge(LedgerLayer))
  )

  const MacosExecutionLayer = Layer.mergeAll(ProcessRunnerLive, MacosPlatformLive)
  const NativeFileSystemLayer = NativeFileSystemLive(
    new NativeFilesystemConfig({ workspace: process.cwd() })
  ).pipe(Layer.provideMerge(StateLayer))
  const ExecutionDependencies = Layer.mergeAll(
    NativeFileSystemLayer,
    MacosExecutionLayer
  )
  const MainLayer = CellLive.pipe(Layer.provideMerge(ExecutionDependencies))

  const main = Command.run(root, {
    name: commandName,
    version: AIRLOCK_VERSION
  })(process.argv)

  const runtime = ManagedRuntime.make(MainLayer)
  try {
    await runtime.runPromise(main)
  } finally {
    await runtime.dispose()
  }
}

const seal = await startupSeal()
if (seal !== undefined) await runCli(seal)
