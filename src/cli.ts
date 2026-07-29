#!/usr/bin/env bun
import { Args, Command, Options } from "@effect/cli"
import { BunContext } from "@effect/platform-bun"
import { FileSystem } from "@effect/platform"
import { Console, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import * as nodePath from "node:path"
import * as nodeOs from "node:os"
import { AdmissionPolicy } from "./admission/index.ts"
import { NativeActionCatalog } from "./actions/index.ts"
import { layerFromEnv } from "./AirlockHome.ts"
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
import { ProgramExecutionWithToolsLive, ProgramRequest, ProgramRunner } from "./program/index.ts"
import {
  ToolDefinitionDirectories,
  exportToolActions,
  loadKnownToolDefinitions,
  makeFileToolDefinitionReader
} from "./tools/index.ts"
import { RuntimeConfig, RuntimeConfigLive, RuntimeLive } from "./runtime/index.ts"
import { AIRLOCK_VERSION } from "./version.ts"

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

const failInput = (field: string, reason: string) =>
  Effect.fail(new CliInputError({ field, reason }))

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

const discoveredTools = (workspace: string) =>
  loadKnownToolDefinitions(makeFileToolDefinitionReader(), definitionDirectories(workspace)).pipe(
    Effect.flatMap((registry) => exportToolActions(registry, new Set(NativeActionCatalog.map((action) => action.name)))),
    Effect.mapError((error) => new CliInputError({ field: "tool-definitions", reason: error.message ?? error._tag }))
  )

const bindPolicyPathScopes = (
  policy: AdmissionPolicy
): Effect.Effect<AdmissionPolicy, never, FileSystem.FileSystem> => {
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
    return new AdmissionPolicy({ ...policy, pathAllowlist })
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
    Effect.mapError((error) => new CliInputError({ field: "AIRLOCK_POLICY_FILE", reason: String(error) })),
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(AdmissionPolicy))),
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

const rm = Command.make(
  "rm",
  { target: Args.text({ name: "target" }), scope: scopeOption },
  ({ scope, target }) =>
    rendered(
      resolveWithin(scope, target).pipe(
        Effect.flatMap((resolved) => Effect.flatMap(Hold, (hold) => hold.remove(resolved)))
      )
    )
).pipe(Command.withDescription("Recursive remove — staged, recoverable via undo"))

const write = Command.make(
  "write",
  { target: Args.text({ name: "target" }), content: Args.text({ name: "content" }), scope: scopeOption },
  ({ content, scope, target }) =>
    rendered(
      resolveWithin(scope, target).pipe(
        Effect.flatMap((resolved) => Effect.flatMap(Hold, (hold) => hold.overwrite(resolved, content)))
      )
    )
).pipe(Command.withDescription("Overwrite — previous version held, recoverable"))

const undo = Command.make(
  "undo",
  { id: Args.text({ name: "act-id" }).pipe(Args.optional) },
  ({ id }) =>
    rendered(Effect.gen(function* () {
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

const held = Command.make("held", {}, () =>
  rendered(Effect.flatMap(Hold, (hold) => hold.held))
).pipe(Command.withDescription("List held (recoverable) mutations"))

const reap = Command.make(
  "reap",
  { olderThan: duration("older-than", "7d") },
  ({ olderThan }) => rendered(parseDuration("older-than", olderThan).pipe(
    Effect.flatMap((millis) => Effect.flatMap(Hold, (hold) => hold.reap(millis)))
  ))
).pipe(Command.withDescription("Reclaim held bytes — the second phase, the only unlink"))

// ── emission verbs ──────────────────────────────────────────────────────────

const methodOption = Options.choice("method", ["GET", "POST", "PUT", "PATCH", "DELETE"])
  .pipe(Options.withDefault("POST" as const))

const send = Command.make(
  "send",
  {
    url: Args.text({ name: "url" }),
    method: methodOption,
    body: Options.text("body").pipe(Options.optional),
    hold: duration("hold", "30s")
  },
  ({ body, hold, method, url }) => rendered(parseDuration("hold", hold).pipe(
    Effect.flatMap((millis) => Effect.flatMap(Outbox, (outbox) => outbox.stage(
      new EmissionRequest({ url, method, body: Option.getOrUndefined(body) }),
      millis
    )))
  ))
).pipe(Command.withDescription("Stage an external request — nothing is sent yet"))

const pending = Command.make("pending", {}, () =>
  rendered(Effect.flatMap(Outbox, (outbox) => outbox.pending))
).pipe(Command.withDescription("List staged emissions"))

const commit = Command.make(
  "commit",
  { id: Args.text({ name: "emission-id" }) },
  ({ id }) => rendered(Effect.flatMap(Outbox, (outbox) => outbox.commit(EmissionId.make(id))))
).pipe(Command.withDescription("Approve and send a staged emission now"))

const cancel = Command.make(
  "cancel",
  { id: Args.text({ name: "emission-id" }) },
  ({ id }) => rendered(Effect.flatMap(Outbox, (outbox) => outbox.cancel(EmissionId.make(id))))
).pipe(Command.withDescription("Cancel a staged emission — it was never sent"))

const flush = Command.make("flush", {}, () =>
  rendered(Effect.flatMap(Outbox, (outbox) => outbox.flush))
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

const doctor = Command.make("doctor", {}, () => rendered(capabilityPayload))
  .pipe(Command.withDescription("Report the exact macOS enforcement envelope"))

const capabilities = Command.make("capabilities", {}, () => rendered(capabilityPayload))
  .pipe(Command.withDescription("Machine-readable alias for doctor"))

const actions = Command.make("actions", {
  workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
}, ({ workspace }) => rendered(discoveredTools(nodePath.resolve(workspace)).pipe(
  Effect.map((tools) => ({
    schemaVersion: "airlock/actions/v1",
    actions: NativeActionCatalog,
    definitions: tools.map((tool) => ({
      name: tool.name,
      definitionId: tool.loaded.definition.id,
      version: tool.loaded.definition.version,
      executable: tool.loaded.definition.executables.map((item) => item.selector),
      resultDecoder: tool.action.resultDecoder
    }))
  }))
))).pipe(Command.withDescription("List built-in actions plus inert discovered tool definitions"))

const schema = Command.make(
  "schema",
  { subject: Args.text({ name: "subject" }).pipe(Args.optional) },
  ({ subject }) => rendered(Effect.suspend(() => {
    const requested = Option.getOrElse(subject, () => "all")
    if (!(["all", "actions", "plan", "language"] as const).includes(requested as "all" | "actions" | "plan" | "language")) {
      return failInput("subject", "expected actions, plan, language, or all")
    }
    return Effect.succeed({
      schemaVersion: "airlock/discovery/v1",
      ...(requested === "all" || requested === "actions" ? { actions: NativeActionCatalog } : {}),
      ...(requested === "all" || requested === "plan" ? {
        plan: {
          schemaVersion: "airlock/plan/v1",
          nodes: ["Capture", "Invoke", "Apply", "RequestExternal"],
          invoke: { executable: "absolute path", args: "string[]", commandString: false }
        }
      } : {}),
      ...(requested === "all" || requested === "language" ? {
        language: {
          syntax: "airlock",
          effects: "identifier ActionResolver calls only",
          control: ["let", "if", "for literal range", "return", "assert"]
        }
      } : {})
    })
  }))
).pipe(Command.withDescription("Discover versioned action, Plan, and language contracts"))

const exec = Command.make(
  "exec",
  {
    executable: Options.text("executable"),
    arg: Options.text("arg").pipe(Options.repeated),
    cwd: Options.text("cwd"),
    profile: profileOption,
    privateWorkspace: Options.text("private-workspace").pipe(Options.optional),
    timeout: Options.text("timeout").pipe(Options.optional),
    outputLimitBytes: Options.integer("output-limit-bytes").pipe(Options.withDefault(1_048_576))
  },
  ({ executable, arg, cwd, profile, privateWorkspace, timeout, outputLimitBytes }) =>
    rendered(Effect.gen(function* () {
      const timeoutMs: number | undefined = yield* (
        Option.isNone(timeout) ? Effect.succeed<number | undefined>(undefined) : parseDuration("timeout", timeout.value)
      )
      const request = new ProcessRequest({
          executable,
          args: arg,
          cwd,
          env: profile === "compatibility" ? compatibilityEnvironment() : {},
          stdout: "capture",
          stderr: "capture",
          outputLimitBytes,
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
        if (Option.isNone(privateWorkspace)) {
          return yield* failInput("private-workspace", "is required for native-contained execution and must not already exist")
        }
        const cell = yield* Cell
        const receipt = yield* cell.run(new CellRequest({
          sourceWorkspace: cwd,
          privateWorkspace: privateWorkspace.value,
          process: request,
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
      return yield* failInput("profile", "vm-enclosed has no bundled VM Cell backend; refusing host fallback")
    }))
).pipe(Command.withDescription("Run an absolute executable with argv atoms; no command-string form exists"))

const executeProgram = (
  source: string,
  rawBindings: Option.Option<string>,
  profile: "compatibility" | "native-contained" | "vm-enclosed",
  requestedWorkspace: string
) =>
  Effect.gen(function* () {
    const workspace = yield* bindProgramWorkspace(profile, requestedWorkspace)
    const policy = yield* supervisorPolicy(profile, workspace).pipe(
      Effect.flatMap(bindPolicyPathScopes)
    )
    const tools = yield* discoveredTools(workspace)
    const parsedBindings = yield* parseBindings(rawBindings)
    const bindingsValue = profile === "native-contained"
      ? { ...parsedBindings, workspace }
      : parsedBindings
    const runtimeLayer = RuntimeLive.pipe(
      Layer.provideMerge(RuntimeConfigLive(new RuntimeConfig({
        workspace,
        profile,
        environment: profile === "compatibility" ? compatibilityEnvironment() : {}
      }))),
      Layer.provideMerge(
        NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))
      )
    )
    const programLayer = ProgramExecutionWithToolsLive(
      policy,
      new Map(tools.map((tool) => [tool.name, tool])),
      profile
    ).pipe(
      Layer.provideMerge(runtimeLayer)
    )
    const runner = yield* ProgramRunner.pipe(Effect.provide(programLayer))
    const result = yield* runner.run(new ProgramRequest({ source, bindings: bindingsValue }))
    return {
      schemaVersion: "airlock/program-run/v1",
      profile,
      workspace,
      result: projectProgramRun(result)
    }
  })

const run = Command.make(
  "run",
  {
    program: Args.file({ name: "program.air" }),
    bindings: Options.text("bindings").pipe(Options.optional),
    profile: profileOption,
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
  },
  ({ program, bindings, profile, workspace: requestedWorkspace }) =>
    renderedProgram(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const source = yield* fs.readFileString(program).pipe(
          Effect.mapError((error) => new CliInputError({ field: "program.air", reason: String(error) }))
        )
        return yield* executeProgram(source, bindings, profile, requestedWorkspace)
      })
    )
).pipe(Command.withDescription("Run an Airlock program through explicit admission, runtime, Hold, and Outbox seams"))

const evalProgram = Command.make(
  "eval",
  {
    source: Options.text("source"),
    bindings: Options.text("bindings").pipe(Options.optional),
    profile: profileOption,
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
  },
  ({ source, bindings, profile, workspace }) =>
    renderedProgram(executeProgram(source, bindings, profile, workspace))
).pipe(Command.withDescription("Run Airlock source supplied as one structured argument by an agent harness"))

const agentRun = Command.make(
  "run",
  {
    program: Args.file({ name: "program.air" }),
    bindings: Options.text("bindings").pipe(Options.optional),
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
  },
  ({ program, bindings, workspace: requestedWorkspace }) =>
    renderedProgram(
      Effect.gen(function* () {
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
          source,
          bindings,
          profile,
          requestedWorkspace
        )
      })
    )
).pipe(
  Command.withDescription(
    "Run an Airlock program under the supervisor-pinned agent profile"
  )
)

const agentEvalProgram = Command.make(
  "eval",
  {
    source: Options.text("source"),
    bindings: Options.text("bindings").pipe(Options.optional),
    workspace: Options.text("workspace").pipe(Options.withDefault(process.cwd()))
  },
  ({ source, bindings, workspace }) =>
    renderedProgram(
      agentProgramProfile.pipe(
        Effect.flatMap((profile) =>
          executeProgram(source, bindings, profile, workspace)
        )
      )
    )
).pipe(
  Command.withDescription(
    "Run supplied Airlock source under the supervisor-pinned agent profile"
  )
)

// ── ledger ──────────────────────────────────────────────────────────────────

const ledger = Command.make("ledger", {}, () => rendered(Effect.flatMap(Ledger, (l) => l.entries)))
  .pipe(Command.withDescription("The append-only record of every act"))

const supervisorRoot = Command.make("airlock").pipe(Command.withSubcommands([
  rm, write, undo, held, reap,
  send, pending, commit, cancel, flush,
  doctor, capabilities, actions, schema, exec, run, evalProgram,
  ledger
]))

/**
 * The agent launcher deliberately omits terminal and bypass surfaces. Effects
 * enter through ProgramExecution and supervisor-supplied admission policy.
 * The program may request structured Invoke and Apply nodes, but it cannot
 * select the enclosing profile, invoke a raw CLI escape, dispatch, undo, or
 * reap from this command graph.
 */
const agentRoot = Command.make("airlock-agent").pipe(Command.withSubcommands([
  doctor, capabilities, actions, schema,
  agentRun, agentEvalProgram,
  held, pending, ledger
]))

/** One composition root. Pristine components retain authority; CLI is glue. */
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

const main = process.env["AIRLOCK_AGENT_SURFACE"] === "1"
  ? Command.run(agentRoot, { name: "airlock-agent", version: AIRLOCK_VERSION })(process.argv)
  : Command.run(supervisorRoot, { name: "airlock", version: AIRLOCK_VERSION })(process.argv)

const runtime = ManagedRuntime.make(MainLayer)

try {
  await runtime.runPromise(main)
} finally {
  await runtime.dispose()
}
