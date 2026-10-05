import { Context, Effect, Fiber, FileSystem, Layer, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import { LedgerLive } from "../src/Ledger.ts"
import {
  DispatchProvenance,
  HttpExternalIntent,
  Outbox,
  OutboxLive
} from "../src/Outbox.ts"

const bySupervisor = new DispatchProvenance({ committedBy: "supervisor" })

const layersFor = (home: string) =>
  OutboxLive.pipe(
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunServices.layer)
  )

interface World {
  readonly outbox: Context.Service.Shape<typeof Outbox>
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
        Effect.callback<http.Server>((resume) => {
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
  ).pipe(Effect.provide(BunServices.layer))

const post = (url: string) =>
  new HttpExternalIntent({ url, method: "POST", body: "payload" })

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
        const error = yield* outbox.commit(emission.id, bySupervisor).pipe(Effect.flip)
        expect(error._tag).toBe("EmissionNotPending")
        expect(received()).toBe(0)
      })
    )
  )

  it.effect("commit is the affirmative gate: performs the send, records the outcome", () =>
    world(({ outbox, received, url }) =>
      Effect.gen(function* () {
        const emission = yield* outbox.stage(post(url), 60_000)
        const committed = yield* outbox.commit(emission.id, bySupervisor)
        expect(committed.status).toBe("committed")
        expect(committed.outcome?.status).toBe(200)
        expect(received()).toBe(1)

        // committing twice is unrepresentable in state
        const error = yield* outbox.commit(emission.id, bySupervisor).pipe(Effect.flip)
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
        const committing = yield* Effect.forkChild(outbox.commit(staged.id, bySupervisor))
        yield* Effect.callback<void>((resume) => {
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
