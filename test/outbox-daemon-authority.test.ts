import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import { EmissionRequest } from "../src/domain.ts"
import { LedgerLive } from "../src/Ledger.ts"
import {
  DispatchProvenance,
  Outbox,
  OutboxLive,
  StagedDispatchAuthorization
} from "../src/Outbox.ts"

const sealDigest = `sha256:${"a".repeat(64)}`
const otherSealDigest = `sha256:${"b".repeat(64)}`

const layersFor = (home: string) =>
  OutboxLive.pipe(
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

const withWorld = <A, E>(
  body: (context: {
    readonly fs: Context.Tag.Service<typeof FileSystem.FileSystem>
    readonly path: Context.Tag.Service<typeof Path.Path>
    readonly home: string
    readonly outbox: Context.Tag.Service<typeof Outbox>
    readonly baseUrl: string
    readonly received: () => number
  }) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fs.makeTempDirectoryScoped()
      const home = path.join(temporary, "airlock-home")
      const outbox = yield* Effect.provide(Outbox, layersFor(home))
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
        fs,
        path,
        home,
        outbox,
        baseUrl: `http://127.0.0.1:${address.port}`,
        received: () => hits
      })
    })
  ).pipe(Effect.provide(BunContext.layer))

const authorizationFor = (endpoint: string) =>
  new StagedDispatchAuthorization({
    sealDigest,
    grantId: "grant/read-api",
    grantSelector: `${endpoint.slice(0, endpoint.lastIndexOf("/") + 1)}*`,
    dispatchClass: "read",
    endpoint
  })

const post = (url: string, body: string) =>
  new EmissionRequest({
    url,
    method: "POST",
    headers: { authorization: "Bearer private-token" },
    body
  })

describe("Outbox — persisted daemon dispatch authority", () => {
  it.effect("discovers only matching sealed read evidence after restart", () =>
    withWorld(({ fs, path, home, outbox, baseUrl, received }) =>
      Effect.gen(function* () {
        const authorizedUrl = `${baseUrl}/read`
        const authorization = authorizationFor(authorizedUrl)
        const authorized = yield* outbox.stage(
          post(authorizedUrl, "private-authorized-body"),
          60_000,
          authorization
        )
        const unsealed = yield* outbox.stage(
          post(`${baseUrl}/mutate`, "private-unsealed-body"),
          60_000
        )

        expect(authorized.authorization).toEqual(authorization)
        expect(unsealed.authorization).toBeUndefined()
        expect(received()).toBe(0)

        const manifestJson = yield* fs.readFileString(
          path.join(
            home,
            "outbox",
            `${authorized.id}.staged`,
            "manifest.json"
          )
        )
        expect(JSON.parse(manifestJson)).toMatchObject({
          schemaVersion: "airlock/outbox-manifest/v1",
          authorization
        })
        expect(manifestJson).not.toContain("private-authorized-body")
        expect(manifestJson).not.toContain("private-token")

        const restarted = yield* Effect.provide(Outbox, layersFor(home))
        const wrongSeal = yield* restarted.pendingAuthorized(otherSealDigest)
        expect(wrongSeal).toEqual([])
        expect(received()).toBe(0)

        const discovered = yield* restarted.pendingAuthorized(sealDigest)
        expect(discovered.map((emission) => emission.id)).toEqual([
          authorized.id
        ])
        expect(discovered[0]?.authorization).toEqual(authorization)
        expect(JSON.stringify(discovered)).not.toContain(
          "private-authorized-body"
        )
        expect(JSON.stringify(discovered)).not.toContain("private-token")
        expect(received()).toBe(0)

        const inspected = yield* restarted.inspect(authorized.id)
        expect(inspected.authorization).toEqual(authorization)
        const pending = yield* restarted.pending
        expect(pending.map((emission) => emission.id).sort()).toEqual(
          [authorized.id, unsealed.id].sort()
        )

        const stored = discovered[0]?.authorization
        expect(stored).toBeDefined()
        if (stored === undefined) return
        const committed = yield* restarted.commit(
          authorized.id,
          new DispatchProvenance({
            committedBy: "policy-auto",
            grantId: stored.grantId,
            grantSelector: stored.grantSelector,
            dispatchClass: stored.dispatchClass,
            endpoint: stored.endpoint
          })
        )
        expect(committed.outcome?.provenance).toMatchObject({
          committedBy: "policy-auto",
          grantId: "grant/read-api",
          dispatchClass: "read",
          endpoint: authorizedUrl
        })
        expect(committed.authorization).toEqual(authorization)
        expect(received()).toBe(1)
        expect((yield* restarted.inspect(unsealed.id)).status).toBe("staged")
        expect(yield* restarted.pendingAuthorized(sealDigest)).toEqual([])
      })
    )
  )

  it.effect("rejects an authorization bound to another endpoint", () =>
    withWorld(({ outbox, baseUrl, received }) =>
      Effect.gen(function* () {
        const failure = yield* outbox.stage(
          post(`${baseUrl}/actual`, "body"),
          60_000,
          authorizationFor(`${baseUrl}/other`)
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "InvalidOutboxIntent",
          field: "authorization.endpoint"
        })
        expect(yield* outbox.pending).toEqual([])
        expect(received()).toBe(0)
      })
    )
  )

  it.effect("fails closed on wider authorization vocabulary in a manifest", () =>
    withWorld(({ fs, path, home, outbox, baseUrl, received }) =>
      Effect.gen(function* () {
        const endpoint = `${baseUrl}/read`
        const staged = yield* outbox.stage(
          post(endpoint, "body"),
          60_000,
          authorizationFor(endpoint)
        )
        const manifestPath = path.join(
          home,
          "outbox",
          `${staged.id}.staged`,
          "manifest.json"
        )
        const document = JSON.parse(
          yield* fs.readFileString(manifestPath)
        ) as { authorization: Record<string, unknown> }
        document.authorization.commit = "auto"
        yield* fs.writeFileString(manifestPath, JSON.stringify(document))

        const restarted = yield* Effect.provide(Outbox, layersFor(home))
        const failure = yield* restarted
          .pendingAuthorized(sealDigest)
          .pipe(Effect.flip)
        expect(failure).toMatchObject({
          _tag: "OutboxStateCorrupt",
          id: staged.id,
          document: "manifest.json"
        })
        expect(received()).toBe(0)
      })
    )
  )

  it.effect("refuses an exact-byte dispatch substitution before terminal transition", () =>
    withWorld(({ fs, path, home, outbox, baseUrl, received }) =>
      Effect.gen(function* () {
        const endpoint = `${baseUrl}/read`
        const staged = yield* outbox.stage(
          post(endpoint, "secret-body"),
          0,
          authorizationFor(endpoint)
        )
        const dispatchPath = path.join(
          home,
          "outbox",
          `${staged.id}.staged`,
          "dispatch.json"
        )
        const original = yield* fs.readFileString(dispatchPath)
        expect(original).toContain("/read")
        yield* fs.writeFileString(dispatchPath, original.replace("/read", "/evil"))

        const failure = yield* outbox.commit(staged.id, new DispatchProvenance({
          committedBy: "policy-auto",
          grantId: "grant/read-api",
          grantSelector: `${baseUrl}/*`,
          dispatchClass: "read",
          endpoint
        })).pipe(Effect.flip)
        expect(failure).toMatchObject({
          _tag: "OutboxStateCorrupt",
          id: staged.id,
          document: "dispatch.json"
        })
        expect((yield* outbox.inspect(staged.id)).status).toBe("staged")
        expect(received()).toBe(0)
      })
    )
  )

})
