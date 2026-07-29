import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import { EmissionRequest } from "../src/domain.ts"
import {
  Ledger,
  LedgerFilesystemError
} from "../src/Ledger.ts"
import {
  Outbox,
  OutboxLive
} from "../src/Outbox.ts"

type LedgerAct = "stage" | "commit" | "cancel"

const failingLedger = (failedAct: LedgerAct) =>
  Layer.succeed(
    Ledger,
    Ledger.of({
      record: (entry) =>
        entry.act === failedAct
          ? Effect.fail(
              new LedgerFilesystemError({
                operation: "append",
                path: "/injected/ledger.jsonl",
                reason: `injected ${failedAct} ledger failure`
              })
            )
          : Effect.void,
      entries: Effect.succeed([])
    })
  )

const layersFor = (home: string, failedAct: LedgerAct) =>
  OutboxLive.pipe(
    Layer.provideMerge(failingLedger(failedAct)),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

const withWorld = <A, E>(
  failedAct: LedgerAct,
  body: (context: {
    readonly outbox: typeof Outbox.Service
    readonly url: string
    readonly received: () => number
  }) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fs.makeTempDirectoryScoped()
      const home = path.join(temporary, "airlock-home")
      const outbox = yield* Effect.provide(
        Outbox,
        layersFor(home, failedAct)
      )
      let hits = 0
      const server = yield* Effect.acquireRelease(
        Effect.async<http.Server>((resume) => {
          const value = http.createServer((_request, response) => {
            hits += 1
            response.writeHead(200)
            response.end("ok")
          })
          value.listen(0, "127.0.0.1", () =>
            resume(Effect.succeed(value))
          )
        }),
        (value) =>
          Effect.async<void>((resume) => {
            value.close(() => resume(Effect.void))
          })
      )
      const address = server.address() as AddressInfo
      return yield* body({
        outbox,
        url: `http://127.0.0.1:${address.port}/hook`,
        received: () => hits
      })
    })
  ).pipe(Effect.provide(BunContext.layer))

const post = (url: string) =>
  new EmissionRequest({
    url,
    method: "POST",
    body: "payload"
  })

describe("Outbox — ledger recovery receipts", () => {
  it.effect("returns the inspectable staged id when ledger append fails", () =>
    withWorld("stage", ({ outbox, received, url }) =>
      Effect.gen(function* () {
        const failure = yield* outbox.stage(post(url), 60_000).pipe(Effect.flip)
        expect(failure._tag).toBe("OutboxRecoveryRequired")
        if (failure._tag !== "OutboxRecoveryRequired") return

        expect(failure).toMatchObject({
          phase: "ledger-after-stage",
          status: "staged",
          emission: {
            status: "staged"
          }
        })
        expect(failure.emission.id).toBe(failure.id)
        expect(yield* outbox.inspect(failure.id)).toEqual(failure.emission)
        expect((yield* outbox.pending).map((emission) => emission.id)).toEqual([
          failure.id
        ])
        expect(received()).toBe(0)
      })
    )
  )

  it.effect("returns the committed outcome when its ledger append fails without redispatch", () =>
    withWorld("commit", ({ outbox, received, url }) =>
      Effect.gen(function* () {
        const staged = yield* outbox.stage(post(url), 0)
        const failure = yield* outbox.commit(staged.id).pipe(Effect.flip)
        expect(failure._tag).toBe("OutboxRecoveryRequired")
        if (failure._tag !== "OutboxRecoveryRequired") return

        expect(failure).toMatchObject({
          id: staged.id,
          phase: "ledger-after-commit",
          status: "committed",
          emission: {
            id: staged.id,
            status: "committed",
            outcome: {
              status: 200
            }
          }
        })
        expect(yield* outbox.inspect(staged.id)).toEqual(failure.emission)
        expect(received()).toBe(1)

        const retry = yield* outbox.commit(staged.id).pipe(Effect.flip)
        expect(retry._tag).toBe("EmissionNotPending")
        expect(received()).toBe(1)
      })
    )
  )

  it.effect("returns the cancelled receipt when its ledger append fails", () =>
    withWorld("cancel", ({ outbox, received, url }) =>
      Effect.gen(function* () {
        const staged = yield* outbox.stage(post(url), 60_000)
        const failure = yield* outbox.cancel(staged.id).pipe(Effect.flip)
        expect(failure._tag).toBe("OutboxRecoveryRequired")
        if (failure._tag !== "OutboxRecoveryRequired") return

        expect(failure).toMatchObject({
          id: staged.id,
          phase: "ledger-after-cancel",
          status: "cancelled",
          emission: {
            id: staged.id,
            status: "cancelled"
          }
        })
        expect(yield* outbox.inspect(staged.id)).toEqual(failure.emission)
        expect(received()).toBe(0)
      })
    )
  )
})
