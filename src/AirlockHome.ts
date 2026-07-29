import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer, Schema } from "effect"
import * as os from "node:os"
import * as nodePath from "node:path"

/**
 * The persisted realm layout. This is an interaction seam, not a policy
 * object: callers receive locations, while components retain authority over
 * how data at those locations is interpreted.
 */
export class AirlockHome extends Context.Tag("airlock/AirlockHome")<
  AirlockHome,
  {
    readonly home: string
    readonly holdDir: string
    readonly outboxDir: string
    readonly ledgerFile: string
  }
>() {}

export class AirlockHomeError extends Schema.TaggedError<AirlockHomeError>()(
  "AirlockHomeError",
  {
    operation: Schema.Literal("validate", "create-directory"),
    path: Schema.String,
    reason: Schema.String
  }
) {}

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

const validateHome = (home: string) => {
  const normalized = nodePath.resolve(home)
  return home.trim().length === 0
    ? Effect.fail(
        new AirlockHomeError({
          operation: "validate",
          path: home,
          reason: "AIRLOCK_HOME must not be empty"
        })
      )
    : !nodePath.isAbsolute(normalized)
      ? Effect.fail(
          new AirlockHomeError({
            operation: "validate",
            path: home,
            reason: "AIRLOCK_HOME must resolve to an absolute path"
          })
        )
      : Effect.succeed(normalized)
}

const make = (requestedHome: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* validateHome(requestedHome)
    const holdDir = path.join(home, "hold")
    const outboxDir = path.join(home, "outbox")
    const makeDirectory = (directory: string) =>
      fs.makeDirectory(directory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new AirlockHomeError({
              operation: "create-directory",
              path: directory,
              reason: reasonOf(cause)
            })
        )
      )

    yield* makeDirectory(holdDir)
    yield* makeDirectory(outboxDir)
    return AirlockHome.of({
      home,
      holdDir,
      outboxDir,
      ledgerFile: path.join(home, "ledger.jsonl")
    })
  })

/** Explicit home selection is the test and embedding seam. */
export const layer = (home: string) => Layer.effect(AirlockHome, make(home))

/** The CLI default; process environment is resolved once at layer construction. */
export const layerFromEnv = Layer.effect(
  AirlockHome,
  make(process.env["AIRLOCK_HOME"] ?? nodePath.join(os.homedir(), ".airlock"))
)
