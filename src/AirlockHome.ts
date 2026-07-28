import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer } from "effect"
import * as os from "node:os"
import * as nodePath from "node:path"

export class AirlockHome extends Context.Tag("airlock/AirlockHome")<
  AirlockHome,
  {
    readonly home: string
    readonly holdDir: string
    readonly outboxDir: string
    readonly ledgerFile: string
  }
>() {}

const make = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const holdDir = path.join(home, "hold")
    const outboxDir = path.join(home, "outbox")
    yield* fs.makeDirectory(holdDir, { recursive: true })
    yield* fs.makeDirectory(outboxDir, { recursive: true })
    return AirlockHome.of({
      home,
      holdDir,
      outboxDir,
      ledgerFile: path.join(home, "ledger.jsonl")
    })
  }).pipe(Effect.orDie)

export const layer = (home: string) => Layer.effect(AirlockHome, make(home))

export const layerFromEnv = Layer.effect(
  AirlockHome,
  Effect.suspend(() =>
    make(process.env["AIRLOCK_HOME"] ?? nodePath.join(os.homedir(), ".airlock"))
  )
)
