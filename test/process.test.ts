import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { Effect } from "effect"
import {
  ProcessCancelled,
  ProcessContractViolation,
  ProcessInputText,
  ProcessOutputLimitExceeded,
  ProcessRequest,
  ProcessTimedOut,
  runProcess
} from "../src/process/Process.ts"

const decoder = new TextDecoder()
const request = (overrides: Partial<ProcessRequest>) =>
  new ProcessRequest({
    executable: "/bin/echo",
    argv: [],
    cwd: process.cwd(),
    env: {},
    stdout: "capture",
    stderr: "capture",
    outputLimitBytes: 1024,
    ...overrides
  })

const execute = (command: ProcessRequest, options?: { readonly signal?: AbortSignal }) =>
  Effect.runPromise(runProcess(command, options))

const fail = (command: ProcessRequest, options?: { readonly signal?: AbortSignal }) =>
  Effect.runPromise(runProcess(command, options).pipe(Effect.flip))

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const controllers: AbortController[] = []
afterEach(() => controllers.splice(0).forEach((controller) => controller.abort()))

// Vitest runs its workers under Node; these are Bun/macOS integration tests.
const describeOnBun = typeof Bun === "undefined" ? describe.skip : describe

describeOnBun("process runner", () => {
  it("passes executable and argv as atoms, never as shell text", async () => {
    const target = `${process.cwd()}/process-runner-injection-marker`
    const receipt = await execute(
      request({
        argv: [`literal; touch ${target}`]
      })
    )

    expect(decoder.decode(receipt.stdout)).toBe(`literal; touch ${target}\n`)
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("uses explicit cwd and environment", async () => {
    const cwd = await mkdtemp(`${process.cwd()}/.process-test-`)
    try {
      const receipt = await execute(
        request({
          executable: "/bin/sh",
          argv: ["-c", "printf '%s|%s' \"$PWD\" \"$AIRLOCK_TEST\""],
          cwd,
          env: { AIRLOCK_TEST: "isolated" }
        })
      )
      expect(decoder.decode(receipt.stdout)).toBe(`${cwd}|isolated`)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("supports text stdin and captures stdout/stderr separately", async () => {
    const receipt = await execute(
      request({
        executable: "/bin/sh",
        argv: ["-c", "cat; printf warning >&2"],
        stdin: new ProcessInputText({ _tag: "text", text: "payload" })
      })
    )
    expect(decoder.decode(receipt.stdout)).toBe("payload")
    expect(decoder.decode(receipt.stderr)).toBe("warning")
  })

  it("returns ordinary non-zero exits in the receipt", async () => {
    const receipt = await execute(
      request({ executable: "/bin/sh", argv: ["-c", "exit 23"] })
    )
    expect(receipt.exitCode).toBe(23)
    expect(receipt.signal).toBeNull()
  })

  it("rejects an aggregate captured-output overflow with its partial receipt", async () => {
    const error = await fail(
      request({
        executable: "/bin/sh",
        argv: ["-c", "printf 12345; printf 67890 >&2"],
        outputLimitBytes: 7
      })
    )

    expect(error).toBeInstanceOf(ProcessOutputLimitExceeded)
    const overflow = error as ProcessOutputLimitExceeded
    expect(overflow.receipt.stdout.byteLength + overflow.receipt.stderr.byteLength).toBe(7)
  })

  it("terminates a timed-out process and reports a timeout receipt", async () => {
    const error = await fail(
      request({ executable: "/bin/sleep", argv: ["5"], timeoutMs: 25 })
    )

    expect(error).toBeInstanceOf(ProcessTimedOut)
    expect((error as ProcessTimedOut).receipt.pid).toBeGreaterThan(0)
  })

  it("terminates cancellation through an AbortSignal", async () => {
    const controller = new AbortController()
    controllers.push(controller)
    const running = fail(
      request({ executable: "/bin/sleep", argv: ["5"] }),
      { signal: controller.signal }
    )
    setTimeout(() => controller.abort(), 25)

    const error = await running
    expect(error).toBeInstanceOf(ProcessCancelled)
  })

  it("terminates descendants that remain in the spawned process group", async () => {
    const cwd = await mkdtemp(`${process.cwd()}/.process-test-`)
    const pidFile = `${cwd}/child.pid`
    const controller = new AbortController()
    controllers.push(controller)
    try {
      const running = fail(
        request({
          executable: "/bin/sh",
          argv: ["-c", `sleep 5 & child=$!; printf %s "$child" > "${pidFile}"; wait`],
          cwd
        }),
        { signal: controller.signal }
      )
      for (let tries = 0; tries < 20; tries++) {
        try {
          await stat(pidFile)
          break
        } catch {
          await delay(5)
        }
      }
      const childPid = Number(await readFile(pidFile, "utf8"))
      controller.abort()
      await running
      await delay(25)
      expect(() => process.kill(childPid, 0)).toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects paths and arguments that cannot be represented safely", async () => {
    const error = await fail(
      request({ executable: "echo", argv: ["bad\0atom"] })
    )
    expect(error).toBeInstanceOf(ProcessContractViolation)
  })
})
