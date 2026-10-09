import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { handlersFor } from "../src/core/airlock/Implement.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { consumeWireToken, defineOutbox, type DispatchPermit, enterImplementation, isLiveWireToken, type WireToken } from "../src/core/outbox/Outbox.ts"
import { DispatchProvenance, IdempotencyKey } from "../src/core/outbox/Records.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"

const Get = defineToolContract({ name: "http.get", version: "1", effect: "capture", input: Schema.Struct({ endpoint: Schema.String }), output: Schema.Boolean })
const box = defineOutbox({ "http.get": Get })
const authority = new DispatchProvenance({ committedBy: "supervisor" })

const world = (implementation: Parameters<typeof handlersFor>[1], observe?: (permit: DispatchPermit) => void) => {
  const handlers = handlersFor(box.kinds, implementation, {})
  return box.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer,
    Layer.succeed(box.Dispatcher, { "http.get": (request) => { observe?.(request.permit); return handlers["http.get"](request) } })
  )))
}

const call = Effect.gen(function* () {
  const outbox = yield* box.Outbox
  const staged = yield* outbox.stage({ key: IdempotencyKey.make("wire-call"), intent: { kind: "http.get", dispatch: { endpoint: "https://example.com/" } }, holdMillis: 0 })
  return yield* outbox.commit(staged.id, authority)
})

describe("core: implementation wire token", () => {
  it.effect("allows one genuine use while the call is live and refuses copies and forgery", () => {
    let token: WireToken | undefined
    return call.pipe(Effect.provide(world({ "http.get": (_: unknown, context: { wireToken: WireToken }) => {
      token = context.wireToken
      expect(isLiveWireToken(token)).toBe(true)
      expect(consumeWireToken({ ...token })).toBe(false)
      expect(consumeWireToken(JSON.parse(JSON.stringify(token)))).toBe(false)
      expect(consumeWireToken(token)).toBe(true)
      expect(isLiveWireToken(token)).toBe(false)
      expect(consumeWireToken(token)).toBe(false)
      return true
    } })), Effect.tap(() => Effect.sync(() => { expect(token !== undefined && isLiveWireToken(token)).toBe(false) })))
  })

  it.effect("revokes an unused token after a call settles and refuses second derivation", () => {
    let token: WireToken | undefined, parent: DispatchPermit | undefined
    return call.pipe(Effect.provide(world({ "http.get": (_: unknown, context: { wireToken: WireToken }) => {
      token = context.wireToken
      expect(parent === undefined ? undefined : enterImplementation(parent, "http.get", '{"endpoint":"https://example.com/"}')).toBeUndefined()
      return true
    } }, (permit) => { parent = permit })), Effect.tap(() => Effect.sync(() => {
      if (token === undefined) throw new Error("implementation must receive a token")
      expect(isLiveWireToken(token)).toBe(false)
      expect(consumeWireToken(token)).toBe(false)
    })))
  })

  it.effect("cannot derive a token for a substituted call while the parent permit is live", () => {
    const layer = box.layer.pipe(Layer.provideMerge(Layer.mergeAll(
      memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer,
      Layer.succeed(box.Dispatcher, { "http.get": (request) => Effect.sync(() => {
        expect(enterImplementation(request.permit, "http.get", '{"endpoint":"https://outside.test/"}')).toBeUndefined()
        const token = enterImplementation(request.permit, "http.get", '{"endpoint":"https://example.com/"}')
        expect(token !== undefined && consumeWireToken(token)).toBe(true)
        return { outcome: true, response: new Uint8Array(), truncated: false }
      }) })
    )))
    return call.pipe(Effect.provide(layer))
  })

  it.effect("refuses an aborted token before the parent call has settled", () => {
    const layer = box.layer.pipe(Layer.provideMerge(Layer.mergeAll(
      memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer,
      Layer.succeed(box.Dispatcher, { "http.get": (request) => Effect.sync(() => {
        const controller = new AbortController()
        const token = enterImplementation(request.permit, "http.get", '{"endpoint":"https://example.com/"}', controller.signal)
        if (token === undefined) throw new Error("live exact permit must derive a token")
        expect(isLiveWireToken(token)).toBe(true)
        controller.abort()
        expect(isLiveWireToken(token)).toBe(false)
        expect(consumeWireToken(token)).toBe(false)
        return { outcome: true, response: new Uint8Array(), truncated: false }
      }) })
    )))
    return call.pipe(Effect.provide(layer))
  })
})
