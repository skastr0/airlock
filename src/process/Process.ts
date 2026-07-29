import { Context, DateTime, Effect, Layer, Schema } from "effect"

/**
 * A structured, non-shell process boundary for macOS/Bun.
 *
 * `executable` is always an absolute path and `argv` is passed to Bun as
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
  argv: Schema.Array(Schema.String),
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
  argv: Schema.Array(Schema.String),
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
  for (const [index, argument] of request.argv.entries()) {
    if (argument.includes("\0")) throw invalid(`argv[${index}]`, "must not contain NUL")
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
      argv: request.argv,
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
    child = Bun.spawn({
      cmd: [request.executable, ...request.argv],
      cwd: request.cwd,
      env: request.env,
      stdin: stdin as "ignore",
      stdout: output(request.stdout) as "pipe",
      stderr: output(request.stderr) as "pipe",
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
  const terminateGroup = () => {
    if (child.exitCode !== null) return
    try {
      // `detached: true` makes the direct child the POSIX session/group leader.
      globalThis.process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
    killTimer = setTimeout(() => {
      if (child.exitCode !== null) return
      try {
        globalThis.process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
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
  const capture = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (stream === undefined) return new Uint8Array()
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const remaining = request.outputLimitBytes - capturedBytes
        if (remaining > 0) {
          const accepted = next.value.subarray(0, remaining)
          chunks.push(accepted)
          capturedBytes += accepted.byteLength
        }
        if (next.value.byteLength > remaining && stopReason === undefined) {
          stopReason = "output"
          terminateGroup()
        }
      }
    } finally {
      reader.releaseLock()
    }
    return join(chunks)
  }

  const stdoutRead = request.stdout === "capture" ? capture(child.stdout) : Promise.resolve(new Uint8Array())
  const stderrRead = request.stderr === "capture" ? capture(child.stderr) : Promise.resolve(new Uint8Array())
  await child.exited
  const [stdout, stderr] = await Promise.all([stdoutRead, stderrRead])
  if (timeout !== undefined) clearTimeout(timeout)
  if (killTimer !== undefined) clearTimeout(killTimer)
  options.signal?.removeEventListener("abort", abort)

  const receipt = new ProcessReceipt({
    executable: request.executable,
    argv: request.argv,
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
