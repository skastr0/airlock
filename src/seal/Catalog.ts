import type { Stats } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { NativeActionCatalog } from "../actions/index.ts"
import {
  LoadedToolDefinition,
  ToolDefinitionDirectories,
  ToolDefinitionDocument,
  ToolDefinitionLocation,
  ToolDefinitionRegistry,
  decodeToolDefinition,
  exportToolActions,
  knownToolDefinitionLocations,
  type ExportedToolAction
} from "../tools/Definitions.ts"
import { TOOL_DEFINITION_FILE_SUFFIX } from "../tools/FileReader.ts"
import type { VerifiedCatalogDocument, VerifiedSeal } from "./Seal.ts"

/**
 * Mapping a verified snapshot is deliberately distinct from verifying it. The
 * seal verifier already owns the digest, id, and filesystem checks; this error
 * means the retained bytes no longer satisfy the generic definition decoder.
 */
export class SealedCatalogDecodeFailed
  extends Schema.TaggedError<SealedCatalogDecodeFailed>()(
    "SealedCatalogDecodeFailed",
    {
      id: Schema.String,
      file: Schema.String,
      cause: Schema.String,
      reason: Schema.String
    }
  ) {}

/** A sealed definition still may not collide with the native action surface. */
export class SealedCatalogExportFailed
  extends Schema.TaggedError<SealedCatalogExportFailed>()(
    "SealedCatalogExportFailed",
    {
      name: Schema.String,
      reason: Schema.Literal("duplicate-export", "native-shadow")
    }
  ) {}

/** An immediate legacy definition name is tamper evidence in sealed mode. */
export class LegacyToolDefinitionTamper
  extends Schema.TaggedError<LegacyToolDefinitionTamper>()(
    "LegacyToolDefinitionTamper",
    {
      location: ToolDefinitionLocation,
      path: Schema.String,
      reason: Schema.Literal("legacy-definition-present")
    }
  ) {}

export const LegacyToolDefinitionPathReason = Schema.Literal(
  "symlink",
  "not-directory",
  "path-component-not-directory",
  "changed-during-scan"
)
export type LegacyToolDefinitionPathReason =
  typeof LegacyToolDefinitionPathReason.Type

/** A legacy trust root whose kind cannot be bounded to one exact directory. */
export class LegacyToolDefinitionPathRejected
  extends Schema.TaggedError<LegacyToolDefinitionPathRejected>()(
    "LegacyToolDefinitionPathRejected",
    {
      location: ToolDefinitionLocation,
      reason: LegacyToolDefinitionPathReason
    }
  ) {}

/** Inspection/list failures are refusals, never permission to skip a root. */
export class LegacyToolDefinitionReadFailed
  extends Schema.TaggedError<LegacyToolDefinitionReadFailed>()(
    "LegacyToolDefinitionReadFailed",
    {
      location: ToolDefinitionLocation,
      operation: Schema.Literal("inspect", "list", "reinspect"),
      reason: Schema.String
    }
  ) {}

export type SealedCatalogLoadError =
  | SealedCatalogDecodeFailed
  | SealedCatalogExportFailed

export type LegacyToolDefinitionError =
  | LegacyToolDefinitionTamper
  | LegacyToolDefinitionPathRejected
  | LegacyToolDefinitionReadFailed

/** Exact path overrides are useful to integrations and avoid global HOME edits in tests. */
export interface LegacyDefinitionDirectoryOverrides {
  readonly builtin?: string
  readonly installed?: string
  readonly user?: string
  readonly project?: string
  readonly airlockHome?: string
  readonly homeDirectory?: string
  /** Supplying an empty object models AIRLOCK_HOME as truly unset. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface LegacyDefinitionScanOptions
  extends LegacyDefinitionDirectoryOverrides {
  /** Bypass path derivation with four exact directories. */
  readonly directories?: ToolDefinitionDirectories
}

export interface SealedToolsOptions extends LegacyDefinitionScanOptions {
  /** Defaults to every native name, not merely the grant-enabled subset. */
  readonly nativeActionNames?: ReadonlySet<string>
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

/** The built-in location currently loaded by src/cli.ts, expressed from this module. */
export const DEFAULT_LEGACY_BUILTIN_DEFINITION_DIRECTORY = join(
  moduleDirectory,
  "..",
  "..",
  "tool-definitions"
)

/**
 * Build exactly the four immediate legacy roots used by the unsealed CLI:
 * built-in distribution, AIRLOCK_HOME, user config, and selected workspace.
 * This is a finite trust-surface check; it neither claims nor attempts to scan
 * arbitrary disk locations.
 */
export const legacyDefinitionDirectories = (
  workspace: string,
  overrides: LegacyDefinitionDirectoryOverrides = {}
): ToolDefinitionDirectories => {
  const home = overrides.homeDirectory ?? homedir()
  const env = overrides.env ?? process.env
  const airlockHome = overrides.airlockHome ??
    env["AIRLOCK_HOME"] ??
    join(home, ".airlock")

  return new ToolDefinitionDirectories({
    builtin: overrides.builtin ?? DEFAULT_LEGACY_BUILTIN_DEFINITION_DIRECTORY,
    installed: overrides.installed ?? join(airlockHome, "tools"),
    user: overrides.user ?? join(home, ".config", "airlock", "tools"),
    project: overrides.project ?? join(workspace, ".airlock", "tools")
  })
}

const errorTag = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "_tag" in cause &&
      typeof (cause as { readonly _tag?: unknown })._tag === "string"
    ? (cause as { readonly _tag: string })._tag
    : "ToolDefinitionDecodeFailed"

const errorReason = (cause: unknown): string => {
  if (
    typeof cause === "object" && cause !== null && "reason" in cause &&
    typeof (cause as { readonly reason?: unknown }).reason === "string"
  ) {
    return (cause as { readonly reason: string }).reason
  }
  if (
    typeof cause === "object" && cause !== null && "message" in cause &&
    typeof (cause as { readonly message?: unknown }).message === "string"
  ) {
    return (cause as { readonly message: string }).message
  }
  return errorTag(cause)
}

const decodeSnapshot = (
  snapshot: VerifiedCatalogDocument
): Effect.Effect<LoadedToolDefinition, SealedCatalogDecodeFailed> => {
  const location = new ToolDefinitionLocation({
    // The generic vocabulary has no sealed location kind. This is provenance
    // data only; no reader is retained or invoked by this mapping.
    kind: "installed",
    directory: dirname(snapshot.path)
  })

  return Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(snapshot.rawBytes),
    catch: () => new SealedCatalogDecodeFailed({
      id: snapshot.id,
      file: snapshot.path,
      cause: "ToolDefinitionDecodeFailed",
      reason: "snapshot is not valid UTF-8"
    })
  }).pipe(
    Effect.flatMap((json) => decodeToolDefinition(
      new ToolDefinitionDocument({ location, file: snapshot.path, json })
    ).pipe(
      Effect.mapError((cause) => new SealedCatalogDecodeFailed({
        id: snapshot.id,
        file: snapshot.path,
        cause: errorTag(cause),
        reason: errorReason(cause)
      }))
    )),
    // Reconstruct explicitly so the returned carrier has only inert snapshot
    // provenance, even if the generic decoder's constructor changes later.
    Effect.map((loaded) => new LoadedToolDefinition({
      definition: loaded.definition,
      location,
      file: snapshot.path
    }))
  )
}

/**
 * Decode and export only the byte snapshots retained by startup verification.
 * No path from VerifiedSeal is opened, listed, resolved, or otherwise observed.
 */
export const loadVerifiedCatalog = (
  seal: VerifiedSeal,
  nativeActionNames: ReadonlySet<string>
): Effect.Effect<ReadonlyArray<ExportedToolAction>, SealedCatalogLoadError> =>
  Effect.forEach(seal.catalog, decodeSnapshot, { concurrency: 1 }).pipe(
    Effect.map((definitions) => new ToolDefinitionRegistry({ definitions })),
    Effect.flatMap((registry) => exportToolActions(registry, nativeActionNames)),
    Effect.mapError((error) => error instanceof SealedCatalogDecodeFailed
      ? error
      : new SealedCatalogExportFailed({
        name: error.name,
        reason: error.reason
      }))
  )

const osCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause &&
      typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : undefined

const pathRejected = (
  location: ToolDefinitionLocation,
  reason: LegacyToolDefinitionPathReason
) => new LegacyToolDefinitionPathRejected({ location, reason })

const readFailed = (
  location: ToolDefinitionLocation,
  operation: "inspect" | "list" | "reinspect"
) => new LegacyToolDefinitionReadFailed({
  location,
  operation,
  reason: `cannot ${operation} exact legacy definition directory`
})

type OptionalDirectory = Stats | undefined

const inspectOptionalDirectory = (
  location: ToolDefinitionLocation,
  operation: "inspect" | "reinspect"
): Effect.Effect<OptionalDirectory, LegacyToolDefinitionPathRejected | LegacyToolDefinitionReadFailed> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await lstat(location.directory)
      } catch (cause) {
        if (osCode(cause) === "ENOENT") return undefined
        throw cause
      }
    },
    catch: (cause) => {
      const code = osCode(cause)
      if (code === "ENOTDIR") {
        return pathRejected(location, "path-component-not-directory")
      }
      if (code === "ELOOP" || code === "EMLINK") {
        return pathRejected(location, "symlink")
      }
      return readFailed(location, operation)
    }
  }).pipe(
    Effect.flatMap((entry) => {
      if (entry === undefined) return Effect.succeed(undefined)
      if (entry.isSymbolicLink()) {
        return Effect.fail(pathRejected(location, "symlink"))
      }
      if (!entry.isDirectory()) {
        return Effect.fail(pathRejected(location, "not-directory"))
      }
      return Effect.succeed(entry)
    })
  )

const sameDirectory = (left: Stats, right: Stats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

const listImmediateNames = (
  location: ToolDefinitionLocation
): Effect.Effect<ReadonlyArray<string>, LegacyToolDefinitionPathRejected | LegacyToolDefinitionReadFailed> =>
  Effect.tryPromise({
    try: () => readdir(location.directory, { withFileTypes: true }),
    catch: (cause) => {
      const code = osCode(cause)
      if (code === "ENOENT" || code === "ENOTDIR") {
        return pathRejected(location, "changed-during-scan")
      }
      if (code === "ELOOP" || code === "EMLINK") {
        return pathRejected(location, "symlink")
      }
      return readFailed(location, "list")
    }
  }).pipe(
    // Entry kind is intentionally ignored: a file, directory, socket, or
    // symlink bearing the suffix is equally a conflicting trust source.
    Effect.map((entries) => entries.map((entry) => entry.name).sort())
  )

const scanLegacyLocation = (
  location: ToolDefinitionLocation
): Effect.Effect<void, LegacyToolDefinitionError> =>
  Effect.gen(function* () {
    const before = yield* inspectOptionalDirectory(location, "inspect")
    if (before === undefined) return

    const names = yield* listImmediateNames(location)
    const candidate = names.find((name) =>
      name.endsWith(TOOL_DEFINITION_FILE_SUFFIX)
    )
    if (candidate !== undefined) {
      return yield* new LegacyToolDefinitionTamper({
        location,
        path: join(location.directory, candidate),
        reason: "legacy-definition-present"
      })
    }

    const after = yield* inspectOptionalDirectory(location, "reinspect")
    if (after === undefined || !sameDirectory(before, after)) {
      return yield* pathRejected(location, "changed-during-scan")
    }
  })

/**
 * Refuse any immediate legacy `*.airlock-tool.json` name in the four fixed
 * roots. Missing roots are allowed. Roots that are symlinks/non-directories or
 * cannot be inspected are refused because their suffix trust is ambiguous.
 * The scan is intentionally non-recursive and never reads definition bytes.
 */
export const assertNoLegacyToolDefinitions = (
  workspace: string,
  options: LegacyDefinitionScanOptions = {}
): Effect.Effect<void, LegacyToolDefinitionError> => {
  const directories = options.directories ??
    legacyDefinitionDirectories(workspace, options)
  return Effect.forEach(
    knownToolDefinitionLocations(directories),
    scanLegacyLocation,
    { concurrency: 1, discard: true }
  )
}

/** Legacy refusal always completes before a verified catalog is mapped. */
export const sealedTools = (
  seal: VerifiedSeal,
  workspace: string,
  options: SealedToolsOptions = {}
): Effect.Effect<
  ReadonlyArray<ExportedToolAction>,
  LegacyToolDefinitionError | SealedCatalogLoadError
> =>
  assertNoLegacyToolDefinitions(workspace, options).pipe(
    Effect.zipRight(loadVerifiedCatalog(
      seal,
      options.nativeActionNames ?? new Set(
        NativeActionCatalog.map((action) => action.name)
      )
    ))
  )
