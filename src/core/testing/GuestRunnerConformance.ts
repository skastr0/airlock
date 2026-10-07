import { type Crypto, Effect, Layer, type Scope } from "effect"
import { toolGrant } from "../admission/ToolGrant.ts"
import { defineAirlock } from "../airlock/Airlock.ts"
import type { Ledger } from "../ledger/Ledger.ts"
import type { OutboxStore } from "../outbox/OutboxStore.ts"
import { type GuestLimits, type GuestOutcome, GuestRunner } from "../runner/GuestRunner.ts"
import { toolPolicy } from "../session/ToolPolicy.ts"
import { holds, type Runner, same } from "./Check.ts"
import { LabelAdd, LabelRemove, MailList, MailSend } from "./ExampleContracts.ts"

/**
 * One isolated home plus the runner under test. `isolated` says whether the
 * runner really separates the guest from the host; the in-process reference
 * does not, and the isolation invariants are skipped for it by name.
 */
export interface GuestRunnerWorld {
  readonly store: Layer.Layer<OutboxStore, unknown>
  readonly ledger: Layer.Layer<Ledger, unknown>
  readonly crypto: Layer.Layer<Crypto.Crypto, unknown>
  readonly runner: Layer.Layer<GuestRunner, unknown>
  readonly isolated: boolean
}

interface Env {
  readonly dispatched: Array<string>
}

const airlock = defineAirlock({
  contracts: [MailList, MailSend, LabelAdd, LabelRemove],
  implement: {
    "mail.list": ({ mailbox }, { env }: { env: Env }) => {
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

/** The invariants every GuestRunner adapter must hold. */
export const guestRunnerConformance = (
  { describe, test }: Runner,
  name: string,
  world: Effect.Effect<GuestRunnerWorld, unknown, Scope.Scope>
): void => {
  /** Runs guest source for `runId` in a fresh process lifetime over the world. */
  const run = (
    current: GuestRunnerWorld,
    env: Env,
    source: string,
    options: { readonly runId?: string; readonly limits?: Partial<GuestLimits> } = {}
  ): Effect.Effect<GuestOutcome, unknown> =>
    Effect.gen(function* () {
      const surface = yield* airlock.guest({ runId: options.runId ?? "run-1", env })
      const runner = yield* GuestRunner
      return yield* runner.run({ source, surface, ...(options.limits === undefined ? {} : { limits: options.limits }) })
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
  const list = "await tools.mail.list({ mailbox: 'inbox', query: 'q' })"

  describe(`GuestRunner conformance: ${name}`, () => {
    test("returns a guest's plain JSON result", () =>
      Effect.gen(function* () {
        const current = yield* world
        const outcome = yield* run(current, fresh(), "return { sum: [1, 2, 3].reduce((a, b) => a + b, 0), text: 'ok' }")
        same(outcome, { ok: true, result: { sum: 6, text: "ok" }, toolCalls: 0 })
      }))

    test("gives the guest exactly the granted tools, nested by name", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const outcome = yield* run(current, env, `
          const listed = ${list};
          const sent = await tools.mail.send({ to: 'ada@example.com', subject: 's', body: 'b' });
          return {
            top: Object.keys(tools).sort(),
            mail: Object.keys(tools.mail).sort(),
            label: typeof tools.label,
            frozen: Object.isFrozen(tools) && Object.isFrozen(tools.mail),
            listed,
            staged: sent.staged === true && sent.state === 'staged' && !('outcome' in sent)
          };`)
        same(outcome, {
          ok: true,
          result: {
            top: ["mail"],
            mail: ["list", "send"],
            label: "undefined",
            frozen: true,
            listed: { ids: ["inbox-1"] },
            staged: true
          },
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

    test("lets a guest catch a tool's refusal, in plain words", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const outcome = yield* run(current, env, `
          try { await tools.mail.send({ to: 'eve@elsewhere.test', subject: 's', body: 'b' }); return 'sent'; }
          catch (error) { return String(error.message); }`)
        same(outcome.ok, true)
        holds(
          outcome.ok && typeof outcome.result === "string" &&
            outcome.result.includes("mail.send is not allowed") && outcome.result.includes("company"),
          "the guest is told which tool and which grant"
        )
        same(env.dispatched, [])
      }))

    test("fails the run at the call limit even if the guest catches the error", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const outcome = yield* run(current, env, `
          const results = [];
          for (let index = 0; index < 5; index++) {
            try { results.push(await tools.mail.list({ mailbox: 'inbox', query: String(index) })); }
            catch { results.push('caught'); }
          }
          return results;`, { limits: { maxToolCalls: 2 } })
        same(outcome, { ok: false, reason: "tool_call_limit", toolCalls: 2 })
        same(env.dispatched.length, 2, "nothing past the limit was dispatched")
      }))

    test("refuses an oversized or non-JSON tool input before anything is dispatched", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const large = yield* run(current, env, `
          try { await tools.mail.list({ mailbox: 'inbox', query: 'x'.repeat(5000) }); } catch {}
          return 'continued';`, { limits: { maxToolInputBytes: 512 } })
        const getter = yield* run(current, env, `
          try { await tools.mail.list({ mailbox: 'inbox', get query() { return 'q'; } }); } catch {}
          return 'continued';`)
        const cyclic = yield* run(current, env, `
          const input = { mailbox: 'inbox', query: 'q' }; input.self = input;
          try { await tools.mail.list(input); } catch {}
          return 'continued';`)
        same([large, getter, cyclic].map((outcome) => (outcome.ok ? "ok" : outcome.reason)), [
          "tool_input_limit",
          "tool_input_invalid",
          "tool_input_limit"
        ])
        same(env.dispatched, [])
      }))

    test("returns only bounded plain JSON, never a getter, a method or a huge value", () =>
      Effect.gen(function* () {
        const current = yield* world
        const sources: ReadonlyArray<readonly [string, string]> = [
          ["return { get secret() { return 1; } }", "invalid_output"],
          ["return { method() {} }", "invalid_output"],
          ["return new Uint8Array(4)", "invalid_output"],
          ["return NaN", "invalid_output"],
          ["return { toJSON() { return 'smuggled'; }, value: 1n }", "invalid_output"],
          ["const loop = {}; loop.self = loop; return loop", "output_limit"],
          ["return 'x'.repeat(100000)", "output_limit"]
        ]
        for (const [source, reason] of sources) {
          const outcome = yield* run(current, fresh(), source, { limits: { maxOutputBytes: 4_096 } })
          same(outcome.ok ? "ok" : outcome.reason, reason, source)
        }
        // toJSON is never consulted: the own data property is what comes back.
        const plain = yield* run(current, fresh(), "return { toJSON: 1, value: 2 }")
        same(plain, { ok: true, result: { toJSON: 1, value: 2 }, toolCalls: 0 })
      }))

    test("is not fooled by a guest that replaces the primitives it serializes with", () =>
      Effect.gen(function* () {
        const current = yield* world
        const outcome = yield* run(current, fresh(), `
          const original = { stringify: JSON.stringify, keys: Object.keys, finite: Number.isFinite, encode: TextEncoder.prototype.encode };
          try {
            JSON.stringify = () => '"forged"';
            Object.keys = () => [];
            Number.isFinite = () => true;
            TextEncoder.prototype.encode = () => new Uint8Array(0);
            Object.prototype.toJSON = () => 'forged';
            return { honest: [1, 2, 3], nested: { deep: true } };
          } finally {
            // Restored for the benefit of an in-process runner; it changes nothing for an isolated one.
            queueMicrotask(() => {
              JSON.stringify = original.stringify; Object.keys = original.keys;
              Number.isFinite = original.finite; TextEncoder.prototype.encode = original.encode;
              delete Object.prototype.toJSON;
            });
          }`)
        same(outcome, { ok: true, result: { honest: [1, 2, 3], nested: { deep: true } }, toolCalls: 0 })
      }))

    test("reduces a guest's own failure to a fixed reason, with none of its text", () =>
      Effect.gen(function* () {
        const current = yield* world
        const thrown = yield* run(current, fresh(), "throw new Error('secret detail ' + 'x'.repeat(2000))")
        const syntax = yield* run(current, fresh(), "return (;")
        const empty = yield* run(current, fresh(), "")
        const huge = yield* run(current, fresh(), `return "${"a".repeat(200)}"`, { limits: { maxCodeBytes: 64 } })
        same([thrown, syntax, empty, huge], [
          { ok: false, reason: "execution_failed", toolCalls: 0 },
          { ok: false, reason: "execution_failed", toolCalls: 0 },
          { ok: false, reason: "invalid_code", toolCalls: 0 },
          { ok: false, reason: "invalid_code", toolCalls: 0 }
        ])
        holds(!JSON.stringify(thrown).includes("secret detail"), "guest error text does not cross")
      }))

    test("stops waiting at the deadline and revokes the tools", () =>
      Effect.gen(function* () {
        const current = yield* world
        const env = fresh()
        const started = Date.now()
        // An asynchronous wait: a synchronous spin is the platform's CPU limit
        // to stop, and a local runtime may not enforce one.
        const outcome = yield* run(current, env, `
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return ${list};`, { limits: { wallTimeMs: 150 } })
        same(outcome, { ok: false, reason: "timeout", toolCalls: 0 })
        holds(Date.now() - started < 4_000, "the host did not wait for the guest")
        same(env.dispatched, [], "a guest past its deadline can call nothing")
      }), 20_000)

    test("gives an isolated guest no network, no bindings and no host", () =>
      Effect.gen(function* () {
        const current = yield* world
        if (!current.isolated) return
        // Module names are assembled in the guest so that this file, which only
        // quotes guest source, names no host module itself.
        const outcome = yield* run(current, fresh(), `
          const attempt = async (act) => { try { await act(); return 'allowed'; } catch { return 'blocked'; } };
          return {
            fetch: await attempt(async () => { await fetch('https://example.com/'); }),
            socket: await attempt(async () => {
              const { connect } = await import('cloudflare:' + 'sockets');
              const socket = connect('example.com:443'); await socket.opened;
            }),
            node: await attempt(async () => { await import('node:' + 'fs'); }),
            env: await attempt(async () => {
              const { env } = await import('cloudflare:' + 'workers');
              if (Object.keys(env).length > 0) return; throw new Error('empty');
            }),
            process: typeof process,
            console: typeof console.log
          };`)
        same(outcome, {
          ok: true,
          result: {
            fetch: "blocked",
            socket: "blocked",
            node: "blocked",
            env: "blocked",
            process: "undefined",
            console: "function"
          },
          toolCalls: 0
        })
      }))
  })
}
