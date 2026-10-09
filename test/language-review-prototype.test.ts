import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { defineDecoder } from "../src/core/contract/Decoder.ts"
import { decoderIdentity, reviewPrototype, ReviewError } from "./support/air-review.ts"
import { runReviewedPrototype, type PrototypeHost } from "./support/air-review-evaluator.ts"
import { environment, triage } from "./support/air-review-fixtures.ts"
import { runnerExamples } from "./support/hostile-air-corpus.ts"

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
    'return 1 / 0',
    'assert 12; return true'
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

  it.effect("offers nullable at and fixed termination for partial indexing", () => Effect.gen(function* () {
    for (const index of [-1, 0, 10, 0.5]) {
      const source = `let selected = at(["one"],${index}); if selected != null { return selected }; return "none"`
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

  it.effect("normalizes optional output fields to typed null", () => Effect.gen(function* () {
    const source = 'let r = mail.read({id:"one"}); if r.state == "done" { if r.result.preview != null { return "Preview: " + r.result.preview } }; return "absent"'
    const review = yield* reviewPrototype(source, environment)
    const results: readonly Schema.Json[] = [{ from: "a", subject: "b", body: "c" }, { from: "a", subject: "b", body: "c", preview: "short" }]
    for (const [index, result] of results.entries()) {
      expect(yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done(result)) })).toBe(index === 1 ? "Preview: short" : "absent")
    }
  }))

  it.effect("rejects opaque schema inspection and statically excessive budgets", () => Effect.gen(function* () {
    const opaque = defineToolContract({ name: "opaque.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({}) })
    expect(yield* reviewPrototype('let r = opaque.read({id:"one"}); if r.state == "done" { return r.result.missing }; return true', { ...environment, tools: { "opaque.read": { contract: opaque } }, granted: new Set(["opaque.read"]) }).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
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

  it.effect("retains selector and implicit control dependencies through a second capture", () => Effect.gen(function* () {
    const source = 'let first = mail.read({id:"m1"}); if first.state == "done" { if first.result.subject == "go" { let second = mail.read({id:first.result.body}); if second.state == "done" { http.get({url:second.result.from}) } } }; return true'
    const review = yield* reviewPrototype(source, environment)
    const get = review.calls.find((call) => call.tool === "http.get")!
    expect(get.arguments.origins.some((origin) => origin.endsWith(".body"))).toBe(true)
    expect(get.arguments.origins.some((origin) => origin.endsWith(".subject"))).toBe(true)
    expect(get.control.some((origin) => origin.endsWith(".body"))).toBe(true)
  }))

  it.effect("accepts opaque results as whole values without inventing field access", () => Effect.gen(function* () {
    const opaque = defineToolContract({ name: "opaque.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({}) })
    const env = { ...environment, tools: { "opaque.read": { contract: opaque } }, granted: new Set(["opaque.read"]) }
    const review = yield* reviewPrototype('let r = opaque.read({id:"one"}); if r.state == "done" { return r.result }; return null', env)
    expect(yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({})) })).toEqual({})
  }))

  it.effect("types assertions, durations and dynamic numeric failures as fixed stops", () => Effect.gen(function* () {
    expect(yield* runReviewedPrototype(yield* reviewPrototype('assert 1s == 1000ms; assert 2s > 1s; return 12 / 3 - 1', environment), unreachable)).toBe(3)
    const assertion = yield* runReviewedPrototype(yield* reviewPrototype('assert false, "private canary"; return true', environment), unreachable).pipe(Effect.flip)
    expect(assertion.reason).toBe("assert_failed")
    expect(JSON.stringify(assertion)).not.toContain("private canary")
    const counts = defineToolContract({ name: "counts.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Number })
    const env = { ...environment, tools: { "counts.read": { contract: counts } }, granted: new Set(["counts.read"]) }
    for (const [operation, value, reason] of [["return 1 / r.result", 0, "arithmetic_failure"], ["return r.result * 2", Number.MAX_VALUE, "arithmetic_failure"], ["return [1][r.result]", 0.5, "index_out_of_range"], ["for n in 0..r.result { let value = n }; return true", 0.5, "range_bound"]] as const) {
      const review = yield* reviewPrototype(`let r = counts.read({id:"one"}); if r.state == "done" { ${operation} }; return false`, env)
      const stopped = yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done(value)) }).pipe(Effect.flip)
      expect(stopped.reason).toBe(reason)
    }
  }))

  it.effect("keeps literal schema alternatives exact for dynamic inputs", () => Effect.gen(function* () {
    const target = defineToolContract({ name: "pick.use", version: "1", effect: "capture", input: Schema.Struct({ value: Schema.Union([Schema.Literal("a"), Schema.Literal("b")]) }), output: Schema.Boolean })
    const env = { ...environment, tools: { ...environment.tools, "pick.use": { contract: target } }, granted: new Set([...environment.granted, "pick.use"]) }
    const source = 'let r = mail.read({id:"one"}); if r.state == "done" { pick.use({value:r.result.subject}) }; return true'
    expect(yield* reviewPrototype(source, env).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    const known = 'for value in ["a","b"] { pick.use({value:value}) }; return true'
    expect(yield* runReviewedPrototype(yield* reviewPrototype(known, env), { resolve: () => Effect.succeed(done(true)) })).toBe(true)
  }))

  it.effect("encodes constructed optional null as omitted and preserves decoded aliases", () => Effect.gen(function* () {
    const optional = defineToolContract({ name: "optional.use", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String, preview: Schema.optionalKey(Schema.String) }), output: Schema.Boolean })
    const env = { ...environment, tools: { ...environment.tools, "optional.use": { contract: optional } }, granted: new Set([...environment.granted, "optional.use"]) }
    const seen: Schema.Json[] = []
    for (const source of ['optional.use({id:"one",preview:null}); return true', 'let r = mail.read({id:"one"}); if r.state == "done" { optional.use({id:"one",preview:r.result.preview}) }; return true']) {
      expect(yield* runReviewedPrototype(yield* reviewPrototype(source, env), { resolve: (name, input) => Effect.sync(() => { if (name === "mail.read") return done({ from: "a", subject: "b", body: "c" }); seen.push(input); return done(true) }) })).toBe(true)
    }
    expect(seen).toEqual([{ id: "one" }, { id: "one" }])
    const shape = Schema.Struct({ id: Schema.String, preview: Schema.optionalKey(Schema.String) })
    const read = defineToolContract({ name: "optional.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: shape })
    const aliasEnv = { ...env, tools: { ...env.tools, "optional.read": { contract: read } }, granted: new Set([...env.granted, "optional.read"]) }
    const alias = yield* reviewPrototype('let r = optional.read({id:"one"}); if r.state == "done" { optional.use(r.result) }; return true', aliasEnv)
    const inputs: Schema.Json[] = []
    expect(yield* runReviewedPrototype(alias, { resolve: (name, input) => Effect.sync(() => { if (name === "optional.read") return done({ id: "one" }); inputs.push(input); return done(true) }) })).toBe(true)
    expect(inputs).toEqual([{ id: "one" }])
    const required = defineToolContract({ name: "required.use", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String, preview: Schema.String }), output: Schema.Boolean })
    const requiredEnv = { ...aliasEnv, tools: { ...aliasEnv.tools, "required.use": { contract: required } }, granted: new Set([...aliasEnv.granted, "required.use"]) }
    expect(yield* reviewPrototype('let r = optional.read({id:"one"}); if r.state == "done" { required.use(r.result) }; return true', requiredEnv).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
  }))

  it.effect("keeps malformed and defective host outputs outside the typed program", () => Effect.gen(function* () {
    const review = yield* reviewPrototype('let r = mail.read({id:"one"}); return true', environment)
    for (const resolve of [() => Effect.die("private host canary"), () => Effect.fail("private host canary"), () => Effect.succeed(done({ from: 12, subject: "b", body: "c" }))]) {
      const error = yield* runReviewedPrototype(review, { resolve }).pipe(Effect.flip)
      expect(error.reason).toBe("host-result")
      expect(JSON.stringify(error)).not.toContain("private host canary")
    }
  }))
})

describe("generated type-safety evidence (not a proof)", () => {
  it.effect("checks 1000 independent expression/range/index/record oracles from the runner corpus", () => Effect.gen(function* () {
    const echo = defineToolContract({ name: "security.echo", version: "1", effect: "capture", input: Schema.Struct({ value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]) }), output: Schema.Boolean })
    const env = { ...environment, tools: { "security.echo": { contract: echo } }, granted: new Set(["security.echo"]) }
    for (const example of runnerExamples(0x518adc, 1000)) {
      let calls = 0
      const result = yield* runReviewedPrototype(yield* reviewPrototype(example.source, env), { resolve: () => Effect.sync(() => { calls++; return done(true) }) })
      expect(result).toEqual(example.value)
      expect(calls).toBe(example.calls)
    }
  }), { timeout: 60_000 })
  it.effect("runs 10000 generated well-typed programs with randomized conforming results and dynamic checks enabled", () => Effect.gen(function* () {
    let seed = 0x41_72_19
    const random = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum }
    for (let sample = 0; sample < 10_000; sample++) {
      const ids = Array.from({ length: random(4) }, (_, index) => `m${index}`)
      const operation = random(3)
      const use = operation === 0 ? 'let title = "Subject: " + r.result.subject' : operation === 1 ? 'let checked = decode(schema.companyRecipient,r.result.from); if checked.state == "ok" { mail.send({to:checked.value,subject:r.result.subject,body:r.result.body}) }' : 'let selected = at([r.result.body],2); if selected != null { let found = selected }'
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
