import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import {
  ExclusiveRename,
  type ExclusiveRenameError,
  ExclusiveRenameFailed,
  ExclusiveRenameTargetExists,
  ExclusiveRenameUnavailable
} from "../../src/platform/ExclusiveRename.ts"

/**
 * Vitest runs on Node, which cannot import `bun:ffi`. This test adapter still
 * exercises the real macOS primitive: a fixed, argv-only Bun helper invokes
 * renamex_np(RENAME_EXCL) and returns errno as its status. It is never part of
 * the product composition.
 */
const helper = String.raw`
import { FFIType, dlopen, read } from "bun:ffi"
const [source, target] = process.argv.slice(1)
if (source === undefined || target === undefined) process.exit(64)
const library = dlopen("/usr/lib/libSystem.B.dylib", {
  renamex_np: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
    returns: FFIType.i32
  },
  __error: { args: [], returns: FFIType.ptr }
})
const result = library.symbols.renamex_np(
  Buffer.from(source + "\0"),
  Buffer.from(target + "\0"),
  0x00000004
)
if (result === 0) process.exit(0)
const pointer = library.symbols.__error()
const errno = pointer === null ? 125 : read.i32(pointer, 0)
console.error(String(errno))
process.exit(errno > 0 && errno < 126 ? errno : 125)
`

const moveNoReplace = (
  source: string,
  target: string
): Effect.Effect<void, ExclusiveRenameError> =>
  Effect.sync(() =>
    spawnSync("bun", ["-e", helper, "--", source, target], {
      encoding: "utf8",
      timeout: 10_000
    })
  ).pipe(
    Effect.flatMap((result): Effect.Effect<void, ExclusiveRenameError> => {
      if (result.error !== undefined) {
        return Effect.fail(
          new ExclusiveRenameUnavailable({
            platform: process.platform,
            reason: result.error.message
          })
        )
      }
      if (result.status === 0) return Effect.void
      if (result.status === 17) {
        return Effect.fail(
          new ExclusiveRenameTargetExists({ source, target })
        )
      }
      return Effect.fail(
        new ExclusiveRenameFailed({
          source,
          target,
          errno: result.status ?? -1,
          reason: result.stderr.trim() || "renamex_np test helper failed"
        })
      )
    })
  )

export const MacosExclusiveRenameTestLive = Layer.succeed(
  ExclusiveRename,
  ExclusiveRename.of({ moveNoReplace })
)
