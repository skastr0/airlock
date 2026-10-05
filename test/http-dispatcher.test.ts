import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import {
  DispatchProvenance,
  type DispatchPermit,
  IdempotencyKey,
  RESPONSE_LIMIT_BYTES
} from "../src/core/index.ts"
import { FileLedger, FileLedgerLive, ledgerLayer } from "../src/host/FileLedger.ts"
import * as FileOutboxStore from "../src/host/FileOutboxStore.ts"
import { dispatchHttp } from "../src/host/HttpDispatcher.ts"
import { AirlockOutbox, Dispatcher, Outbox, OutboxLive } from "../src/Outbox.ts"

/**
 * The host's HTTP wire, exercised through the real kernel over the file
 * adapters and a local server. These are the properties of the network call
 * itself; lifecycle and replay are the kernel conformance suite's.
 */
const supervisor = new DispatchProvenance({ committedBy: "supervisor" })

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void

const serverFor = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.callback<http.Server>((resume) => {
      const server = http.createServer(handler)
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections()
        server.close(() => resume(Effect.void))
      })
  ).pipe(Effect.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`))

const freshHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "airlock-http-" }), "home")
})

const hostLayer = (home: string) =>
  OutboxLive.pipe(
    Layer.provideMerge(FileLedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunServices.layer)
  )

const stage = (url: string, options: {
  readonly method?: "GET" | "POST"
  readonly headers?: Record<string, string>
  readonly body?: string
} = {}) =>
  Effect.flatMap(Outbox, (outbox) => outbox.stage({
    // A key is public: it is stored and listed, so it never carries the URL.
    key: IdempotencyKey.make(`http-test:${crypto.randomUUID()}`),
    intent: {
      kind: "http",
      dispatch: {
        url,
        method: options.method ?? "POST",
        headers: options.headers ?? {},
        ...(options.body === undefined ? {} : { body: options.body })
      }
    },
    holdMillis: 0
  }))

const world = <A, E, R>(body: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(freshHome, body)).pipe(Effect.provide(BunServices.layer))

describe("host HTTP dispatcher", () => {
  it.effect("sends nothing at staging and exactly one request at commit", () =>
    world((home) => Effect.gen(function* () {
      let hits = 0
      const origin = yield* serverFor((_request, response) => {
        hits += 1
        response.writeHead(201, { "content-type": "text/plain" })
        response.end("created")
      })
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox
        const staged = yield* stage(`${origin}/hook`, { body: "payload" })
        expect(hits).toBe(0)
        const committed = yield* outbox.commit(staged.id, supervisor)
        expect(hits).toBe(1)
        expect(committed.outcome).toEqual({ status: 201, contentType: "text/plain" })
        expect(committed.capture).toMatchObject({ retainedBytes: 7, truncated: false })
        const again = yield* outbox.commit(staged.id, supervisor).pipe(Effect.flip)
        expect(again._tag).toBe("EmissionNotPending")
        expect(hits).toBe(1)
      }).pipe(Effect.provide(hostLayer(home)))
    })))

  it.effect("refuses a forged permit before any request is built", () =>
    world(() => Effect.gen(function* () {
      let hits = 0
      const origin = yield* serverFor((_request, response) => {
        hits += 1
        response.end()
      })
      // The type system stops this; the handler must stop it too when a cast
      // gets a look-alike value past the types.
      const forged = {
        emissionId: `emi_${"0".repeat(32)}`,
        kind: "http",
        dispatchDigest: `sha256:${"0".repeat(64)}`
      } as unknown as DispatchPermit<"http">
      const refused = yield* dispatchHttp({
        permit: forged,
        dispatch: { url: `${origin}/hook`, method: "POST", headers: {} },
        responseLimitBytes: RESPONSE_LIMIT_BYTES
      }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "DispatchFailed", reason: "dispatch permit is not live" })
      expect(hits).toBe(0)
    })))

  it.effect("refuses a real permit once its dispatch has settled", () =>
    world((home) => Effect.gen(function* () {
      let hits = 0
      const origin = yield* serverFor((_request, response) => {
        hits += 1
        response.end("ok")
      })
      const permits: Array<DispatchPermit<"http">> = []
      // The same kernel and adapters as production, with a wire that keeps
      // the permit it was handed so the test can replay it afterwards.
      const recording = AirlockOutbox.layer.pipe(
        Layer.provide(Layer.succeed(Dispatcher, Dispatcher.of({
          http: (request) => {
            permits.push(request.permit)
            return dispatchHttp(request)
          }
        }))),
        Layer.provide(FileOutboxStore.layer),
        Layer.provide(ledgerLayer),
        Layer.provideMerge(FileLedgerLive),
        Layer.provideMerge(AirlockHome.layer(home)),
        Layer.provideMerge(BunServices.layer)
      )
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox
        const staged = yield* stage(`${origin}/hook`)
        yield* outbox.commit(staged.id, supervisor)
        expect(hits).toBe(1)
        expect(permits).toHaveLength(1)
        const replayed = yield* dispatchHttp({
          permit: permits[0]!,
          dispatch: { url: `${origin}/hook`, method: "POST", headers: {} },
          responseLimitBytes: RESPONSE_LIMIT_BYTES
        }).pipe(Effect.flip)
        expect(replayed).toMatchObject({ _tag: "DispatchFailed", reason: "dispatch permit is not live" })
        expect(hits).toBe(1)
      }).pipe(Effect.provide(recording))
    })))

  it.effect("does not follow a redirect to an address that was never staged", () =>
    world((home) => Effect.gen(function* () {
      const paths: Array<string> = []
      const origin = yield* serverFor((request, response) => {
        paths.push(request.url ?? "")
        if (request.url === "/hook") {
          response.writeHead(302, { location: "/elsewhere" })
          response.end()
          return
        }
        response.end("followed")
      })
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox
        const staged = yield* stage(`${origin}/hook`)
        const committed = yield* outbox.commit(staged.id, supervisor)
        expect(committed.outcome.status).toBe(302)
        expect(paths).toEqual(["/hook"])
      }).pipe(Effect.provide(hostLayer(home)))
    })))

  it.effect("retains at most the construction bound of a response and says so", () =>
    world((home) => Effect.gen(function* () {
      const origin = yield* serverFor((_request, response) => {
        response.writeHead(200)
        response.end(Buffer.alloc(RESPONSE_LIMIT_BYTES * 3, 0x61))
      })
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox
        const staged = yield* stage(`${origin}/large`, { method: "GET" })
        const committed = yield* outbox.commit(staged.id, supervisor)
        expect(committed.capture).toEqual(expect.objectContaining({
          retainedBytes: RESPONSE_LIMIT_BYTES,
          truncated: true,
          limitBytes: RESPONSE_LIMIT_BYTES
        }))
        const response = yield* outbox.response(staged.id)
        expect(response._tag).toBe("Some")
        if (response._tag === "Some") expect(response.value.byteLength).toBe(RESPONSE_LIMIT_BYTES)
      }).pipe(Effect.provide(hostLayer(home)))
    })))

  it.effect("records a failed transport as uncertain and never sends it again", () =>
    world((home) => Effect.gen(function* () {
      let hits = 0
      const origin = yield* serverFor((request) => {
        hits += 1
        request.socket.destroy()
      })
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox
        const staged = yield* stage(`${origin}/drop`)
        const failed = yield* outbox.commit(staged.id, supervisor).pipe(Effect.flip)
        expect(failed._tag).toBe("EmissionDispatchUncertain")
        expect((yield* outbox.inspect(staged.id)).state).toBe("uncertain")
        const retry = yield* outbox.commit(staged.id, supervisor).pipe(Effect.flip)
        expect(retry._tag).toBe("EmissionNotPending")
        expect(hits).toBe(1)
      }).pipe(Effect.provide(hostLayer(home)))
    })))

  it.effect("keeps header values, query values and the body out of everything but the sealed dispatch", () =>
    world((home) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const origin = yield* serverFor((_request, response) => response.end("ok"))
      const secrets = ["header-secret-value", "query-secret-value", "body-secret-value", "user-secret"]
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox
        // Ordinary positions: a credential-named header or parameter would be
        // refused at staging, which the next assertions cover.
        const staged = yield* stage(`${origin}/hook?cursor=query-secret-value`, {
          headers: { "x-request-note": "header-secret-value" },
          body: "body-secret-value"
        })
        const committed = yield* outbox.commit(staged.id, supervisor)
        // A literal credential is refused at staging, and the refusal does not
        // repeat it.
        const withUserinfo = yield* Effect.flip(stage(
          `${origin.replace("http://", "http://user-secret:pw@")}/login`
        ))
        expect(withUserinfo._tag).toBe("InvalidIntent")
        const withHeader = yield* Effect.flip(stage(`${origin}/hook`, {
          headers: { authorization: "Bearer header-secret-value" }
        }))
        const withQuery = yield* Effect.flip(stage(`${origin}/hook?token=query-secret-value`))
        expect([withHeader, withQuery]).toMatchObject([
          { _tag: "InvalidIntent", field: "headers.authorization" },
          { _tag: "InvalidIntent", field: "url query parameter token" }
        ])
        expect((yield* outbox.pending).length).toBe(0)
        const ledger = yield* FileLedger
        const visible = JSON.stringify([
          staged,
          committed,
          withUserinfo,
          withHeader,
          withQuery,
          yield* outbox.inspect(staged.id),
          yield* outbox.pending,
          yield* ledger.entries
        ])
        for (const secret of secrets) expect(visible).not.toContain(secret)

        const files: Array<string> = []
        const walk = (directory: string): Effect.Effect<void, unknown> =>
          Effect.flatMap(fs.readDirectory(directory), (entries) =>
            Effect.forEach(entries, (entry) => {
              const full = path.join(directory, entry)
              return Effect.flatMap(fs.stat(full), (info) =>
                info.type === "Directory" ? walk(full) : Effect.sync(() => { files.push(full) }))
            }, { discard: true }))
        yield* walk(home)
        const leaked: Array<string> = []
        for (const file of files) {
          if (path.basename(file) === "dispatch.json") continue
          const text = yield* fs.readFileString(file)
          for (const secret of secrets) if (text.includes(secret)) leaked.push(`${file}: ${secret}`)
        }
        expect(leaked).toEqual([])
        expect(files.some((file) => path.basename(file) === "dispatch.json")).toBe(true)
      }).pipe(Effect.provide(hostLayer(home)))
    })))

  // Real time: the point is that the second runtime is still waiting.
  it.live("a second runtime waits for a live commit instead of calling it uncertain", () =>
    world((home) => Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const origin = yield* serverFor((_request, response) => {
        Effect.runFork(Deferred.succeed(arrived, undefined))
        Effect.runPromise(Deferred.await(finish)).then(() => response.end("late"))
      })
      const staged = yield* stage(`${origin}/slow`).pipe(Effect.provide(hostLayer(home)))
      const committing = yield* Effect.flatMap(Outbox, (outbox) =>
        outbox.commit(staged.id, supervisor)
      ).pipe(Effect.provide(hostLayer(home)), Effect.forkChild)
      yield* Deferred.await(arrived)
      // A second runtime starts on the same home while the first is on the
      // wire. Its startup recovery must queue behind the commit's lease.
      const second = yield* Effect.flatMap(Outbox, (outbox) =>
        outbox.inspect(staged.id)
      ).pipe(Effect.provide(hostLayer(home)), Effect.forkChild)
      yield* Effect.sleep("100 millis")
      expect(second.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(finish, undefined)
      expect((yield* Fiber.join(committing)).state).toBe("committed")
      expect((yield* Fiber.join(second)).state).toBe("committed")
    })))
})
