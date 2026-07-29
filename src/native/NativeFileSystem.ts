import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Either, Layer, Schema } from "effect"
import { lstat } from "node:fs/promises"
import * as nodePath from "node:path"
import { AirlockHome } from "../AirlockHome.ts"
import {
  type HoldFilesystemError,
  type HoldRecoveryRequired,
  Hold,
  type CrossVolumeHold,
  type ReplaceReceipt,
  type SourceEqualsTarget,
  type OverlappingReplacementPaths,
  type SourceNotFound,
  type SourceVolumeMismatch,
  type TargetOccupied,
  type UnsupportedReplacementSymlink
} from "../Hold.ts"
import {
  ProtectedPath,
  type RemoveReceipt,
  ScopeEscape,
  type TargetNotFound
} from "../domain.ts"
import type { LedgerError } from "../Ledger.ts"

/**
 * NativeFileSystem is the small, Unix-shaped filesystem capability for an
 * agent. It deliberately does not model archive, database, package, or other
 * library semantics: those stay in existing tools behind Invoke.
 *
 * This is a candidate domain capability. Its stable seam is the scoped path
 * contract plus the rule that every managed mutation is installed by Hold.
 * It fails closed on symlinks and non file/directory entries rather than
 * pretending lexical containment is an identity-safe handle.
 */

export class NativeFilesystemConfig extends Schema.Class<NativeFilesystemConfig>(
  "NativeFilesystemConfig"
)({
  workspace: Schema.String,
  maxGlobResults: Schema.optionalWith(Schema.Positive, { default: () => 1_000 })
}) {}

export class NativeFilesystemError extends Schema.TaggedError<NativeFilesystemError>()(
  "NativeFilesystemError",
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.String
  }
) {}

export class NativePathUnsupported extends Schema.TaggedError<NativePathUnsupported>()(
  "NativePathUnsupported",
  {
    path: Schema.String,
    kind: Schema.Literal("symlink", "special"),
    reason: Schema.String
  }
) {}

export class NativeGlobInvalid extends Schema.TaggedError<NativeGlobInvalid>()(
  "NativeGlobInvalid",
  { pattern: Schema.String, reason: Schema.String }
) {}

export class NativeGlobLimitExceeded extends Schema.TaggedError<NativeGlobLimitExceeded>()(
  "NativeGlobLimitExceeded",
  { root: Schema.String, pattern: Schema.String, limit: Schema.Number }
) {}

export class NativePathOverlap extends Schema.TaggedError<NativePathOverlap>()(
  "NativePathOverlap",
  {
    source: Schema.String,
    destination: Schema.String,
    reason: Schema.String
  }
) {}

export class NativeJsonInvalid extends Schema.TaggedError<NativeJsonInvalid>()(
  "NativeJsonInvalid",
  { path: Schema.String, reason: Schema.String }
) {}

export const NativeEntryKind = Schema.Literal("file", "directory")
export type NativeEntryKind = typeof NativeEntryKind.Type

export class NativeStat extends Schema.Class<NativeStat>("NativeStat")({
  path: Schema.String,
  kind: NativeEntryKind,
  bytes: Schema.Number,
  mode: Schema.Number,
  device: Schema.Number,
  inode: Schema.Number
}) {}

export class NativeListEntry extends Schema.Class<NativeListEntry>("NativeListEntry")({
  name: Schema.String,
  stat: NativeStat
}) {}

export class NativeWriteReceipt extends Schema.Class<NativeWriteReceipt>("NativeWriteReceipt")({
  receipt: Schema.Struct({
    id: Schema.String,
    source: Schema.String,
    target: Schema.String,
    kind: NativeEntryKind,
    previousHeld: Schema.Boolean,
    at: Schema.DateTimeUtc,
    metadata: Schema.Struct({
      device: Schema.Number,
      inode: Schema.optional(Schema.Number),
      mode: Schema.Number,
      bytes: Schema.Number
    })
  }),
  bytes: Schema.Number
}) {}

export class NativeMoveReceipt extends Schema.Class<NativeMoveReceipt>("NativeMoveReceipt")({
  install: NativeWriteReceipt,
  sourceRemoval: Schema.Struct({
    id: Schema.String,
    target: Schema.String,
    kind: NativeEntryKind,
    at: Schema.DateTimeUtc
  })
}) {}

export class NativeMkdirReceipt extends Schema.Class<NativeMkdirReceipt>("NativeMkdirReceipt")({
  path: Schema.String,
  installs: Schema.Array(NativeWriteReceipt)
}) {}

export class NativeMovePartiallyApplied extends Schema.TaggedError<NativeMovePartiallyApplied>()(
  "NativeMovePartiallyApplied",
  {
    source: Schema.String,
    destination: Schema.String,
    install: NativeWriteReceipt,
    reason: Schema.String
  }
) {}

export class NativeMkdirPartiallyApplied extends Schema.TaggedError<NativeMkdirPartiallyApplied>()(
  "NativeMkdirPartiallyApplied",
  {
    path: Schema.String,
    failedDirectory: Schema.String,
    installs: Schema.Array(NativeWriteReceipt),
    reason: Schema.String
  }
) {}

export type NativeFilesystemErrorUnion =
  | ScopeEscape
  | NativeFilesystemError
  | NativePathUnsupported
  | NativeGlobInvalid
  | NativeGlobLimitExceeded
  | NativePathOverlap
  | NativeJsonInvalid
  | NativeMovePartiallyApplied
  | NativeMkdirPartiallyApplied
  | ProtectedPath
  | SourceNotFound
  | SourceVolumeMismatch
  | SourceEqualsTarget
  | OverlappingReplacementPaths
  | UnsupportedReplacementSymlink
  | TargetOccupied
  | HoldFilesystemError
  | HoldRecoveryRequired
  | CrossVolumeHold
  | LedgerError
  | TargetNotFound

export class NativeFileSystem extends Context.Tag("airlock/NativeFileSystem")<
  NativeFileSystem,
  {
    readonly workspace: string
    readonly inspect: (path: string) => Effect.Effect<NativeStat, NativeFilesystemErrorUnion>
    readonly stat: (path: string) => Effect.Effect<NativeStat, NativeFilesystemErrorUnion>
    readonly readBytes: (path: string) => Effect.Effect<Uint8Array, NativeFilesystemErrorUnion>
    readonly readText: (path: string) => Effect.Effect<string, NativeFilesystemErrorUnion>
    readonly readJson: (path: string) => Effect.Effect<unknown, NativeFilesystemErrorUnion>
    readonly list: (path: string) => Effect.Effect<ReadonlyArray<NativeListEntry>, NativeFilesystemErrorUnion>
    readonly glob: (root: string, pattern: string) => Effect.Effect<ReadonlyArray<string>, NativeFilesystemErrorUnion>
    readonly writeBytes: (path: string, bytes: Uint8Array) => Effect.Effect<NativeWriteReceipt, NativeFilesystemErrorUnion>
    readonly writeText: (path: string, content: string) => Effect.Effect<NativeWriteReceipt, NativeFilesystemErrorUnion>
    readonly remove: (path: string) => Effect.Effect<RemoveReceipt, NativeFilesystemErrorUnion>
    readonly copy: (source: string, destination: string) => Effect.Effect<NativeWriteReceipt, NativeFilesystemErrorUnion>
    readonly move: (source: string, destination: string) => Effect.Effect<NativeMoveReceipt, NativeFilesystemErrorUnion>
    readonly mkdir: (path: string, options?: { readonly parents?: boolean }) => Effect.Effect<NativeMkdirReceipt, NativeFilesystemErrorUnion>
  }
>() {}

const reasonOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

const error = (operation: string, path: string) => (cause: unknown) =>
  new NativeFilesystemError({ operation, path, reason: reasonOf(cause) })

const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT"

const toReceipt = (receipt: ReplaceReceipt, bytes: number) =>
  new NativeWriteReceipt({ receipt, bytes })

const simpleSegment = (segment: string) => {
  let expression = "^"
  for (const character of segment) {
    if (character === "*") expression += "[^/]*"
    else if (character === "?") expression += "[^/]"
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`${expression}$`)
}

const make = (config: NativeFilesystemConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const hold = yield* Hold
    const home = yield* AirlockHome
    const requestedWorkspace = nodePath.resolve(config.workspace)

    const rootInfo = yield* Effect.tryPromise({
      try: () => lstat(requestedWorkspace),
      catch: error("lstat workspace", requestedWorkspace)
    })
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      return yield* new NativePathUnsupported({
        path: requestedWorkspace,
        kind: rootInfo.isSymbolicLink() ? "symlink" : "special",
        reason: "workspace must be a physical directory"
      })
    }
    const workspace = yield* fs.realPath(requestedWorkspace).pipe(
      Effect.mapError(error("resolve workspace", requestedWorkspace))
    )

    const within = (candidate: string) =>
      candidate === workspace || candidate.startsWith(`${workspace}${nodePath.sep}`)

    /** Resolve and walk every existing component without following symlinks. */
    const resolve = Effect.fn("NativeFileSystem.resolve")(function* (raw: string) {
      const resolved = nodePath.resolve(workspace, raw)
      if (!within(resolved)) return yield* new ScopeEscape({ requested: resolved, scope: workspace })
      const relative = nodePath.relative(workspace, resolved)
      const segments = relative === "" ? [] : relative.split(nodePath.sep)
      let current = workspace
      for (const segment of segments) {
        current = nodePath.join(current, segment)
        const entry = yield* Effect.tryPromise({
          try: () => lstat(current),
          // Preserve the host error long enough to distinguish a proposed
          // absent suffix from a permission or I/O failure.
          catch: (cause) => cause
        }).pipe(Effect.either)
        if (Either.isLeft(entry)) {
          if (!isNotFound(entry.left)) {
            return yield* new NativeFilesystemError({
              operation: "lstat path",
              path: current,
              reason: reasonOf(entry.left)
            })
          }
          // A missing suffix is legitimate for a proposed write. The parent
          // walk has already established that every existing component was a
          // physical directory.
          break
        }
        const info = entry.right
        if (info.isSymbolicLink()) {
          return yield* new NativePathUnsupported({
            path: current,
            kind: "symlink",
            reason: "symlinks are outside the native filesystem contract"
          })
        }
        if (!info.isFile() && !info.isDirectory()) {
          return yield* new NativePathUnsupported({
            path: current,
            kind: "special",
            reason: "only regular files and directories are supported"
          })
        }
        if (current !== resolved && !info.isDirectory()) {
          return yield* new NativeFilesystemError({
            operation: "resolve path",
            path: current,
            reason: "a non-directory path component cannot contain a child"
          })
        }
      }
      return resolved
    })

    const statResolved = (resolved: string) =>
      Effect.tryPromise({
        try: () => lstat(resolved),
        catch: error("lstat", resolved)
      }).pipe(
        Effect.flatMap((info) => {
          if (info.isSymbolicLink()) {
            return new NativePathUnsupported({ path: resolved, kind: "symlink", reason: "symlinks are not supported" })
          }
          if (!info.isFile() && !info.isDirectory()) {
            return new NativePathUnsupported({ path: resolved, kind: "special", reason: "only regular files and directories are supported" })
          }
          return Effect.succeed(new NativeStat({
            path: resolved,
            kind: info.isDirectory() ? "directory" : "file",
            bytes: info.size,
            mode: info.mode,
            device: info.dev,
            inode: info.ino
          }))
        })
      )

    const checked = (raw: string) => resolve(raw).pipe(Effect.flatMap(statResolved))
    const mutationPath = (raw: string) => resolve(raw).pipe(
      Effect.flatMap((resolved) =>
        resolved === workspace
          ? Effect.fail(new ProtectedPath({
              target: resolved,
              reason: "the native filesystem capability does not replace its workspace root"
            }))
          : Effect.succeed(resolved)
      )
    )

    const pathsOverlap = (left: string, right: string) =>
      left === right ||
      left.startsWith(`${right}${nodePath.sep}`) ||
      right.startsWith(`${left}${nodePath.sep}`)

    const rejectOverlap = (source: string, destination: string) =>
      pathsOverlap(source, destination)
        ? Effect.fail(new NativePathOverlap({
            source,
            destination,
            reason: "recursive copy and move paths must not contain one another"
          }))
        : Effect.void

    const admitDestinationParent = (destination: string) =>
      statResolved(nodePath.dirname(destination)).pipe(
        Effect.flatMap((parent) =>
          parent.kind === "directory"
            ? Effect.void
            : Effect.fail(new NativeFilesystemError({
                operation: "admit destination",
                path: destination,
                reason: "destination parent is not a directory"
              }))
        )
      )

    // Staging is private Airlock state. `replaceFrom` then moves the staged
    // object into managed state and holds any displaced live binding.
    const stagePath = () => path.join(home.holdDir, `native-stage-${crypto.randomUUID()}`)
    const stageBytes = (bytes: Uint8Array) => {
      const stage = stagePath()
      return fs.writeFile(stage, bytes).pipe(
        Effect.mapError(error("write private stage", stage)),
        Effect.as(stage)
      )
    }

    const install = (target: string, stage: string, bytes: number) =>
      hold.replaceFrom(target, stage).pipe(Effect.map((receipt) => toReceipt(receipt, bytes)))

    const inspect = (raw: string) => checked(raw)
    const stat = inspect

    const readBytes = (raw: string) =>
      checked(raw).pipe(
        Effect.flatMap((entry) =>
          entry.kind === "file"
            ? fs.readFile(entry.path).pipe(Effect.mapError(error("read bytes", entry.path)))
            : Effect.fail(new NativeFilesystemError({ operation: "read bytes", path: entry.path, reason: "path is a directory" }))
        )
      )

    const readText = (raw: string) =>
      readBytes(raw).pipe(
        Effect.flatMap((bytes) =>
          Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: (cause) => new NativeFilesystemError({ operation: "decode text", path: raw, reason: reasonOf(cause) })
          })
        )
      )

    const readJson = (raw: string) =>
      readText(raw).pipe(
        Effect.flatMap((text) => Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => new NativeJsonInvalid({ path: raw, reason: reasonOf(cause) })
        }))
      )

    const list = (raw: string) =>
      checked(raw).pipe(
        Effect.flatMap((directory) =>
          directory.kind !== "directory"
            ? Effect.fail(new NativeFilesystemError({ operation: "list", path: directory.path, reason: "path is not a directory" }))
            : fs.readDirectory(directory.path).pipe(
                Effect.mapError(error("list directory", directory.path)),
                Effect.flatMap((names) => Effect.forEach(names.sort(), (name) =>
                  statResolved(nodePath.join(directory.path, name)).pipe(
                    Effect.map((entry) => new NativeListEntry({ name, stat: entry }))
                  )
                ))
              )
        )
      )

    /** `fs.copy` has rich semantics; native actions admit only a physical tree. */
    const verifyTree = (
      entry: NativeStat
    ): Effect.Effect<number, NativeFilesystemError | NativePathUnsupported> =>
      entry.kind !== "directory"
        ? Effect.succeed(entry.bytes)
        : fs.readDirectory(entry.path).pipe(
            Effect.mapError(error("inspect copy tree", entry.path)),
            Effect.flatMap((names) => Effect.forEach(names, (name) =>
              statResolved(nodePath.join(entry.path, name)).pipe(Effect.flatMap(verifyTree))
            )),
            Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0))
          )

    const validatePattern = (pattern: string): Effect.Effect<ReadonlyArray<string>, NativeGlobInvalid> => {
      if (pattern.length === 0 || nodePath.isAbsolute(pattern) || pattern.split(/[\\/]/).some((segment) => segment === "..")) {
        return Effect.fail(new NativeGlobInvalid({ pattern, reason: "pattern must be a non-empty relative path without traversal" }))
      }
      if (/[\[\]{}]/.test(pattern)) {
        return Effect.fail(new NativeGlobInvalid({ pattern, reason: "character classes and brace expansion are not supported" }))
      }
      return Effect.succeed(pattern.split(/[\\/]/))
    }

    const glob = (rawRoot: string, pattern: string) =>
      resolve(rawRoot).pipe(
        Effect.flatMap((root) => statResolved(root)),
        Effect.flatMap((rootInfo) =>
          rootInfo.kind !== "directory"
            ? Effect.fail(new NativeFilesystemError({ operation: "glob", path: rootInfo.path, reason: "root is not a directory" }))
            : validatePattern(pattern).pipe(
                Effect.flatMap((segments) => {
                  const found: Array<string> = []
                  const visit = (directory: string, index: number): Effect.Effect<void, NativeFilesystemErrorUnion> => {
                    if (found.length > config.maxGlobResults) {
                      return Effect.fail(new NativeGlobLimitExceeded({ root: rootInfo.path, pattern, limit: config.maxGlobResults }))
                    }
                    const segment = segments[index]
                    if (segment === undefined) return Effect.void
                    if (segment === "**") {
                      return Effect.gen(function* () {
                        yield* visit(directory, index + 1)
                        const names = yield* fs.readDirectory(directory).pipe(Effect.mapError(error("glob list", directory)))
                        yield* Effect.forEach(names, (name) => {
                          const child = nodePath.join(directory, name)
                          return statResolved(child).pipe(
                            Effect.flatMap((entry) => entry.kind === "directory" ? visit(child, index) : Effect.void)
                          )
                        })
                      })
                    }
                    const matcher = simpleSegment(segment)
                    return fs.readDirectory(directory).pipe(
                      Effect.mapError(error("glob list", directory)),
                      Effect.flatMap((names) => Effect.forEach(names, (name) => {
                        if (!matcher.test(name)) return Effect.void
                        const child = nodePath.join(directory, name)
                        return statResolved(child).pipe(
                          Effect.flatMap((entry) => {
                            if (index === segments.length - 1) {
                              found.push(entry.path)
                              return found.length > config.maxGlobResults
                                ? Effect.fail(new NativeGlobLimitExceeded({ root: rootInfo.path, pattern, limit: config.maxGlobResults }))
                                : Effect.void
                            }
                            return entry.kind === "directory" ? visit(child, index + 1) : Effect.void
                          })
                        )
                      }))
                    )
                  }
                  return visit(rootInfo.path, 0).pipe(Effect.as(found.sort()))
                })
              )
        )
      )

    const writeBytes = (raw: string, bytes: Uint8Array) =>
      mutationPath(raw).pipe(
        Effect.flatMap((target) => stageBytes(bytes).pipe(Effect.flatMap((stage) => install(target, stage, bytes.byteLength))))
      )

    const writeText = (raw: string, content: string) => writeBytes(raw, new TextEncoder().encode(content))

    const remove = (raw: string) =>
      mutationPath(raw).pipe(
        Effect.tap(statResolved),
        Effect.flatMap((target) => hold.remove(target))
      )

    const copy = (rawSource: string, rawDestination: string) =>
      Effect.all([checked(rawSource), mutationPath(rawDestination)]).pipe(
        Effect.flatMap(([source, destination]) => {
          const stage = stagePath()
          return rejectOverlap(source.path, destination).pipe(
            Effect.zipRight(admitDestinationParent(destination)),
            Effect.zipRight(verifyTree(source)),
            Effect.flatMap((bytes) =>
              fs.copy(source.path, stage, { overwrite: false }).pipe(
                Effect.mapError(error("copy to private stage", stage)),
                Effect.zipRight(install(destination, stage, bytes))
              )
            )
          )
        })
      )

    const move = (rawSource: string, rawDestination: string) =>
      Effect.all([checked(rawSource), mutationPath(rawDestination)]).pipe(
        Effect.flatMap(([source, destination]) => {
          const stage = stagePath()
          return rejectOverlap(source.path, destination).pipe(
            Effect.zipRight(admitDestinationParent(destination)),
            Effect.zipRight(verifyTree(source)),
            Effect.flatMap((bytes) =>
              fs.copy(source.path, stage, { overwrite: false }).pipe(
                Effect.mapError(error("copy move source to private stage", stage)),
                Effect.zipRight(install(destination, stage, bytes))
              )
            ),
            Effect.flatMap((installReceipt) => hold.remove(source.path).pipe(
              Effect.map((sourceRemoval) => new NativeMoveReceipt({
                install: installReceipt,
                sourceRemoval
              })),
              Effect.mapError((cause) => new NativeMovePartiallyApplied({
                source: source.path,
                destination,
                install: installReceipt,
                reason: `${cause._tag}: ${reasonOf(cause)}`
              }))
            ))
          )
        })
      )

    const mkdir = (raw: string, options?: { readonly parents?: boolean }) =>
      mutationPath(raw).pipe(
        Effect.flatMap((target) => Effect.gen(function* () {
          const exists = yield* fs.exists(target).pipe(Effect.mapError(error("check directory", target)))
          if (exists) {
            const entry = yield* statResolved(target)
            if (entry.kind === "directory") return new NativeMkdirReceipt({ path: target, installs: [] })
            return yield* new NativeFilesystemError({ operation: "mkdir", path: target, reason: "path already exists as a file" })
          }
          const missing: Array<string> = [target]
          let parent = nodePath.dirname(target)
          while (options?.parents === true && parent !== workspace) {
            const parentExists = yield* fs.exists(parent).pipe(Effect.mapError(error("check directory parent", parent)))
            if (parentExists) break
            yield* resolve(parent)
            missing.unshift(parent)
            parent = nodePath.dirname(parent)
          }
          if (options?.parents !== true) {
            const parentExists = yield* fs.exists(parent).pipe(Effect.mapError(error("check directory parent", parent)))
            if (!parentExists) return yield* new NativeFilesystemError({ operation: "mkdir", path: target, reason: "parent directory does not exist; pass parents: true" })
          }
          const installs: Array<NativeWriteReceipt> = []
          for (const directory of missing) {
            const stage = stagePath()
            yield* fs.makeDirectory(stage).pipe(Effect.mapError(error("make private staged directory", stage)))
            const installed = yield* install(directory, stage, 0).pipe(Effect.either)
            if (Either.isLeft(installed)) {
              return yield* new NativeMkdirPartiallyApplied({
                path: target,
                failedDirectory: directory,
                installs,
                reason: `${installed.left._tag}: ${reasonOf(installed.left)}`
              })
            }
            installs.push(installed.right)
          }
          return new NativeMkdirReceipt({ path: target, installs })
        }))
      )

    return NativeFileSystem.of({
      workspace,
      inspect,
      stat,
      readBytes,
      readText,
      readJson,
      list,
      glob,
      writeBytes,
      writeText,
      remove,
      copy,
      move,
      mkdir
    })
  })

/** Construction seam: scope and stage storage are explicit dependencies. */
export const NativeFileSystemLive = (config: NativeFilesystemConfig) =>
  Layer.effect(NativeFileSystem, make(config))
