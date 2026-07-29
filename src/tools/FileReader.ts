import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import {
  ToolDefinitionDocument,
  ToolDefinitionReadFailed,
  type ToolDefinitionReader,
  type ToolDefinitionLocation
} from "./Definitions.ts"

/**
 * This adapter reads inert JSON documents from one already-authorized
 * directory. It deliberately performs no discovery beyond that directory,
 * parsing, execution, or authority resolution.
 *
 * It is disposable integration glue, not a tool-definition component: the
 * pristine schemas and validation rules remain in Definitions.ts.
 */

export const TOOL_DEFINITION_FILE_SUFFIX = ".airlock-tool.json"
export const DEFAULT_TOOL_DEFINITION_MAX_BYTES = 256 * 1024

const readFailure = (location: ToolDefinitionLocation, reason: string) =>
  new ToolDefinitionReadFailed({ location, reason })

const optionalDirectory = (location: ToolDefinitionLocation) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await lstat(location.directory)
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause &&
          (cause as { readonly code?: unknown }).code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: () => readFailure(location, "cannot inspect exact definition location")
  }).pipe(
    Effect.flatMap((entry) =>
      entry === undefined
        ? Effect.succeed(false)
        : entry.isDirectory() && !entry.isSymbolicLink()
          ? Effect.succeed(true)
          : Effect.fail(readFailure(location, "exact definition location is not a regular directory"))
    )
  )

const listCandidateNames = (location: ToolDefinitionLocation) =>
  Effect.tryPromise({
    try: () => readdir(location.directory, { withFileTypes: true }),
    catch: () => readFailure(location, "cannot list exact definition location")
  }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.name.endsWith(TOOL_DEFINITION_FILE_SUFFIX) && entry.isFile())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "en"))
    )
  )

const readRegularDocument = (
  location: ToolDefinitionLocation,
  file: string,
  maxBytes: number
) =>
  Effect.tryPromise({
    // `O_NOFOLLOW` makes a raced replacement with a symlink fail rather than
    // silently reading through it. The handle's stat identifies what is
    // actually opened, not merely what was listed earlier.
    try: async () => {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error("not-regular")
        if (info.size > maxBytes) throw new Error("too-large")
        const json = await handle.readFile({ encoding: "utf8" })
        if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error("too-large")
        return json
      } finally {
        await handle.close()
      }
    },
    catch: (cause) => {
      const reason = cause instanceof Error && cause.message === "too-large"
        ? `definition exceeds ${maxBytes} byte limit`
        : cause instanceof Error && cause.message === "not-regular"
          ? "definition is not a regular file"
          : "cannot read regular definition file"
      return readFailure(location, reason)
    }
  }).pipe(
    Effect.map((json) =>
      new ToolDefinitionDocument({ location, file, json })
    )
  )

/**
 * Creates an inert filesystem reader for caller-provided exact locations.
 * A directory never recursively discovers definitions; only immediate,
 * regular `*.airlock-tool.json` children are returned in stable order.
 */
export const makeFileToolDefinitionReader = (
  options: { readonly maxBytes?: number } = {}
): ToolDefinitionReader => {
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_DEFINITION_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer")
  }

  return {
    read: (location) =>
      optionalDirectory(location).pipe(
        Effect.flatMap((exists) => exists ? Effect.gen(function* () {
          const names = yield* listCandidateNames(location)
          return yield* Effect.forEach(
            names,
            (name) => readRegularDocument(location, join(location.directory, name), maxBytes),
            { concurrency: 1 }
          )
        }) : Effect.succeed([]))
      )
  }
}
