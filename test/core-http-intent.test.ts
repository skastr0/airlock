import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { defineOutbox, HttpIntent, IdempotencyKey, Ledger, OutboxStore, WebCrypto } from "../src/core/index.ts"
import {
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore
} from "../src/core/testing/index.ts"

const request = (url: string, headers: Record<string, string> = {}) =>
  ({ url, method: "POST", headers, body: "payload" }) as const

const refusal = (url: string, headers: Record<string, string> = {}) => {
  const summarized = HttpIntent.summarize(request(url, headers))
  return Result.isFailure(summarized) ? summarized.failure : undefined
}

describe("core: the HTTP kind holds no credentials", () => {
  it("refuses a literal credential in the well-known positions, naming the field", () => {
    const refused = [
      refusal("https://api.example.test/send", { Authorization: "Bearer abc" }),
      refusal("https://api.example.test/send", { "proxy-authorization": "Basic abc" }),
      refusal("https://api.example.test/send", { cookie: "sid=abc" }),
      refusal("https://api.example.test/send", { "X-Api-Key": "abc" }),
      refusal("https://api.example.test/send", { "x-session-id": "abc" }),
      refusal("https://api.example.test/send?access_token=abc"),
      refusal("https://api.example.test/send?page=2&api_key=abc"),
      refusal("https://user:pw@api.example.test/send")
    ]
    expect(refused.map((failure) => failure?.field)).toEqual([
      "headers.Authorization",
      "headers.proxy-authorization",
      "headers.cookie",
      "headers.X-Api-Key",
      "headers.x-session-id",
      "url query parameter access_token",
      "url query parameter api_key",
      "url"
    ])
    for (const failure of refused) {
      expect(failure?._tag).toBe("InvalidIntent")
      // The refusal names the position and never repeats the value.
      expect(JSON.stringify(failure)).not.toMatch(/abc|pw@|sid=/)
    }
  })

  it("accepts ordinary headers and parameters, and summarizes them without values", () => {
    const summarized = HttpIntent.summarize(
      request("https://api.example.test/send?page=2&cursor=opaque", {
        "content-type": "application/json",
        "x-request-id": "r-1"
      })
    )
    expect(Result.isSuccess(summarized)).toBe(true)
    expect(Result.getOrThrow(summarized)).toMatchObject({
      target: "https://api.example.test/send",
      headerNames: ["content-type", "x-request-id"]
    })
    expect(JSON.stringify(Result.getOrThrow(summarized))).not.toMatch(/opaque|r-1/)
  })

  it.effect("stores nothing, in the store or the Ledger, for a refused request", () =>
    Effect.gen(function* () {
      const http = defineOutbox({ http: HttpIntent })
      const outboxState = makeMemoryOutboxState()
      const ledgerState = makeMemoryLedgerState()
      const layer = http.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            memoryOutboxStore(outboxState),
            memoryLedger(ledgerState),
            WebCrypto.layer,
            Layer.succeed(http.Dispatcher, { http: () => Effect.die("a refused request is never dispatched") })
          )
        )
      )
      const failure = yield* Effect.gen(function* () {
        const outbox = yield* http.Outbox
        return yield* Effect.flip(outbox.stage({
          key: IdempotencyKey.make("refused-1"),
          intent: {
            kind: "http",
            dispatch: request("https://api.example.test/send", { authorization: "Bearer canary-secret" })
          },
          holdMillis: 0
        }))
      }).pipe(Effect.provide(layer))
      expect(failure).toMatchObject({ _tag: "InvalidIntent", kind: "http", field: "headers.authorization" })

      const stored = yield* Effect.flatMap(OutboxStore, (store) => store.list()).pipe(
        Effect.provide(memoryOutboxStore(outboxState))
      )
      const entries = yield* Effect.flatMap(Ledger, (ledger) => ledger.entries).pipe(
        Effect.provide(memoryLedger(ledgerState))
      )
      expect([stored.length, entries.length, outboxState.dispatches.size]).toEqual([0, 0, 0])
      expect(JSON.stringify([failure, [...outboxState.records], ledgerState.entries])).not.toContain("canary-secret")
    }))
})
