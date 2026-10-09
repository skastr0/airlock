import { Effect, Layer, Schema } from "effect"
import { Ledger, LedgerEntry, LedgerFailed } from "../core/index.ts"
import { type DurableStorage, ensureSchema } from "./Storage.ts"

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(LedgerEntry))
const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(LedgerEntry)))

const failed = (operation: "record" | "read") => (cause: unknown) =>
  new LedgerFailed({
    operation,
    cause: "DurableObjectSql",
    reason: cause instanceof Error ? cause.message : String(cause)
  })

/**
 * Ledger over the same Durable Object SQLite database as the store. Order is
 * the insertion sequence. Idempotence on the entry key is a unique constraint,
 * so recording a key twice is one row however the two writers interleave.
 */
export const durableLedger = (storage: DurableStorage): Layer.Layer<Ledger, LedgerFailed> =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      yield* Effect.try({ try: () => ensureSchema(storage), catch: failed("read") })
      return Ledger.of({
        record: (entry) =>
          Effect.try({
            try: () => {
              storage.sql.exec(
                "INSERT INTO airlock_ledger (key, entry) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
                entry.key ?? null,
                encodeEntry(entry)
              )
            },
            catch: failed("record")
          }),
        entries: Effect.try({
          try: () =>
            storage.sql
              .exec<{ readonly entry: string }>("SELECT entry FROM airlock_ledger ORDER BY seq")
              .toArray()
              .map((row) => row.entry),
          catch: failed("read")
        }).pipe(
          Effect.flatMap((rows) => decodeEntries(rows).pipe(Effect.mapError(failed("read"))))
        )
      })
    })
  )
