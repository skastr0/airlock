import { Cause, Effect, Exit } from "effect"
import { constants } from "node:fs"
import { open, readFile } from "node:fs/promises"

type LockOwner = Readonly<{
  readonly token: string
  readonly pid: number
  readonly createdAt: number
}>

export interface ExclusiveFileLockOptions<E> {
  readonly root: string
  readonly active: string
  /**
   * Retained for the persisted v0 layout. The descriptor-backed macOS protocol
   * never renames the stable lock inode, so these tombstones are no longer
   * written.
   */
  readonly released: string
  readonly abandoned: string
  readonly timeoutMillis?: number
  /** @deprecated Kernel-owned leases need no malformed-owner grace period. */
  readonly malformedGraceMillis?: number
  readonly onError: (
    operation: string,
    target: string,
    cause: unknown
  ) => E
}

const errorCode = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : undefined

const parseOwner = (raw: string): LockOwner | undefined => {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return typeof value.token === "string" &&
      value.token.length > 0 &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.createdAt === "number" &&
      Number.isFinite(value.createdAt)
      ? {
          token: value.token,
          pid: value.pid,
          createdAt: value.createdAt
        }
      : undefined
  } catch {
    return undefined
  }
}

const realDelay = (milliseconds: number) =>
  Effect.async<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), milliseconds)
    return Effect.sync(() => clearTimeout(timer))
  })

type FileHandle = Awaited<ReturnType<typeof open>>

type Lease = Readonly<{
  readonly owner: LockOwner
  readonly handle: FileHandle
}>

/*
 * Darwin's O_EXLOCK is intentionally absent from Node's portable constants.
 * On macOS it is 0x20 and asks open(2) to acquire a flock-style exclusive lock
 * atomically with opening the file. O_NONBLOCK turns contention into EAGAIN
 * instead of blocking an uninterruptible native call.
 */
const DARWIN_O_EXLOCK = 0x20

const contended = (cause: unknown) => {
  const code = errorCode(cause)
  return code === "EAGAIN" || code === "EWOULDBLOCK"
}

/**
 * A bounded, cross-process macOS lease over one stable inode.
 *
 * Authority is the open file description protected by O_EXLOCK, not the owner
 * JSON or a reusable pathname. The kernel releases the lock when the descriptor
 * closes or its process dies. Stale/malformed owner bytes are therefore inert
 * diagnostics that the next successful holder replaces; there is no stale
 * read-then-rename step and consequently no ABA window that can revoke a newer
 * live owner.
 */
export const makeExclusiveFileLock = <E>(
  options: ExclusiveFileLockOptions<E>
) => {
  const timeoutMillis = options.timeoutMillis ?? 30_000

  const fail = (operation: string, target: string, cause: unknown) =>
    options.onError(operation, target, cause)

  const syncRoot = (operation: string) =>
    Effect.tryPromise({
      try: async () => {
        const handle = await open(options.root, "r")
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
      catch: (cause) => fail(operation, options.root, cause)
    })

  const attempt = Effect.fnUntraced(function* () {
    if (process.platform !== "darwin") {
      return yield* Effect.fail(
        fail(
          "acquire-lock",
          options.active,
          `O_EXLOCK lease is unavailable on ${process.platform}`
        )
      )
    }

    const owner: LockOwner = {
      token: crypto.randomUUID(),
      pid: process.pid,
      createdAt: Date.now()
    }
    const claimed = yield* Effect.tryPromise({
      try: async (): Promise<Lease | undefined> => {
        let handle: FileHandle | undefined
        try {
          handle = await open(
            options.active,
            constants.O_RDWR |
              constants.O_CREAT |
              constants.O_NONBLOCK |
              DARWIN_O_EXLOCK,
            0o600
          )
          await handle.truncate(0)
          await handle.writeFile(JSON.stringify(owner), "utf8")
          await handle.sync()
          return { owner, handle }
        } catch (cause) {
          const opened = handle !== undefined
          if (handle !== undefined) {
            try {
              await handle.close()
            } catch {
              // Preserve the publication failure. Closing is best effort here;
              // the kernel also releases the lease when this process exits.
            }
          }
          if (!opened && contended(cause)) return undefined
          throw cause
        }
      },
      catch: (cause) => fail("publish-lock-owner", options.active, cause)
    })
    if (claimed === undefined) return undefined

    const publication = yield* syncRoot(
      "publish-lock-sync-directory"
    ).pipe(Effect.exit)
    if (Exit.isSuccess(publication)) return claimed

    const closed = yield* Effect.tryPromise({
      try: () => claimed.handle.close(),
      catch: (cause) => fail("close-unpublished-lock", options.active, cause)
    }).pipe(Effect.exit)
    return yield* Exit.isFailure(closed)
      ? Effect.failCause(Cause.sequential(publication.cause, closed.cause))
      : Effect.failCause(publication.cause)
  })

  const acquire = (
    restore: <A, E2, R>(
      effect: Effect.Effect<A, E2, R>
    ) => Effect.Effect<A, E2, R>
  ) =>
    Effect.gen(function* () {
      const started = performance.now()
      while (performance.now() - started < timeoutMillis) {
        const claimed = yield* attempt()
        if (claimed !== undefined) return claimed
        // The claim attempt itself is a short uninterruptible resource
        // transition. Only the contention wait is restored so cancellation
        // cannot lose a successfully opened descriptor before finalization.
        yield* restore(realDelay(10))
      }
      return yield* Effect.fail(
        fail(
          "acquire-lock",
          options.active,
          `timed out after ${timeoutMillis}ms`
        )
      )
    })

  const release = (lease: Lease) =>
    Effect.gen(function* () {
      const verified = yield* Effect.tryPromise({
        try: async () => {
          const owner = parseOwner(await readFile(options.active, "utf8"))
          if (owner?.token !== lease.owner.token) {
            throw new Error("active lock is not owned by this lease")
          }
        },
        catch: (cause) => fail("verify-lock-owner", options.active, cause)
      }).pipe(Effect.exit)
      const closed = yield* Effect.tryPromise({
        try: () => lease.handle.close(),
        catch: (cause) => fail("release-lock", options.active, cause)
      }).pipe(Effect.exit)

      if (Exit.isFailure(verified)) {
        return yield* Exit.isFailure(closed)
          ? Effect.failCause(
              Cause.sequential(verified.cause, closed.cause)
            )
          : Effect.failCause(verified.cause)
      }
      return yield* Exit.isFailure(closed)
        ? Effect.failCause(closed.cause)
        : Effect.void
    })

  const withLock = <A, E2, R>(effect: Effect.Effect<A, E2, R>) =>
    Effect.uninterruptibleMask((restore) =>
      acquire(restore).pipe(
        Effect.flatMap((lease) =>
          restore(effect).pipe(
            Effect.exit,
            Effect.flatMap((use) =>
              release(lease).pipe(
                Effect.exit,
                Effect.flatMap((released) => {
                  if (Exit.isFailure(released)) {
                    return Exit.isFailure(use)
                      ? Effect.failCause(
                          Cause.sequential(use.cause, released.cause)
                        )
                      : Effect.failCause(released.cause)
                  }
                  return Exit.isFailure(use)
                    ? Effect.failCause(use.cause)
                    : Effect.succeed(use.value)
                })
              )
            )
          )
        )
      )
    )

  return { withLock } as const
}
