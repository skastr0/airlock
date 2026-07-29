import { describe, expect, it } from "vitest"
import { Cause, Effect, Exit, Fiber } from "effect"
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
      await writeFile(
        active,
        JSON.stringify({
          token: "live-owner",
          pid: process.pid,
          createdAt: Date.now()
        })
      )
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
        const waiter = yield* Effect.fork(lock.withLock(Effect.void))
        yield* realDelay(40)
        yield* Fiber.interrupt(waiter)
      }))

      expect(Date.now() - started).toBeLessThan(500)
      expect(JSON.parse(await readFile(active, "utf8"))).toMatchObject({
        token: "live-owner",
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

  it("retires a published owner when directory sync fails without stranding its live pid", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "airlock-lock-publish-"))
    try {
      const lockFiles = join(temporary, "lock-files")
      const missingSyncRoot = join(temporary, "missing-sync-root")
      const active = join(lockFiles, "active")
      const abandoned = join(lockFiles, "abandoned")
      await mkdir(lockFiles)
      const lock = makeExclusiveFileLock({
        // The claim files live in `lockFiles`; the deliberately absent root is
        // deterministic fault injection for the post-publication directory
        // sync, after the live-PID owner body is already durable.
        root: missingSyncRoot,
        active,
        released: join(lockFiles, "released"),
        abandoned,
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
        expect(Cause.failures(first.cause).length).toBeGreaterThanOrEqual(2)
      }
      await expect(readFile(active, "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      })
      expect(JSON.parse(await readFile(abandoned, "utf8"))).toMatchObject({
        pid: process.pid
      })

      const started = Date.now()
      const second = await Effect.runPromise(
        lock.withLock(Effect.void).pipe(Effect.exit)
      )
      expect(Exit.isFailure(second)).toBe(true)
      expect(Date.now() - started).toBeLessThan(500)
      await expect(readFile(active, "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
