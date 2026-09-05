import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import { EmissionRequest } from "../src/domain.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { Outbox, OutboxLive } from "../src/Outbox.ts"

const layersFor = (home: string) =>
  OutboxLive.pipe(
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

interface World {
  readonly outbox: Context.Tag.Service<typeof Outbox>
  readonly received: () => number
  readonly home: string
  readonly url: string
}

const world = <A, E>(body: (ctx: World) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmp = yield* fs.makeTempDirectoryScoped()
      const home = path.join(tmp, "airlock-home")
      const outbox = yield* Effect.provide(
        Outbox,
        layersFor(home)
      )
      let hits = 0
      const server = yield* Effect.acquireRelease(
        Effect.async<http.Server>((resume) => {
          const s = http.createServer((req, res) => {
            hits += 1
            const respond = () => {
              res.writeHead(200)
              res.end("ok")
            }
            if (req.url === "/slow") setTimeout(respond, 150)
            else respond()
          })
          s.listen(0, "127.0.0.1", () => resume(Effect.succeed(s)))
        }),
        (s) =>
          Effect.sync(() => {
            // Bun's Node-compatible server stops listening synchronously here,
            // but its close callback can remain pending after a pooled fetch.
            // Force established connections closed and do not await that shim.
            s.close()
            s.closeAllConnections()
          })
      )
      const address = server.address() as AddressInfo
      return yield* body({
        outbox,
        received: () => hits,
        home,
        url: `http://127.0.0.1:${address.port}/hook`
      })
    })
  ).pipe(Effect.provide(BunContext.layer))

const post = (url: string) =>
  new EmissionRequest({ url, method: "POST", body: "payload" })

describe("Outbox — cancellable emissions", () => {
  it.effect("staging sends nothing", () =>
    world(({ outbox, received, url }) =>
      Effect.gen(function* () {
        yield* outbox.stage(post(url), 60_000)
        expect(received()).toBe(0)
        const staged = yield* outbox.pending
        expect(staged.length).toBe(1)
      })
    )
  )

  it.effect("cancel within the hold window: the request never existed on the wire", () =>
    world(({ outbox, received, url }) =>
      Effect.gen(function* () {
        const emission = yield* outbox.stage(post(url), 60_000)
        const cancelled = yield* outbox.cancel(emission.id)
        expect(cancelled.status).toBe("cancelled")
        expect(received()).toBe(0)

        // a cancelled emission cannot be committed
        const error = yield* outbox.commit(emission.id).pipe(Effect.flip)
        expect(error._tag).toBe("EmissionNotPending")
        expect(received()).toBe(0)
      })
    )
  )

  it.effect("commit is the affirmative gate: performs the send, records the outcome", () =>
    world(({ outbox, received, url }) =>
      Effect.gen(function* () {
        const emission = yield* outbox.stage(post(url), 60_000)
        const committed = yield* outbox.commit(emission.id)
        expect(committed.status).toBe("committed")
        expect(committed.outcome?.status).toBe(200)
        expect(received()).toBe(1)

        // committing twice is unrepresentable in state
        const error = yield* outbox.commit(emission.id).pipe(Effect.flip)
        expect(error._tag).toBe("EmissionNotPending")
        expect(received()).toBe(1)
      })
    )
  )

  it.effect("flush honors the hold window: due emissions go, held ones wait", () =>
    world(({ outbox, received, url }) =>
      Effect.gen(function* () {
        const due = yield* outbox.stage(post(url), 0)
        yield* outbox.stage(post(url), 60_000)

        const report = yield* outbox.flush
        expect(report.committed.map((e) => e.id)).toEqual([due.id])
        expect(report.waiting).toBe(1)
        expect(received()).toBe(1)
      })
    )
  )

  it.effect("does not recover a live commit from another Airlock process as uncertain", () =>
    world(({ home, outbox, received, url }) =>
      Effect.gen(function* () {
        const staged = yield* outbox.stage(post(url.replace("/hook", "/slow")), 0)
        const committing = yield* Effect.fork(outbox.commit(staged.id))
        yield* Effect.async<void>((resume) => {
          const timer = setTimeout(() => resume(Effect.void), 25)
          return Effect.sync(() => clearTimeout(timer))
        })

        // Constructing another Outbox used to recover every `.committing`
        // directory immediately. It must now wait for the live claimant.
        const observer = yield* Effect.provide(Outbox, layersFor(home))
        const observed = yield* observer.inspect(staged.id)
        const committed = yield* Fiber.join(committing)

        expect(committed.status).toBe("committed")
        expect(observed.status).toBe("committed")
        expect(received()).toBe(1)
      })
    )
  )
})
