import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import {
  defineOutbox,
  defineToolContract,
  DispatchFailed,
  type DispatchPermit,
  DispatchProvenance,
  HttpIntent,
  IdempotencyKey,
  isLivePermit,
  WebCrypto
} from "../src/core/index.ts"
import { handlersFor } from "../src/core/airlock/Implement.ts"
import {
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore
} from "../src/core/testing/index.ts"
import { dispatchHttp } from "../src/host/HttpDispatcher.ts"

const supervisor = new DispatchProvenance({ committedBy: "supervisor" })
const httpBox = defineOutbox({ http: HttpIntent })

const serverFor = (paths: Array<string>) => Effect.acquireRelease(
  Effect.callback<http.Server>((resume) => {
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? "")
      response.end("ok")
    })
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
  }),
  (server) => Effect.callback<void>((resume) => {
    server.closeAllConnections()
    server.close(() => resume(Effect.void))
  })
).pipe(Effect.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`))

const httpWorld = (handler: typeof dispatchHttp) => httpBox.layer.pipe(Layer.provideMerge(Layer.mergeAll(
  memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer,
  Layer.succeed(httpBox.Dispatcher, { http: handler })
)))

const stage = (url: string) => Effect.flatMap(httpBox.Outbox, (outbox) => outbox.stage({
  key: IdempotencyKey.make("security-http-permit"),
  intent: { kind: "http", dispatch: { url, method: "POST", headers: {}, body: "staged-payload" } },
  holdMillis: 0
}))

const Read = defineToolContract({
  name: "security.read",
  version: "1",
  input: Schema.Struct({ resource: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  public: ["resource"],
  emissionEffect: "read"
})
const toolBox = defineOutbox({ "security.read": Read })

const Other = defineToolContract({
  name: "security.other",
  version: "1",
  input: Schema.Struct({ resource: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  public: ["resource"],
  emissionEffect: "read"
})

describe("security: a dispatch permit authorizes one exact request", () => {
  it.effect("refuses substituted HTTP bytes while the genuine permit is live", () => Effect.gen(function* () {
    const paths: Array<string> = []
    const origin = yield* serverFor(paths)
    const handler: typeof dispatchHttp = (request) => Effect.gen(function* () {
      const substituted = yield* dispatchHttp({
        ...request, dispatch: { ...request.dispatch, url: `${origin}/never-staged` }
      }).pipe(Effect.result)
      const delivery = yield* dispatchHttp(request)
      expect({ rejected: Result.isFailure(substituted), paths }).toEqual({ rejected: true, paths: ["/staged"] })
      return delivery
    })
    yield* Effect.gen(function* () {
      const outbox = yield* httpBox.Outbox
      const staged = yield* stage(`${origin}/staged`)
      yield* outbox.commit(staged.id, supervisor)
    }).pipe(Effect.provide(httpWorld(handler)))
  }))

  it.effect("lets only one concurrent use of a live HTTP permit reach the wire", () => Effect.gen(function* () {
    const paths: Array<string> = []
    const origin = yield* serverFor(paths)
    const handler: typeof dispatchHttp = (request) => Effect.gen(function* () {
      const results = yield* Effect.all([
        dispatchHttp(request).pipe(Effect.result), dispatchHttp(request).pipe(Effect.result)
      ], { concurrency: "unbounded" })
      const succeeded = results.filter(Result.isSuccess)
      expect({ deliveries: succeeded.length, paths }).toEqual({ deliveries: 1, paths: ["/staged"] })
      return succeeded[0]?.success ?? (yield* new DispatchFailed({ reason: "no dispatch succeeded" }))
    })
    yield* Effect.gen(function* () {
      const outbox = yield* httpBox.Outbox
      const staged = yield* stage(`${origin}/staged`)
      yield* outbox.commit(staged.id, supervisor)
    }).pipe(Effect.provide(httpWorld(handler)))
  }))

  it.effect("checks a tool permit when its Effect runs, including an Effect built before revocation", () => {
    let calls = 0
    const handlers = handlersFor(toolBox.kinds, {
      "security.read": () => { calls += 1; return { ok: true } }
    }, {})
    let deferred: ReturnType<typeof handlers["security.read"]> | undefined
    const layer = toolBox.layer.pipe(Layer.provideMerge(Layer.mergeAll(
      memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer,
      Layer.succeed(toolBox.Dispatcher, {
        "security.read": (request) => {
          deferred = handlers["security.read"](request)
          return handlers["security.read"](request)
        }
      })
    )))
    return Effect.gen(function* () {
      const outbox = yield* toolBox.Outbox
      const staged = yield* outbox.stage({
        key: IdempotencyKey.make("security-tool-permit"),
        intent: { kind: "security.read", dispatch: { resource: "allowed" } },
        holdMillis: 0
      })
      yield* outbox.commit(staged.id, supervisor)
      expect(calls).toBe(1)
      if (deferred === undefined) return yield* Effect.die("handler never received a permit")
      const replayed = yield* deferred.pipe(Effect.result)
      expect({ rejected: Result.isFailure(replayed), calls }).toEqual({ rejected: true, calls: 1 })
    }).pipe(Effect.provide(layer))
  })

  it.effect("revokes the permit and records uncertainty when constructing a handler throws", () => {
    let permit: DispatchPermit<"http"> | undefined
    const handler: typeof dispatchHttp = (request) => {
      permit = request.permit
      throw new Error("synchronous handler failure")
    }
    return Effect.gen(function* () {
      const outbox = yield* httpBox.Outbox
      const staged = yield* stage("http://127.0.0.1:1/not-sent")
      yield* outbox.commit(staged.id, supervisor).pipe(Effect.exit)
      expect((yield* outbox.inspect(staged.id)).state).toBe("uncertain")
      expect(permit !== undefined && isLivePermit(permit)).toBe(false)
    }).pipe(Effect.provide(httpWorld(handler)))
  })

  it.effect("refuses a live permit at another tool with the same input schema", () => {
    const box = defineOutbox({ "security.read": Read, "security.other": Other })
    const calls: Array<string> = []
    const handlers = handlersFor(box.kinds, {
      "security.read": () => { calls.push("read"); return { ok: true } },
      "security.other": () => { calls.push("other"); return { ok: true } }
    }, {})
    const layer = box.layer.pipe(Layer.provideMerge(Layer.mergeAll(
      memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer,
      Layer.succeed(box.Dispatcher, {
        ...handlers,
        "security.read": (request) => Effect.gen(function* () {
          const wrong = yield* handlers["security.other"](
            request as unknown as Parameters<typeof handlers["security.other"]>[0]
          ).pipe(Effect.result)
          expect(Result.isFailure(wrong)).toBe(true)
          return yield* handlers["security.read"](request)
        })
      })
    )))
    return Effect.gen(function* () {
      const outbox = yield* box.Outbox
      const staged = yield* outbox.stage({
        key: IdempotencyKey.make("security-cross-kind-permit"),
        intent: { kind: "security.read", dispatch: { resource: "allowed" } }, holdMillis: 0
      })
      yield* outbox.commit(staged.id, supervisor)
      expect(calls).toEqual(["read"])
    }).pipe(Effect.provide(layer))
  })
})
