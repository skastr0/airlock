import { memoryAdapters } from "./support/memory.ts"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { defineAirlock } from "../src/core/airlock/Airlock.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { Ledger } from "../src/core/ledger/Ledger.ts"
import { DispatchProvenance, EmissionId } from "../src/core/outbox/Records.ts"
import { GuestRunner } from "../src/core/runner/GuestRunner.ts"
import { programRunner } from "../src/core/runner/ProgramRunner.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { MailList, MailSend } from "../src/core/testing/index.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"

const world = () => {
  const sent: Array<string> = []
  const airlock = defineAirlock({
    contracts: [MailList, MailSend],
    implement: {
      "mail.list": () => ({ ids: ["m-1", "m-2"] }),
      "mail.send": ({ body }) => {
        sent.push(body)
        return { messageId: `sent-${sent.length}` }
      }
    },
    policy: toolPolicy({
      budget: { maxCalls: 8, maxInputBytes: 4_096 },
      toolGrants: [
        toolGrant(MailList, { id: "read", when: "now" }),
        toolGrant(MailSend, { id: "send", when: "approved" })
      ]
    })
  })
  const layer = Layer.mergeAll(
    airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(memoryAdapters(), WebCrypto.layer))),
    programRunner
  )
  const review = (source: string) => Effect.gen(function* () {
    const surface = yield* airlock.guest({ runId: "review", env: undefined })
    return yield* (yield* GuestRunner).review({ source, surface })
  })
  const planOf = (source: string) => Effect.gen(function* () {
    const reviewed = yield* review(source)
    if (!reviewed.ok) return yield* Effect.die(`review failed: ${JSON.stringify(reviewed)}`)
    expect(reviewed.refusals).toEqual([])
    return reviewed.plan
  })
  const run = (runId: string, source: string, plan?: string) => Effect.gen(function* () {
    const surface = yield* (plan === undefined
      ? airlock.guest({ runId, env: undefined })
      : airlock.guest({ runId, env: undefined, plan }))
    return yield* (yield* GuestRunner).run({ source, surface })
  })
  return { airlock, sent, layer, review, planOf, run }
}

const FIXED = `let sent = mail.send({ to: "ada@example.com", subject: "hi", body: "fixed" })
return sent`

const OTHER = `let sent = mail.send({ to: "ada@example.com", subject: "hello", body: "fixed" })
return sent`

const DYNAMIC = `let listed = mail.list({ mailbox: "inbox", query: "is:unread" })
assert listed.state == "done", "unread"
let sent = mail.send({ to: "ada@example.com", subject: "hi", body: listed.result.ids[0] })
return sent`

const resultOf = (outcome: { readonly ok: boolean }) => {
  if (!outcome.ok) throw new Error(`run failed: ${JSON.stringify(outcome)}`)
  return (outcome as unknown as { readonly result: { readonly state: string; readonly id: string } }).result
}

describe("core: a reviewed program approved ahead of time", () => {
  it.effect("commits a request whose content the program fixes, under its approved Plan, and stages it without one", () => {
    const { airlock, sent, layer, planOf, run } = world()
    return Effect.gen(function* () {
      const plan = yield* planOf(FIXED)
      expect(plan.nodes.map((node) => [node.tool, node.approval])).toEqual([["mail.send", "program"]])

      expect(resultOf(yield* run("unplanned", FIXED)).state).toBe("staged")
      expect(sent).toEqual([])

      const supervisor = yield* airlock.supervisor(undefined)
      expect(yield* supervisor.approved(plan.id)).toBe(false)
      expect(yield* supervisor.approvePlan(plan.id)).toEqual({ plan: plan.id })
      expect(yield* supervisor.approved(plan.id)).toBe(true)

      const done = resultOf(yield* run("planned", FIXED, plan.id))
      expect(done.state).toBe("done")
      expect(sent).toEqual(["fixed"])
      const record = yield* supervisor.inspect(done.id)
      expect(record.state).toBe("committed")
      expect((record as { readonly provenance?: unknown }).provenance).toMatchObject({ committedBy: "reviewed-plan", plan: plan.id })

      // A replay of the same run returns what was recorded and sends nothing again.
      expect(resultOf(yield* run("planned", FIXED, plan.id))).toEqual(done)
      expect(sent).toEqual(["fixed"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("stages a request whose content the program does not fix, even under an approved Plan", () => {
    const { airlock, sent, layer, planOf, run } = world()
    return Effect.gen(function* () {
      const plan = yield* planOf(DYNAMIC)
      expect(plan.nodes.map((node) => [node.tool, node.approval])).toEqual([["mail.list", "program"], ["mail.send", "exact-batch"]])
      const supervisor = yield* airlock.supervisor(undefined)
      yield* supervisor.approvePlan(plan.id)

      expect(resultOf(yield* run("dynamic", DYNAMIC, plan.id)).state).toBe("staged")
      expect(sent).toEqual([])
      expect((yield* supervisor.pending).map((emission) => emission.kind)).toEqual(["mail.send"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("ends a program that reviews to a different Plan as plan_mismatch, before any call", () => {
    const { airlock, sent, layer, planOf, run } = world()
    return Effect.gen(function* () {
      const plan = yield* planOf(FIXED)
      const supervisor = yield* airlock.supervisor(undefined)
      yield* supervisor.approvePlan(plan.id)

      expect(yield* run("other", OTHER, plan.id)).toEqual({ ok: false, reason: "plan_mismatch", toolCalls: 0 })
      expect(sent).toEqual([])
      expect(yield* supervisor.pending).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses to open a run under a Plan nobody approved, or under something that is not a Plan id", () => {
    const { layer, planOf, run } = world()
    return Effect.gen(function* () {
      const plan = yield* planOf(FIXED)
      const unapproved = yield* Effect.result(run("unapproved", FIXED, plan.id))
      expect(Result.isFailure(unapproved) && unapproved.failure.code).toBe("not-allowed")
      const invalid = yield* Effect.result(run("invalid", FIXED, "not-a-plan"))
      expect(Result.isFailure(invalid) && invalid.failure.code).toBe("not-found")
    }).pipe(Effect.provide(layer))
  })

  it.effect("records an approval once, however often it is given", () => {
    const { airlock, layer, planOf } = world()
    return Effect.gen(function* () {
      const plan = yield* planOf(FIXED)
      const supervisor = yield* airlock.supervisor(undefined)
      yield* supervisor.approvePlan(plan.id)
      yield* supervisor.approvePlan(plan.id)
      const entries = yield* (yield* Ledger).entries
      expect(entries.filter((entry) => entry.act === "approve").map((entry) => entry.ref)).toEqual([plan.id])
    }).pipe(Effect.provide(layer))
  })

  it.effect("lets only a reviewed-plan commit name a Plan, and requires it to", () => {
    const { airlock, layer, planOf, run } = world()
    return Effect.gen(function* () {
      const plan = yield* planOf(FIXED)
      const id = EmissionId.make(resultOf(yield* run("staged", FIXED)).id)
      const outbox = yield* airlock.outbox.Outbox
      for (const provenance of [
        new DispatchProvenance({ committedBy: "reviewed-plan" }),
        new DispatchProvenance({ committedBy: "supervisor", plan: plan.id })
      ]) {
        const committed = yield* Effect.result(outbox.commit(id, provenance))
        expect(Result.isFailure(committed) && committed.failure._tag).toBe("InvalidDispatchAuthorization")
      }
      expect((yield* outbox.inspect(id)).state).toBe("staged")
    }).pipe(Effect.provide(layer))
  })
})
