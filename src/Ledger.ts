import { FileSystem } from "@effect/platform"
import { Context, Effect, Layer, Schema } from "effect"
import { AirlockHome } from "./AirlockHome.ts"
import { LedgerEntry } from "./domain.ts"

export class Ledger extends Context.Tag("airlock/Ledger")<
  Ledger,
  {
    readonly record: (entry: LedgerEntry) => Effect.Effect<void>
    readonly entries: Effect.Effect<ReadonlyArray<LedgerEntry>>
  }
>() {}

const encodeEntry = Schema.encode(Schema.parseJson(LedgerEntry))
const decodeEntry = Schema.decode(Schema.parseJson(LedgerEntry))

export const LedgerLive = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { ledgerFile } = yield* AirlockHome
    return Ledger.of({
      record: (entry) =>
        encodeEntry(entry).pipe(
          Effect.flatMap((line) =>
            fs.writeFileString(ledgerFile, `${line}\n`, { flag: "a" })
          ),
          Effect.orDie
        ),
      entries: fs.readFileString(ledgerFile).pipe(
        Effect.catchTag("SystemError", (e) =>
          e.reason === "NotFound" ? Effect.succeed("") : Effect.die(e)
        ),
        Effect.map((raw) => raw.split("\n").filter((l) => l.trim().length > 0)),
        Effect.flatMap(Effect.forEach((line) => decodeEntry(line))),
        Effect.orDie
      )
    })
  })
)
