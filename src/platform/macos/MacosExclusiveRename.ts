import { Effect, Layer } from "effect"
import {
  ExclusiveRename,
  type ExclusiveRenameError,
  ExclusiveRenameFailed,
  ExclusiveRenameTargetExists,
  ExclusiveRenameUnavailable
} from "../ExclusiveRename.ts"

const RENAME_EXCL = 0x00000004
const EEXIST = 17

type NativeLibrary = Readonly<{
  readonly symbols: Readonly<{
    readonly renamex_np: (
      source: Uint8Array,
      target: Uint8Array,
      flags: number
    ) => number
    readonly __error: () => number | bigint | null
  }>
  readonly readErrno: (pointer: number | bigint) => number
}>

type NativeState =
  | Readonly<{ readonly _tag: "Available"; readonly library: NativeLibrary }>
  | Readonly<{ readonly _tag: "Unavailable"; readonly reason: string }>

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

const errnoName = (errno: number) => {
  switch (errno) {
    case 2:
      return "ENOENT"
    case 13:
      return "EACCES"
    case EEXIST:
      return "EEXIST"
    case 18:
      return "EXDEV"
    case 22:
      return "EINVAL"
    case 45:
      return "ENOTSUP"
    default:
      return `errno ${errno}`
  }
}

/**
 * libSystem is already process-resident on macOS. The adapter retains this FFI
 * handle for the runtime lifetime; closing it while a provided Hold service is
 * still reachable would make the capability invalid after Layer construction.
 */
const loadNative = async (): Promise<NativeState> => {
  if (process.platform !== "darwin") {
    return {
      _tag: "Unavailable",
      reason: `renamex_np(RENAME_EXCL) is a macOS capability, not ${process.platform}`
    }
  }
  if (process.versions.bun === undefined) {
    return {
      _tag: "Unavailable",
      reason: "the macOS adapter requires the Bun runtime for native FFI"
    }
  }
  try {
    // Keep the builtin specifier computed so Node-based contract tests can
    // import this module and provide their own adapter without resolving a Bun
    // builtin they cannot execute.
    const specifier = ["bun", "ffi"].join(":")
    const ffi = await import(specifier) as Readonly<{
      readonly FFIType: Readonly<Record<
        "cstring" | "u32" | "i32" | "ptr",
        unknown
      >>
      readonly dlopen: (
        name: string,
        symbols: Readonly<Record<string, unknown>>
      ) => Readonly<{
        readonly symbols: Readonly<{
          readonly renamex_np: (
            source: Uint8Array,
            target: Uint8Array,
            flags: number
          ) => number
          readonly __error: () => number | bigint | null
        }>
      }>
      readonly read: Readonly<{
        readonly i32: (pointer: number | bigint, offset: number) => number
      }>
    }>
    const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: {
        args: [ffi.FFIType.cstring, ffi.FFIType.cstring, ffi.FFIType.u32],
        returns: ffi.FFIType.i32
      },
      __error: {
        args: [],
        returns: ffi.FFIType.ptr
      }
    })
    return {
      _tag: "Available",
      library: {
        symbols: library.symbols,
        readErrno: (pointer) => ffi.read.i32(pointer, 0)
      }
    }
  } catch (cause) {
    return {
      _tag: "Unavailable",
      reason: `could not load renamex_np: ${reasonOf(cause)}`
    }
  }
}

const nativeState = loadNative()

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

  const loaded: Effect.Effect<NativeState> = Effect.promise(() => nativeState)
  return loaded.pipe(
    Effect.flatMap((state): Effect.Effect<void, ExclusiveRenameError> => {
      if (state._tag === "Unavailable") {
        return Effect.fail(
          new ExclusiveRenameUnavailable({
            platform: process.platform,
            reason: state.reason
          })
        )
      }
      const library = state.library
      return Effect.try({
        try: () => {
          const result = library.symbols.renamex_np(
            Buffer.from(`${source}\0`),
            Buffer.from(`${target}\0`),
            RENAME_EXCL
          )
          if (result === 0) return { result, errno: 0 }
          const pointer = library.symbols.__error()
          return {
            result,
            errno: pointer === null ? -1 : library.readErrno(pointer)
          }
        },
        catch: (cause) =>
          new ExclusiveRenameFailed({
            source,
            target,
            errno: -1,
            reason: `renamex_np invocation failed: ${reasonOf(cause)}`
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
          return Effect.fail(new ExclusiveRenameFailed({
            source,
            target,
            errno,
            reason: `${errnoName(errno)}: renamex_np(RENAME_EXCL) failed`
          }))
        })
      )
    })
  )
}

export const MacosExclusiveRenameLive = Layer.succeed(
  ExclusiveRename,
  ExclusiveRename.of({ moveNoReplace })
)
