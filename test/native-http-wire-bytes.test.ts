import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { artifactIdOf } from "../src/native/Artifacts.ts"
import { httpTools } from "../src/native/HttpTools.ts"
import { HttpGet, HttpStage } from "../src/native/index.ts"
import { memoryArtifacts } from "./support/MemoryArtifacts.ts"

/**
 * The rule: the digest a person approved covers the bytes that leave. A real
 * server records the raw bytes of each request body, and each case compares
 * them with the approved bytes, byte for byte.
 */

const server = Effect.acquireRelease(
  Effect.promise(() => new Promise<{ origin: string; bodies: Array<Uint8Array>; close: () => void }>((resolve) => {
    const bodies: Array<Uint8Array> = []
    const http = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => { chunks.push(chunk) })
      request.on("end", () => {
        bodies.push(new Uint8Array(Buffer.concat(chunks)))
        response.writeHead(204).end()
      })
    })
    http.listen(0, "127.0.0.1", () =>
      resolve({ origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, bodies, close: () => http.close() }))
  })),
  (running) => Effect.sync(running.close)
)

/** Stages one http.stage call as a guest and commits it as the supervisor. */
const send = (origin: string, artifacts: ReturnType<typeof memoryArtifacts>, body: { body: string } | { bodyArtifact: string }) =>
  Effect.gen(function* () {
    const airlock = defineAirlock({
      contracts: [HttpGet, HttpStage],
      implement: httpTools({ responseLimitBytes: 1_024, artifacts: artifacts.store }),
      policy: toolPolicy({
        toolGrants: [toolGrant(HttpStage, { id: "stage" })],
        resources: { endpoint: [`${origin}/*`] },
        budget: { maxCalls: 10, maxInputBytes: 100_000 }
      })
    })
    return yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: `run-${crypto.randomUUID()}`, env: undefined })
      const staged = yield* guest.call("http.stage", { endpoint: `${origin}/send`, method: "POST", headers: {}, holdMillis: 0, ...body })
      return yield* (yield* airlock.supervisor(undefined)).commit((staged as { id: string }).id)
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(
      memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer
    )))), Effect.result)
  })

describe("the bytes that leave are the bytes that were approved", () => {
  it.live("an artifact body leaves byte for byte: a byte-order mark, invalid UTF-8, NUL and CRLF included", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, bodies } = yield* server
      const artifacts = memoryArtifacts()
      const cases = [
        new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("approved")]),
        new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28, 0xed, 0xa0, 0x80]),
        new TextEncoder().encode("line one\r\nline two\n\u0000tail"),
        new TextEncoder().encode("﻿﻿doubled mark, é decomposed, é composed")
      ]
      for (const approved of cases) {
        const id = artifacts.put(approved)
        yield* send(origin, artifacts, { bodyArtifact: id })
        const left = bodies.at(-1)!
        expect([...left]).toEqual([...approved])
        // What left has the digest the request named.
        expect(artifactIdOf(left)).toBe(id)
      }
      expect(bodies).toHaveLength(cases.length)
    }))
  )

  it.live("a text body leaves as its exact UTF-8 encoding, once", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, bodies } = yield* server
      const artifacts = memoryArtifacts()
      for (const text of ["plain", "﻿marked", "é and é stay distinct", "astral \u{1f512} and tab\tand CRLF\r\n"]) {
        yield* send(origin, artifacts, { body: text })
        expect([...bodies.at(-1)!]).toEqual([...new TextEncoder().encode(text)])
      }
      expect(bodies).toHaveLength(4)
    }))
  )

  it.live("text that has no exact encoding is not sent at all", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, bodies } = yield* server
      // A lone surrogate would be silently replaced on encoding.
      const result = yield* send(origin, memoryArtifacts(), { body: "broken \ud800 text" })
      expect(result._tag).toBe("Failure")
      expect(bodies).toEqual([])
    }))
  )
})
