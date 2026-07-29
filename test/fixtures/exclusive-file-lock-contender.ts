/**
 * Independent Bun-process contender for the ExclusiveFileLock integration
 * proof. The shared `critical.sentinel` uses O_EXCL as an independent kernel
 * overlap detector; it is evidence, not the lock implementation under test.
 */
import { Effect, Schema } from "effect"
import { constants, existsSync } from "node:fs"
import {
  appendFile,
  open,
  rm,
  writeFile
} from "node:fs/promises"
import { join } from "node:path"
import { makeExclusiveFileLock } from "../../src/platform/ExclusiveFileLock.ts"
import {
  LockContenderCompleted,
  LockContenderEvent,
  LockContenderFailed,
  LockContenderResult
} from "./exclusive-file-lock-contract.ts"

class FixtureFailure extends Schema.TaggedError<FixtureFailure>(
  "FixtureFailure"
)("FixtureFailure", {
  stage: Schema.String,
  reason: Schema.String
}) {}

const [lockRoot, active, evidenceRoot, contenderId, startGate, rawHoldMillis] =
  process.argv.slice(2)

const resultPath =
  evidenceRoot === undefined || contenderId === undefined
    ? undefined
    : join(evidenceRoot, `${contenderId}.result.json`)

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const tagOf = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause._tag === "string"
    ? cause._tag
    : "UnknownFixtureFailure"

const writeResult = (result: LockContenderResult) =>
  resultPath === undefined
    ? Promise.resolve()
    : writeFile(
        resultPath,
        JSON.stringify(Schema.encodeSync(LockContenderResult)(result))
      )

const validateInput = Effect.gen(function* () {
  if (
    lockRoot === undefined ||
    active === undefined ||
    evidenceRoot === undefined ||
    contenderId === undefined ||
    startGate === undefined ||
    rawHoldMillis === undefined
  ) {
    return yield* new FixtureFailure({
      stage: "arguments",
      reason:
        "expected lockRoot active evidenceRoot contenderId startGate holdMillis"
    })
  }
  if (!/^[a-z0-9-]+$/.test(contenderId)) {
    return yield* new FixtureFailure({
      stage: "arguments",
      reason: "contenderId must contain only lowercase letters, digits, or -"
    })
  }
  const holdMillis = Number(rawHoldMillis)
  if (
    !Number.isSafeInteger(holdMillis) ||
    holdMillis < 25 ||
    holdMillis > 2_000
  ) {
    return yield* new FixtureFailure({
      stage: "arguments",
      reason: "holdMillis must be an integer from 25 through 2000"
    })
  }
  return {
    lockRoot,
    active,
    evidenceRoot,
    contenderId,
    startGate,
    holdMillis
  }
})

const waitForStart = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 10_000
      while (!existsSync(path) && Date.now() < deadline) {
        await Bun.sleep(5)
      }
      if (!existsSync(path)) {
        throw new Error(`start gate did not open: ${path}`)
      }
    },
    catch: (cause) =>
      new FixtureFailure({
        stage: "start-gate",
        reason: reasonOf(cause)
      })
  })

const program = Effect.gen(function* () {
  const input = yield* validateInput
  const readyPath = join(input.evidenceRoot, `${input.contenderId}.ready`)
  const eventPath = join(input.evidenceRoot, "events.jsonl")
  const sentinelPath = join(input.evidenceRoot, "critical.sentinel")
  const overlapPath = join(
    input.evidenceRoot,
    `overlap-${input.contenderId}.json`
  )
  yield* Effect.tryPromise({
    try: () => writeFile(readyPath, String(process.pid)),
    catch: (cause) =>
      new FixtureFailure({
        stage: "ready",
        reason: reasonOf(cause)
      })
  })
  yield* waitForStart(input.startGate)

  const lock = makeExclusiveFileLock({
    root: input.lockRoot,
    active: input.active,
    released: join(input.lockRoot, "released"),
    abandoned: join(input.lockRoot, "abandoned"),
    timeoutMillis: 12_000,
    onError: (operation, target, cause) =>
      new FixtureFailure({
        stage: operation,
        reason: `${target}: ${reasonOf(cause)}`
      })
  })
  const waitingStarted = performance.now()

  const heldMillis = yield* lock.withLock(
    Effect.tryPromise({
      try: async () => {
        let sentinel: Awaited<ReturnType<typeof open>> | undefined
        const heldStarted = performance.now()
        try {
          try {
            sentinel = await open(
              sentinelPath,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL,
              0o600
            )
            await sentinel.writeFile(
              JSON.stringify({
                contenderId: input.contenderId,
                pid: process.pid
              })
            )
            await sentinel.sync()
          } catch (cause) {
            if (errorCode(cause) === "EEXIST") {
              await writeFile(
                overlapPath,
                JSON.stringify({
                  contenderId: input.contenderId,
                  pid: process.pid,
                  reason: "independent O_EXCL sentinel was already held"
                })
              )
            }
            throw cause
          }

          await appendFile(
            eventPath,
            `${JSON.stringify(
              Schema.encodeSync(LockContenderEvent)(
                new LockContenderEvent({
                  contenderId: input.contenderId,
                  pid: process.pid,
                  phase: "enter",
                  atMillis: Date.now()
                })
              )
            )}\n`
          )
          await Bun.sleep(input.holdMillis)
          await appendFile(
            eventPath,
            `${JSON.stringify(
              Schema.encodeSync(LockContenderEvent)(
                new LockContenderEvent({
                  contenderId: input.contenderId,
                  pid: process.pid,
                  phase: "exit",
                  atMillis: Date.now()
                })
              )
            )}\n`
          )
          return performance.now() - heldStarted
        } finally {
          if (sentinel !== undefined) {
            await sentinel.close()
            await rm(sentinelPath)
          }
        }
      },
      catch: (cause) =>
        new FixtureFailure({
          stage:
            errorCode(cause) === "EEXIST"
              ? "overlap-detected"
              : "critical-section",
          reason: reasonOf(cause)
        })
    })
  )

  return new LockContenderCompleted({
    contenderId: input.contenderId,
    pid: process.pid,
    waitedMillis: performance.now() - waitingStarted - heldMillis,
    heldMillis
  })
})

await Effect.runPromise(program).then(
  async (result) => {
    await writeResult(result)
  },
  async (cause) => {
    const result = new LockContenderFailed({
      contenderId: contenderId ?? "invalid",
      pid: process.pid,
      errorTag: tagOf(cause),
      reason: reasonOf(cause)
    })
    try {
      await writeResult(result)
    } finally {
      process.stderr.write(`${JSON.stringify(result)}\n`)
      process.exitCode = 1
    }
  }
)
