#!/usr/bin/env bun
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { Cause, Console, Crypto, Effect, Exit, FileSystem, Layer, ManagedRuntime, Option, Runtime as EffectRuntime, Schema } from "effect"
import * as nodePath from "node:path"
import { createInterface } from "node:readline"
import { BoxGrantVerb } from "./core/admission/index.ts"
import { toolGrant } from "./core/admission/ToolGrant.ts"
import { type AirlockFailure, defineAirlock, type Supervisor } from "./core/airlock/Airlock.ts"
import type { Ledger } from "./core/ledger/Ledger.ts"
import { Canonical } from "./core/index.ts"
import { GuestReview, GuestRunner } from "./core/runner/GuestRunner.ts"
import { programRunner } from "./core/runner/ProgramRunner.ts"
import { ToolPolicy, toolPolicy } from "./core/session/ToolPolicy.ts"
import * as WebCrypto from "./core/WebCrypto.ts"
import { layerFromEnv } from "./AirlockHome.ts"
import { HoldLive } from "./HoldLive.ts"
import { Hold } from "./Hold.ts"
import { Change, ChangeLive } from "./change/Change.ts"
import { formatContent, formatInventory, formatReview } from "./change-view.ts"
import { FileArtifacts, FileArtifactsLive } from "./host/FileArtifacts.ts"
import { FileLedger, FileLedgerLive, ledgerLayer } from "./host/FileLedger.ts"
import * as FileOutboxStore from "./host/FileOutboxStore.ts"
import { HeldCalls, HeldCallsConfig, HeldCallsLive } from "./host/HeldCalls.ts"
import { FilesystemContracts, filesystemTools } from "./host/FilesystemTools.ts"
import { filesystemHost } from "./host/FilesystemHost.ts"
import { filesystemRecovery } from "./host/FilesystemRecovery.ts"
import { Cell, CellLive } from "./cell/index.ts"
import { LinuxPlatform, LinuxPlatformLive } from "./platform/linux/index.ts"
import { MacosPlatform, MacosPlatformLive } from "./platform/macos/index.ts"
import {
  FileCopy,
  FileGlob,
  FileInspect,
  FileList,
  FileMkdir,
  FileMove,
  FileRead,
  FileRemove,
  FileStat,
  FileWrite,
  NativeFileSystem,
  NativeFileSystemLive,
  NativeFilesystemConfig
} from "./native/index.ts"
import { ProcessRunner, ProcessRunnerLive } from "./process/Process.ts"
import { AIRLOCK_VERSION } from "./version.ts"
import {
  type SealContext,
  SealVerificationFailed,
  loadStartupSeal,
  verifyInstalledReadiness
} from "./seal/index.ts"
import { describeFailure, reasonOf } from "./FailureText.ts"

/**
 * CLI is deliberately an adapter: it parses agent-facing atoms, opens one
 * Airlock over this machine's filesystem tools, and renders what it answers.
 * Programs act only through that Airlock; nothing here changes a file, starts
 * a process or sends a request itself.
 */

export class CliInputError extends Schema.TaggedError<CliInputError>()(
  "CliInputError",
  { field: Schema.String, reason: Schema.String }
) {}

const emit = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const failed = Effect.sync(() => {
  process.exitCode = 1
})

const rendered = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  format?: (value: A) => string
) =>
  effect.pipe(
    Effect.flatMap(value => format === undefined ? emit(value) : Console.log(format(value))),
    Effect.catch((error) => Console.error(JSON.stringify(error)).pipe(Effect.andThen(failed)))
  )

const failInput = (field: string, reason: string) =>
  Effect.fail(new CliInputError({ field, reason }))

/**
 * Parsing removes every ungranted verb from a sealed command graph. This is a
 * final handler-boundary defense against a stale graph, not the user-visible
 * denial path: denied verbs fail as ordinary command mismatches.
 */
/**
 * What a person decides. Every command of a sealed install is the agent's to
 * run, so no seal can grant these; a person decides from outside the box.
 */
type DecisionVerb = "approve-plan" | "commit" | "cancel" | "undo" | "reap"
type CommandVerb = BoxGrantVerb | DecisionVerb

const granted = (seal: SealContext, verb: CommandVerb | "change") =>
  seal._tag === "UnsealedSeal" || (Schema.is(BoxGrantVerb)(verb) && seal.grant.verbs.includes(verb))

const requireVerb = (seal: SealContext, verb: CommandVerb): Effect.Effect<void, CliInputError> =>
  granted(seal, verb)
    ? Effect.void
    : failInput("verb", `the verified seal does not grant ${verb}`)

// ── the Airlock over this machine ───────────────────────────────────────────

/** How long Hold keeps what a change replaced, so `undo` can put it back. */
const HOLD_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000
/** A response a web request returns beyond this is truncated. */
const RESPONSE_LIMIT_BYTES = 1_048_576

/**
 * With no policy file, a program may read and change files in its workspace
 * and nothing else. Reads run at once; a change runs at once through Hold, so
 * `airlock undo` can put it back. Starting a process or reaching the network
 * needs a policy that grants it.
 */
const workspacePolicy = (workspace: string) => toolPolicy({
  toolGrants: [
    ...[FileInspect, FileStat, FileRead, FileList, FileGlob].map((contract) =>
      toolGrant(contract, { id: contract.tag, when: "now" })),
    ...[FileWrite, FileRemove, FileMkdir, FileCopy, FileMove].map((contract) =>
      toolGrant(contract, { id: contract.tag, when: "now" }))
  ],
  resources: { path: [workspace] },
  budget: { maxCalls: 256, maxInputBytes: 4_194_304 }
})

const policyFileError = (reason: string) => new CliInputError({ field: "AIRLOCK_POLICY_FILE", reason })

/** The supervisor's policy: the sealed one, the file `AIRLOCK_POLICY_FILE` names, or the workspace default. */
const policyFor = (seal: SealContext, workspace: string): Effect.Effect<ToolPolicy, CliInputError, FileSystem.FileSystem> => {
  if (seal._tag === "VerifiedSeal") return Effect.succeed(seal.grant.policy)
  const policyFile = process.env["AIRLOCK_POLICY_FILE"]
  if (policyFile === undefined || policyFile.trim().length === 0) return Effect.succeed(workspacePolicy(workspace))
  return Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(policyFile)).pipe(
    Effect.mapError((error) => policyFileError(describeFailure(error))),
    Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(ToolPolicy), { onExcessProperty: "error" })(text).pipe(
      Effect.mapError((error) => policyFileError(reasonOf(error)))
    )),
    // Flow rules are checked as they are composed; a bad rule is the file's fault.
    Effect.flatMap((policy) => Effect.try({
      try: () => toolPolicy(policy),
      catch: (error) => policyFileError(reasonOf(error))
    }))
  )
}

/** The workspace a run's relative paths name, as the directory it really is. */
const workspaceOf = (requested: string): Effect.Effect<string, CliInputError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspace = yield* fs.realPath(nodePath.resolve(requested)).pipe(
      Effect.mapError((error) => new CliInputError({ field: "workspace", reason: describeFailure(error) }))
    )
    const info = yield* fs.stat(workspace).pipe(
      Effect.mapError((error) => new CliInputError({ field: "workspace", reason: describeFailure(error) }))
    )
    if (info.type !== "Directory") return yield* failInput("workspace", `${workspace} is not a directory`)
    return workspace
  })

const workspaceFlag = Flag.String("workspace").pipe(Flag.withDefault(process.cwd()))

/** Whether this machine enforces every fence `native-contained` promises. */
const nativeContainment = Effect.suspend(
  (): Effect.Effect<boolean, unknown, LinuxPlatform | MacosPlatform> =>
    process.platform === "linux"
      ? Effect.flatMap(LinuxPlatform, (linux) => Effect.map(linux.capabilityReport, (report) =>
          report.cloneOrCopyWorkspace.posture === "enforced" &&
          report.nativeContainment.namespaces.posture === "enforced" &&
          report.nativeContainment.privateWritableView.posture === "enforced" &&
          report.nativeContainment.liveWorkspaceWriteFence.posture === "enforced" &&
          report.nativeContainment.deniedNetworkFence.posture === "enforced" &&
          report.nativeContainment.executableObjectFence.posture === "enforced" &&
          report.nativeContainment.bootstrapEnvironment.posture === "enforced"))
      : Effect.flatMap(MacosPlatform, (macos) => Effect.map(macos.capabilityReport, (report) =>
          report.nativeContainment.seatbelt.posture === "enforced" &&
          report.nativeContainment.privateWritableView.posture === "enforced" &&
          report.nativeContainment.liveWorkspaceWriteFence.posture === "enforced" &&
          report.nativeContainment.deniedNetworkFence.posture === "enforced"))
)

/**
 * Opens the Airlock over this machine for one command: the filesystem tools
 * on `workspace`, held to `policy`, recording into the Airlock home.
 */
const openAirlock = (seal: SealContext, requestedWorkspace: string) =>
  Effect.gen(function* () {
    const workspace = yield* workspaceOf(requestedWorkspace)
    const policy = yield* policyFor(seal, workspace)
    const confiningProfiles = (yield* nativeContainment.pipe(Effect.orElseSucceed(() => false)))
      ? ["native-contained" as const]
      : []
    const services = yield* Effect.gen(function* () {
      return {
        calls: yield* HeldCalls,
        hold: yield* Hold,
        files: yield* NativeFileSystem,
        process: yield* ProcessRunner,
        cell: yield* Cell,
        artifacts: yield* FileArtifacts
      }
    }).pipe(Effect.provide(
      Layer.mergeAll(
        HeldCallsLive(new HeldCallsConfig({ retentionMillis: HOLD_RETENTION_MILLIS })),
        NativeFileSystemLive(new NativeFilesystemConfig({ workspace })),
        FileArtifactsLive
      )
    ))
    const host = yield* filesystemHost({ workspace, confiningProfiles, recovery: filesystemRecovery(services.calls) })
    const airlock = defineAirlock({
      contracts: FilesystemContracts,
      implement: filesystemTools({
        ...services,
        workspace,
        // A process starts from nothing but what its call names, and the call is public.
        environment: {},
        confiningProfiles,
        responseLimitBytes: RESPONSE_LIMIT_BYTES
      }),
      host,
      policy
    })
    const context = yield* Layer.build(
      Layer.mergeAll(airlock.layer(undefined), programRunner).pipe(
        Layer.provideMerge(Layer.mergeAll(FileOutboxStore.layer, ledgerLayer, WebCrypto.layer))
      )
    ).pipe(Effect.mapError((error) => new CliInputError({ field: "airlock", reason: reasonOf(error) })))
    return { airlock, context, workspace }
  })

type Opened = Effect.Success<ReturnType<typeof openAirlock>>

/** A command's work over the opened Airlock. */
const withAirlock = <A, E, R>(
  seal: SealContext,
  verb: CommandVerb,
  workspace: string,
  body: (opened: Opened) => Effect.Effect<A, E, R>
) =>
  requireVerb(seal, verb).pipe(
    Effect.andThen(openAirlock(seal, workspace)),
    Effect.flatMap(body),
    Effect.scoped
  )

// ── programs ────────────────────────────────────────────────────────────────

const parseBindings = (raw: Option.Option<string>): Effect.Effect<Readonly<Record<string, Schema.Json>>, CliInputError> =>
  Option.isNone(raw)
    ? Effect.succeed({})
    : Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(raw.value).pipe(
        Effect.mapError((error) => new CliInputError({ field: "bindings", reason: reasonOf(error) }))
      )

const readProgram = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.mapError((error) => new CliInputError({ field: "program.air", reason: describeFailure(error) }))
  )

/** A program's source: the file it names, or the source given inline. Exactly one. */
const sourceOf = (file: Option.Option<string>, inline: Option.Option<string>) =>
  Option.isSome(file) && Option.isNone(inline)
    ? readProgram(file.value)
    : Option.isNone(file) && Option.isSome(inline)
      ? Effect.succeed(inline.value)
      : failInput("source", "give a program file or --source, not both")

const freshRunId = Effect.map(Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4), (uuid) => `run-${uuid}`)

/**
 * Reviews and runs one program. Its result is the run's outcome; a run that
 * did not produce a result exits 1. The run id names the run again: running
 * the same id once more returns the recorded results of calls that already ran.
 */
const runProgram = (
  seal: SealContext,
  verb: "run" | "eval",
  request: {
    readonly source: Effect.Effect<string, CliInputError, FileSystem.FileSystem>
    readonly workspace: string
    readonly bindings: Option.Option<string>
    readonly runId: Option.Option<string>
    readonly plan: Option.Option<string>
  }
) =>
  rendered(withAirlock(seal, verb, request.workspace, ({ airlock, context, workspace }) =>
    Effect.gen(function* () {
      const source = yield* request.source
      const bindings = yield* parseBindings(request.bindings)
      if (Object.hasOwn(bindings, "workspace")) return yield* failInput("bindings", "workspace is bound by airlock")
      const runId = Option.isSome(request.runId) ? request.runId.value : yield* freshRunId
      const surface = yield* (Option.isSome(request.plan)
        ? airlock.guest({ runId, env: undefined, plan: request.plan.value })
        : airlock.guest({ runId, env: undefined }))
      const runner = yield* GuestRunner
      const outcome = yield* runner.run({ source, surface, bindings: { ...bindings, workspace } })
      if (!outcome.ok) yield* failed
      return { runId, workspace, outcome }
    }).pipe(Effect.provide(context))
  ))

const programFile = Argument.File("program.air")
const runIdFlag = Flag.String("run-id").pipe(Flag.optional, Flag.withDescription("Run again under this id; calls that already ran return their recorded results"))
const planFlag = Flag.String("plan").pipe(Flag.optional, Flag.withDescription("Hold the run to this approved Plan; the calls it covers run without waiting"))
const bindingsFlag = Flag.String("bindings").pipe(Flag.optional, Flag.withDescription("A JSON object of names the program can read"))

const makeRun = (seal: SealContext) => Command.make(
  "run",
  { program: programFile, workspace: workspaceFlag, bindings: bindingsFlag, runId: runIdFlag, plan: planFlag },
  ({ program, ...request }) => runProgram(seal, "run", { ...request, source: readProgram(program) })
).pipe(Command.withDescription("Review and run an Airlock program"))

const makeEval = (seal: SealContext) => Command.make(
  "eval",
  { source: Flag.String("source"), workspace: workspaceFlag, bindings: bindingsFlag, runId: runIdFlag, plan: planFlag },
  ({ source, ...request }) => runProgram(seal, "eval", { ...request, source: Effect.succeed(source) })
).pipe(Command.withDescription("Review and run Airlock source given as one argument"))

const makeReview = (seal: SealContext) => Command.make(
  "review",
  {
    program: programFile.pipe(Argument.optional),
    source: Flag.String("source").pipe(Flag.optional),
    workspace: workspaceFlag,
    bindings: bindingsFlag
  },
  ({ program, source, workspace, bindings }) =>
    rendered(withAirlock(seal, "review", workspace, ({ airlock, context, workspace }) =>
      Effect.gen(function* () {
        const text = yield* sourceOf(program, source)
        const bound = yield* parseBindings(bindings)
        const surface = yield* airlock.guest({ runId: "review", env: undefined })
        const runner = yield* GuestRunner
        const review = yield* runner.review({ source: text, surface, bindings: { ...bound, workspace } })
        if (!review.ok || review.refusals.length > 0) yield* failed
        const approved = review.ok
          ? yield* Effect.flatMap(airlock.supervisor(undefined), (supervisor) => supervisor.approved(review.plan.id))
          : false
        return { review: Schema.encodeSync(GuestReview)(review), approved }
      }).pipe(Effect.provide(context))
    ))
).pipe(Command.withDescription("Review a program without running it: its Plan, any refusals, and whether the Plan is approved"))

const makeDescribe = (seal: SealContext) => Command.make(
  "describe",
  { workspace: workspaceFlag },
  ({ workspace }) =>
    rendered(withAirlock(seal, "describe", workspace, ({ airlock, context }) =>
      Effect.map(airlock.guest({ runId: "describe", env: undefined }), (surface) => ({
        actions: surface.actions,
        description: surface.description
      })).pipe(Effect.provide(context))
    ))
).pipe(Command.withDescription("What a program can call here, and how to write one"))

// ── the supervisor ──────────────────────────────────────────────────────────

const id = Argument.String("id")

/** One supervisor operation, as a command. */
const supervising = <A>(
  verb: CommandVerb,
  description: string,
  operation: (supervisor: Supervisor, id: string) => Effect.Effect<A, AirlockFailure, Ledger>
) => (seal: SealContext) => Command.make(
  verb,
  { id, workspace: workspaceFlag },
  ({ id, workspace }) =>
    rendered(withAirlock(seal, verb, workspace, ({ airlock, context }) =>
      Effect.flatMap(airlock.supervisor(undefined), (supervisor) => operation(supervisor, id)).pipe(Effect.provide(context))
    ))
).pipe(Command.withDescription(description))

const makeApprovePlan = supervising("approve-plan", "Approve a reviewed Plan by its id; a run held to it does not wait for the calls it covers",
  (supervisor, plan) => supervisor.approvePlan(plan))
const makeInspect = supervising("inspect", "Show one recorded call", (supervisor, id) => supervisor.inspect(id))
const makeCommit = supervising("commit", "Approve a waiting call and carry it out now", (supervisor, id) => supervisor.commit(id))
const makeCancel = supervising("cancel", "Drop a waiting call; it never happens", (supervisor, id) => supervisor.cancel(id))
const makeUndo = supervising("undo", "Put back what a completed call changed, from Hold", (supervisor, id) => supervisor.restore(id))

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

const parseDuration = (field: string, raw: string): Effect.Effect<number, CliInputError> => {
  const match = raw.match(/^(\d+)(ms|s|m|h|d)$/)
  return match === null
    ? failInput(field, "must be an integer duration such as 30s, 5m, 1h or 7d")
    : Effect.succeed(Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS])
}

/** Every done receipt promises its `heldUntil`; nothing younger than the retention is reaped. */
const makeReap = (seal: SealContext) => Command.make(
  "reap",
  { olderThan: Flag.String("older-than").pipe(Flag.withDefault("7d")) },
  ({ olderThan }) => rendered(requireVerb(seal, "reap").pipe(
    Effect.andThen(parseDuration("older-than", olderThan)),
    Effect.flatMap((millis) => millis < HOLD_RETENTION_MILLIS
      ? failInput("older-than", "a held call is kept for at least 7d; reap only what is older")
      : Effect.succeed(millis)),
    Effect.flatMap((millis) => Effect.flatMap(Hold, (hold) => hold.reap(millis)))
  ))
).pipe(Command.withDescription("Discard what Hold kept longer ago than --older-than (at least 7d); after this, undo cannot reach it"))

const makePending = (seal: SealContext) => Command.make(
  "pending",
  { workspace: workspaceFlag },
  ({ workspace }) =>
    rendered(withAirlock(seal, "pending", workspace, ({ airlock, context }) =>
      Effect.flatMap(airlock.supervisor(undefined), (supervisor) => supervisor.pending).pipe(Effect.provide(context))
    ))
).pipe(Command.withDescription("List the calls waiting for a decision"))

const makeLedger = (seal: SealContext) => Command.make("ledger", {}, () =>
  rendered(requireVerb(seal, "ledger").pipe(
    Effect.andThen(Effect.flatMap(FileLedger, (ledger) => ledger.entries))
  ))
).pipe(Command.withDescription("The append-only record of every act"))

// ── reviewed local changes ──────────────────────────────────────────────────

const renderedChangeOutcome = <A extends { readonly state: string }, E, R>(
  effect: Effect.Effect<A, E, R>,
  successfulStates: ReadonlyArray<string> = ["installed", "undone"]
) => rendered(effect.pipe(
  Effect.tap((outcome) => successfulStates.includes(outcome.state) ? Effect.void : failed)
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
      if (outcome.state !== "installed") yield* failed
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

// ── this machine ────────────────────────────────────────────────────────────

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
  rendered(requireVerb(seal, "doctor").pipe(Effect.andThen(capabilityPayload)))
).pipe(Command.withDescription("Report the exact host enforcement envelope"))

const makeCapabilities = (seal: SealContext) => Command.make("capabilities", {}, () =>
  rendered(requireVerb(seal, "capabilities").pipe(Effect.andThen(capabilityPayload)))
).pipe(Command.withDescription("Machine-readable alias for doctor"))

// ── the command graph ───────────────────────────────────────────────────────

type CurrentCommandVerb = CommandVerb | "change"
type AnyCliCommand = Command.Command<any, any, any, any, any>
type CommandFactory = (seal: SealContext) => AnyCliCommand

type CurrentCommandDescriptor = Readonly<{
  verb: CurrentCommandVerb
  supervisor: CommandFactory
  agent?: CommandFactory
  /** A person's decision: never on the agent's binary unless a seal grants it. */
  supervisorOnly?: boolean
}>

/** One construction table owns the complete graph. `change` is local-only. */
const commandDescriptors: ReadonlyArray<CurrentCommandDescriptor> = [
  { verb: "describe", supervisor: makeDescribe },
  { verb: "review", supervisor: makeReview },
  { verb: "run", supervisor: makeRun },
  { verb: "eval", supervisor: makeEval },
  { verb: "approve-plan", supervisor: makeApprovePlan, supervisorOnly: true },
  { verb: "pending", supervisor: makePending },
  { verb: "inspect", supervisor: makeInspect },
  { verb: "commit", supervisor: makeCommit, supervisorOnly: true },
  { verb: "cancel", supervisor: makeCancel, supervisorOnly: true },
  { verb: "undo", supervisor: makeUndo, supervisorOnly: true },
  { verb: "reap", supervisor: makeReap, supervisorOnly: true },
  { verb: "ledger", supervisor: makeLedger },
  { verb: "doctor", supervisor: makeDoctor },
  { verb: "capabilities", supervisor: makeCapabilities },
  { verb: "change", supervisor: makeChange, agent: makeAgentChange }
]

/** A zero-grant root has no subcommands; every candidate is refused by parsing. */
const makeRoot = (
  name: string,
  subcommands: ReadonlyArray<AnyCliCommand>
): AnyCliCommand => Command.make(name).pipe(Command.withSubcommands(subcommands))

const makeUnsealedSupervisorRoot = (seal: SealContext) => makeRoot(
  "airlock",
  commandDescriptors.map((descriptor) => descriptor.supervisor(seal))
)

/** The agent's binary has no command that decides what a person decides. */
const makeUnsealedAgentRoot = (seal: SealContext) => makeRoot(
  "airlock-agent",
  commandDescriptors
    .filter((descriptor) => descriptor.supervisorOnly !== true)
    .map((descriptor) => (descriptor.agent ?? descriptor.supervisor)(seal))
)

/** Both installed aliases consume this same grant-filtered command graph. */
const makeSealedRoot = (seal: SealContext, name: string) => makeRoot(
  name,
  commandDescriptors
    .filter((descriptor) =>
      seal._tag === "VerifiedSeal" &&
      descriptor.verb !== "change" &&
      granted(seal, descriptor.verb))
    .map((descriptor) => descriptor.supervisor(seal))
)

/**
 * Seal verification is the process bootstrap boundary. A present, invalid seal
 * exits before AirlockHome, FileLedger, Hold, the Outbox, or any command
 * handler is constructed. Only an actually absent AIRLOCK_SEAL selects the
 * unsealed path.
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
  const StateLayer = HoldLive.pipe(Layer.provideMerge(LedgerLayer))
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
