import { EAGAIN, linuxLibc, LOCK_EX_NB } from "./LinuxLibc.ts"

/**
 * The Linux half of the recoverable exclusive lease.
 *
 * Darwin acquires the lease inside `open(2)` through `O_EXLOCK`, which is a BSD
 * extension Linux does not have. `flock(2)` provides the same kernel-owned
 * whole-file lease over an open file description: the kernel releases it when
 * the descriptor closes or the owning process dies, so a crashed holder leaves
 * no lock to reclaim and stale owner JSON stays an inert diagnostic. The lease
 * is taken after the descriptor exists rather than atomically with it; the
 * caller therefore closes the descriptor when contention is reported, which
 * costs an extra syscall and changes no observable lease semantics.
 *
 * `LOCK_NB` keeps contention an immediate EWOULDBLOCK instead of parking the
 * fiber in an uninterruptible native call.
 */

/** The reason the Linux lease cannot be taken here, or `undefined` if it can. */
export const linuxLeaseUnavailability = async (): Promise<
  string | undefined
> => {
  const state = await linuxLibc()
  return state._tag === "Unavailable"
    ? `flock(2) lease is unavailable: ${state.reason}`
    : undefined
}

/**
 * Takes the exclusive lease on an already-open descriptor.
 *
 * Resolves `true` when this descriptor owns the lease and `false` when another
 * open file description holds it. Any other errno is a real failure and throws.
 */
export const acquireLinuxFileLease = async (fd: number): Promise<boolean> => {
  const state = await linuxLibc()
  if (state._tag === "Unavailable") {
    throw new Error(`flock(2) lease is unavailable: ${state.reason}`)
  }
  const result = state.libc.symbols.flock(fd, LOCK_EX_NB)
  if (result === 0) return true
  const errno = state.libc.errno()
  if (errno === EAGAIN) return false
  throw new Error(`flock(LOCK_EX|LOCK_NB) failed with errno ${errno}`)
}
