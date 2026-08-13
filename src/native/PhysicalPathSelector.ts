import { Error as PlatformError, FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { lstat } from "node:fs/promises"
import * as nodePath from "node:path"

/**
 * A path selector could not be bound to one physical spelling before
 * admission. Platform errors stay behind this tagged boundary; callers decide
 * whether a failed trusted policy selector is fatal or remains inert.
 */
export class PhysicalPathSelectorBindingFailed extends Schema.TaggedError<PhysicalPathSelectorBindingFailed>()(
  "PhysicalPathSelectorBindingFailed",
  {
    workspace: Schema.String,
    requested: Schema.String,
    operation: Schema.Literal("validate", "realpath", "inspect-prefix", "inspect-selector"),
    reason: Schema.String
  }
) {}

const platformFailure = (
  workspace: string,
  requested: string,
  operation: "realpath" | "inspect-prefix" | "inspect-selector"
) => (cause: PlatformError.PlatformError) =>
  new PhysicalPathSelectorBindingFailed({
    workspace,
    requested,
    operation,
    reason: cause.message
  })

const isNotFound = (
  cause: PlatformError.PlatformError
): cause is PlatformError.SystemError =>
  cause._tag === "SystemError" && cause.reason === "NotFound"

/**
 * Resolve a selector relative to a trusted workspace and bind it to a physical
 * spelling. A proposed leaf (or deeper proposed suffix) is supported by
 * resolving the longest existing prefix and appending the missing segments.
 * Only typed NotFound errors cause the walk to climb; permission, I/O, and
 * non-directory failures remain failures.
 */
export const bindPhysicalPathSelector = (
  workspace: string,
  raw: string,
  options: { readonly rejectSymlinksWithinWorkspace?: boolean } = {}
): Effect.Effect<
  string,
  PhysicalPathSelectorBindingFailed,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const resolvedWorkspace = nodePath.resolve(workspace)
    if (raw.trim().length === 0) {
      return yield* new PhysicalPathSelectorBindingFailed({
        workspace: resolvedWorkspace,
        requested: raw,
        operation: "validate",
        reason: "path selector must not be blank"
      })
    }
    if (raw.includes("\0")) {
      return yield* new PhysicalPathSelectorBindingFailed({
        workspace: resolvedWorkspace,
        requested: raw,
        operation: "validate",
        reason: "path selector must not contain NUL"
      })
    }

    const fs = yield* FileSystem.FileSystem
    const requested = nodePath.resolve(resolvedWorkspace, raw)

    // A selected symlink leaf must remain a symlink operation, never be
    // rebound to its target. Ancestor aliases (notably macOS /tmp ->
    // /private/tmp) are intentionally left to realPath canonicalization.
    if (options.rejectSymlinksWithinWorkspace !== false) {
      const selected = yield* Effect.tryPromise({
        try: () => lstat(requested),
        catch: (cause) => cause
      }).pipe(Effect.either)
      if (selected._tag === "Right" && selected.right.isSymbolicLink()) {
        return yield* new PhysicalPathSelectorBindingFailed({
          workspace: resolvedWorkspace,
          requested: raw,
          operation: "inspect-selector",
          reason: `selected existing path is a symlink: ${requested}`
        })
      }
      if (selected._tag === "Left") {
        const cause = selected.left
        if (
          typeof cause !== "object" || cause === null ||
          !("code" in cause) || cause.code !== "ENOENT"
        ) {
          return yield* new PhysicalPathSelectorBindingFailed({
            workspace: resolvedWorkspace,
            requested: raw,
            operation: "inspect-selector",
            reason: cause instanceof Error ? cause.message : String(cause)
          })
        }
      }
    }

    const suffix: Array<string> = []
    let probe = requested

    while (true) {
      const physical = yield* fs.realPath(probe).pipe(Effect.either)
      if (physical._tag === "Right") {
        if (suffix.length === 0) return physical.right

        const prefix = yield* fs.stat(physical.right).pipe(
          Effect.mapError(
            platformFailure(resolvedWorkspace, raw, "inspect-prefix")
          )
        )
        if (prefix.type !== "Directory") {
          return yield* new PhysicalPathSelectorBindingFailed({
            workspace: resolvedWorkspace,
            requested: raw,
            operation: "inspect-prefix",
            reason: `longest existing prefix is not a directory: ${physical.right}`
          })
        }
        return nodePath.join(physical.right, ...suffix)
      }

      if (!isNotFound(physical.left)) {
        return yield* platformFailure(
          resolvedWorkspace,
          raw,
          "realpath"
        )(physical.left)
      }
      const parent = nodePath.dirname(probe)
      if (parent === probe) {
        return yield* new PhysicalPathSelectorBindingFailed({
          workspace: resolvedWorkspace,
          requested: raw,
          operation: "realpath",
          reason: "no existing path prefix could be resolved"
        })
      }
      suffix.unshift(nodePath.basename(probe))
      probe = parent
    }
  })
