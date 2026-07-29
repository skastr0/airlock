import { describe, expect, it } from "vitest"
import { Effect, Fiber } from "effect"
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
})
