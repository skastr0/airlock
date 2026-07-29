#!/usr/bin/env bun
import { Args, Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import * as nodePath from "node:path"
import { layerFromEnv } from "./AirlockHome.ts"
import {
  ActId,
  EmissionId,
  EmissionRequest,
  ScopeEscape
} from "./domain.ts"
import { Hold, HoldLive } from "./Hold.ts"
import { Ledger, LedgerLive } from "./Ledger.ts"
import { Outbox, OutboxLive } from "./Outbox.ts"

// ── glue: output + error rendering (agent-native: JSON on stdout) ───────────

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

const parseDuration = (raw: string): number | undefined => {
  const match = raw.match(/^(\d+)(ms|s|m|h|d)$/)
  if (match === null) return undefined
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Number(match[1]) * units[match[2] as keyof typeof units]
}

const duration = (name: string, fallback: string) =>
  Options.text(name).pipe(
    Options.withDefault(fallback),
    Options.map((raw) => parseDuration(raw) ?? Number.NaN)
  )

const scopeOption = Options.text("scope").pipe(Options.withDefault("/"))

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

// ── mutation verbs ──────────────────────────────────────────────────────────

const rm = Command.make(
  "rm",
  { target: Args.text({ name: "target" }), scope: scopeOption },
  ({ scope, target }) =>
    rendered(
      resolveWithin(scope, target).pipe(
        Effect.flatMap((resolved) =>
          Effect.flatMap(Hold, (hold) => hold.remove(resolved))
        )
      )
    )
).pipe(Command.withDescription("Recursive remove — staged, recoverable via undo"))

const write = Command.make(
  "write",
  {
    target: Args.text({ name: "target" }),
    content: Args.text({ name: "content" }),
    scope: scopeOption
  },
  ({ content, scope, target }) =>
    rendered(
      resolveWithin(scope, target).pipe(
        Effect.flatMap((resolved) =>
          Effect.flatMap(Hold, (hold) => hold.overwrite(resolved, content))
        )
      )
    )
).pipe(Command.withDescription("Overwrite — previous version held, recoverable"))

const undo = Command.make(
  "undo",
  { id: Args.text({ name: "act-id" }).pipe(Args.optional) },
  ({ id }) =>
    rendered(
      Effect.flatMap(
        Hold,
        (hold) =>
          Option.isSome(id)
            ? hold.undo(ActId.make(id.value))
            : hold.undoLast
      )
    )
).pipe(Command.withDescription("Restore a held act (defaults to the most recent)"))

const held = Command.make("held", {}, () =>
  rendered(Effect.flatMap(Hold, (hold) => hold.held))
).pipe(Command.withDescription("List held (recoverable) mutations"))

const reap = Command.make(
  "reap",
  { olderThan: duration("older-than", "7d") },
  ({ olderThan }) =>
    rendered(Effect.flatMap(Hold, (hold) => hold.reap(olderThan)))
).pipe(
  Command.withDescription(
    "Reclaim held bytes — the second phase, the only unlink"
  )
)

// ── emission verbs ──────────────────────────────────────────────────────────

const methodOption = Options.choice("method", [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
]).pipe(Options.withDefault("POST" as const))

const send = Command.make(
  "send",
  {
    url: Args.text({ name: "url" }),
    method: methodOption,
    body: Options.text("body").pipe(Options.optional),
    hold: duration("hold", "30s")
  },
  ({ body, hold, method, url }) =>
    rendered(
      Effect.flatMap(Outbox, (outbox) =>
        outbox.stage(
          new EmissionRequest({
            url,
            method,
            body: Option.getOrUndefined(body)
          }),
          hold
        )
      )
    )
).pipe(
  Command.withDescription("Stage an external request — nothing is sent yet")
)

const pending = Command.make("pending", {}, () =>
  rendered(Effect.flatMap(Outbox, (outbox) => outbox.pending))
).pipe(Command.withDescription("List staged emissions"))

const commit = Command.make(
  "commit",
  { id: Args.text({ name: "emission-id" }) },
  ({ id }) =>
    rendered(Effect.flatMap(Outbox, (outbox) => outbox.commit(EmissionId.make(id))))
).pipe(Command.withDescription("Approve and send a staged emission now"))

const cancel = Command.make(
  "cancel",
  { id: Args.text({ name: "emission-id" }) },
  ({ id }) =>
    rendered(Effect.flatMap(Outbox, (outbox) => outbox.cancel(EmissionId.make(id))))
).pipe(Command.withDescription("Cancel a staged emission — it was never sent"))

const flush = Command.make("flush", {}, () =>
  rendered(Effect.flatMap(Outbox, (outbox) => outbox.flush))
).pipe(Command.withDescription("Send every staged emission whose hold expired"))

// ── ledger ──────────────────────────────────────────────────────────────────

const ledger = Command.make("ledger", {}, () =>
  rendered(Effect.flatMap(Ledger, (l) => l.entries))
).pipe(Command.withDescription("The append-only record of every act"))

// ── wiring ──────────────────────────────────────────────────────────────────

const root = Command.make("airlock").pipe(
  Command.withSubcommands([
    rm,
    write,
    undo,
    held,
    reap,
    send,
    pending,
    commit,
    cancel,
    flush,
    ledger
  ])
)

const MainLayer = Layer.mergeAll(HoldLive, OutboxLive).pipe(
  Layer.provideMerge(LedgerLive),
  Layer.provideMerge(layerFromEnv),
  Layer.provideMerge(BunContext.layer)
)

const cli = Command.run(root, { name: "airlock", version: "0.1.0" })

cli(process.argv).pipe(Effect.provide(MainLayer), BunRuntime.runMain)
