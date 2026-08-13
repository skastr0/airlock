import { chmod, lstat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from "node:net"
import { Effect, Schema } from "effect"
import type { BoxGrantSha256 } from "../admission/BoxGrant.ts"
import {
  type DaemonHealthState,
  checkDaemonLiveness,
  handleDaemonRequest
} from "./Protocol.ts"

const MAX_DAEMON_MESSAGE_BYTES = 4_096

export class DaemonSocketFailed extends Schema.TaggedError<DaemonSocketFailed>()(
  "DaemonSocketFailed",
  {
    operation: Schema.Literal("validate", "listen", "connect", "read", "write", "close"),
    reason: Schema.String
  }
) {}

export interface DaemonHealthServerOptions {
  readonly state: DaemonHealthState
  /** A launchd-owned descriptor may be supplied instead of a path. */
  readonly fd?: number
  readonly socketPath?: string
  readonly socketMode?: number
}

const socketFailure = (
  operation: "validate" | "listen" | "connect" | "read" | "write" | "close",
  reason: string
) => new DaemonSocketFailed({ operation, reason })

const reasonOf = (cause: unknown) => cause instanceof Error
  ? cause.message
  : String(cause)

const validateServerOptions = (
  options: DaemonHealthServerOptions
): Effect.Effect<void, DaemonSocketFailed> => Effect.gen(function* () {
  const hasFd = options.fd !== undefined
  const hasPath = options.socketPath !== undefined
  if (hasFd === hasPath) {
    return yield* socketFailure("validate", "exactly one of fd or socketPath is required")
  }
  if (hasFd && (!Number.isSafeInteger(options.fd) || options.fd! < 0)) {
    return yield* socketFailure("validate", "fd must be a nonnegative integer")
  }
  if (hasPath && (
    options.socketPath!.trim().length === 0 ||
    !isAbsolute(options.socketPath!) ||
    options.socketPath!.includes("\0")
  )) {
    return yield* socketFailure("validate", "socketPath must be an absolute nonblank path")
  }
})

const readFrame = (
  socket: Socket
): Effect.Effect<unknown, DaemonSocketFailed> =>
  Effect.async<unknown, DaemonSocketFailed>((resume) => {
    let bytes = 0
    let text = ""
    let settled = false
    const finish = (effect: Effect.Effect<unknown, DaemonSocketFailed>) => {
      if (settled) return
      settled = true
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("end", onEnd)
      resume(effect)
    }
    const onError = (cause: Error) => finish(Effect.fail(
      socketFailure("read", reasonOf(cause))
    ))
    const onEnd = () => finish(Effect.fail(
      socketFailure("read", "connection ended before one complete frame")
    ))
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_DAEMON_MESSAGE_BYTES) {
        finish(Effect.fail(socketFailure("read", "message exceeds 4096 bytes")))
        socket.destroy()
        return
      }
      text += chunk.toString("utf8")
      const newline = text.indexOf("\n")
      if (newline < 0) return
      if (newline !== text.length - 1 || text.indexOf("\n", newline + 1) >= 0) {
        finish(Effect.fail(socketFailure("read", "expected exactly one newline-delimited frame")))
        socket.destroy()
        return
      }
      try {
        finish(Effect.succeed(JSON.parse(text.slice(0, -1)) as unknown))
      } catch {
        finish(Effect.fail(socketFailure("read", "frame is not valid JSON")))
      }
    }
    socket.on("data", onData)
    socket.once("error", onError)
    socket.once("end", onEnd)
    return Effect.sync(() => {
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("end", onEnd)
      if (!socket.destroyed) socket.destroy()
    })
  })

const writeFrame = (
  socket: Socket,
  value: unknown,
  closeAfterWrite = false
): Effect.Effect<void, DaemonSocketFailed> =>
  Effect.async<void, DaemonSocketFailed>((resume) => {
    const encoded = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(encoded) > MAX_DAEMON_MESSAGE_BYTES) {
      resume(Effect.fail(socketFailure("write", "response exceeds 4096 bytes")))
      return
    }
    let settled = false
    const onError = (cause: Error) => {
      if (settled) return
      settled = true
      resume(Effect.fail(socketFailure("write", reasonOf(cause))))
    }
    socket.once("error", onError)
    socket.write(encoded, "utf8", () => {
      if (settled) return
      settled = true
      socket.off("error", onError)
      if (closeAfterWrite) socket.end()
      resume(Effect.void)
    })
    return Effect.sync(() => socket.off("error", onError))
  })

const serveConnection = (
  socket: Socket,
  state: DaemonHealthState
): Effect.Effect<void, never> =>
  readFrame(socket).pipe(
    Effect.flatMap((request) => handleDaemonRequest(request, state)),
    Effect.flatMap((response) => writeFrame(socket, response, true)),
    Effect.catchAll((error) => writeFrame(socket, error, true).pipe(
      Effect.catchAll(() => Effect.sync(() => socket.destroy()))
    )),
    Effect.asVoid
  )

const startServer = (
  options: DaemonHealthServerOptions
): Effect.Effect<Server, DaemonSocketFailed> =>
  validateServerOptions(options).pipe(
    Effect.zipRight(Effect.async<Server, DaemonSocketFailed>((resume) => {
      let settled = false
      const server = createServer((socket) => {
        Effect.runFork(serveConnection(socket, options.state))
      })
      const finish = (effect: Effect.Effect<Server, DaemonSocketFailed>) => {
        if (settled) return
        settled = true
        server.off("error", onError)
        resume(effect)
      }
      const onError = (cause: Error) => finish(Effect.fail(
        socketFailure("listen", reasonOf(cause))
      ))
      server.once("error", onError)
      const listening = async () => {
        try {
          if (options.socketPath !== undefined) {
            await chmod(options.socketPath, options.socketMode ?? 0o660)
          }
          finish(Effect.succeed(server))
        } catch (cause) {
          server.close()
          finish(Effect.fail(socketFailure("listen", reasonOf(cause))))
        }
      }
      if (options.fd !== undefined) {
        server.listen({ fd: options.fd }, () => void listening())
      } else {
        server.listen(options.socketPath!, () => void listening())
      }
      return Effect.sync(() => {
        if (!server.listening) server.close()
      })
    }))
  )

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void)
      return
    }
    server.close(() => resume(Effect.void))
  })

/**
 * Serve only health on a filesystem Unix socket or launchd-owned descriptor.
 * This component never removes a stale pathname; launchd or a fresh run
 * directory owns lifecycle. Failure is therefore safer than replacing one.
 */
export const runDaemonHealthServer = (
  options: DaemonHealthServerOptions
): Effect.Effect<never, DaemonSocketFailed, never> =>
  Effect.scoped(
    Effect.acquireRelease(startServer(options), closeServer).pipe(
      Effect.zipRight(Effect.never)
    )
  )

const validateClientSocket = (
  socketPath: string
): Effect.Effect<void, DaemonSocketFailed> => Effect.tryPromise({
  try: async () => {
    if (!isAbsolute(socketPath) || socketPath.trim().length === 0 || socketPath.includes("\0")) {
      throw new Error("socket path must be absolute")
    }
    const info = await lstat(socketPath)
    if (info.isSymbolicLink() || !info.isSocket()) {
      throw new Error("path is not a Unix socket")
    }
  },
  catch: (cause) => socketFailure("validate", reasonOf(cause))
})

/** A one-frame health transport. It carries no requested operation or policy. */
export const unixDaemonHealthTransport = (
  socketPath: string,
  timeoutMillis = 2_000
) => ({
  request: (request: unknown): Effect.Effect<unknown, DaemonSocketFailed> =>
    validateClientSocket(socketPath).pipe(
      Effect.zipRight(Effect.acquireUseRelease(
        Effect.async<Socket, DaemonSocketFailed>((resume) => {
          const socket = createConnection(socketPath)
          const timer = setTimeout(() => {
            socket.destroy()
            resume(Effect.fail(socketFailure("connect", "connection timed out")))
          }, timeoutMillis)
          socket.once("connect", () => {
            clearTimeout(timer)
            resume(Effect.succeed(socket))
          })
          socket.once("error", (cause) => {
            clearTimeout(timer)
            resume(Effect.fail(socketFailure("connect", reasonOf(cause))))
          })
          return Effect.sync(() => {
            clearTimeout(timer)
            socket.destroy()
          })
        }),
        (socket) => writeFrame(socket, request).pipe(
          Effect.zipRight(readFrame(socket)),
          Effect.timeoutFail({
            duration: timeoutMillis,
            onTimeout: () => socketFailure("read", "response timed out")
          })
        ),
        (socket) => Effect.sync(() => socket.destroy())
      ))
    )
})

/** Same-seal readiness or a typed refusal; there is no local fallback. */
export const checkDaemonSocket = (
  socketPath: string,
  expectedGrantDigest: BoxGrantSha256,
  timeoutMillis = 2_000
) => checkDaemonLiveness(
  unixDaemonHealthTransport(socketPath, timeoutMillis),
  expectedGrantDigest
)
