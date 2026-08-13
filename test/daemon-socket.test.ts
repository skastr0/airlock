import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  DaemonHealthCheckFailed,
  DaemonProtocolRejected,
  checkDaemonSocket,
  requireDaemonHealth,
  runDaemonHealthServer,
  unixDaemonHealthTransport
} from "../src/daemon/index.ts"

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as const

const withServer = <A, E>(
  body: (socketPath: string) => Effect.Effect<A, E>
) => Effect.scoped(Effect.gen(function* () {
  const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "airlock-daemon-socket-")))
  const run = join(root, "run")
  yield* Effect.promise(() => mkdir(run, { mode: 0o750 }))
  const socketPath = join(run, "daemon.sock")
  yield* Effect.forkScoped(runDaemonHealthServer({
    socketPath,
    state: { grantDigest: digest("a"), ready: true }
  }))
  // Fork acquisition starts immediately; wait only for the listen callback.
  yield* Effect.sleep("25 millis")
  return yield* body(socketPath)
}))

describe("daemon Unix health transport", () => {
  it("proves same-seal readiness over a health-only socket", async () =>
    Effect.runPromise(withServer((socketPath) => Effect.gen(function* () {
      const response = yield* checkDaemonSocket(socketPath, digest("a"))
      expect(response).toMatchObject({ grantDigest: digest("a"), ready: true })
    })))
  )

  it("fails closed for a wrong daemon and has no local fallback", async () =>
    Effect.runPromise(withServer((socketPath) => Effect.gen(function* () {
      const failure = yield* checkDaemonSocket(
        socketPath,
        digest("b")
      ).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(DaemonHealthCheckFailed)
      expect(failure).toMatchObject({ reason: "grant-digest-mismatch" })
    })))
  )

  it("rejects excess request authority instead of interpreting it", async () =>
    Effect.runPromise(withServer((socketPath) => Effect.gen(function* () {
      const transport = unixDaemonHealthTransport(socketPath)
      const response = yield* transport.request({
        request: "health",
        operation: "commit",
        grantDigest: digest("a")
      })
      const rejected = yield* requireDaemonHealth(
        response,
        digest("a")
      ).pipe(Effect.flip)
      expect(rejected).toBeInstanceOf(DaemonProtocolRejected)
      expect(rejected).toMatchObject({ direction: "response" })
    })))
  )


  it("bounds a peer that accepts but never returns a frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "airlock-daemon-stall-"))
    const socketPath = join(root, "daemon.sock")
    const peers = new Set<import("node:net").Socket>()
    const server = createServer((socket) => {
      peers.add(socket)
      socket.once("close", () => peers.delete(socket))
    })
    await new Promise<void>((done, reject) => {
      server.once("error", reject)
      server.listen(socketPath, done)
    })
    const started = Date.now()
    try {
      const failure = await Effect.runPromise(
        unixDaemonHealthTransport(socketPath, 50)
          .request({ request: "health" })
          .pipe(Effect.flip)
      )
      expect(failure).toMatchObject({ operation: "read", reason: "response timed out" })
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      for (const peer of peers) peer.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it("contains no unlink, fetch, or terminal effect site", async () => {
    const source = await readFile(
      new URL("../src/daemon/Socket.ts", import.meta.url),
      "utf8"
    )
    expect(source).not.toMatch(/\bunlink\s*\(/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\.remove\s*\(/)
    expect(source).not.toMatch(/\.commit\s*\(/)
    expect(source).not.toMatch(/\.reap\s*\(/)
  })
})
