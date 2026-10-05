import { Context, type Effect, Schema } from "effect"

export const EffectClass = Schema.Literals([
  "observation",
  "mutation",
  "emission",
  "computation"
])
export type EffectClass = typeof EffectClass.Type

export class LedgerEntry extends Schema.Class<LedgerEntry>("LedgerEntry")({
  at: Schema.DateTimeUtcFromString,
  effect: EffectClass,
  act: Schema.Literals([
    "remove",
    "overwrite",
    "undo",
    "reap",
    "retire-runtime-private",
    "stage",
    "commit",
    "cancel"
  ]),
  ref: Schema.String,
  detail: Schema.optionalKey(Schema.String)
}) {}

/**
 * The ledger could not durably record or read. `cause` names the adapter's own
 * error tag so a host can route to its richer recovery without the kernel
 * knowing what a file, a journal tail, or a SQL row is.
 */
export class LedgerFailed extends Schema.TaggedError<LedgerFailed>()("LedgerFailed", {
  operation: Schema.Literals(["record", "read"]),
  cause: Schema.String,
  reason: Schema.String
}) {}

/**
 * Append-only receipt history. A successful `record` means the entry is
 * durable and will appear, in order, in every later `entries`.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly record: (entry: LedgerEntry) => Effect.Effect<void, LedgerFailed>
    readonly entries: Effect.Effect<ReadonlyArray<LedgerEntry>, LedgerFailed>
  }
>()("airlock/core/Ledger") {}
