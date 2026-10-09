import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { Refused } from "../src/core/airlock/Implement.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import type { WireToken } from "../src/core/outbox/Outbox.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { sendHttp } from "../src/host/HttpDispatcher.ts"
import { HttpGet, HttpStage } from "../src/native/index.ts"
import { artifactIdOf } from "../src/native/Artifacts.ts"
import { memoryArtifacts } from "./support/MemoryArtifacts.ts"
import { type HttpToolContext, httpTools } from "../src/native/HttpTools.ts"
import { endpointResources } from "../src/core/contract/PortableToolHost.ts"

/**
 * The two HTTP tools against a real server, called the way the kernel calls
 * them: the wire token each implementation receives is minted by the kernel
 * for an admitted, committed call. Nothing here builds a token.
 */


type Seen = { readonly method: string; readonly url: string; readonly headers: IncomingMessage["headers"]; readonly body: string }

const server = Effect.acquireRelease(
  Effect.promise(() => new Promise<{ origin: string; seen: Array<Seen>; close: () => void }>((resolve) => {
    const seen: Array<Seen> = []
    const http = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => {
        seen.push({ method: request.method!, url: request.url!, headers: request.headers, body })
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/elsewhere" }).end()
        } else if (request.url === "/big") {
          response.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(5_000))
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true}`)
        }
      })
    })
    http.listen(0, "127.0.0.1", () =>
      resolve({ origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, seen, close: () => http.close() }))
  })),
  (running) => Effect.sync(running.close)
)

const artifacts = memoryArtifacts()
const textArtifact = artifacts.put("artifact body")
const binaryArtifact = artifacts.put(new Uint8Array([0xff, 0xfe]))
const tools = httpTools({ responseLimitBytes: 1_024, artifacts: artifacts.store })

const bound = (endpoint: string, right: "connect" | "emit") =>
  endpointResources.bind({ kind: "endpoint", selector: endpoint, rights: [right], field: "endpoint" })

/**
 * Makes one call as a guest of an Airlock over the two contracts, commits it
 * as the supervisor if it was staged, and returns what its implementation
 * answered. The kernel admits the endpoint and hands it to the implementation.
 */
const call = <Name extends "http.get" | "http.stage">(
  origin: string,
  kind: Name,
  input: unknown,
  implementation: (input: never, context: HttpToolContext) => Effect.Effect<unknown, unknown> = tools[kind] as never
) =>
  Effect.gen(function* () {
    let answer: unknown
    const airlock = defineAirlock({
      contracts: [HttpGet, HttpStage],
      implement: {
        ...tools,
        [kind]: (admitted: never, context: HttpToolContext) =>
          implementation(admitted, context).pipe(Effect.tap((value) => Effect.sync(() => { answer = value })))
      } as never,
      policy: toolPolicy({
        toolGrants: [toolGrant(HttpGet, { id: "get", when: "now" }), toolGrant(HttpStage, { id: "stage" })],
        resources: { endpoint: [`${origin}/*`] },
        budget: { maxCalls: 10, maxInputBytes: 100_000 }
      })
    })
    yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: `run-${crypto.randomUUID()}`, env: undefined })
      const result = yield* guest.call(kind, input)
      if (typeof result === "object" && result !== null && "staged" in result) {
        yield* (yield* airlock.supervisor).commit((result as { id: string }).id)
      }
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(
      memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer
    )))), Effect.result)
    return answer
  })

describe("local HTTP tools", () => {
  it.live("http.get asks once, with no body and only the header the contract allows", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, seen } = yield* server
      const answer = yield* call(origin, "http.get", { endpoint: `${origin}/status`, accept: "application/json" })
      expect(answer).toEqual({ status: 200, content_type: "application/json", bytes: 11, truncated: false, body: `{"ok":true}` })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ method: "GET", url: "/status", body: "" })
      expect(seen[0]!.headers.accept).toBe("application/json")
    }))
  )

  it.live("never follows a redirect, and says when a response was cut short", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, seen } = yield* server
      expect(yield* call(origin, "http.get", { endpoint: `${origin}/redirect`, accept: "*/*" })).toMatchObject({ status: 302 })
      expect(seen.map((request) => request.url)).toEqual(["/redirect"])
      expect(yield* call(origin, "http.get", { endpoint: `${origin}/big`, accept: "text/plain" }))
        .toMatchObject({ status: 200, bytes: 1_024, truncated: true, body: null })
    }))
  )

  it.live("http.stage sends exactly the staged request and keeps the response as an artifact", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, seen } = yield* server
      const answer = yield* call(origin, "http.stage", {
        endpoint: `${origin}/send`, method: "POST", headers: { "content-type": "text/plain" }, body: "payload", holdMillis: 0
      })
      expect(answer).toMatchObject({ status: 200, bytes: 11, truncated: false, response_artifact: artifactIdOf(new TextEncoder().encode(`{"ok":true}`)) })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ method: "POST", url: "/send", body: "payload" })

      yield* call(origin, "http.stage", { endpoint: `${origin}/send`, method: "PUT", headers: {}, bodyArtifact: textArtifact, holdMillis: 0 })
      expect(seen[1]).toMatchObject({ method: "PUT", body: "artifact body" })
      // A body that is not text is refused before anything is sent.
      const refusal = yield* call(origin, "http.stage", { endpoint: `${origin}/send`, method: "PUT", headers: {}, bodyArtifact: binaryArtifact, holdMillis: 0 })
      expect(refusal).toBeInstanceOf(Refused)
      expect(seen).toHaveLength(2)
    }))
  )

  it.live("one call reaches the wire once, and never after it has settled", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, seen } = yield* server
      const request = { method: "GET" as const, headers: {} }
      const extra = yield* bound(`${origin}/extra`, "connect")
      let saved: WireToken | undefined
      let second: unknown
      yield* call(origin, "http.get", { endpoint: `${origin}/status`, accept: "*/*" }, (input, context) =>
        Effect.gen(function* () {
          saved = context.wireToken
          const answer = yield* tools["http.get"](input, context)
          second = yield* sendHttp(context.wireToken, extra, request, 1_024).pipe(Effect.flip)
          return answer
        }))
      expect(second).toMatchObject({ _tag: "DispatchRefused" })
      expect(seen.map((entry) => entry.url)).toEqual(["/status"])

      // A token kept past its call, and a copy of one, send nothing.
      let unused: WireToken | undefined
      yield* call(origin, "http.get", { endpoint: `${origin}/status`, accept: "*/*" }, (_input, context) =>
        Effect.sync(() => {
          unused = context.wireToken
          return { status: 0, content_type: null, bytes: 0, truncated: false, body: null }
        }))
      expect((yield* sendHttp(unused!, extra, request, 1_024).pipe(Effect.flip))._tag).toBe("DispatchRefused")
      expect((yield* sendHttp({ ...saved! }, extra, request, 1_024).pipe(Effect.flip))._tag).toBe("DispatchRefused")
      expect(seen.map((entry) => entry.url)).toEqual(["/status"])
    }))
  )

  it.live("sends only to the endpoint admission bound, whatever the input says", () =>
    Effect.scoped(Effect.gen(function* () {
      const { origin, seen } = yield* server
      // An implementation handed a different input than the one admitted
      // still reaches only the bound address.
      const answer = yield* call(origin, "http.get", { endpoint: `${origin}/admitted`, accept: "*/*" }, (_input, context) =>
        tools["http.get"]({ endpoint: `${origin}/somewhere-else`, accept: "*/*" }, context))
      expect(answer).toMatchObject({ status: 200 })
      expect(seen.map((entry) => entry.url)).toEqual(["/admitted"])
      // Without an admitted endpoint, or with a resource that is not one, nothing is sent.
      const none = yield* call(origin, "http.get", { endpoint: `${origin}/admitted`, accept: "*/*" }, (input, context) =>
        tools["http.get"](input, { wireToken: context.wireToken, resources: [] }))
      expect(none).toBeInstanceOf(Refused)
      let wrongKind: unknown
      yield* call(origin, "http.get", { endpoint: `${origin}/admitted`, accept: "*/*" }, (_input, context) =>
        sendHttp(context.wireToken, {
          binding: { field: "endpoint", kind: "path", rights: ["read"], selector: `${origin}/path`, identity: {} },
          capability: undefined
        }, { method: "GET", headers: {} }, 1_024).pipe(
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => { wrongKind = error }))
        ))
      expect(wrongKind).toMatchObject({ _tag: "DispatchRefused" })
      expect(seen.map((entry) => entry.url)).toEqual(["/admitted"])
    }))
  )
})
