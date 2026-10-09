import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { DurationSchema } from "../src/core/language/ast.ts"
import { InformationLabel } from "../src/core/labels/Labels.ts"
import { defineToolContract } from "../src/core/contract/ToolContract.ts"
import { defineDecoder, hasRefinement } from "../src/core/contract/Decoder.ts"
import { createRoleWitnessIssuer } from "../src/core/contract/RoleWitness.ts"
import { decoderIdentity, reviewPrototype, ReviewError, type Review } from "./support/air-review.ts"
import { runReviewedPrototype, type CallObservation, type PrototypeHost } from "./support/air-review-evaluator.ts"
import { CompanyRecipient, environment, triage } from "./support/air-review-fixtures.ts"
import { runnerExamples } from "./support/hostile-air-corpus.ts"

const done = (result: Schema.Json): Schema.Json => ({ state: "done", id: "receipt-1", result })
const unreachable: PrototypeHost = { resolve: () => Effect.die("no host call expected") }
const assertObservedDependencies = (review: Review) => (observed: CallObservation): void => {
  const call = review.calls.find((call) => call.tool === observed.tool && call.span.start === observed.span.start)!
  expect(call).toBeDefined()
  for (const origin of observed.argument.data.provenance) expect(call.arguments.dataOrigins, `whole argument data ${observed.tool}: ${origin}`).toContain(origin)
  for (const origin of observed.argument.control.provenance) expect(call.arguments.controlOrigins, `whole argument control ${observed.tool}: ${origin}`).toContain(origin)
  for (const origin of observed.control.provenance) expect(call.control, `control ${observed.tool}: ${origin}`).toContain(origin)
  if (call.arguments.type.kind === "record") for (const [field, roles] of Object.entries(observed.fields)) {
    const value = call.arguments.type.fields.get(field)!
    for (const origin of roles.data.provenance) expect(value.dataOrigins, `${observed.tool}.${field} data: ${origin}`).toContain(origin)
    for (const origin of roles.control.provenance) expect(value.controlOrigins, `${observed.tool}.${field} control: ${origin}`).toContain(origin)
  }
}

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

  it.effect("retains exact checked schema identity across different tool model paths", () => Effect.gen(function* () {
    const checked = Schema.String.check(Schema.makeFilter((text) => text.startsWith("ok:")))
    const read = defineToolContract({ name: "checked.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: checked })
    const use = defineToolContract({ name: "checked.use", version: "1", effect: "capture", input: Schema.Struct({ value: checked }), output: Schema.Boolean })
    const env = { ...environment, tools: { "checked.read": { contract: read }, "checked.use": { contract: use } }, granted: new Set(["checked.read", "checked.use"]) }
    const source = 'let r = checked.read({id:"one"}); if r.state == "done" { checked.use({value:r.result}) }; return true'
    const review = yield* reviewPrototype(source, env)
    expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name) => Effect.succeed(name === "checked.read" ? done("ok:value") : done(true)) })).toBe(true)
    expect(yield* reviewPrototype(source.replace('value:r.result', 'value:r.result + ""'), env).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
  }))

  it.effect("attests contract-provided decoder proofs without applying a transform again", () => Effect.gen(function* () {
    const provides = defineToolContract({ name: "trusted.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ from: Schema.String }), flow: { provides: { from: [{ name: CompanyRecipient.name, version: CompanyRecipient.version }] } } })
    const env = { ...environment, tools: { ...environment.tools, "trusted.read": { contract: provides } }, granted: new Set([...environment.granted, "trusted.read"]) }
    const review = yield* reviewPrototype('let r = trusted.read({id:"one"}); if r.state == "done" { mail.send({to:r.result.from,subject:"Hi",body:"Hello"}) }; return true', env)
    expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name) => Effect.succeed(name === "trusted.read" ? done({ from: "a@example.com" }) : { state: "staged", id: "send" }) })).toBe(true)
    const failed = yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ from: "a@outside.test" })) }).pipe(Effect.flip)
    expect(failed.reason).toBe("host-result")
  }))

  it.effect("decodes and types trusted host bindings before any program call", () => Effect.gen(function* () {
    const label = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] })
    const env = { ...environment, bindings: { config: { schema: Schema.Struct({ url: Schema.String, count: Schema.NumberFromString }), value: { url: "https://example.com/bound", count: "2" }, label } } }
    const review = yield* reviewPrototype('for n in 0..config.count { http.get({url:config.url}) }; return config.count', { ...env, maxCalls: 100 })
    expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: () => Effect.succeed(done({ text: "ok" })) })).toBe(2)
    expect(yield* reviewPrototype('return config.count + "bad"', env).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    expect(yield* reviewPrototype('let config = 1; return config', env).pipe(Effect.flip)).toHaveProperty("_tag", "DuplicateBinding")
    expect(yield* reviewPrototype('return config.count', { ...env, bindings: { config: { ...env.bindings.config, value: { url: "ok", count: "bad" } } } }).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
  }))

  it.effect("preserves nullable wire fields as null and narrows tagged schema unions", () => Effect.gen(function* () {
    const nullableInput = defineToolContract({ name: "nullable.use", version: "1", effect: "capture", input: Schema.Struct({ preview: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])) }), output: Schema.Boolean })
    const union = defineToolContract({ name: "union.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Union([Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }), Schema.Struct({ kind: Schema.Literal("count"), count: Schema.Number })]) })
    const env = { ...environment, tools: { "nullable.use": { contract: nullableInput }, "union.read": { contract: union } }, granted: new Set(["nullable.use", "union.read"]) }
    let seen: Schema.Json = false
    const nullable = yield* reviewPrototype('nullable.use({preview:null}); return true', env)
    expect(yield* runReviewedPrototype(nullable, { resolve: (_, input) => Effect.sync(() => { seen = input; return done(true) }) })).toBe(true)
    expect(seen).toEqual({ preview: null })
    const source = 'let r = union.read({id:"one"}); if r.state == "done" { if "text" == r.result.kind { return r.result.text + "!" } else { return r.result.count + 1 } }; return null'
    const review = yield* reviewPrototype(source, env)
    expect(yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ kind: "text", text: "hello" })) })).toBe("hello!")
    expect(yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ kind: "count", count: 1 })) })).toBe(2)
  }))

  it.effect("creates duration scalars only from literals or trusted duration schemas", () => Effect.gen(function* () {
    expect(yield* runReviewedPrototype(yield* reviewPrototype('return {kind:"Duration",value:"bad",unit:"s"}.value', environment), unreachable)).toBe("bad")
    expect(yield* runReviewedPrototype(yield* reviewPrototype('return 1s == {kind:"Duration",value:1,unit:"s"}', environment), unreachable)).toBe(false)
    expect(yield* runReviewedPrototype(yield* reviewPrototype('return [1s] == [{kind:"Duration",value:1,unit:"s"}]', environment), unreachable)).toBe(false)
    const duration = defineToolContract({ name: "duration.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: DurationSchema })
    const env = { ...environment, tools: { "duration.read": { contract: duration } }, granted: new Set(["duration.read"]) }
    const review = yield* reviewPrototype('let r = duration.read({id:"one"}); if r.state == "done" { return r.result == 1000ms }; return false', env)
    expect(yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ kind: "Duration", value: 1, unit: "s" })) })).toBe(true)
  }))

  it.effect("keeps receipt metadata distinct and gives wayBack nullable typed fields", () => Effect.gen(function* () {
    const source = 'let r = mail.read({id:"one"}); if r.state == "done" { if r.wayBack != null { http.get({url:r.wayBack.recoveryId}) } }; return true'
    const review = yield* reviewPrototype(source, environment)
    const wayBack = { callId: "call", recoveryId: "recovery", heldUntil: "2099-01-01T00:00:00.000Z" }
    expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name) => Effect.succeed(name === "mail.read" ? { state: "done", id: "id", result: { from: "a", subject: "b", body: "c" }, wayBack } : done({ text: "ok" })) })).toBe(true)
    const ids = yield* reviewPrototype('let r = mail.read({id:"one"}); if r.state == "done" { http.get({url:r.id}) }; return true', environment)
    const input = ids.calls.find((call) => call.tool === "http.get")!
    expect(input.arguments.origins.some((origin) => origin.endsWith(".id"))).toBe(true)
    expect(input.arguments.origins.some((origin) => origin.endsWith(".state"))).toBe(false)
  }))

  it.effect("transports non-JSON decoded dates opaquely by exact codec identity", () => Effect.gen(function* () {
    const date = Schema.DateTimeUtcFromString
    const read = defineToolContract({ name: "date.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ date }) })
    const use = defineToolContract({ name: "date.use", version: "1", effect: "capture", input: Schema.Struct({ date }), output: Schema.Boolean })
    const env = { ...environment, tools: { "date.read": { contract: read }, "date.use": { contract: use } }, granted: new Set(["date.read", "date.use"]) }
    const wire = "2026-10-09T12:00:00.000Z"
    const source = 'let r = date.read({id:"one"}); if r.state == "done" { let alias = r.result.date; assert alias == r.result.date; date.use({date:alias}) }; return true'
    const seen: Schema.Json[] = []
    const review = yield* reviewPrototype(source, env)
    expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name, input) => Effect.sync(() => { if (name === "date.read") return done({ date: wire }); seen.push(input); return done(true) }) })).toBe(true)
    expect(seen).toEqual([{ date: wire }])
    for (const use of ['return r.result.date + ""', 'return r.result.date.value', 'return r.result.date == "2026-10-09T12:00:00.000Z"', 'let copied = decode(schema.companyRecipient,r.result.date)']) {
      expect(yield* reviewPrototype(`let r = date.read({id:"one"}); if r.state == "done" { ${use} }; return true`, env).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    }
    const other = Schema.DateTimeUtcFromString.check(Schema.makeFilter(() => true))
    const wrong = defineToolContract({ name: "date.other", version: "1", effect: "capture", input: Schema.Struct({ date: other }), output: Schema.Boolean })
    const wrongEnv = { ...env, tools: { ...env.tools, "date.other": { contract: wrong } }, granted: new Set([...env.granted, "date.other"]) }
    expect(yield* reviewPrototype(source.replace('date.use', 'date.other'), wrongEnv).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
  }))

  it.effect("preserves opaque identity through nullable fields, lists and trusted bindings", () => Effect.gen(function* () {
    const date = Schema.DateTimeUtcFromString
    const payload = Schema.Struct({ date: Schema.NullOr(date), dates: Schema.Array(date) })
    const read = defineToolContract({ name: "date.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: payload })
    const use = defineToolContract({ name: "date.use", version: "1", effect: "capture", input: Schema.Struct({ date: Schema.NullOr(date) }), output: Schema.Boolean })
    const wire = "2026-10-09T12:00:00.000Z"
    const env = { ...environment, tools: { "date.read": { contract: read }, "date.use": { contract: use } }, granted: new Set(["date.read", "date.use"]), bindings: { fixed: { schema: payload, value: { date: wire, dates: [wire] }, label: new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] }) } } }
    const source = 'let r = date.read({id:"one"}); if r.state == "done" { assert r.result.date == r.result.date; if r.result.date != null { date.use({date:r.result.date}) }; for d in r.result.dates { date.use({date:d}) } }; date.use({date:fixed.date}); return true'
    const review = yield* reviewPrototype(source, env)
    for (let sample = 0; sample < 100; sample++) {
      const inputs: Schema.Json[] = []
      const result = yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name, input) => Effect.sync(() => { if (name === "date.read") return done({ date: sample % 2 === 0 ? wire : null, dates: sample % 3 === 0 ? [wire, wire] : [] }); inputs.push(input); return done(true) }) })
      expect(result).toBe(true)
      expect(inputs.every((input) => JSON.stringify(input) === JSON.stringify({ date: wire }))).toBe(true)
    }
    const malformed = yield* runReviewedPrototype(review, { resolve: () => Effect.succeed(done({ date: "bad date", dates: [] })) }).pipe(Effect.flip)
    expect(malformed.reason).toBe("host-result")
  }))

  it.effect("keeps selected payload, decoder control and call PC in distinct roles", () => Effect.gen(function* () {
    const choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ index: Schema.Number, ignored: Schema.String }) })
    const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: choice } }, granted: new Set([...environment.granted, "choice.read"]) }
    const source = 'let choice = choice.read({id:"one"}); if choice.state == "done" { let candidates = [{to:"a@example.com"},{to:"b@example.com"}]; let selected = candidates[choice.result.index]; let decoded = decode(schema.companyRecipient,selected.to); if decoded.state == "ok" { mail.send({to:decoded.value,subject:"hello",body:choice.result.ignored}) } }; return true'
    const review = yield* reviewPrototype(source, env)
    const call = review.calls.find((call) => call.tool === "mail.send")!
    expect(call.arguments.type.kind).toBe("record")
    if (call.arguments.type.kind !== "record") throw new Error("record expected")
    const to = call.arguments.type.fields.get("to")!, body = call.arguments.type.fields.get("body")!
    expect(to.dataOrigins).toEqual([])
    expect(to.controlOrigins.some((origin) => origin.endsWith(".result.index"))).toBe(true)
    expect(body.dataOrigins.some((origin) => origin.endsWith(".result.ignored"))).toBe(true)
    expect(body.controlOrigins.some((origin) => origin.endsWith(".result.index"))).toBe(false)
    expect(call.control.some((origin) => origin.endsWith(".result.index"))).toBe(true)
    const seen: CallObservation[] = []
    expect(yield* runReviewedPrototype(review, { observe: (call) => { assertObservedDependencies(review)(call); seen.push(call) }, resolve: (name) => Effect.succeed(name === "choice.read" ? done({ index: 1, ignored: "payload" }) : done({ messageId: "sent" })) })).toBe(true)
    const send = seen.find((call) => call.tool === "mail.send")!
    expect(send.fields.to!.data.confidentiality).toBe("public")
    expect(send.fields.to!.control.confidentiality).toBe("private")
    expect(send.fields.body!.data.provenance.some((origin) => origin.endsWith(".result.ignored"))).toBe(true)
    expect(send.fields.body!.control.provenance.some((origin) => origin.endsWith(".result.index"))).toBe(false)
  }))

  it.effect("retains argument-local control through a capture result and later projection", () => Effect.gen(function* () {
    const choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ index: Schema.Number }) })
    const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: choice } }, granted: new Set([...environment.granted, "choice.read"]) }
    const source = 'let choice = choice.read({id:"one"}); if choice.state == "done" { let selected = [{url:"https://example.com/a"},{url:"https://example.com/b"}][choice.result.index]; let fetched = http.get({url:selected.url}); if fetched.state == "done" { http.get({url:fetched.result.text}) } }; return true'
    const review = yield* reviewPrototype(source, env)
    const second = review.calls.filter((call) => call.tool === "http.get")[1]!
    if (second.arguments.type.kind !== "record") throw new Error("record expected")
    const url = second.arguments.type.fields.get("url")!
    expect(url.controlOrigins.some((origin) => origin.endsWith(".result.index"))).toBe(true)
    expect(url.dataOrigins.some((origin) => origin.endsWith(".result.index"))).toBe(false)
    expect(url.dataOrigins.some((origin) => origin.endsWith(".result.text"))).toBe(true)
    expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name) => Effect.succeed(name === "choice.read" ? done({ index: 0 }) : done({ text: "https://example.com/final" })) })).toBe(true)
  }))

  it.effect("summarizes every tagged-record variant when a whole alias is passed", () => Effect.gen(function* () {
    const payload = Schema.Union([Schema.Struct({ tag: Schema.Literal("a"), value: Schema.String }), Schema.Struct({ tag: Schema.Literal("b"), other: Schema.String })])
    const read = defineToolContract({ name: "variant.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: payload })
    const use = defineToolContract({ name: "variant.use", version: "1", effect: "capture", input: payload, output: Schema.Boolean })
    const env = { ...environment, tools: { "variant.read": { contract: read }, "variant.use": { contract: use } }, granted: new Set(["variant.read", "variant.use"]) }
    const source = 'let r = variant.read({id:"one"}); if r.state == "done" { let alias = r.result; variant.use(alias) }; return true'
    const review = yield* reviewPrototype(source, env)
    const call = review.calls.find((call) => call.tool === "variant.use")!
    expect(call.arguments.dataOrigins.some((origin) => origin.endsWith(".result.value"))).toBe(true)
    expect(call.arguments.dataOrigins.some((origin) => origin.endsWith(".result.other"))).toBe(true)
    const variants: readonly Schema.Json[] = [{ tag: "a", value: "first" }, { tag: "b", other: "second" }]
    for (const value of variants) expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name) => Effect.succeed(name === "variant.read" ? done(value) : done(true)) })).toBe(true)
  }))

  it.effect("issues exact role witnesses without lowering selection secrecy or losing decoder proof", () => Effect.gen(function* () {
    const choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ index: Schema.Number }) })
    const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: choice } }, granted: new Set([...environment.granted, "choice.read"]) }
    const review = yield* reviewPrototype('let r = choice.read({id:"one"}); if r.state == "done" { let selected = ["a@example.com","b@example.com"][r.result.index]; let checked = decode(schema.companyRecipient,selected); if checked.state == "ok" { mail.send({to:checked.value,subject:"hi",body:"body"}) } }; return true', env)
    const issuer = createRoleWitnessIssuer("same-id")
    let guarded = 0, handled = 0
    const host: PrototypeHost = { roleIssuer: issuer, observe: assertObservedDependencies(review), beforeCall: (call) => Effect.sync(() => {
      guarded++
      expect(issuer.inspect(call.argument.value, call.argument.witness)).toBeDefined()
      for (const field of Object.values(call.fields)) {
        const roles = issuer.inspect(field.value, field.witness)!
        expect(roles.data).toEqual(field.data)
        expect(roles.control).toEqual(field.control)
      }
      if (call.tool === "mail.send") {
        const to = call.fields.to!
        expect(to.data.confidentiality).toBe("public")
        expect(to.control.confidentiality).toBe("private")
        expect(to.value.label.confidentiality).toBe("private")
        expect(hasRefinement(to.value, CompanyRecipient)).toBe(true)
      }
    }), resolve: (name) => Effect.sync(() => { handled++; return name === "choice.read" ? done({ index: 0 }) : done({ messageId: "sent" }) }) }
    expect(yield* runReviewedPrototype(review, host)).toBe(true)
    expect({ guarded, handled }).toEqual({ guarded: 2, handled: 2 })
    const replay = yield* runReviewedPrototype(review, host).pipe(Effect.flip)
    expect(replay.reason).toBe("out-of-plan")
    expect(handled).toBe(2)
  }))

  it.effect("awaits guard refusal before any handler and rejects a copied issuer", () => Effect.gen(function* () {
    const review = yield* reviewPrototype('return http.get({url:"https://example.com"})', environment)
    let handled = 0
    const resolve = () => Effect.sync(() => { handled++; return done({ text: "ok" }) })
    const denied = yield* runReviewedPrototype(review, { beforeCall: () => Effect.fail("private policy text"), resolve }).pipe(Effect.flip)
    expect(denied.reason).toBe("out-of-plan")
    expect(JSON.stringify(denied)).not.toContain("private policy text")
    const copied = { ...createRoleWitnessIssuer("copied") }
    const invalid = yield* runReviewedPrototype(review, { roleIssuer: copied, resolve }).pipe(Effect.flip)
    expect(invalid.reason).toBe("out-of-plan")
    expect(handled).toBe(0)
  }))

  it.effect("reviews negated literal arguments with their exact negative-zero value", () => Effect.gen(function* () {
    const zero = defineToolContract({ name: "negative.zero", version: "1", effect: "capture", input: Schema.Struct({ value: Schema.Number.check(Schema.makeFilter((value) => Object.is(value, -0))) }), output: Schema.Boolean })
    const env = { ...environment, tools: { "negative.zero": { contract: zero } }, granted: new Set(["negative.zero"]) }
    const review = yield* reviewPrototype('let zero = -0; negative.zero({value:zero}); return zero != 0', env)
    const call = review.calls[0]!
    expect(call.arguments.constant).toBeDefined()
    expect(Object.is(Reflect.get(call.arguments.constant as object, "value"), -0)).toBe(true)
    let handled = 0
    expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (_, input) => Effect.sync(() => { handled++; expect(Object.is(Reflect.get(input as object, "value"), -0)).toBe(true); return done(true) }) })).toBe(true)
    expect(handled).toBe(1)
    expect(yield* reviewPrototype('negative.zero({value:0}); return true', env).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    const not = yield* reviewPrototype('return !false', environment)
    expect([...not.expressionFacts.values()].some((fact) => fact.constant === true)).toBe(true)
  }))

  it.effect("does not claim a schema zero literal proves one exact zero sign", () => Effect.gen(function* () {
    expect(Object.is(Schema.decodeUnknownSync(Schema.Literal(-0))(0), 0)).toBe(true)
    const read = defineToolContract({ name: "zero.read", version: "1", effect: "capture", input: Schema.Struct({}), output: Schema.Struct({ value: Schema.Literal(-0) }) })
    const use = defineToolContract({ name: "zero.use", version: "1", effect: "capture", input: Schema.Struct({ value: Schema.Number.check(Schema.makeFilter((value) => Object.is(value, -0))) }), output: Schema.Boolean })
    const env = { ...environment, tools: { "zero.read": { contract: read }, "zero.use": { contract: use } }, granted: new Set(["zero.read", "zero.use"]) }
    const unsafe = yield* reviewPrototype('let r = zero.read({}); if r.state == "done" { zero.use({value:r.result.value}) }; return true', env).pipe(Effect.result)
    expect(Result.isFailure(unsafe)).toBe(true)
    const review = yield* reviewPrototype('let r = zero.read({}); if r.state == "done" { if r.result.value == 0 { return true } else { return false } }; return null', env)
    for (const value of [0, -0]) expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: () => Effect.succeed(done({ value })) })).toBe(Object.is(value, 0))
  }))
})

describe("generated type-safety evidence (not a proof)", () => {
  it.effect("checks 1000 independent expression/range/index/record oracles from the runner corpus", () => Effect.gen(function* () {
    const echo = defineToolContract({ name: "security.echo", version: "1", effect: "capture", input: Schema.Struct({ value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]) }), output: Schema.Boolean })
    const env = { ...environment, tools: { "security.echo": { contract: echo } }, granted: new Set(["security.echo"]) }
    for (const example of runnerExamples(0x518adc, 1000)) {
      let calls = 0
      const review = yield* reviewPrototype(example.source, env)
      const result = yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: () => Effect.sync(() => { calls++; return done(true) }) })
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
      const host: PrototypeHost = { observe: assertObservedDependencies(review), resolve: (name) => Effect.sync(() => {
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

  it.effect("covers every observed field/control origin across 1000 generated nested selections", () => Effect.gen(function* () {
    const choice = defineToolContract({ name: "choice.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ index: Schema.Number, ignored: Schema.String }) })
    const env = { ...environment, tools: { ...environment.tools, "choice.read": { contract: choice } }, granted: new Set([...environment.granted, "choice.read"]) }
    for (let sample = 0; sample < 1000; sample++) {
      const nested = sample % 2 === 0, safe = sample % 3 === 0
      const candidates = nested ? '[{nested:{url:"https://example.com/a",ignored:choice.result.ignored}},{nested:{url:"https://example.com/b",ignored:choice.result.ignored}}]' : '[{url:"https://example.com/a",ignored:choice.result.ignored},{url:"https://example.com/b",ignored:choice.result.ignored}]'
      const pick = safe ? 'at(candidates,choice.result.index)' : 'candidates[choice.result.index]'
      const use = `let alias = selected; http.get({url:alias.${nested ? "nested.url" : "url"}})`
      const source = `let choice = choice.read({id:"one"}); if choice.state == "done" { let candidates = ${candidates}; let selected = ${pick}; ${safe ? `if selected != null { ${use} }` : use} }; return true`
      const review = yield* reviewPrototype(source, env)
      const get = review.calls.find((call) => call.tool === "http.get")!
      expect(get.arguments.origins.some((origin) => origin.endsWith(".ignored"))).toBe(false)
      expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name) => Effect.succeed(name === "choice.read" ? done({ index: sample % 2, ignored: "private unrelated data" }) : done({ text: "ok" })) })).toBe(true)
    }
  }), { timeout: 60_000 })

  it.effect("covers control retained after branches and from earlier loop iterations", () => Effect.gen(function* () {
    const sources = [
      'let r = mail.read({id:"one"}); if r.state == "done" { if r.result.subject == "go" { mail.read({id:r.result.body}) } }; http.get({url:"https://example.com/final"}); return true',
      'for n in 0..3 { http.get({url:"https://example.com/first"}); mail.read({id:"one"}) }; http.get({url:"https://example.com/final"}); return true',
      'for id in ["one","two"] { if true { mail.read({id:id}) }; http.get({url:"https://example.com/after"}) }; return true'
    ]
    for (const source of sources) {
      const review = yield* reviewPrototype(source, environment)
      expect(yield* runReviewedPrototype(review, { observe: assertObservedDependencies(review), resolve: (name) => Effect.succeed(name === "http.get" ? done({ text: "ok" }) : done({ from: "a@example.com", subject: "go", body: "second" })) })).toBe(true)
    }
  }))

  it.effect("rejects 1000 ill-typed mutations instead of reaching the host", () => Effect.gen(function* () {
    for (let sample = 0; sample < 1000; sample++) {
      const source = sample % 3 === 0 ? `let r = mail.read({id:${sample}}); return true` : sample % 3 === 1 ? `let r = mail.read({id:"m${sample}"}); return r.result.body` : `let r = mail.read({id:"m${sample}"}); if r.state == "done" { return r.result.missing${sample} }; return true`
      expect(yield* reviewPrototype(source, environment).pipe(Effect.flip)).toBeInstanceOf(ReviewError)
    }
  }), { timeout: 60_000 })
})
