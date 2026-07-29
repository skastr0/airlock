import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  LockContenderEvent,
  LockContenderResult
} from "./fixtures/exclusive-file-lock-contract.ts"

const contenderFixture = fileURLToPath(
  new URL(
    "./fixtures/exclusive-file-lock-contender.ts",
    import.meta.url
  )
)

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const waitFor = async (
  description: string,
  predicate: () => boolean,
  timeoutMillis = 10_000
) => {
  const deadline = Date.now() + timeoutMillis
  while (!predicate() && Date.now() < deadline) {
    await delay(5)
  }
  if (!predicate()) throw new Error(`timed out waiting for ${description}`)
}

const collect = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = []
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    stream.on("error", reject)
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })

describe("ExclusiveFileLock — real macOS process contention", () => {
  it.skipIf(process.platform !== "darwin")(
    "serializes independent Bun processes with one kernel-owned lease",
    async () => {
      const temporary = await mkdtemp(
        join(tmpdir(), "airlock-exclusive-lock-process-")
      )
      const lockRoot = join(temporary, "locks")
      const evidenceRoot = join(temporary, "evidence")
      const active = join(lockRoot, "active")
      const startGate = join(temporary, "start")
      const contenderCount = 16
      const holdMillis = 50
      const contenderIds = Array.from(
        { length: contenderCount },
        (_, index) => `contender-${index}`
      )
      await Promise.all([
        mkdir(lockRoot, { recursive: true }),
        mkdir(evidenceRoot, { recursive: true })
      ])

      const children = contenderIds.map((contenderId) => {
        const child = spawn(
          "bun",
          [
            contenderFixture,
            lockRoot,
            active,
            evidenceRoot,
            contenderId,
            startGate,
            String(holdMillis)
          ],
          {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"]
          }
        )
        return {
          child,
          stderr: collect(child.stderr),
          exited: new Promise<number>((resolve, reject) => {
            child.once("error", reject)
            child.once("exit", (code, signal) => {
              if (code !== null) {
                resolve(code)
              } else {
                reject(
                  new Error(
                    `${contenderId} exited by ${signal ?? "unknown signal"}`
                  )
                )
              }
            })
          })
        }
      })

      try {
        await waitFor(
          "every child process to reach the start barrier",
          () =>
            contenderIds.every((contenderId) =>
              existsSync(join(evidenceRoot, `${contenderId}.ready`))
            )
        )
        await writeFile(startGate, "start")

        const exitCodes = await Promise.race([
          Promise.all(children.map(({ exited }) => exited)),
          delay(20_000).then(() => {
            throw new Error("contenders did not finish within 20 seconds")
          })
        ])
        const stderr = await Promise.all(
          children.map((contender) => contender.stderr)
        )
        expect(exitCodes, stderr.join("\n")).toEqual(
          Array.from({ length: contenderCount }, () => 0)
        )

        const results = await Promise.all(
          contenderIds.map(async (contenderId) =>
            Schema.decodeUnknownSync(LockContenderResult)(
              JSON.parse(
                await readFile(
                  join(evidenceRoot, `${contenderId}.result.json`),
                  "utf8"
                )
              )
            )
          )
        )
        expect(
          results.every((result) => result._tag === "Completed")
        ).toBe(true)
        expect(new Set(results.map(({ pid }) => pid)).size).toBe(
          contenderCount
        )

        const evidenceEntries = await readdir(evidenceRoot)
        expect(
          evidenceEntries.filter((entry) => entry.startsWith("overlap-"))
        ).toEqual([])

        const eventLines = (await readFile(
          join(evidenceRoot, "events.jsonl"),
          "utf8"
        ))
          .trim()
          .split("\n")
        const events = eventLines.map((line) =>
          Schema.decodeUnknownSync(LockContenderEvent)(JSON.parse(line))
        )
        expect(events).toHaveLength(contenderCount * 2)

        let inside = 0
        let maximumInside = 0
        const phases = new Map<string, Array<"enter" | "exit">>()
        for (const event of events) {
          const contenderPhases = phases.get(event.contenderId) ?? []
          contenderPhases.push(event.phase)
          phases.set(event.contenderId, contenderPhases)
          if (event.phase === "enter") {
            inside += 1
            maximumInside = Math.max(maximumInside, inside)
          } else {
            inside -= 1
          }
          expect(inside).toBeGreaterThanOrEqual(0)
        }

        expect(maximumInside).toBe(1)
        expect(inside).toBe(0)
        expect(
          contenderIds.map((contenderId) => phases.get(contenderId))
        ).toEqual(
          contenderIds.map(() => ["enter", "exit"])
        )
      } finally {
        for (const { child } of children) {
          if (child.exitCode === null) child.kill()
        }
        await rm(temporary, { recursive: true, force: true })
      }
    },
    30_000
  )
})
