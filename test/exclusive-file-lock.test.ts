import { describe, expect, it } from "vitest"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeExclusiveFileLock } from "../src/platform/ExclusiveFileLock.ts"

const realDelay = (milliseconds: number) =>
  Effect.async<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), milliseconds)
    return Effect.sync(() => clearTimeout(timer))
  })

describe("ExclusiveFileLock", () => {
  it("keeps a contended acquisition interruptible without stealing the live owner", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "airlock-lock-test-"))
    try {
      const root = join(temporary, "locks")
      const active = join(root, "active")
      await mkdir(root)
      const lock = makeExclusiveFileLock({
        root,
        active,
        released: join(root, "released"),
        abandoned: join(root, "abandoned"),
        timeoutMillis: 1_200,
        malformedGraceMillis: 100,
        onError: (operation, target, cause) =>
          new Error(`${operation} ${target}: ${String(cause)}`)
      })

      const started = Date.now()
      await Effect.runPromise(Effect.gen(function* () {
        const ownerReady = yield* Deferred.make<void>()
        const releaseOwner = yield* Deferred.make<void>()
        const owner = yield* lock.withLock(
          Deferred.succeed(ownerReady, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseOwner))
          )
        ).pipe(Effect.fork)
        yield* Deferred.await(ownerReady)
        const before = yield* Effect.promise(() => readFile(active, "utf8"))
        const waiter = yield* Effect.fork(lock.withLock(Effect.void))
        yield* realDelay(40)
        yield* Fiber.interrupt(waiter)
        const after = yield* Effect.promise(() => readFile(active, "utf8"))
        expect(after).toBe(before)
        yield* Deferred.succeed(releaseOwner, undefined)
        yield* Fiber.join(owner)
      }))

      expect(Date.now() - started).toBeLessThan(500)
      expect(JSON.parse(await readFile(active, "utf8"))).toMatchObject({
        pid: process.pid
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it("returns release failure through the typed channel", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "airlock-lock-release-"))
    try {
      const root = join(temporary, "locks")
      const active = join(root, "active")
      await mkdir(root)
      const lock = makeExclusiveFileLock({
        root,
        active,
        released: join(root, "released"),
        abandoned: join(root, "abandoned"),
        onError: (operation, target, cause) => ({
          _tag: "TestLockFailure" as const,
          operation,
          target,
          cause: String(cause)
        })
      })

      const result = await Effect.runPromise(
        lock.withLock(
          Effect.tryPromise({
            try: () =>
              writeFile(
                active,
                JSON.stringify({
                  token: "foreign-owner",
                  pid: process.pid,
                  createdAt: Date.now()
                })
              ),
            catch: (cause) => ({
              _tag: "TestBodyFailure" as const,
              cause: String(cause)
            })
          })
        ).pipe(Effect.either)
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "TestLockFailure",
          operation: "verify-lock-owner",
          target: active
        })
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it("closes an unpublished descriptor when directory sync fails", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "airlock-lock-publish-"))
    try {
      const lockFiles = join(temporary, "lock-files")
      const missingSyncRoot = join(temporary, "missing-sync-root")
      const active = join(lockFiles, "active")
      await mkdir(lockFiles)
      const lock = makeExclusiveFileLock({
        // The stable claim inode lives in `lockFiles`; the deliberately absent
        // root deterministically faults the post-publication directory sync
        // after the owner body is already durable.
        root: missingSyncRoot,
        active,
        released: join(lockFiles, "released"),
        abandoned: join(lockFiles, "abandoned"),
        timeoutMillis: 1_200,
        malformedGraceMillis: 100,
        onError: (operation, target, cause) => ({
          _tag: "TestLockFailure" as const,
          operation,
          target,
          cause: String(cause)
        })
      })

      const first = await Effect.runPromise(
        lock.withLock(Effect.void).pipe(Effect.exit)
      )
      expect(Exit.isFailure(first)).toBe(true)
      if (Exit.isFailure(first)) {
        expect(Array.from(Cause.failures(first.cause))).toEqual([
          expect.objectContaining({
            _tag: "TestLockFailure",
            operation: "publish-lock-sync-directory",
            target: missingSyncRoot
          })
        ])
      }
      expect(JSON.parse(await readFile(active, "utf8"))).toMatchObject({
        pid: process.pid
      })

      const started = Date.now()
      const second = await Effect.runPromise(
        lock.withLock(Effect.void).pipe(Effect.exit)
      )
      expect(Exit.isFailure(second)).toBe(true)
      expect(Date.now() - started).toBeLessThan(500)

      // The failed publisher closed its descriptor. A correctly configured
      // runtime can immediately lock the same stable inode despite stale owner
      // metadata from the failed publication.
      const recovered = makeExclusiveFileLock({
        root: lockFiles,
        active,
        released: join(lockFiles, "released"),
        abandoned: join(lockFiles, "abandoned"),
        timeoutMillis: 1_200,
        onError: (operation, target, cause) => ({
          _tag: "TestLockFailure" as const,
          operation,
          target,
          cause: String(cause)
        })
      })
      const recoveredResult = await Effect.runPromise(
        recovered.withLock(Effect.succeed("recovered"))
      )
      expect(recoveredResult).toBe("recovered")
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it("serializes every contender after stale owner metadata", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "airlock-lock-stale-"))
    try {
      const root = join(temporary, "locks")
      const active = join(root, "active")
      await mkdir(root)
      await writeFile(
        active,
        JSON.stringify({
          token: "dead-owner",
          pid: 999_999,
          createdAt: 0
        })
      )
      const lock = makeExclusiveFileLock({
        root,
        active,
        released: join(root, "released"),
        abandoned: join(root, "abandoned"),
        timeoutMillis: 4_000,
        malformedGraceMillis: 0,
        onError: (operation, target, cause) => ({
          _tag: "TestLockFailure" as const,
          operation,
          target,
          cause: String(cause)
        })
      })
      let inside = 0
      let maximumInside = 0
      let entered = 0
      const criticalSection = Effect.acquireUseRelease(
        Effect.sync(() => {
          inside += 1
          entered += 1
          maximumInside = Math.max(maximumInside, inside)
        }),
        () => realDelay(20),
        () =>
          Effect.sync(() => {
            inside -= 1
          })
      )

      const results = await Effect.runPromise(
        Effect.all(
          Array.from(
            { length: 32 },
            () => lock.withLock(criticalSection).pipe(Effect.either)
          ),
          { concurrency: "unbounded" }
        )
      )

      expect(results.every((result) => result._tag === "Right")).toBe(true)
      expect(entered).toBe(32)
      expect(maximumInside).toBe(1)
      expect(inside).toBe(0)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
