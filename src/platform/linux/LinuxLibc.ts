/**
 * One process-lifetime handle on the C library for the Linux adapters.
 *
 * Both Linux primitives Airlock needs — `renameat2(RENAME_NOREPLACE)` and
 * `flock(2)` — are libc entry points, so they share a single lazily resolved
 * `dlopen`. The handle is retained for the runtime lifetime: closing it while a
 * provided Hold or lock capability is still reachable would make that
 * capability invalid after construction.
 *
 * Resolution is typed rather than thrown. A host without Bun FFI, without
 * glibc, or without `renameat2` reports `Unavailable` with a reason, and the
 * callers turn that into an explicit refusal. Nothing here ever falls back to a
 * replacing rename or to an advisory lock the kernel does not own.
 */

/** glibc exports the C library as `libc.so.6`; `libc.so` is the linker name. */
const LIBRARY_CANDIDATES = ["libc.so.6", "libc.so"] as const

/** `renameat2`/`openat` resolve relative paths against the caller's cwd. */
export const AT_FDCWD = -100

/** `RENAME_NOREPLACE` — fail with EEXIST instead of replacing the target. */
export const RENAME_NOREPLACE = 1

/** `LOCK_EX | LOCK_NB` — take the exclusive lease or report contention. */
export const LOCK_EX_NB = 2 | 4

export const EAGAIN = 11
export const EEXIST = 17
export const ENOSYS = 38
export const EOPNOTSUPP = 95

export type LinuxLibc = Readonly<{
  readonly symbols: Readonly<{
    readonly renameat2: (
      oldDirectoryFd: number,
      oldPath: Uint8Array,
      newDirectoryFd: number,
      newPath: Uint8Array,
      flags: number
    ) => number
    readonly flock: (fd: number, operation: number) => number
    readonly __errno_location: () => number | bigint | null
  }>
  /** Reads the thread-local `errno` behind the pointer libc just returned. */
  readonly errno: () => number
}>

export type LinuxLibcState =
  | Readonly<{ readonly _tag: "Available"; readonly libc: LinuxLibc }>
  | Readonly<{ readonly _tag: "Unavailable"; readonly reason: string }>

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

type BunFfi = Readonly<{
  readonly FFIType: Readonly<Record<"cstring" | "i32" | "u32" | "ptr", unknown>>
  readonly dlopen: (
    name: string,
    symbols: Readonly<Record<string, unknown>>
  ) => Readonly<{ readonly symbols: LinuxLibc["symbols"] }>
  readonly read: Readonly<{
    readonly i32: (pointer: number | bigint, offset: number) => number
  }>
}>

const load = async (): Promise<LinuxLibcState> => {
  if (process.platform !== "linux") {
    return {
      _tag: "Unavailable",
      reason:
        `renameat2/flock are Linux capabilities, not ${process.platform}`
    }
  }
  if (process.versions.bun === undefined) {
    return {
      _tag: "Unavailable",
      reason: "the Linux adapter requires the Bun runtime for native FFI"
    }
  }
  let ffi: BunFfi
  try {
    // Keep the builtin specifier computed so Node-based contract tests can
    // import this module and provide their own adapter without resolving a Bun
    // builtin they cannot execute.
    const specifier = ["bun", "ffi"].join(":")
    ffi = await import(specifier) as BunFfi
  } catch (cause) {
    return {
      _tag: "Unavailable",
      reason: `could not load bun:ffi: ${reasonOf(cause)}`
    }
  }

  const failures: Array<string> = []
  for (const candidate of LIBRARY_CANDIDATES) {
    try {
      const library = ffi.dlopen(candidate, {
        renameat2: {
          args: [
            ffi.FFIType.i32,
            ffi.FFIType.cstring,
            ffi.FFIType.i32,
            ffi.FFIType.cstring,
            ffi.FFIType.u32
          ],
          returns: ffi.FFIType.i32
        },
        flock: {
          args: [ffi.FFIType.i32, ffi.FFIType.i32],
          returns: ffi.FFIType.i32
        },
        __errno_location: {
          args: [],
          returns: ffi.FFIType.ptr
        }
      })
      return {
        _tag: "Available",
        libc: {
          symbols: library.symbols,
          errno: () => {
            const pointer = library.symbols.__errno_location()
            return pointer === null ? -1 : ffi.read.i32(pointer, 0)
          }
        }
      }
    } catch (cause) {
      failures.push(`${candidate}: ${reasonOf(cause)}`)
    }
  }
  return {
    _tag: "Unavailable",
    reason: `could not load renameat2/flock from libc (${failures.join("; ")})`
  }
}

const state = load()

export const linuxLibc = (): Promise<LinuxLibcState> => state
