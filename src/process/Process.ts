import { Context, DateTime, Effect, Layer, Schema } from "effect"

/**
 * A structured, non-shell process boundary for Bun-backed hosts.
 *
 * `executable` is always an absolute path and `args` is passed to Bun as
 * individual atoms. This module deliberately has no command-string API.
 */

export class ProcessInputText extends Schema.Class<ProcessInputText>(
  "ProcessInputText"
)({
  _tag: Schema.Literal("text"),
  text: Schema.String
}) {}

export class ProcessInputBytes extends Schema.Class<ProcessInputBytes>(
  "ProcessInputBytes"
)({
  _tag: Schema.Literal("bytes"),
  bytes: Schema.Uint8Array
}) {}

export const ProcessInput = Schema.Union(
  Schema.Literal("discard", "inherit"),
  ProcessInputText,
  ProcessInputBytes
)
export type ProcessInput = typeof ProcessInput.Type

export const ProcessOutput = Schema.Literal("capture", "inherit", "discard")
export type ProcessOutput = typeof ProcessOutput.Type

/** The stable command contract. `outputLimitBytes` is a combined capture cap. */
export class ProcessRequest extends Schema.Class<ProcessRequest>("ProcessRequest")({
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
  stdin: Schema.optionalWith(ProcessInput, { default: () => "discard" as const }),
  stdout: Schema.optionalWith(ProcessOutput, { default: () => "capture" as const }),
  stderr: Schema.optionalWith(ProcessOutput, { default: () => "capture" as const }),
  outputLimitBytes: Schema.optionalWith(Schema.Number, {
    default: () => 1024 * 1024
  }),
  timeoutMs: Schema.optional(Schema.Number)
}) {}

export class ProcessReceipt extends Schema.Class<ProcessReceipt>("ProcessReceipt")({
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  pid: Schema.Number,
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stdout: Schema.Uint8Array,
  stderr: Schema.Uint8Array,
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.DateTimeUtc
}) {}

export class ProcessContractViolation extends Schema.TaggedError<ProcessContractViolation>()(
  "ProcessContractViolation",
  { field: Schema.String, reason: Schema.String }
) {}

export class ProcessSpawnFailed extends Schema.TaggedError<ProcessSpawnFailed>()(
  "ProcessSpawnFailed",
  { executable: Schema.String, cause: Schema.String }
) {}

export class ProcessOutputLimitExceeded extends Schema.TaggedError<ProcessOutputLimitExceeded>()(
  "ProcessOutputLimitExceeded",
  { limitBytes: Schema.Number, receipt: ProcessReceipt }
) {}

export class ProcessTimedOut extends Schema.TaggedError<ProcessTimedOut>()(
  "ProcessTimedOut",
  { timeoutMs: Schema.Number, receipt: ProcessReceipt }
) {}

export class ProcessCancelled extends Schema.TaggedError<ProcessCancelled>()(
  "ProcessCancelled",
  { receipt: ProcessReceipt }
) {}

export type ProcessError =
  | ProcessContractViolation
  | ProcessSpawnFailed
  | ProcessOutputLimitExceeded
  | ProcessTimedOut
  | ProcessCancelled

export interface ProcessRunOptions {
  /** Cancellation controls the process group, not merely the direct child. */
  readonly signal?: AbortSignal
  /** Grace period between SIGTERM and SIGKILL. Defaults to 500 ms. */
  readonly killGraceMs?: number
  /**
   * Backend-only inherited descriptors, installed contiguously from child fd 3.
   * The caller owns and closes the source descriptors after `run` settles.
   */
  readonly extraFileDescriptors?: ReadonlyArray<number>
}

/** The typed process seam; Bun is confined to the adapter below. */
export class ProcessRunner extends Context.Tag("airlock/ProcessRunner")<
  ProcessRunner,
  {
    readonly run: (
      request: ProcessRequest,
      options?: ProcessRunOptions
    ) => Effect.Effect<ProcessReceipt, ProcessError>
  }
>() {}

const encoder = new TextEncoder()

const invalid = (field: string, reason: string) =>
  new ProcessContractViolation({ field, reason })

const assertRequest = (request: ProcessRequest): void => {
  if (!request.executable.startsWith("/")) {
    throw invalid("executable", "must be an absolute path")
  }
  if (!request.cwd.startsWith("/")) {
    throw invalid("cwd", "must be an absolute path")
  }
  if (!Number.isSafeInteger(request.outputLimitBytes) || request.outputLimitBytes < 0) {
    throw invalid("outputLimitBytes", "must be a non-negative safe integer")
  }
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
  ) {
    throw invalid("timeoutMs", "must be a positive safe integer")
  }
  for (const [index, argument] of request.args.entries()) {
    if (argument.includes("\0")) throw invalid(`args[${index}]`, "must not contain NUL")
  }
  for (const [key, value] of Object.entries(request.env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw invalid(`env.${key}`, "environment names must be non-empty and contain neither = nor NUL")
    }
    if (value.includes("\0")) throw invalid(`env.${key}`, "must not contain NUL")
  }
}

const join = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(size)
  let cursor = 0
  for (const chunk of chunks) {
    result.set(chunk, cursor)
    cursor += chunk.byteLength
  }
  return result
}

/**
 * Executes a program without a shell. On timeout, cancellation, or output
 * overflow it terminates the POSIX process group (SIGTERM then SIGKILL).
 *
 * A process group is the strongest portable ownership primitive Bun exposes
 * here. Programs can intentionally call setsid/setpgid or daemonize, so this
 * cannot claim ownership of descendants that leave that group.
 */
const runNativeProcess = async (
  request: ProcessRequest,
  options: ProcessRunOptions = {}
): Promise<ProcessReceipt> => {
  assertRequest(request)
  if (options.signal?.aborted) {
    const now = DateTime.unsafeMake(new Date())
    const receipt = new ProcessReceipt({
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      pid: 0,
      exitCode: null,
      signal: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      startedAt: now,
      finishedAt: now
    })
    throw new ProcessCancelled({ receipt })
  }

  const startedAt = DateTime.unsafeMake(new Date())
  const stdin =
    request.stdin === "inherit"
      ? "inherit"
      : request.stdin === "discard"
        ? "ignore"
        : request.stdin._tag === "text"
          ? encoder.encode(request.stdin.text)
          : request.stdin.bytes
  const output = (mode: ProcessOutput) =>
    mode === "capture" ? "pipe" : mode === "inherit" ? "inherit" : "ignore"

  let child: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    // The explicit `cmd` array is the central no-shell guarantee.
    const stdout = output(request.stdout)
    const stderr = output(request.stderr)
    child = Bun.spawn({
      cmd: [request.executable, ...request.args],
      cwd: request.cwd,
      env: request.env,
      stdin: stdin as "ignore",
      stdout: stdout as "pipe",
      stderr: stderr as "pipe",
      ...(options.extraFileDescriptors === undefined || options.extraFileDescriptors.length === 0
        ? {}
        : {
            stdio: [
              stdin as "ignore",
              stdout as "pipe",
              stderr as "pipe",
              ...options.extraFileDescriptors
            ]
          }),
      detached: true
    })
  } catch (cause) {
    throw new ProcessSpawnFailed({
      executable: request.executable,
      cause: cause instanceof Error ? cause.message : String(cause)
    })
  }

  let stopReason: "timeout" | "cancelled" | "output" | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const groupExists = () => {
    try {
      globalThis.process.kill(-child.pid, 0)
      return true
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== "ESRCH"
    }
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      globalThis.process.kill(-child.pid, signal)
      return
    } catch {
      if (child.exitCode === null) child.kill(signal)
    }
  }
  const terminateGroup = () => {
    // The group may outlive its leader. Signalling must therefore be keyed to
    // the stable process-group id rather than `child.exitCode`.
    signalGroup("SIGTERM")
    if (killTimer !== undefined) return
    killTimer = setTimeout(() => {
      if (groupExists()) signalGroup("SIGKILL")
    }, options.killGraceMs ?? 500)
  }

  const abort = () => {
    if (stopReason === undefined) {
      stopReason = "cancelled"
      terminateGroup()
    }
  }
  options.signal?.addEventListener("abort", abort, { once: true })
  const timeout =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (stopReason === undefined) {
            stopReason = "timeout"
            terminateGroup()
          }
        }, request.timeoutMs)

  let capturedBytes = 0
  const capture = (stream: ReadableStream<Uint8Array> | undefined) => {
    const chunks: Uint8Array[] = []
    if (stream === undefined) {
      return {
        completion: Promise.resolve(),
        settled: () => true,
        cancel: () => {},
        bytes: () => new Uint8Array(),
        failure: () => undefined as unknown
      }
    }

    const reader = stream.getReader()
    let settled = false
    let readFailure: unknown
    const completion = (async () => {
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const remaining = request.outputLimitBytes - capturedBytes
          if (remaining > 0) {
            const accepted = next.value.subarray(0, remaining)
            // Retain bytes independently of Bun's native pipe buffer.
            chunks.push(accepted.slice())
            capturedBytes += accepted.byteLength
          }
          if (next.value.byteLength > remaining && stopReason === undefined) {
            stopReason = "output"
            terminateGroup()
          }
        }
      } catch (cause) {
        readFailure = cause
      } finally {
        settled = true
        reader.releaseLock()
      }
    })()
    return {
      completion,
      settled: () => settled,
      cancel: () => {
        if (!settled) void reader.cancel("Airlock process teardown").catch(() => {})
      },
      bytes: () => join(chunks),
      failure: () => readFailure
    }
  }

  const stdoutCapture = request.stdout === "capture"
    ? capture(child.stdout)
    : capture(undefined)
  const stderrCapture = request.stderr === "capture"
    ? capture(child.stderr)
    : capture(undefined)
  const captures = [stdoutCapture, stderrCapture]
  const waitForCaptures = (milliseconds: number) => {
    if (captures.every((capture) => capture.settled())) {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds)
      void Promise.all(captures.map((capture) => capture.completion)).then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  let directExitObserved = false
  const directExit = child.exited.then(() => {
    directExitObserved = true
  })
  let processGroupObserved = groupExists()
  // A direct-child receipt is not closure completion. Same-group descendants
  // retain inherited descriptors and Cell authority, so completion is the
  // disappearance of the detached process group. Tracking the group directly
  // also avoids depending solely on Bun 1.3's lossy Linux pidfd notification.
  while (true) {
    const present = groupExists()
    processGroupObserved ||= present
    if (
      !present &&
      (processGroupObserved || directExitObserved || stopReason !== undefined)
    ) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!directExitObserved) {
    // Give Bun a bounded chance to publish the already-reaped exit status.
    await Promise.race([
      directExit,
      new Promise<void>((resolve) => setTimeout(resolve, 200))
    ])
  }
  if (stopReason === undefined) {
    // Successful output remains lossless and EOF-driven.
    await Promise.all(captures.map((capture) => capture.completion))
  } else if (!(await waitForCaptures(200))) {
    // Bun 1.3 can leave a pipe reader pending after a killed PID namespace even
    // when the kernel reports the process group gone. Preserve every delivered
    // byte, then bound teardown by cancelling the parent-side readers.
    for (const capture of captures) capture.cancel()
    await waitForCaptures(200)
  }
  const captureFailure = captures
    .map((capture) => capture.failure())
    .find((cause) => cause !== undefined)
  if (captureFailure !== undefined) throw captureFailure
  const stdout = stdoutCapture.bytes()
  const stderr = stderrCapture.bytes()
  if (timeout !== undefined) clearTimeout(timeout)
  if (killTimer !== undefined) clearTimeout(killTimer)
  options.signal?.removeEventListener("abort", abort)

  const receipt = new ProcessReceipt({
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    pid: child.pid,
    exitCode: child.exitCode,
    signal: child.signalCode,
    stdout,
    stderr,
    startedAt,
    finishedAt: DateTime.unsafeMake(new Date())
  })
  switch (stopReason) {
    case "timeout":
      throw new ProcessTimedOut({ timeoutMs: request.timeoutMs!, receipt })
    case "cancelled":
      throw new ProcessCancelled({ receipt })
    case "output":
      throw new ProcessOutputLimitExceeded({ limitBytes: request.outputLimitBytes, receipt })
    default:
      return receipt
  }
}

const isProcessError = (cause: unknown): cause is ProcessError =>
  cause instanceof ProcessContractViolation ||
  cause instanceof ProcessSpawnFailed ||
  cause instanceof ProcessOutputLimitExceeded ||
  cause instanceof ProcessTimedOut ||
  cause instanceof ProcessCancelled

const mergedSignal = (runtime: AbortSignal, requested?: AbortSignal) => {
  if (requested === undefined) return { signal: runtime, close: () => {} }
  const controller = new AbortController()
  const abort = () => controller.abort()
  runtime.addEventListener("abort", abort, { once: true })
  requested.addEventListener("abort", abort, { once: true })
  if (runtime.aborted || requested.aborted) controller.abort()
  return {
    signal: controller.signal,
    close: () => {
      runtime.removeEventListener("abort", abort)
      requested.removeEventListener("abort", abort)
    }
  }
}

/**
 * Effect-owned lifecycle: interrupting the enclosing fiber aborts and waits
 * for the native child cleanup path. The error channel is entirely tagged.
 */
export const runProcess = (
  request: ProcessRequest,
  options: ProcessRunOptions = {}
): Effect.Effect<ProcessReceipt, ProcessError> =>
  Effect.tryPromise({
    try: (runtimeSignal) => {
      const { signal, close } = mergedSignal(runtimeSignal, options.signal)
      return runNativeProcess(request, { ...options, signal }).finally(close)
    },
    catch: (cause) =>
      isProcessError(cause)
        ? cause
        : new ProcessSpawnFailed({
            executable: request.executable,
            cause: cause instanceof Error ? cause.message : String(cause)
          })
  })

export const ProcessRunnerLive = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({ run: runProcess })
)
