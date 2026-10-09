import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { portableToolHost } from "../src/core/contract/PortableToolHost.ts"
import { describeWire, prepareWire, type WireRequest } from "../src/core/contract/Wire.ts"
import { type ToolHost } from "../src/core/contract/ToolHost.ts"
import { Sha256Digest } from "../src/core/Canonical.ts"
import { isLiveWireToken, takeWireRequest } from "../src/core/outbox/Outbox.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"

const digest = Sha256Digest.make(`sha256:${"a".repeat(64)}`)
const input = Schema.Struct({ url: Schema.String, body: Schema.optionalKey(Schema.String), artifact: Schema.optionalKey(Schema.String) })
const post = defineToolContract({ name: "http.stage", version: "1", effect: "request", input, output: Schema.Boolean, public: ["url"],
  resources: { url: { kind: "endpoint", rights: ["emit"] } }, wire: (value) => ({ endpoint: "url", method: "POST", headers: { "X-Checked": "approved" },
    ...(value.body === undefined ? {} : { body: value.body }), ...(value.artifact === undefined ? {} : { bodyArtifact: value.artifact }) }) })
const policy = toolPolicy({ resources: { endpoint: ["https://example.test/*"] }, toolGrants: [toolGrant(post, { id: "post" })], budget: { maxCalls: 3, maxInputBytes: 4096 } })

describe("core: declared exact wire requests", () => {
  it.effect("takes only the admitted endpoint, headers and body once, keeping private content out of authority", () => {
    const seen: WireRequest[] = []
    const airlock = defineAirlock({ contracts: [post], policy, implement: { "http.stage": (_input, context) => {
      expect(isLiveWireToken(context.wireToken)).toBe(true)
      const request = takeWireRequest(context.wireToken)
      if (request === undefined) throw new Error("declared wire must be bound")
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.headers)).toBe(true)
      seen.push(request)
      expect(takeWireRequest(context.wireToken)).toBeUndefined()
      return true
    } } })
    const state = makeMemoryOutboxState()
    const layer = airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(state), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer)))
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "exact-wire", env: undefined })
      const staged = yield* guest.call("http.stage", { url: "https://example.test/admitted", body: "private-body-canary" })
      const supervisor = yield* airlock.supervisor(undefined)
      expect(seen).toEqual([])
      const stored = [...state.records.values()][0]!
      expect(stored.admission?.execution?.wire?.digest).toMatch(/^sha256:/)
      expect(JSON.stringify(stored)).not.toContain("private-body-canary")
      yield* supervisor.commit((staged as { id: string }).id)
      expect(seen[0]).toMatchObject({ method: "POST", headers: { "x-checked": "approved" }, body: "private-body-canary",
        endpoint: { binding: { selector: "https://example.test/admitted" } } })
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses a changed declaration before issuing wire authority", () => {
    const current = { headers: { "x-checked": "one" }, body: "approved" }
    let calls = 0
    const contract = defineToolContract({ name: "http.stage", version: "1", effect: "request", input, output: Schema.Boolean, public: ["url"],
      resources: { url: { kind: "endpoint", rights: ["emit"] } }, wire: () => ({ endpoint: "url", method: "POST", headers: current.headers, body: current.body }) })
    const airlock = defineAirlock({ contracts: [contract], policy, implement: { "http.stage": () => { calls++; return true } } })
    const layer = airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer)))
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "declaration-drift", env: undefined })
      const receipt = yield* guest.call("http.stage", { url: "https://example.test/admitted" })
      current.headers["x-checked"] = "injected"
      current.body = "unreviewed body"
      const supervisor = yield* airlock.supervisor(undefined)
      const rejected = yield* supervisor.commit((receipt as { id: string }).id).pipe(Effect.result)
      expect(Result.isFailure(rejected)).toBe(true)
      expect(calls).toBe(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("binds artifact content digests at staging and requires a digest provider for opaque ids", () => Effect.gen(function* () {
    const bound = yield* portableToolHost.resources.bind({ kind: "endpoint", selector: "https://example.test/admitted", field: "url", rights: ["emit"] })
    const addressed = yield* prepareWire(post, { url: bound.binding.selector, artifact: digest }, [bound.binding], portableToolHost)
    expect(addressed?.bodyArtifactDigest).toBe(digest)
    const unsupported = yield* prepareWire(post, { url: bound.binding.selector, artifact: "opaque" }, [bound.binding], portableToolHost).pipe(Effect.result)
    expect(unsupported).toMatchObject({ _tag: "Failure", failure: { _tag: "ResourceRefused" } })
    const host: ToolHost = { ...portableToolHost, wireBodyDigest: () => Effect.succeed(digest) }
    const opaque = yield* prepareWire(post, { url: bound.binding.selector, artifact: "opaque" }, [bound.binding], host)
    expect(opaque?.bodyArtifactDigest).toBe(digest)
    const material = Result.getOrThrow(describeWire(post, { url: bound.binding.selector, artifact: "opaque" }, [bound.binding], opaque?.bodyArtifactDigest))
    expect(material).toMatchObject({ bodyArtifact: "opaque", bodyArtifactDigest: digest })
  }).pipe(Effect.provide(WebCrypto.layer)))

  it.effect("gives a contract without a wire declaration no opening capability", () => {
    const pure = defineToolContract({ name: "pure.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Boolean })
    const airlock = defineAirlock({ contracts: [pure], implement: { "pure.read": (_input, context) => {
      expect(isLiveWireToken(context.wireToken)).toBe(false)
      expect(takeWireRequest(context.wireToken)).toBeUndefined()
      return true
    } }, policy: toolPolicy({ toolGrants: [toolGrant(pure, { id: "read", when: "now" })], budget: { maxCalls: 1, maxInputBytes: 4096 } }) })
    return Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "no-wire", env: undefined })
      yield* guest.call("pure.read", { id: "value" })
    }).pipe(Effect.provide(airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryOutboxStore(makeMemoryOutboxState()), memoryLedger(makeMemoryLedgerState()), WebCrypto.layer)))))
  })
})
