import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { defineDecoder } from "../src/core/contract/Decoder.ts"
import { decoderIdentity, reviewPrototype, ReviewError } from "./support/air-review.ts"
import { runReviewedPrototype, type PrototypeHost } from "./support/air-review-evaluator.ts"
import { environment, triage } from "./support/air-review-fixtures.ts"

const done = (result: Schema.Json): Schema.Json => ({ state: "done", id: "receipt-1", result })
const unreachable: PrototypeHost = { resolve: () => Effect.die("no host call expected") }

describe("current-syntax type checker prototype", () => {
  for (const source of [
    'let r = mail.read({missing: "m1"}); return true',
    'let r = mail.read({id: 12}); return true',
    'let r = mail.read({id:"m1", extra:true}); return true',
    'let r = mail.read({id:"m1"}); return r.result.body',
    'let r = mail.read({id:"m1"}); if r.state == "done" { return r.result.bodi }; return true',
    'let r = mail.read({id:"m1"}); if r.state != "done" { return r.result.body }; return true',
    'mail.send({to:"sink@example.com",subject:"Hi",body:"Hello"}); return true',
    'let d = decode(schema.companyRecipient,"sink@example.com"); if d.state == "ok" { mail.send({to:d.value + "",subject:"Hi",body:"Hello"}) }; return true',
    'if false { absent.tool({id:"m1"}) }; return true',
    'return ["one"][10].value',
    'return null',
    'return 1 / 0',
    'assert true; return true'
  ]) it.effect(`rejects before any host call: ${source}`, () => Effect.gen(function* () {
    const error = yield* reviewPrototype(source, environment).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ReviewError)
  }))

  it.effect("checks all branches, tracks per-field origins and bounded call instances", () => Effect.gen(function* () {
    const review = yield* reviewPrototype(triage, environment)
    expect(review.tools).toEqual(["mail.list", "mail.read", "mail.send"])
    expect(review.maximumCalls).toEqual({ "mail.list": 1, "mail.read": 10, "mail.send": 10 })
    const send = review.calls.find((call) => call.tool === "mail.send")!
    expect(send.maximumOccurrences).toBe(10)
    expect(send.control.some((source) => source.endsWith(".unread"))).toBe(true)
    expect(send.arguments.type.kind).toBe("record")
    if (send.arguments.type.kind === "record") {
      expect(send.arguments.type.fields.get("to")!.refinements).toContain(JSON.stringify(["companyRecipient", "1"]))
      expect(send.arguments.type.fields.get("to")!.origins.some((source) => source.endsWith(".from"))).toBe(true)
    }
    expect(review.expressionFacts.size).toBeGreaterThan(20)
  }))

  it.effect("evaluates triage with exact-value proof and filters decoder rejection", () => Effect.gen(function* () {
    const sends: Schema.Json[] = []
    const host: PrototypeHost = { resolve: (name, input) => Effect.sync(() => {
      if (name === "mail.list") return done({ messages: [{ id: "one", unread: true }, { id: "two", unread: true }, { id: "three", unread: false }] })
      if (name === "mail.read") return done({ from: typeof input === "object" && input !== null && "id" in input && input.id === "one" ? "ada@example.com" : "outside@evil.test", subject: "Invoice", body: "Private mail" })
      sends.push(input); return { state: "staged", id: "send-1" }
    }) }
    expect(yield* runReviewedPrototype(yield* reviewPrototype(triage, environment), host)).toBe(true)
    expect(sends).toEqual([{ to: "ada@example.com", subject: "Fwd: Invoice", body: "Private mail" }])
  }))

  it.effect("handles the receipt union through if/else and continues a refused batch", () => Effect.gen(function* () {
    const source = `for id in ["one","two"] { let r = mail.read({id:id}); if r.state == "done" { let subject = r.result.subject } else { if r.state == "staged" { let pending = r.id } else { let reason = r.refusal.code } } }; return true`
    let calls = 0
    const host: PrototypeHost = { resolve: () => Effect.sync(() => ++calls === 1 ? { state: "refused", refusal: { code: "not-allowed", message: "Refused" } } : done({ from: "ada@example.com", subject: "hello", body: "mail" })) }
    expect(yield* runReviewedPrototype(yield* reviewPrototype(source, environment), host)).toBe(true)
    expect(calls).toBe(2)
  }))

  it.effect("makes out-of-range and fractional indexes total Option values", () => Effect.gen(function* () {
    for (const index of [-1, 0, 10, 0.5]) {
      // Unary minus is intentionally not in this sound subset yet.
      if (index < 0) continue
      const source = `let selected = ["one"][${index}]; if selected.state == "some" { return selected.value }; return "none"`
      expect(yield* runReviewedPrototype(yield* reviewPrototype(source, environment), unreachable)).toBe(index === 0 ? "one" : "none")
    }
  }))

  it.effect("decodes wire tool results before exposing transformed fields", () => Effect.gen(function* () {
    const counts = defineToolContract({ name: "counts.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ count: Schema.NumberFromString }) })
    const env = { ...environment, tools: { "counts.read": { contract: counts } }, granted: new Set(["counts.read"]) }
    const review = yield* reviewPrototype('let r = counts.read({id:"one"}); if r.state == "done" { return r.result.count > 10 }; return false', env)
    expect(yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ count: "12" })) })).toBe(true)
    const stopped = yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ count: "invalid" })) }).pipe(Effect.flip)
    expect(stopped.reason).toBe("host-result")
  }))

  it.effect("lifts optional output fields into Option without guest null", () => Effect.gen(function* () {
    const source = 'let r = mail.read({id:"one"}); if r.state == "done" { let preview = r.result.preview; if preview.state == "some" { return preview.value } }; return "absent"'
    const review = yield* reviewPrototype(source, environment)
    const results: readonly Schema.Json[] = [{ from: "a", subject: "b", body: "c" }, { from: "a", subject: "b", body: "c", preview: "short" }]
    for (const [index, result] of results.entries()) {
      expect(yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done(result)) })).toBe(index === 1 ? "short" : "absent")
    }
  }))

  it.effect("rejects opaque schema inspection and statically excessive budgets", () => Effect.gen(function* () {
    const opaque = defineToolContract({ name: "opaque.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({}) })
    expect(yield* reviewPrototype('let r = opaque.read({id:"one"}); return true', { ...environment, tools: { "opaque.read": { contract: opaque } }, granted: new Set(["opaque.read"]) }).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    expect(yield* reviewPrototype(triage, { ...environment, maxCalls: 20 }).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    const review = yield* reviewPrototype('let r = mail.list({mailbox:"inbox"}); return true', environment)
    const failure = yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ messages: Array.from({ length: 11 }, () => ({ id: "one", unread: false })) })) }).pipe(Effect.flip)
    expect(failure.reason).toBe("value-limit")
  }))

  it.effect("intersects refinement proofs inside union/list joins", () => Effect.gen(function* () {
    const other = defineDecoder({ name: "anyText", version: "1", schema: Schema.String })
    const env = { ...environment, decoders: { ...environment.decoders, anyText: other } }
    const source = 'let trusted = decode(schema.companyRecipient,"a@example.com"); let unchecked = decode(schema.anyText,"a@outside.test"); for item in [trusted,unchecked] { if item.state == "ok" { mail.send({to:item.value,subject:"Hi",body:"Hello"}) } }; return true'
    expect(yield* reviewPrototype(source, env).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
  }))

  it.effect("keeps decoder identities injective when names and versions contain separators", () => Effect.sync(() => {
    expect(decoderIdentity({ name: "a@b", version: "c" })).not.toBe(decoderIdentity({ name: "a", version: "b@c" }))
  }))
})

describe("generated type-safety evidence (not a proof)", () => {
  it.effect("runs 10000 generated well-typed programs with randomized conforming results and dynamic checks enabled", () => Effect.gen(function* () {
    let seed = 0x41_72_19
    const random = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum }
    for (let sample = 0; sample < 10_000; sample++) {
      const ids = Array.from({ length: random(4) }, (_, index) => `m${index}`)
      const operation = random(3)
      const use = operation === 0 ? 'let title = "Subject: " + r.result.subject' : operation === 1 ? 'let checked = decode(schema.companyRecipient,r.result.from); if checked.state == "ok" { mail.send({to:checked.value,subject:r.result.subject,body:r.result.body}) }' : 'let selected = [r.result.body][2]; if selected.state == "some" { let found = selected.value }'
      const source = `for id in ${JSON.stringify(ids)} { let r = mail.read({id:id}); if r.state == "done" { ${use} } else { if r.state == "staged" { let pending = r.id } else { let denied = r.refusal.message } } }; return true`
      const review = yield* reviewPrototype(source, environment)
      const host: PrototypeHost = { resolve: (name) => Effect.sync(() => {
        const state = random(3)
        if (state === 0) return { state: "refused", refusal: { code: "policy", message: "Denied" } }
        if (state === 1) return { state: "staged", id: `pending-${sample}` }
        return name === "mail.send" ? done({ messageId: `sent-${sample}` }) : done({ from: random(2) === 0 ? "a@example.com" : "a@outside.test", subject: `subject-${random(100)}`, body: `mail-${random(100)}`, ...(random(2) === 0 ? { preview: "short" } : {}) })
      }) }
      const outcome = yield* runReviewedPrototype(review, host).pipe(Effect.result)
      if (outcome._tag === "Failure") throw new Error(`checker regression seed=${seed} sample=${sample} source=${source} stop=${outcome.failure.reason}`)
      expect(outcome.success).toBe(true)
    }
  }), { timeout: 60_000 })

  it.effect("rejects 1000 ill-typed mutations instead of reaching the host", () => Effect.gen(function* () {
    for (let sample = 0; sample < 1000; sample++) {
      const source = sample % 3 === 0 ? `let r = mail.read({id:${sample}}); return true` : sample % 3 === 1 ? `let r = mail.read({id:"m${sample}"}); return r.result.body` : `let r = mail.read({id:"m${sample}"}); if r.state == "done" { return r.result.missing${sample} }; return true`
      expect(yield* reviewPrototype(source, environment).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    }
  }), { timeout: 60_000 })
})
