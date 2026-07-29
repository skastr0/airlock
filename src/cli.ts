#!/usr/bin/env bun
import { Args, Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FileSystem } from "@effect/platform"
import { Console, Effect, Layer, Option, Schema } from "effect"
import * as nodePath from "node:path"
import { NativeActionCatalog } from "./actions/index.ts"
import { layerFromEnv } from "./AirlockHome.ts"
import { ActId, EmissionId, EmissionRequest, ScopeEscape } from "./domain.ts"
import { Hold, HoldLive } from "./Hold.ts"
import { parse } from "./language/parser.ts"
import { evaluate, type ActionResolver, type LanguageValue } from "./language/evaluator.ts"
import { Ledger, LedgerLive } from "./Ledger.ts"
import { Cell, CellLive, CellRequest } from "./cell/index.ts"
import { MacosPlatform, MacosPlatformLive } from "./platform/macos/index.ts"
import { ProcessRequest, ProcessRunner, ProcessRunnerLive } from "./process/Process.ts"
import { Outbox, OutboxLive } from "./Outbox.ts"
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

const rendered = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.flatMap(emit),
    Effect.catchAll((error) =>
      Console.error(JSON.stringify(error)).pipe(
        Effect.zipRight(Effect.sync(() => process.exit(1)))
      )
    )
  )

const failInput = (field: string, reason: string) =>
  Effect.fail(new CliInputError({ field, reason }))

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
      return value as Readonly<Record<string, LanguageValue>>
    },
    catch: (cause) => new CliInputError({
      field: "bindings",
      reason: cause instanceof Error ? cause.message : String(cause)
    })
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
    rendered(Effect.flatMap(Hold, (hold) => Option.isSome(id) ? hold.undo(ActId.make(id.value)) : hold.undoLast))
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

const actions = Command.make("actions", {}, () => rendered(Effect.succeed({
  schemaVersion: "airlock/actions/v1",
  actions: NativeActionCatalog
}))).pipe(Command.withDescription("List the built-in, Unix-shaped action vocabulary"))

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
          env: {},
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

/**
 * The language currently has a pure evaluator and an explicit ActionResolver
 * seam. Until the composed ProgramRunner has concrete admission and runtime
 * adapters, `run` is useful for pure programs and deliberately rejects every
 * effectful action rather than adding a second execution path in CLI glue.
 */
const noActions: ActionResolver<never, CliInputError> = {
  resolve: (action) => failInput("program", `no admitted ProgramRunner is installed; action '${action}' cannot execute`)
}

const run = Command.make(
  "run",
  {
    program: Args.file({ name: "program.air" }),
    bindings: Options.text("bindings").pipe(Options.optional),
    profile: profileOption
  },
  ({ program, bindings, profile }) =>
    rendered(
      (profile === "compatibility"
        ? Effect.void
        : failInput("profile", `${profile} requires an admitted ProgramRunner; refusing compatibility fallback`)
      ).pipe(
        Effect.zipRight(parseBindings(bindings)),
        Effect.flatMap((parsedBindings) => Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.readFileString(program).pipe(
            Effect.mapError((error) => new CliInputError({ field: "program.air", reason: String(error) })),
            Effect.flatMap(parse),
            Effect.flatMap((source) => evaluate(source, noActions, { bindings: parsedBindings }))
          )
        )),
        Effect.map((result) => ({ schemaVersion: "airlock/program-run/v1", profile, result }))
      )
    )
).pipe(Command.withDescription("Evaluate an Airlock program; effects require the admitted ProgramRunner"))

// ── ledger ──────────────────────────────────────────────────────────────────

const ledger = Command.make("ledger", {}, () => rendered(Effect.flatMap(Ledger, (l) => l.entries)))
  .pipe(Command.withDescription("The append-only record of every act"))

const root = Command.make("airlock").pipe(Command.withSubcommands([
  rm, write, undo, held, reap,
  send, pending, commit, cancel, flush,
  doctor, capabilities, actions, schema, exec, run,
  ledger
]))

/** One composition root. Pristine components retain authority; CLI is glue. */
const HomeLayer = layerFromEnv.pipe(Layer.provide(BunContext.layer))
const StateLayer = Layer.mergeAll(
  LedgerLive,
  Layer.provide(HoldLive, LedgerLive),
  Layer.provide(OutboxLive, LedgerLive)
)

const MacosExecutionLayer = Layer.mergeAll(ProcessRunnerLive, MacosPlatformLive)
const CellLayer = Layer.provide(CellLive, MacosExecutionLayer)

const MainLayer = Layer.mergeAll(StateLayer, MacosExecutionLayer, CellLayer).pipe(
  Layer.provideMerge(HomeLayer),
  Layer.provideMerge(BunContext.layer)
)

const cli = Command.run(root, { name: "airlock", version: AIRLOCK_VERSION })

cli(process.argv).pipe(Effect.provide(MainLayer), BunRuntime.runMain)
