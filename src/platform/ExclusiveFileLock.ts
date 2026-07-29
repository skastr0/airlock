import { Effect } from "effect"
import {
  lstat,
  open,
  readFile,
  rename
} from "node:fs/promises"

type LockOwner = Readonly<{
  readonly token: string
  readonly pid: number
  readonly createdAt: number
}>

export interface ExclusiveFileLockOptions<E> {
  readonly root: string
  readonly active: string
  readonly released: string
  readonly abandoned: string
  readonly timeoutMillis?: number
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

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return errorCode(cause) !== "ESRCH"
  }
}

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

/**
 * A bounded, cross-process lease made only from durable file creation and
 * atomic rename. At most `active`, `released`, and `abandoned` exist.
 *
 * The active file is the claim: `open("wx")` creates it atomically. Its owner
 * body is synced before work begins. A malformed claim is given a grace period
 * so another process cannot steal the file during publication; a dead owner or
 * old malformed claim is atomically moved to the single abandoned slot.
 */
export const makeExclusiveFileLock = <E>(
  options: ExclusiveFileLockOptions<E>
) => {
  const timeoutMillis = options.timeoutMillis ?? 30_000
  const malformedGraceMillis = options.malformedGraceMillis ?? 2_000

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

  const retire = (
    destination: string,
    operation: string
  ): Effect.Effect<boolean, E> =>
    Effect.tryPromise({
      try: async () => {
        try {
          await rename(options.active, destination)
          return true
        } catch (cause) {
          if (errorCode(cause) === "ENOENT") return false
          throw cause
        }
      },
      catch: (cause) => fail(operation, options.active, cause)
    }).pipe(
      Effect.tap((retired) =>
        retired ? syncRoot(`${operation}-sync-directory`) : Effect.void
      )
    )

  const acquire = Effect.fnUntraced(function* () {
    const started = Date.now()
    while (Date.now() - started < timeoutMillis) {
      const owner: LockOwner = {
        token: crypto.randomUUID(),
        pid: process.pid,
        createdAt: Date.now()
      }
      const claimed = yield* Effect.tryPromise({
        try: async () => {
          let handle
          try {
            handle = await open(options.active, "wx", 0o600)
          } catch (cause) {
            if (errorCode(cause) === "EEXIST") return false
            throw cause
          }

          try {
            await handle.writeFile(JSON.stringify(owner), "utf8")
            await handle.sync()
          } catch (cause) {
            try {
              await handle.close()
            } finally {
              try {
                await rename(options.active, options.abandoned)
              } catch {
                // Preserve the first failure. A later acquisition can reclaim
                // the old malformed active claim after the grace interval.
              }
            }
            throw cause
          }
          await handle.close()
          return true
        },
        catch: (cause) => fail("publish-lock-owner", options.active, cause)
      })

      if (claimed) {
        yield* syncRoot("publish-lock-sync-directory")
        return owner.token
      }

      const snapshot = yield* Effect.tryPromise({
        try: async () => {
          try {
            const info = await lstat(options.active)
            const raw = await readFile(options.active, "utf8")
            return {
              owner: parseOwner(raw),
              ageMillis: Math.max(0, Date.now() - info.mtimeMs)
            }
          } catch (cause) {
            if (errorCode(cause) === "ENOENT") return undefined
            throw cause
          }
        },
        catch: (cause) => fail("inspect-lock-owner", options.active, cause)
      })

      if (snapshot === undefined) continue
      const reclaim =
        snapshot.owner === undefined
          ? snapshot.ageMillis >= malformedGraceMillis
          : !processExists(snapshot.owner.pid)
      if (reclaim) {
        yield* retire(options.abandoned, "abandon-stale-lock")
        continue
      }
      yield* realDelay(10)
    }

    return yield* Effect.fail(
      fail(
        "acquire-lock",
        options.active,
        `timed out after ${timeoutMillis}ms`
      )
    )
  })

  const release = (token: string) =>
    Effect.tryPromise({
      try: async () => {
        const owner = parseOwner(await readFile(options.active, "utf8"))
        if (owner?.token !== token) {
          throw new Error("active lock is not owned by this lease")
        }
      },
      catch: (cause) => fail("verify-lock-owner", options.active, cause)
    }).pipe(
      Effect.zipRight(retire(options.released, "release-lock")),
      Effect.flatMap((released) =>
        released
          ? Effect.void
          : Effect.fail(
              fail("release-lock", options.active, "active lock disappeared")
            )
      )
    )

  const withLock = <A, E2, R>(effect: Effect.Effect<A, E2, R>) =>
    Effect.uninterruptibleMask((restore) =>
      restore(acquire()).pipe(
        Effect.flatMap((token) =>
          restore(effect).pipe(
            Effect.ensuring(release(token).pipe(Effect.orDie))
          )
        )
      )
    )

  return { acquire, release, withLock } as const
}
