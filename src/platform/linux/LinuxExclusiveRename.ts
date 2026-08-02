import { Effect, Layer } from "effect"
import {
  ExclusiveRename,
  type ExclusiveRenameError,
  ExclusiveRenameFailed,
  ExclusiveRenameTargetExists,
  ExclusiveRenameUnavailable
} from "../ExclusiveRename.ts"
import {
  AT_FDCWD,
  EEXIST,
  ENOSYS,
  EOPNOTSUPP,
  linuxLibc,
  RENAME_NOREPLACE
} from "./LinuxLibc.ts"

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

const errnoName = (errno: number) => {
  switch (errno) {
    case 1:
      return "EPERM"
    case 2:
      return "ENOENT"
    case 13:
      return "EACCES"
    case EEXIST:
      return "EEXIST"
    case 18:
      return "EXDEV"
    case 21:
      return "EISDIR"
    case 22:
      return "EINVAL"
    case 39:
      return "ENOTEMPTY"
    case ENOSYS:
      return "ENOSYS"
    case EOPNOTSUPP:
      return "EOPNOTSUPP"
    default:
      return `errno ${errno}`
  }
}

/**
 * `RENAME_NOREPLACE` is refused as a whole by kernels older than 3.15 and by
 * filesystems whose rename does not implement the flag. That is an absent
 * capability on this path, not a rename that failed: reporting it as
 * unavailable keeps the caller on the typed refusal path instead of letting a
 * replacing rename stand in for an atomic no-replace one.
 */
const unavailableErrno = (errno: number) =>
  errno === ENOSYS || errno === EOPNOTSUPP

const moveNoReplace = (
  source: string,
  target: string
): Effect.Effect<void, ExclusiveRenameError> => {
  if (source.includes("\0") || target.includes("\0")) {
    return Effect.fail(
      new ExclusiveRenameFailed({
        source,
        target,
        errno: 22,
        reason: "EINVAL: paths must not contain NUL bytes"
      })
    )
  }

  return Effect.promise(linuxLibc).pipe(
    Effect.flatMap((state): Effect.Effect<void, ExclusiveRenameError> => {
      if (state._tag === "Unavailable") {
        return Effect.fail(
          new ExclusiveRenameUnavailable({
            platform: process.platform,
            reason: state.reason
          })
        )
      }
      const libc = state.libc
      return Effect.try({
        try: () => {
          const result = libc.symbols.renameat2(
            AT_FDCWD,
            Buffer.from(`${source}\0`),
            AT_FDCWD,
            Buffer.from(`${target}\0`),
            RENAME_NOREPLACE
          )
          return { result, errno: result === 0 ? 0 : libc.errno() }
        },
        catch: (cause) =>
          new ExclusiveRenameFailed({
            source,
            target,
            errno: -1,
            reason: `renameat2 invocation failed: ${reasonOf(cause)}`
          })
      }).pipe(
        Effect.flatMap(({
          result,
          errno
        }): Effect.Effect<void, ExclusiveRenameError> => {
          if (result === 0) return Effect.void
          if (errno === EEXIST) {
            return Effect.fail(
              new ExclusiveRenameTargetExists({ source, target })
            )
          }
          if (unavailableErrno(errno)) {
            return Effect.fail(
              new ExclusiveRenameUnavailable({
                platform: process.platform,
                reason:
                  `${errnoName(errno)}: renameat2(RENAME_NOREPLACE) is not ` +
                  `implemented for ${target}`
              })
            )
          }
          return Effect.fail(new ExclusiveRenameFailed({
            source,
            target,
            errno,
            reason: `${errnoName(errno)}: renameat2(RENAME_NOREPLACE) failed`
          }))
        })
      )
    })
  )
}

export const LinuxExclusiveRenameLive = Layer.succeed(
  ExclusiveRename,
  ExclusiveRename.of({ moveNoReplace })
)
