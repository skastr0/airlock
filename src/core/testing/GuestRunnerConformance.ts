import { type Crypto, Effect, Fiber, Layer, type Scope } from "effect"
import { toolGrant } from "../admission/ToolGrant.ts"
import { defineAirlock } from "../airlock/Airlock.ts"
import type { Ledger } from "../ledger/Ledger.ts"
import type { OutboxStore } from "../outbox/OutboxStore.ts"
import { type GuestLimits, type GuestOutcome, GuestRunner } from "../runner/GuestRunner.ts"
import { toolPolicy } from "../session/ToolPolicy.ts"
import { holds, type Runner, same } from "./Check.ts"
import { LabelAdd, LabelRemove, MailList, MailSend } from "./ExampleContracts.ts"

/** One isolated home plus the runner under test. */
export interface GuestRunnerWorld {
  readonly store: Layer.Layer<OutboxStore, unknown>
  readonly ledger: Layer.Layer<Ledger, unknown>
  readonly crypto: Layer.Layer<Crypto.Crypto, unknown>
  readonly runner: Layer.Layer<GuestRunner, unknown>
}

interface Env {
  readonly dispatched: Array<string>
}

const airlock = defineAirlock({
  contracts: [MailList, MailSend, LabelAdd, LabelRemove],
  implement: {
    "mail.list": async ({ mailbox }, { env }: { env: Env }) => {
      // A provider that takes far longer than any test's deadline.
      if (mailbox === "slow") await new Promise((resolve) => setTimeout(resolve, 5_000))
      env.dispatched.push("mail.list")
      return { ids: [`${mailbox}-${env.dispatched.length}`] }
    },
    "mail.send": (_input, { env }: { env: Env }) => {
      env.dispatched.push("mail.send")
      return { messageId: "sent" }
    },
    "label.add": () => ({ added: true }),
    "label.remove": () => ({ removed: true })
  },
  policy: toolPolicy({
    budget: { maxCalls: 64, maxInputBytes: 1_000_000 },
    toolGrants: [
      toolGrant(MailList, { id: "read", class: "read", commit: "auto" }),
      toolGrant(MailSend, { id: "company", where: { to: { endsWith: "@example.com" } } })
    ]
  })
})

/** The invariants a GuestRunner must hold on every host: what a program can do, and how a run ends. */
export const guestRunnerConformance = (
  { describe, test }: Runner,
  name: string,
  world: Effect.Effect<GuestRunnerWorld, unknown, Scope.Scope>
): void => {
  /** Runs an Airlock program for `runId` in a fresh process lifetime over the world. */
  const run = (
    current: GuestRunnerWorld,
    env: Env,
    source: string,
    options: {
      readonly runId?: string
      readonly limits?: Partial<GuestLimits>
      readonly signal?: AbortSignal
      readonly bindings?: { readonly [name: string]: unknown }
    } = {}
  ): Effect.Effect<GuestOutcome, unknown> =>
    Effect.gen(function* () {
      const surface = yield* airlock.guest({ runId: options.runId ?? "run-1", env })
      const runner = yield* GuestRunner
      return yield* runner.run({
        source,
        surface,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          airlock.layer(env).pipe(
            Layer.provideMerge(Layer.mergeAll(current.store, current.ledger, current.crypto))
          ),
          current.runner
        )
      )
    )
  const fresh = (): Env => ({ dispatched: [] })
  const list = `mail.list({ mailbox: "inbox", query: "q" })`
  const reasonOf = (outcome: GuestOutcome) => (outcome.ok ? "ok" : outcome.reason)

  describe(`GuestRunner conformance: ${name}`, () => {
    test("returns what the program returns, as plain JSON, and null when it returns nothing", () =>
      Effect.gen(function* () {
        const current = yield* world
        const returned = yield* run(current, fresh(), `
          let total = 1 + 2 + 3
          return { sum: total, text: "o" + "k", list: [true, null] }`)
        same(returned, { ok: true, result: { sum: 6, text: "ok", list: [true, null] }, toolCalls: 0 })
        same(yield* run(current, fresh(), "let unused = 1"), { ok: true, result: null, toolCalls: 0 })
      }))

    test("gives the program the names its host binds, as bounded copies that grant nothing", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const workspace = { root: "/work", writable: ["a", "b"] }
        const outcome = yield* run(current, env, `
          let inbox = mail.list({ mailbox: workspace.root, query: "q" })
          return { root: workspace.root, last: workspace.writable[1], enabled: enabled, inbox: inbox }`, {
          bindings: { workspace, enabled: true }
        })
        same(outcome, {
          ok: true,
          result: { root: "/work", last: "b", enabled: true, inbox: { ids: ["/work-1"] } },
          toolCalls: 1
        })
        // A bound name is a value, never a tool, and a name the host did not bind is still unbound.
        same(reasonOf(yield* run(current, env, "return workspace({})", { bindings: { workspace } })), "tool_refused")
        same(reasonOf(yield* run(current, env, "return workspace.root")), "execution_failed")
        const getter = Object.defineProperty({}, "secret", { enumerable: true, get: () => "leaked" })
        same([
          yield* run(current, env, "return 1", { bindings: { big: "x".repeat(200) }, limits: { maxToolResultBytes: 64 } }),
          yield* run(current, env, "return 1", { bindings: { wide: [1, 2, 3] }, limits: { maxNodes: 3 } }),
          yield* run(current, env, "return live", { bindings: { live: getter } })
        ].map(reasonOf), ["value_limit", "value_limit", "execution_failed"])
        same(env.dispatched, ["mail.list"])
      }))

    test("calls granted tools by their dotted names: a read runs, a write is only recorded", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const outcome = yield* run(current, env, `
          let listed = ${list}
          let sent = mail.send({ to: "ada@example.com", subject: "s", body: "b" })
          return { listed: listed, staged: sent.staged, state: sent.state }`)
        same(outcome, {
          ok: true,
          result: { listed: { ids: ["inbox-1"] }, staged: true, state: "staged" },
          toolCalls: 2
        })
        same(env.dispatched, ["mail.list"], "the send was recorded, not sent")
      }))

    test("replays a run with recorded results and no second dispatch", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const source = `return [${list}, ${list}]`
        const first = yield* run(current, env, source, { runId: "replayed" })
        const again = yield* run(current, env, source, { runId: "replayed" })
        same(again, first)
        same(env.dispatched.length, 2, "two distinct calls, each dispatched once across both runs")
        const other = yield* run(current, env, source, { runId: "another" })
        holds(JSON.stringify(other) !== JSON.stringify(first), "another run is another set of calls")
        same(env.dispatched.length, 4)
      }))

    test("ends the run at a refused call, saying which tool and which grant", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const outcome = yield* run(current, env, `
          mail.send({ to: "eve@elsewhere.test", subject: "s", body: "b" })
          return ${list}`)
        holds(!outcome.ok && outcome.reason === "tool_refused" && outcome.toolCalls === 1, "the run ended at the refusal")
        holds(
          !outcome.ok && outcome.refusal !== undefined && outcome.refusal.tool === "mail.send" &&
            outcome.refusal.code === "not-allowed" &&
            outcome.refusal.message.includes("mail.send is not allowed") && outcome.refusal.message.includes("company"),
          "the caller is told which tool and which grant"
        )
        same(env.dispatched, [], "nothing after a refusal runs")
      }))

    test("refuses a tool the session does not grant, and any name that is not a tool", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const ungranted = yield* run(current, env, `label.add({ messageId: "m", label: "l" })`)
        same(ungranted, {
          ok: false,
          reason: "tool_refused",
          toolCalls: 1,
          refusal: { tool: "label.add", code: "unknown-tool", message: "label.add is not a tool this session grants" }
        })
        // The words a program in another language would reach for are only names here.
        // Some are assembled, so that this file, which only quotes programs, names no host global or wire call itself.
        const [load, host, wire] = ["req" + "uire", "pro" + "cess", "fet" + "ch"]
        for (const source of [
          `${wire}("https://example.com/")`,
          `connect("example.com:443")`,
          `${load}("fs")`,
          `${host}.exit(1)`,
          `globalThis.${wire}({ url: "https://example.com/" })`,
          `mail.list.constructor({ mailbox: "inbox", query: "q" })`,
          `__proto__({})`
        ]) {
          const outcome = yield* run(current, env, source)
          same([reasonOf(outcome), outcome.toolCalls], ["tool_refused", 1], source)
        }
        for (const source of [`return ${host}`, "return globalThis", "return env.MAIL_TOKEN", "return mail", "return this"]) {
          const outcome = yield* run(current, env, source)
          same(outcome.ok ? "ok" : [outcome.reason, outcome.fault], ["execution_failed", "unbound-name"], source)
        }
        for (const source of ["import fs", "return `x`", "return $HOME", "let f = (x) => x", "return new Date()", "return a ? b : c"]) {
          same(reasonOf(yield* run(current, env, source)), "invalid_code", source)
        }
        same(env.dispatched, [])
      }))

    test("fails the run at the call limit and at the session's budget", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const limited = yield* run(current, env, `for index in 0..5 { ${list} }\nreturn "finished"`, {
          limits: { maxToolCalls: 2 }
        })
        same(limited, { ok: false, reason: "tool_call_limit", toolCalls: 2 })
        same(env.dispatched.length, 2, "nothing past the limit was dispatched")
        const spent = yield* run(current, fresh(), `for index in 0..70 { ${list} }\nreturn "finished"`, {
          runId: "budget",
          limits: { maxToolCalls: 100 }
        })
        same(reasonOf(spent), "tool_call_limit", "the policy's 64 calls are the session's limit")
      }))

    test("refuses an oversized, missing or surplus tool input before anything is dispatched", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const large = yield* run(current, env, `
          let a = "xxxxxxxxxxxxxxxx"
          let b = a + a + a + a + a + a + a + a
          let c = b + b + b + b + b + b + b + b
          mail.list({ mailbox: "inbox", query: c })`, { limits: { maxToolInputBytes: 512 } })
        const missing = yield* run(current, env, "mail.list()")
        const surplus = yield* run(current, env, `mail.list({ mailbox: "inbox", query: "q" }, 1)`)
        const deep = yield* run(current, env, `mail.list({ mailbox: "inbox", query: "q", extra: [[[1]]] })`, {
          limits: { maxDepth: 2 }
        })
        const wrong = yield* run(current, env, `mail.list("inbox")`)
        same([large, missing, surplus, deep, wrong].map(reasonOf), [
          "tool_input_limit",
          "tool_input_invalid",
          "tool_input_invalid",
          "tool_input_limit",
          "tool_refused"
        ])
        holds(!wrong.ok && wrong.refusal?.code === "invalid-input", "an input of the wrong shape is refused by the contract")
        same(env.dispatched, [])
      }))

    test("bounds the result, and every value a program builds on the way", () =>
      Effect.gen(function* () {
        const current = yield* world
        const doubling = Array.from({ length: 12 }, (_, index) => `let s${index + 1} = s${index} + s${index}`).join("\n")
        const output = yield* run(current, fresh(), `let s0 = "xx"\n${doubling}\nreturn s12`, {
          limits: { maxOutputBytes: 4_096, maxToolInputBytes: 16_384 }
        })
        same(output, { ok: false, reason: "output_limit", toolCalls: 0 })
        // Forty doublings would be a terabyte. The run stops at the first string past the limit.
        const forty = Array.from({ length: 40 }, (_, index) => `let s${index + 1} = s${index} + s${index}`).join("\n")
        const string = yield* run(current, fresh(), `let s0 = "xx"\n${forty}\nreturn 1`)
        same(reasonOf(string), "value_limit")
        // Shared structure: four short lines name a value of thousands of nodes, forty would name 8^40.
        const shared = Array.from({ length: 40 }, (_, index) => {
          const previous = `v${index}`
          return `let v${index + 1} = [${Array.from({ length: 8 }, () => previous).join(", ")}]`
        }).join("\n")
        const nodes = yield* run(current, fresh(), `let v0 = 1\n${shared}\nreturn v40 == v40`)
        same(nodes, { ok: false, reason: "value_limit", toolCalls: 0, at: { line: 5, column: 10 } })
      }))

    test("stops a loop at the iteration budget, counted across every loop", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const long = yield* run(current, env, `for index in 0..5000 { let twice = index * 2 }\nreturn ${list}`)
        const nested = yield* run(current, env, `
          for outer in 0..40 {
            for inner in 0..40 { let product = outer * inner }
          }
          return ${list}`)
        const within = yield* run(current, env, `for index in 0..900 { let twice = index * 2 }\nreturn "done"`)
        same([long, nested, within].map(reasonOf), ["loop_limit", "loop_limit", "ok"])
        same(env.dispatched, [], "a run over its budget calls nothing afterwards")
      }))

    test("reduces a program's own failure to a fixed reason and a place, with none of its text", () =>
      Effect.gen(function* () {
        const current = yield* world
        const cases: ReadonlyArray<readonly [string, unknown]> = [
          [`assert 1 == 2, "secret detail"`, { ok: false, reason: "assert_failed", toolCalls: 0, at: { line: 1, column: 1 } }],
          [`let ok = 1\nreturn secret_detail`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 2, column: 8 }, fault: "unbound-name" }],
          [`let record = { a: 1 }\nreturn record.secret_detail`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 2, column: 8 }, fault: "missing-field" }],
          [`return [1][3]`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 1, column: 8 }, fault: "invalid-index" }],
          [`return 1 / 0`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 1, column: 8 }, fault: "invalid-operation" }],
          [`return "secret detail" + 1`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 1, column: 8 }, fault: "invalid-operation" }],
          [`return { a: 1, a: 2 }`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 1, column: 16 }, fault: "duplicate-field" }],
          [`let call = [1]\nreturn call[0]({})`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 2, column: 8 }, fault: "invalid-call" }],
          [`let secret_detail = 1\nlet secret_detail = 2`, { ok: false, reason: "execution_failed", toolCalls: 0, at: { line: 2, column: 1 }, fault: "duplicate-binding" }],
          [`return (secret_detail;`, { ok: false, reason: "invalid_code", toolCalls: 0, at: { line: 1, column: 22 } }],
          ["", { ok: false, reason: "invalid_code", toolCalls: 0 }]
        ]
        for (const [source, expected] of cases) {
          const outcome = yield* run(current, fresh(), source)
          same(outcome, expected, source)
          holds(!JSON.stringify(outcome).includes("secret"), "the program's own text does not cross")
        }
        const huge = yield* run(current, fresh(), `return "${"a".repeat(200)}"`, { limits: { maxCodeBytes: 64 } })
        same(huge, { ok: false, reason: "invalid_code", toolCalls: 0 })
        // Nesting deep enough to exhaust a stack is a fixed failure like any other.
        const deep = yield* run(current, fresh(), `return ${"(".repeat(6_000)}1${")".repeat(6_000)}`)
        holds(deep.ok ? deep.result === 1 : deep.reason === "invalid_code" || deep.reason === "execution_failed", "deep nesting ends in an outcome")
      }))

    test("stops at the deadline, whether the program is computing or waiting on a tool", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const started = Date.now()
        const computing = yield* run(current, env, `
          for index in 0..100000000 { let twice = index * 2 }
          return ${list}`, { limits: { wallTimeMs: 150, maxLoopIterations: 100_000_000 } })
        same(computing, { ok: false, reason: "timeout", toolCalls: 0 })
        const waiting = yield* run(current, env, `
          mail.list({ mailbox: "slow", query: "q" })
          return ${list}`, { runId: "waiting", limits: { wallTimeMs: 150 } })
        same(waiting, { ok: false, reason: "timeout", toolCalls: 1 })
        holds(Date.now() - started < 4_000, "the host did not wait for the program or the tool")
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
        same(env.dispatched, [], "a run past its deadline calls nothing")
      }), 20_000)

    test("calls nothing once the run is interrupted or aborted", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const source = `for index in 0..100000000 { let twice = index * 2 }\nreturn ${list}`
        const limits = { maxLoopIterations: 100_000_000 }
        const running = yield* Effect.forkChild(run(current, env, source, { limits }))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
        yield* Fiber.interrupt(running)

        const controller = new AbortController()
        const aborting = yield* Effect.forkChild(run(current, env, source, { limits, signal: controller.signal }))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
        controller.abort()
        same(yield* Fiber.join(aborting), { ok: false, reason: "aborted", toolCalls: 0 })
        same(yield* run(current, env, list, { signal: controller.signal }), { ok: false, reason: "aborted", toolCalls: 0 })

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
        same(env.dispatched, [], "an interrupted or aborted run calls nothing afterwards")
      }), 20_000)
  })
}
