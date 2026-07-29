import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import { EmissionRequest } from "../src/domain.ts"
import { Ledger, LedgerLive } from "../src/Ledger.ts"
import {
  ExternalCommandIntent,
  Outbox,
  OutboxLive
} from "../src/Outbox.ts"

const layersFor = (home: string) =>
  OutboxLive.pipe(
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

const withWorld = <A, E>(
  body: (context: {
    readonly home: string
    readonly fs: Context.Tag.Service<typeof FileSystem.FileSystem>
    readonly path: Context.Tag.Service<typeof Path.Path>
    readonly outbox: Context.Tag.Service<typeof Outbox>
    readonly ledger: Context.Tag.Service<typeof Ledger>
    readonly url: string
    readonly received: () => number
  }) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmp = yield* fs.makeTempDirectoryScoped()
      const home = path.join(tmp, "airlock-home")
      const outbox = yield* Effect.provide(Outbox, layersFor(home))
      const ledger = yield* Effect.provide(Ledger, layersFor(home))
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
        (server) =>
          Effect.async<void>((resume) => {
            server.close(() => resume(Effect.void))
          })
      )
      const address = server.address() as AddressInfo
      return yield* body({
        home,
        fs,
        path,
        outbox,
        ledger,
        url: `http://127.0.0.1:${address.port}/hook`,
        received: () => hits
      })
    })
  ).pipe(Effect.provide(BunContext.layer))

const post = (
  url: string,
  options?: {
    readonly body?: string
    readonly headers?: Readonly<Record<string, string>>
  }
) =>
  new EmissionRequest({
    url,
    method: "POST",
    ...(options?.body === undefined ? {} : { body: options.body }),
    ...(options?.headers === undefined ? {} : { headers: options.headers })
  })

describe("Outbox — durable dispatch boundary", () => {
  it.effect("has one claimant under concurrent commit", () =>
    withWorld(({ outbox, received, url }) =>
      Effect.gen(function* () {
        const staged = yield* outbox.stage(post(url), 60_000)
        const results = yield* Effect.all(
          [
            outbox.commit(staged.id).pipe(Effect.either),
            outbox.commit(staged.id).pipe(Effect.either)
          ],
          { concurrency: "unbounded" }
        )

        expect(results.filter((result) => result._tag === "Right")).toHaveLength(
          1
        )
        expect(results.filter((result) => result._tag === "Left")).toHaveLength(
          1
        )
        expect(received()).toBe(1)
      })
    )
  )

  it.effect("does not silently follow a redirect to an unadmitted endpoint", () =>
    withWorld(({ outbox, received, url }) =>
      Effect.scoped(Effect.gen(function* () {
        let originHits = 0
        const origin = yield* Effect.acquireRelease(
          Effect.async<http.Server>((resume) => {
            const value = http.createServer((_request, response) => {
              originHits += 1
              response.writeHead(302, { location: url })
              response.end()
            })
            value.listen(0, "127.0.0.1", () =>
              resume(Effect.succeed(value))
            )
          }),
          (server) =>
            Effect.async<void>((resume) => {
              server.close(() => resume(Effect.void))
            })
        )
        const address = origin.address() as AddressInfo
        const staged = yield* outbox.stage(
          post(`http://127.0.0.1:${address.port}/redirect`),
          60_000
        )

        const committed = yield* outbox.commit(staged.id)
        expect(committed.outcome?.status).toBe(302)
        expect(originHits).toBe(1)
        expect(received()).toBe(0)
      }))
    )
  )

  it.effect("records transport ambiguity as terminal uncertain and never retries it", () =>
    withWorld(({ outbox }) =>
      Effect.gen(function* () {
        const staged = yield* outbox.stage(
          post("http://127.0.0.1:1/unreachable"),
          60_000
        )

        const first = yield* outbox.commit(staged.id).pipe(Effect.flip)
        expect(first._tag).toBe("EmissionDispatchUncertain")
        expect((yield* outbox.inspect(staged.id)).status).toBe("uncertain")

        const retry = yield* outbox.commit(staged.id).pipe(Effect.flip)
        expect(retry._tag).toBe("EmissionNotPending")
        expect((yield* outbox.pending).map((item) => item.id)).not.toContain(
          staged.id
        )
      })
    )
  )

  it.effect("recovers a durable committing claim as uncertain without dispatch", () =>
    withWorld(({ fs, home, outbox, path, received, url }) =>
      Effect.gen(function* () {
        const staged = yield* outbox.stage(post(url), 60_000)
        const root = path.join(home, "outbox")
        yield* fs.rename(
          path.join(root, `${staged.id}.staged`),
          path.join(root, `${staged.id}.committing`)
        )

        const restarted = yield* Effect.provide(Outbox, layersFor(home))
        expect((yield* restarted.inspect(staged.id)).status).toBe("uncertain")
        expect(received()).toBe(0)

        const retry = yield* restarted.commit(staged.id).pipe(Effect.flip)
        expect(retry._tag).toBe("EmissionNotPending")
        expect(received()).toBe(0)
      })
    )
  )

  it.effect("fails closed when one id has multiple lifecycle directories", () =>
    withWorld(({ fs, home, outbox, path, url }) =>
      Effect.gen(function* () {
        const staged = yield* outbox.stage(post(url), 60_000)
        const root = path.join(home, "outbox")
        yield* fs.copy(
          path.join(root, `${staged.id}.staged`),
          path.join(root, `${staged.id}.committed`)
        )

        const inspected = yield* outbox.inspect(staged.id).pipe(Effect.flip)
        expect(inspected._tag).toBe("OutboxStateCorrupt")
        if (inspected._tag === "OutboxStateCorrupt") {
          expect(inspected.document).toBe("multiple-state-directories")
        }

        const listed = yield* outbox.pending.pipe(Effect.flip)
        expect(listed._tag).toBe("OutboxStateCorrupt")
      })
    )
  )

  it.effect("keeps secrets out of public records, manifest metadata, and ledger", () =>
    withWorld(({ fs, home, ledger, outbox, path, url }) =>
      Effect.gen(function* () {
        const secretHeader = "Bearer top-secret-token"
        const secretBody = "private-body-value"
        const secretQuery = "query-secret"
        const staged = yield* outbox.stage(
          post(`${url}?token=${secretQuery}`, {
            body: secretBody,
            headers: { authorization: secretHeader }
          }),
          60_000
        )

        expect(JSON.stringify(staged)).not.toContain(secretHeader)
        expect(JSON.stringify(staged)).not.toContain(secretBody)
        expect(JSON.stringify(staged)).not.toContain(secretQuery)

        const manifest = yield* fs.readFileString(
          path.join(
            home,
            "outbox",
            `${staged.id}.staged`,
            "manifest.json"
          )
        )
        expect(manifest).not.toContain(secretHeader)
        expect(manifest).not.toContain(secretBody)
        expect(manifest).not.toContain(secretQuery)

        const entries = yield* ledger.entries
        expect(JSON.stringify(entries)).not.toContain(secretHeader)
        expect(JSON.stringify(entries)).not.toContain(secretBody)
        expect(JSON.stringify(entries)).not.toContain(secretQuery)
      })
    )
  )

  it.effect("rejects invalid holds and external commands before staging", () =>
    withWorld(({ outbox }) =>
      Effect.gen(function* () {
        const badHold = yield* outbox
          .stage(post("https://example.com"), Number.NaN)
          .pipe(Effect.flip)
        expect(badHold._tag).toBe("InvalidHoldDuration")

        const unsupported = yield* outbox
          .stage(
            new ExternalCommandIntent({
              executable: "/usr/bin/curl",
              args: ["https://example.com"]
            }),
            1_000
          )
          .pipe(Effect.flip)
        expect(unsupported._tag).toBe("UnsupportedExternalIntent")
        expect(yield* outbox.pending).toHaveLength(0)
      })
    )
  )

  it.effect("keeps the single wire-capable site lexically inside Outbox.commit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString("src/Outbox.ts")
      expect(source.match(/\bfetch\s*\(/g)).toHaveLength(1)
      const commitStart = source.indexOf('const commit = Effect.fn("Outbox.commit")')
      const cancelStart = source.indexOf('const cancel = Effect.fn("Outbox.cancel")')
      const fetchSite = source.indexOf("fetch(")
      expect(commitStart).toBeGreaterThanOrEqual(0)
      expect(fetchSite).toBeGreaterThan(commitStart)
      expect(fetchSite).toBeLessThan(cancelStart)
    }).pipe(Effect.provide(BunContext.layer))
  )
})
