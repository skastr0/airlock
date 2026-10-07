import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { defineOutbox, HttpIntent, IdempotencyKey, Ledger, OutboxStore, WebCrypto } from "../src/core/index.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"

const http = defineOutbox({ http: HttpIntent })
const request = (parameter: string) => ({
  url: `https://account.blob.core.windows.net/container/blob?sv=2026-04-06&sp=r&${parameter}=sas-canary-secret`,
  method: "GET" as const, headers: {}
})

describe("security: standard HTTP credential aliases", () => {
  it.each(["sig", "SIG", "%73ig"])("refuses a SAS signature under %s without repeating its value", (parameter) => {
    const result = HttpIntent.summarize(request(parameter))
    expect(Result.isFailure(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("sas-canary-secret")
  })

  it.effect("stores no SAS signature in the sealed dispatch or ledger", () => Effect.gen(function* () {
    const storeState = makeMemoryOutboxState()
    const ledgerState = makeMemoryLedgerState()
    const outcome = yield* Effect.gen(function* () {
      const outbox = yield* http.Outbox
      return yield* Effect.result(outbox.stage({
        key: IdempotencyKey.make("sas-1"), intent: { kind: "http", dispatch: request("sig") }, holdMillis: 0
      }))
    }).pipe(Effect.provide(http.layer.pipe(Layer.provideMerge(Layer.mergeAll(
      memoryOutboxStore(storeState), memoryLedger(ledgerState), WebCrypto.layer,
      Layer.succeed(http.Dispatcher, { http: () => Effect.die("staging must not dispatch") })
    )))))
    const records = yield* Effect.flatMap(OutboxStore, (store) => store.list()).pipe(Effect.provide(memoryOutboxStore(storeState)))
    const entries = yield* Effect.flatMap(Ledger, (ledger) => ledger.entries).pipe(Effect.provide(memoryLedger(ledgerState)))
    expect({
      state: outcome._tag, records: records.length, entries: entries.length,
      dispatches: storeState.dispatches.size,
      storesSignature: [...storeState.dispatches.values()].some((sealed) => sealed.canonical.includes("sas-canary-secret"))
    }).toEqual({ state: "Failure", records: 0, entries: 0, dispatches: 0, storesSignature: false })
  }))

  it("accepts unrelated names containing the letters sig", () => {
    const result = HttpIntent.summarize({ url: "https://example.test/?design=one", method: "GET", headers: {} })
    expect(Result.isSuccess(result)).toBe(true)
  })
})
