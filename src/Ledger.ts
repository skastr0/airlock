import { FileSystem } from "@effect/platform"
import { Context, Effect, Layer, Schema } from "effect"
import { AirlockHome } from "./AirlockHome.ts"
import { LedgerEntry } from "./domain.ts"

/**
 * Append-only receipt history. Ledger serializes operations in one runtime so
 * a successful `record` always contributes one whole JSONL line. Cross-process
 * coordination and fsync durability are deliberately outside this v1 seam.
 */
export class Ledger extends Context.Tag("airlock/Ledger")<
  Ledger,
  {
    readonly record: (entry: LedgerEntry) => Effect.Effect<void, LedgerError>
    readonly entries: Effect.Effect<ReadonlyArray<LedgerEntry>, LedgerError>
  }
>() {}

export class LedgerFilesystemError extends Schema.TaggedError<LedgerFilesystemError>()(
  "LedgerFilesystemError",
  {
    operation: Schema.Literal("append", "read"),
    path: Schema.String,
    reason: Schema.String
  }
) {}

export class LedgerDecodeError extends Schema.TaggedError<LedgerDecodeError>()(
  "LedgerDecodeError",
  {
    path: Schema.String,
    line: Schema.Number,
    reason: Schema.String
  }
) {}

export type LedgerError = LedgerFilesystemError | LedgerDecodeError

const encodeEntry = Schema.encode(Schema.parseJson(LedgerEntry))
const decodeEntry = Schema.decode(Schema.parseJson(LedgerEntry))

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

export const LedgerLive = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { ledgerFile } = yield* AirlockHome
    const mutex = yield* Effect.makeSemaphore(1)

    const record = Effect.fn("Ledger.record")(function* (entry: LedgerEntry) {
      const line = yield* encodeEntry(entry).pipe(
        Effect.mapError(
          (cause) =>
            new LedgerDecodeError({
              path: ledgerFile,
              line: 0,
              reason: `cannot encode receipt: ${reasonOf(cause)}`
            })
        )
      )
      yield* fs.writeFileString(ledgerFile, `${line}\n`, { flag: "a" }).pipe(
        Effect.mapError(
          (cause) =>
            new LedgerFilesystemError({
              operation: "append",
              path: ledgerFile,
              reason: reasonOf(cause)
            })
        )
      )
    })

    const entries = Effect.fn("Ledger.entries")(function* () {
      const raw = yield* fs.readFileString(ledgerFile).pipe(
        Effect.catchTag("SystemError", (error) =>
          error.reason === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(
                new LedgerFilesystemError({
                  operation: "read",
                  path: ledgerFile,
                  reason: reasonOf(error)
                })
              )
        ),
        Effect.catchTag("BadArgument", (error) =>
          Effect.fail(
            new LedgerFilesystemError({
              operation: "read",
              path: ledgerFile,
              reason: reasonOf(error)
            })
          )
        )
      )
      const lines = raw.split("\n").filter((line) => line.trim().length > 0)
      return yield* Effect.forEach(lines, (line, index) =>
        decodeEntry(line).pipe(
          Effect.mapError(
            (cause) =>
              new LedgerDecodeError({
                path: ledgerFile,
                line: index + 1,
                reason: reasonOf(cause)
              })
          )
        )
      )
    })

    return Ledger.of({
      record: (entry) => record(entry).pipe(mutex.withPermits(1)),
      entries: entries().pipe(mutex.withPermits(1))
    })
  })
)
