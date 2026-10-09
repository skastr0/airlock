import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Admission, defineAirlock, refused, toolPolicy, WebCrypto } from "../src/core/index.ts"
import {
  LabelAdd,
  LabelRemove,
  MailList,
  MailSend,
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore
} from "../src/core/testing/index.ts"

// ── everything a user writes ────────────────────────────────────────────────

interface Env {
  readonly MAIL_TOKEN: string
  readonly sent: Array<{ readonly to: string; readonly key: string; readonly token: string }>
  readonly behaviour?: "refuse" | "throw"
}

const airlock = defineAirlock({
  contracts: [MailList, MailSend, LabelAdd, LabelRemove],
  implement: {
    // A plain synchronous function.
    "mail.list": ({ mailbox }) => ({ ids: [`${mailbox}-1`, `${mailbox}-2`] }),
    // An async function that reads a credential from the environment.
    "mail.send": async ({ to }, { env, idempotencyKey }: { env: Env; idempotencyKey: string }) => {
      if (env.behaviour === "refuse") return refused("mail connection is not configured")
      if (env.behaviour === "throw") throw new Error(`upstream said no to ${to} with ${env.MAIL_TOKEN}`)
      env.sent.push({ to, key: idempotencyKey, token: env.MAIL_TOKEN })
      return { messageId: `sent-${env.sent.length}` }
    },
    // An Effect, for a user who has them.
    "label.add": () => Effect.succeed({ added: true }),
    "label.remove": () => ({ removed: true })
  },
  policy: toolPolicy({
    budget: { maxCalls: 6, maxInputBytes: 4_096 },
    toolGrants: [
      Admission.toolGrant(MailList, { id: "read-inbox", when: "now" }),
      Admission.toolGrant(MailSend, { id: "support-replies", where: { to: { endsWith: "@example.com" } } }),
      Admission.toolGrant(LabelAdd, { id: "labels", when: "approved" })
    ]
  })
})

// ── a host: memory adapters ─────────────────────────────────────────────────

const host = () => {
  const ledgerState = makeMemoryLedgerState()
  const store = memoryOutboxStore(makeMemoryOutboxState(), ledgerState)
  const ledger = memoryLedger(ledgerState)
  return <A, E>(env: Env, body: Effect.Effect<A, E, typeof airlock.outbox.Outbox.Identifier | import("effect").Crypto.Crypto>) =>
    body.pipe(
      Effect.provide(airlock.layer(env).pipe(Layer.provideMerge(Layer.mergeAll(store, ledger, WebCrypto.layer))))
    )
}
const environment = (behaviour?: Env["behaviour"]): Env => ({
  MAIL_TOKEN: "token-canary",
  sent: [],
  ...(behaviour === undefined ? {} : { behaviour })
})

describe("core: defineAirlock", () => {
  it.effect("gives a guest its granted tools as plain calls and plain results", () =>
    Effect.gen(function* () {
      const run = host()
      const env = environment()
      const result = yield* run(env, Effect.gen(function* () {
        const guest = yield* airlock.guest({ runId: "run-1", env })
        return {
          tools: guest.tools,
          listed: yield* guest.call("mail.list", { mailbox: "inbox", query: "is:unread" }),
          sent: yield* guest.call("mail.send", { to: "ada@example.com", subject: "hi", body: "text" }),
          ungranted: yield* guest.call("label.remove", { messageId: "m", label: "l" })
        }
      }))
      expect(result.tools).toEqual(["label.add", "mail.list", "mail.send"])
      expect(result.listed).toMatchObject({ state: "done", result: { ids: ["inbox-1", "inbox-2"] } })
      expect(result.sent).toMatchObject({ state: "staged" })
      expect(result.ungranted).toMatchObject({
        state: "refused", refusal: { code: "unknown-tool",
        message: "label.remove is not a tool this session grants" }
      })
      expect(env.sent).toEqual([])
    }))

  it.effect("lets a supervisor commit, with the implementation reading the host's environment", () =>
    Effect.gen(function* () {
      const run = host()
      const env = environment()
      const committed = yield* run(env, Effect.gen(function* () {
        const guest = yield* airlock.guest({ runId: "run-1", env })
        const staged = yield* guest.call("mail.send", { to: "ada@example.com", subject: "hi", body: "text" })
        const supervisor = yield* airlock.supervisor(env)
        const pending = yield* supervisor.pending
        const id = staged.state === "staged" ? staged.id : ""
        return {
          pending: pending.map((emission) => [emission.id, emission.kind, emission.state]),
          id,
          emission: yield* supervisor.commit(id),
          again: yield* Effect.flip(supervisor.commit(id))
        }
      }))
      expect(committed.pending).toEqual([[committed.id, "mail.send", "staged"]])
      // Plain data: JSON all the way down, with the tool's typed outcome.
      expect(JSON.parse(JSON.stringify(committed.emission))).toEqual(committed.emission)
      expect(committed.emission).toMatchObject({
        state: "committed",
        kind: "mail.send",
        outcome: { messageId: "sent-1" },
        admission: { grantIds: ["support-replies"] }
      })
      expect(committed.again).toMatchObject({ code: "not-pending" })
      // The credential came from the environment and the key names this call.
      expect(env.sent).toEqual([{ to: "ada@example.com", key: committed.id, token: "token-canary" }])
      expect(JSON.stringify(committed)).not.toContain("token-canary")
    }))

  it.effect("says in plain words why a call was not allowed", () =>
    Effect.gen(function* () {
      const run = host()
      const env = environment()
      const failures = yield* run(env, Effect.gen(function* () {
        const guest = yield* airlock.guest({ runId: "run-1", env })
        return yield* Effect.all([
          guest.call("mail.send", { to: "eve@elsewhere.test", subject: "s", body: "b" }),
          guest.call("mail.send", { to: "ada@example.com" }),
          guest.call("mail.list", { mailbox: 7 })
        ])
      }))
      expect(failures.map((failure) => failure.state === "refused" ? [failure.refusal.code, failure.refusal.message] : failure.state)).toEqual([
        ["not-allowed", "mail.send is not allowed: `to` is not allowed by grant \"support-replies\""],
        ["invalid-input", expect.stringContaining("mail.send was given an invalid input")],
        ["invalid-input", expect.stringContaining("mail.list was given an invalid input")]
      ])
    }))

  it.effect("records a refusal as refused and a thrown error as uncertain, without its text", () =>
    Effect.gen(function* () {
      const outcome = (behaviour: "refuse" | "throw") => {
        const run = host()
        const env = environment(behaviour)
        return run(env, Effect.gen(function* () {
          const guest = yield* airlock.guest({ runId: "run-1", env })
          const staged = yield* guest.call("mail.send", { to: "ada@example.com", subject: "hi", body: "text" })
          const supervisor = yield* airlock.supervisor(env)
          const id = (staged as { id: string }).id
          const failure = yield* Effect.flip(supervisor.commit(id))
          return { failure, emission: yield* supervisor.inspect(id) }
        }))
      }
      const refusal = yield* outcome("refuse")
      expect(refusal.failure).toMatchObject({ code: "refused" })
      expect(refusal.failure.message).toContain("nothing was sent: mail connection is not configured")
      expect(refusal.emission).toMatchObject({ state: "refused", reason: "mail connection is not configured" })

      const thrown = yield* outcome("throw")
      expect(thrown.failure).toMatchObject({ code: "uncertain" })
      expect(thrown.emission).toMatchObject({ state: "uncertain" })
      // The thrown error quoted the recipient and a credential; neither is kept.
      expect(JSON.stringify(thrown)).not.toMatch(/token-canary|upstream said no/)
    }))

  it.effect("describes exactly the granted tools, as actions and as prose", () =>
    Effect.gen(function* () {
      const run = host()
      const env = environment()
      const guest = yield* run(env, airlock.guest({ runId: "run-1", env }))
      expect(guest.actions).toEqual([
        {
          name: "label.add",
          input: "{ messageId: string, label: string }",
          result: "{ added: boolean }",
          returns: "staged",
          effect: "request",
          answeredBy: "label.remove"
        },
        {
          name: "mail.list",
          input: "{ mailbox: string, query: string }",
          result: "{ ids: [string] }",
          returns: "result",
          effect: "capture",
          resultRetention: "digest"
        },
        {
          name: "mail.send",
          input: "{ to: string, subject: string, body: string }",
          result: "{ messageId: string }",
          returns: "staged",
          effect: "request"
        }
      ])
      const lines = guest.description.split("\n")
      expect(lines[0]).toBe("An Airlock program (.air) is a list of statements, one per line.")
      expect(lines.slice(-3)).toEqual([
        `- label.add({ messageId: string, label: string }) -> { state: "staged", id: string }. Makes an external request; is recorded for approval and returns a staged receipt, never a result; nothing happens until a supervisor commits it. Can be answered by label.remove.`,
        `- mail.list({ mailbox: string, query: string }) -> { state: "done", id: string, result: { ids: [string] } }. Captures a value; runs at once and returns a done receipt with its result. Keeps only the result digest; replay reads again and stops if the result changed.`,
        `- mail.send({ to: string, subject: string, body: string }) -> { state: "staged", id: string }. Makes an external request; is recorded for approval and returns a staged receipt, never a result; nothing happens until a supervisor commits it.`,
      ])
      expect(JSON.stringify(guest.actions)).not.toContain("\"label.remove\",\"input\"")
    }))

  it("does not compile without one correctly typed implementation per contract", () => {
    const policy = toolPolicy({ budget: { maxCalls: 1, maxInputBytes: 1 }, toolGrants: [] })
    const build = () => [
      defineAirlock({
        contracts: [MailList, MailSend],
        // @ts-expect-error mail.send has no implementation
        implement: { "mail.list": () => ({ ids: [] }) },
        policy
      }),
      defineAirlock({
        contracts: [MailList],
        // @ts-expect-error an implementation must return its contract's output
        implement: { "mail.list": () => ({ messageId: "wrong" }) },
        policy
      }),
      defineAirlock({
        contracts: [MailList],
        // @ts-expect-error label.add is not one of the contracts
        implement: { "mail.list": () => ({ ids: [] }), "label.add": () => ({ added: true }) },
        policy
      }),
      defineAirlock({
        contracts: [MailList],
        // @ts-expect-error the input is the contract's: mail.list has no `to`
        implement: { "mail.list": ({ to }) => ({ ids: [to] }) },
        policy
      })
    ]
    expect(typeof build).toBe("function")
  })
})
