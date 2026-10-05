import { type Crypto, Deferred, Effect, Fiber, Layer, Option, Result, Schema, type Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Ledger, type LedgerEntry, LedgerFailed } from "../ledger/Ledger.ts"
import {
  type Delivery,
  DispatchFailed,
  type DispatchHandlers,
  DispatchRefused,
  type DispatchRequest
} from "../outbox/Dispatcher.ts"
import { defineIntentKind } from "../outbox/Intent.ts"
import {
  defineOutbox,
  DISPATCH_TIMEOUT_MILLIS,
  isLivePermit,
  type OutboxOf,
  type OutboxService,
  RESPONSE_LIMIT_BYTES
} from "../outbox/Outbox.ts"
import { OutboxStore } from "../outbox/OutboxStore.ts"
import {
  DispatchAuthorization,
  DispatchProvenance,
  type EmissionId,
  EmissionRecord,
  IdempotencyKey,
  InvalidIntent
} from "../outbox/Records.ts"
import { holds, type Runner, same } from "./Check.ts"
import { toolGrant, ToolGrantPolicy } from "../admission/ToolGrant.ts"
import { openToolSession } from "../session/ToolSession.ts"
import { exampleContracts, MailList, MailSend } from "./ExampleContracts.ts"
import { digestOf, encoded, instant } from "./Fixtures.ts"

/**
 * One isolated Airlock home for one test: a store and a ledger over the same
 * durable state, plus the host's Crypto. Building the Layers again is a
 * restart.
 */
export interface OutboxWorld {
  readonly store: Layer.Layer<OutboxStore, unknown>
  readonly ledger: Layer.Layer<Ledger, unknown>
  readonly crypto: Layer.Layer<Crypto.Crypto, unknown>
  /**
   * Replaces the sealed dispatch stored for `id` with different bytes, the way
   * an attacker with write access to the store would. Required: an adapter
   * that cannot be shown to fail closed does not conform.
   */
  readonly tamperDispatch: (id: EmissionId) => Effect.Effect<void, unknown>
  /** Damages the stored record for `id` so that it no longer decodes. Required. */
  readonly corruptRecord: (id: EmissionId) => Effect.Effect<void, unknown>
}

// ── a kind and a wire the suite controls ────────────────────────────────────

const ProbeDispatch = Schema.Struct({ target: Schema.String, payload: Schema.String })
type ProbeDispatch = typeof ProbeDispatch.Type
const ProbeOutcome = Schema.Struct({ echo: Schema.String })
type ProbeOutcome = typeof ProbeOutcome.Type

const encoder = new TextEncoder()

const Probe = defineIntentKind({
  tag: "probe",
  dispatch: ProbeDispatch,
  summary: Schema.Struct({ target: Schema.String, payloadBytes: Schema.Int }),
  outcome: ProbeOutcome,
  summarize: (dispatch) =>
    dispatch.target.length === 0
      ? Result.fail(new InvalidIntent({ kind: "probe", field: "target", reason: "must not be empty" }))
      : Result.succeed({
          target: dispatch.target,
          payloadBytes: encoder.encode(dispatch.payload).byteLength
        }),
  target: (summary) => summary.target
})

const probes = defineOutbox({ probe: Probe })
type Outbox = OutboxService<typeof probes.kinds>
type Request = DispatchRequest<"probe", ProbeDispatch>
type Wire = (request: Request) => Effect.Effect<Delivery<ProbeOutcome>, DispatchFailed | DispatchRefused>

const echo: Wire = (request) =>
  Effect.succeed({
    outcome: { echo: request.dispatch.payload },
    response: encoder.encode(`ok:${request.dispatch.payload}`),
    truncated: false
  })

/** Records every handler call, and whether the permit was live when it arrived. */
const recordingWire = (wire: Wire = echo) => {
  const calls: Array<{ readonly payload: string; readonly live: boolean; readonly permit: Request["permit"] }> = []
  return {
    calls,
    wire: ((request) => {
      calls.push({
        payload: request.dispatch.payload,
        live: isLivePermit(request.permit),
        permit: request.permit
      })
      return wire(request)
    }) satisfies Wire
  }
}

// ── tool contracts, declared outside the kernel ─────────────────────────────

const tools = defineOutbox(exampleContracts)
type Tools = OutboxService<typeof tools.kinds>
type ToolHandlers = DispatchHandlers<typeof tools.kinds>

/** A wire for the example contracts that records every call it receives. */
const toolWire = (overrides: Partial<ToolHandlers> = {}) => {
  const calls: Array<{ readonly tool: string; readonly input: unknown }> = []
  const reply = <Outcome>(outcome: Outcome, body: string) =>
    Effect.succeed({ outcome, response: encoder.encode(body), truncated: false })
  const defaults: ToolHandlers = {
    "mail.list": (request) =>
      reply({ ids: [`m-${calls.length}`, request.dispatch.mailbox] }, `listing ${calls.length}`),
    "mail.send": () => reply({ messageId: "sent-1" }, "sent"),
    "label.add": () => reply({ added: true }, "added"),
    "label.remove": () => reply({ removed: true }, "removed")
  }
  const wire = { ...defaults, ...overrides }
  const handlers: ToolHandlers = {
    "mail.list": (request) => {
      calls.push({ tool: "mail.list", input: request.dispatch })
      return wire["mail.list"](request)
    },
    "mail.send": (request) => {
      calls.push({ tool: "mail.send", input: request.dispatch })
      return wire["mail.send"](request)
    },
    "label.add": (request) => {
      calls.push({ tool: "label.add", input: request.dispatch })
      return wire["label.add"](request)
    },
    "label.remove": (request) => {
      calls.push({ tool: "label.remove", input: request.dispatch })
      return wire["label.remove"](request)
    }
  }
  return { calls, handlers }
}

const bySupervisor = new DispatchProvenance({ committedBy: "supervisor" })
const key = (name: string) => IdempotencyKey.make(name)
const request = (name: string, payload = "hello", holdMillis = 0) => ({
  key: key(name),
  intent: { kind: "probe", dispatch: { target: "probe://one", payload } },
  holdMillis
} as const)

/**
 * The invariants the Outbox kernel must hold over any conforming store and
 * ledger. A host runs this against its own adapters; passing it is what makes
 * those adapters an Airlock Outbox.
 */
export const outboxConformance = (
  { describe, test }: Runner,
  name: string,
  world: Effect.Effect<OutboxWorld, unknown, Scope.Scope>
): void => {
  /**
   * One process lifetime: the kernel is built (and runs its startup recovery)
   * over the world's adapters and the given wire. A second session is a restart.
   */
  const session = <A, E>(
    current: OutboxWorld,
    wire: Wire,
    body: (outbox: Outbox, store: OutboxStore["Service"], ledger: Ledger["Service"]) => Effect.Effect<A, E>,
    ledger: Layer.Layer<Ledger, unknown> = current.ledger,
    store: Layer.Layer<OutboxStore, unknown> = current.store
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* probes.Outbox, yield* OutboxStore, yield* Ledger)
    }).pipe(
      Effect.provide(
        probes.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              store,
              ledger,
              current.crypto,
              Layer.succeed(probes.Dispatcher, { probe: wire })
            )
          )
        )
      )
    )

  /** One process lifetime of the tool-contract Outbox over the same world. */
  const toolSession = <A, E>(
    current: OutboxWorld,
    handlers: ToolHandlers,
    body: (
      outbox: Tools,
      store: OutboxStore["Service"],
      ledger: Ledger["Service"]
    ) => Effect.Effect<A, E, OutboxOf<typeof tools.kinds> | Crypto.Crypto>
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* tools.Outbox, yield* OutboxStore, yield* Ledger)
    }).pipe(
      Effect.provide(
        tools.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              current.store,
              current.ledger,
              current.crypto,
              Layer.succeed(tools.Dispatcher, handlers)
            )
          )
        )
      )
    )

  const acts = (entries: ReadonlyArray<LedgerEntry>) => entries.map((entry) => `${entry.act}:${entry.ref}`)

  const timed = (
    name: string,
    body: () => Effect.Effect<void, unknown, Scope.Scope>,
    timeout?: number
  ) => test(name, () => body().pipe(Effect.provide(TestClock.layer())), timeout)

  describe(`Outbox conformance: ${name}`, () => {
    timed("staging records intent and sends nothing", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a", "secret-payload")))
        same(staged.state, "staged")
        same(staged.summary, { target: "probe://one", payloadBytes: 14 })
        holds(!JSON.stringify(staged).includes("secret-payload"), "an emission never carries dispatch material")
        const [pending, entries] = yield* session(current, wire, (outbox, _, ledger) =>
          Effect.all([outbox.pending, ledger.entries]))
        same(pending.map((emission) => emission.id), [staged.id])
        same(acts(entries), [`stage:${staged.id}`])
        same(calls.length, 0)
      }))

    timed("replaying a key returns the same emission and stages nothing new", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const first = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        const replay = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        same(replay.id, first.id)
        same(replay.stagedAt.toString(), first.stagedAt.toString())

        const committed = yield* session(current, wire, (outbox) => outbox.commit(first.id, bySupervisor))
        const afterCommit = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        same(afterCommit.state, "committed")
        same(afterCommit.id, committed.id)

        const [all, entries] = yield* session(current, wire, (_, store, ledger) =>
          Effect.all([store.list(), ledger.entries]))
        same(all.length, 1)
        same(acts(entries), [`stage:${first.id}`, `commit:${first.id}`])
        same(calls.length, 1)
      }))

    timed("refuses a reused key that asks for something else", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { wire } = recordingWire()
        const first = yield* session(current, wire, (outbox) => outbox.stage(request("a", "one")))
        const [payload, hold, authorized] = yield* session(current, wire, (outbox) =>
          Effect.all([
            Effect.flip(outbox.stage(request("a", "two"))),
            Effect.flip(outbox.stage(request("a", "one", 5_000))),
            Effect.flip(outbox.stage({
              ...request("a", "one"),
              authorization: new DispatchAuthorization({
                sealDigest: digestOf("c"),
                grantId: "grant/1",
                grantSelector: "probe://*",
                dispatchClass: "read",
                target: "probe://one"
              })
            }))
          ]))
        same([payload._tag, hold._tag, authorized._tag], [
          "IdempotencyConflict",
          "IdempotencyConflict",
          "IdempotencyConflict"
        ])
        const kept = yield* session(current, wire, (outbox) => outbox.inspect(first.id))
        same(kept.summary, { target: "probe://one", payloadBytes: 3 })
      }))

    timed("rejects an invalid intent, hold, or authorization before storing anything", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { wire } = recordingWire()
        const failures = yield* session(current, wire, (outbox) =>
          Effect.all([
            Effect.flip(outbox.stage({ ...request("a"), intent: { kind: "probe", dispatch: { target: "", payload: "x" } } })),
            Effect.flip(outbox.stage(request("b", "x", -1))),
            Effect.flip(outbox.stage(request("c", "x", Number.NaN))),
            Effect.flip(outbox.stage({
              ...request("d"),
              authorization: new DispatchAuthorization({
                sealDigest: digestOf("c"),
                grantId: "grant/1",
                grantSelector: "probe://*",
                dispatchClass: "read",
                target: "probe://elsewhere"
              })
            }))
          ]))
        same(failures.map((failure) => failure._tag), [
          "InvalidIntent",
          "InvalidHoldDuration",
          "InvalidHoldDuration",
          "InvalidDispatchAuthorization"
        ])
        same((yield* session(current, wire, (_, store) => store.list())).length, 0)
      }))

    timed("commit dispatches once, with a permit that is live only for that dispatch", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a", "ping")))
        const committed = yield* session(current, wire, (outbox) => outbox.commit(staged.id, bySupervisor))
        same(committed.state, "committed")
        same(committed.outcome, { echo: "ping" })
        same(committed.provenance.committedBy, "supervisor")
        same(
          [committed.capture.retainedBytes, committed.capture.truncated, committed.capture.limitBytes],
          [7, false, RESPONSE_LIMIT_BYTES]
        )
        same(calls.map((call) => [call.payload, call.live]), [["ping", true]])
        holds(!isLivePermit(calls[0]!.permit), "a permit is revoked once its dispatch settles")
        same(calls[0]!.permit.emissionId, staged.id)

        const response = yield* session(current, wire, (outbox) => outbox.response(staged.id))
        same(Option.map(response, (bytes) => new TextDecoder().decode(bytes)), Option.some("ok:ping"))
      }))

    timed("an emission converts to its stored record and back without loss", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a", "ping")))
        const committed = yield* session(current, wire, (outbox) => outbox.commit(staged.id, bySupervisor))
        const stored = yield* session(current, wire, (_, store) => store.read(staged.id))
        const record = yield* probes.toRecord(committed)
        same(Option.map(stored, encoded), Option.some(encoded(record)), "toRecord yields the stored record")
        same(yield* probes.fromRecord(record), committed, "fromRecord is its inverse")
        // The JSON form survives a trip through text, as an artifact would carry it.
        const json = JSON.stringify(encoded(record))
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EmissionRecord))(json)
        same(yield* probes.fromRecord(decoded), committed)
        const stagedRecord = yield* probes.toRecord(staged)
        same([stagedRecord.state, "outcome" in stagedRecord], ["staged", false])
      }))

    timed("lets exactly one of two racing commits reach the wire", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        const results = yield* session(current, wire, (outbox) =>
          Effect.all(
            Array.from({ length: 6 }, () => Effect.result(outbox.commit(staged.id, bySupervisor))),
            { concurrency: "unbounded" }
          ))
        same(results.filter(Result.isSuccess).length, 1)
        for (const result of results) {
          if (Result.isFailure(result)) same(result.failure._tag, "EmissionNotPending")
        }
        same(calls.length, 1)
      }))

    timed("a cancelled emission can never be sent", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        const cancelled = yield* session(current, wire, (outbox) => outbox.cancel(staged.id))
        same(cancelled.state, "cancelled")
        const [commit, again, entries] = yield* session(current, wire, (outbox, _, ledger) =>
          Effect.all([
            Effect.flip(outbox.commit(staged.id, bySupervisor)),
            Effect.flip(outbox.cancel(staged.id)),
            ledger.entries
          ]))
        same([commit._tag, again._tag], ["EmissionNotPending", "EmissionNotPending"])
        same(acts(entries), [`stage:${staged.id}`, `cancel:${staged.id}`])
        same(calls.length, 0)
      }))

    timed("a failed dispatch is uncertain and is never retried", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire(() => Effect.fail(new DispatchFailed({ reason: "connection reset" })))
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        const failed = yield* session(current, wire, (outbox) =>
          Effect.flip(outbox.commit(staged.id, bySupervisor)))
        same(failed._tag === "EmissionDispatchUncertain" ? failed.reason : failed._tag, "dispatch-failed")

        // A later attempt, in this process or after a restart, and a replayed
        // stage, all find it settled and send nothing.
        const working = recordingWire()
        const [retry, replay, flushed, response, entries] = yield* session(current, working.wire, (outbox, _, ledger) =>
          Effect.all([
            Effect.flip(outbox.commit(staged.id, bySupervisor)),
            outbox.stage(request("a")),
            outbox.flush,
            outbox.response(staged.id),
            ledger.entries
          ]))
        same(retry._tag, "EmissionNotPending")
        same(replay.state, "uncertain")
        same(flushed.committed.length, 0)
        holds(Option.isNone(response), "an uncertain emission keeps no response")
        same(acts(entries), [`stage:${staged.id}`])
        same([calls.length, working.calls.length], [1, 0])
      }))

    timed("a handler's proof that nothing was sent settles as refused, with a receipt", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire(() =>
          Effect.fail(new DispatchRefused({ reason: "connection not configured" })))
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        const refused = yield* session(current, wire, (outbox) =>
          Effect.flip(outbox.commit(staged.id, bySupervisor)))
        same(
          refused._tag === "EmissionRefused" ? refused.reason : refused._tag,
          "connection not configured"
        )

        // Refused is terminal: it is not pending, not retried, and a replayed
        // stage reports it rather than quietly staging the act again.
        const working = recordingWire()
        const [emission, retry, cancel, replay, flushed, response, entries] = yield* session(
          current,
          working.wire,
          (outbox, _, ledger) =>
            Effect.all([
              outbox.inspect(staged.id),
              Effect.flip(outbox.commit(staged.id, bySupervisor)),
              Effect.flip(outbox.cancel(staged.id)),
              outbox.stage(request("a")),
              outbox.flush,
              outbox.response(staged.id),
              ledger.entries
            ])
        )
        same(emission.state === "refused" ? emission.reason : emission.state, "connection not configured")
        same([retry._tag, cancel._tag], ["EmissionNotPending", "EmissionNotPending"])
        same(replay.state, "refused")
        same(flushed.committed.length, 0)
        holds(Option.isNone(response), "a refused emission has no response")
        same(acts(entries), [`stage:${staged.id}`, `refuse:${staged.id}`])
        same([calls.length, working.calls.length], [1, 0])

        // The same act under a new key is a new emission and may be sent.
        const again = yield* session(current, working.wire, (outbox) =>
          Effect.flatMap(outbox.stage(request("a-retry")), (fresh) => outbox.commit(fresh.id, bySupervisor)))
        same([again.state, again.id === staged.id, working.calls.length], ["committed", false, 1])
      }))

    timed("a dispatch interrupted mid-flight settles as uncertain", () =>
      Effect.gen(function* () {
        const current = yield* world
        const started = yield* Deferred.make<void>()
        const { calls, wire } = recordingWire(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        const state = yield* session(current, wire, (outbox) =>
          Effect.gen(function* () {
            const staged = yield* outbox.stage(request("a"))
            const committing = yield* Effect.forkChild(outbox.commit(staged.id, bySupervisor))
            yield* Deferred.await(started)
            yield* Fiber.interrupt(committing)
            return (yield* outbox.inspect(staged.id)).state
          }))
        same(state, "uncertain")
        same(calls.length, 1)
      }))

    timed("a dispatch that outlives the construction bound settles as uncertain", () =>
      Effect.gen(function* () {
        const current = yield* world
        const started = yield* Deferred.make<void>()
        const { wire } = recordingWire(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        const failure = yield* session(current, wire, (outbox) =>
          Effect.gen(function* () {
            const staged = yield* outbox.stage(request("a"))
            const committing = yield* Effect.forkChild(Effect.flip(outbox.commit(staged.id, bySupervisor)))
            yield* Deferred.await(started)
            yield* TestClock.adjust(DISPATCH_TIMEOUT_MILLIS)
            return yield* Fiber.join(committing)
          }))
        same(failure._tag === "EmissionDispatchUncertain" ? failure.reason : failure._tag, "dispatch-timed-out")
      }))

    timed("a response over the bound is refused, and nothing of it is kept", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { wire } = recordingWire(() =>
          Effect.succeed({
            outcome: { echo: "big" },
            response: new Uint8Array(RESPONSE_LIMIT_BYTES + 1),
            truncated: false
          }))
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        const failure = yield* session(current, wire, (outbox) =>
          Effect.flip(outbox.commit(staged.id, bySupervisor)))
        same(failure._tag, "EmissionDispatchUncertain")
        const [emission, response] = yield* session(current, wire, (outbox) =>
          Effect.all([outbox.inspect(staged.id), outbox.response(staged.id)]))
        same(emission.state, "uncertain")
        holds(Option.isNone(response), "an oversized response is not stored")
      }))

    timed("a crash while committing is settled as uncertain on restart, never re-sent", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        // The process dies after `staged → committing` is durable.
        yield* session(current, wire, (_, store) =>
          store.transition(staged.id, "staged", {
            state: "committing",
            provenance: bySupervisor,
            committingAt: instant(5)
          }))
        const [emission, retry, entries] = yield* session(current, wire, (outbox, _, ledger) =>
          Effect.all([
            outbox.inspect(staged.id),
            Effect.flip(outbox.commit(staged.id, bySupervisor)),
            ledger.entries
          ]))
        same(emission.state === "uncertain" ? emission.reason : emission.state, "recovered-after-restart")
        same(retry._tag, "EmissionNotPending")
        same(acts(entries), [`stage:${staged.id}`])
        same(calls.length, 0)
      }))

    timed("a commit whose receipt cannot be recorded is still committed, and says so", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        const unavailable = Layer.succeed(Ledger, Ledger.of({
          record: () => Effect.fail(new LedgerFailed({ operation: "record", cause: "Offline", reason: "no ledger" })),
          entries: Effect.succeed([])
        }))
        const failure = yield* session(
          current,
          wire,
          (outbox) => Effect.flip(outbox.commit(staged.id, bySupervisor)),
          unavailable
        )
        same(
          failure._tag === "OutboxRecoveryRequired" ? [failure.status, failure.reason] : failure._tag,
          ["committed", "Offline: no ledger"]
        )
        const [emission, retry] = yield* session(current, wire, (outbox) =>
          Effect.all([outbox.inspect(staged.id), Effect.flip(outbox.commit(staged.id, bySupervisor))]))
        same(emission.state, "committed")
        same(retry._tag, "EmissionNotPending")
        same(calls.length, 1)
      }))

    timed("flush commits what is due and leaves held emissions waiting", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const [due, held] = yield* session(current, wire, (outbox) =>
          Effect.all([outbox.stage(request("due", "now", 0)), outbox.stage(request("held", "later", 60_000))]))
        const first = yield* session(current, wire, (outbox) => outbox.flush)
        same(first.committed.map((emission) => emission.id), [due.id])
        same([first.failed.length, first.waiting], [0, 1])

        yield* TestClock.adjust(60_000)
        const second = yield* session(current, wire, (outbox) => outbox.flush)
        same(second.committed.map((emission) => emission.id), [held.id])
        same(second.waiting, 0)
        same(calls.map((call) => call.payload), ["now", "later"])
      }))

    timed("lists pre-authorized emissions only under their own seal", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const authorization = new DispatchAuthorization({
          sealDigest: digestOf("c"),
          grantId: "grant/read",
          grantSelector: "probe://*",
          dispatchClass: "read",
          target: "probe://one"
        })
        const [authorized] = yield* session(current, wire, (outbox) =>
          Effect.all([outbox.stage({ ...request("a"), authorization }), outbox.stage(request("b"))]))
        const [mine, other] = yield* session(current, wire, (outbox) =>
          Effect.all([outbox.pendingAuthorized(digestOf("c")), outbox.pendingAuthorized(digestOf("d"))]))
        same(mine.map((emission) => emission.id), [authorized.id])
        same(mine[0]?.authorization?.grantId, "grant/read")
        same(other.length, 0)
        same(calls.length, 0)
      }))

    timed("a tool call is summarized by names, sizes and public fields, never private values", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const staged = yield* toolSession(current, handlers, (outbox) =>
          outbox.stage({
            key: key("send-1"),
            intent: {
              kind: "mail.send",
              dispatch: { to: "ada@example.com", subject: "quarterly numbers", body: "the secret figures" }
            },
            holdMillis: 0
          }))
        same(staged.kind === "mail.send" ? staged.summary : staged.kind, {
          tool: "mail.send",
          version: "1",
          target: "tool:mail.send",
          fields: ["body", "subject", "to"],
          inputBytes: 82,
          public: { to: "ada@example.com" }
        })
        const [record, entries] = yield* toolSession(current, handlers, (_, store, ledger) =>
          Effect.all([store.read(staged.id), ledger.entries]))
        const visible = JSON.stringify([staged, Option.map(record, encoded), entries])
        holds(visible.includes("ada@example.com"), "a public field is visible")
        holds(!visible.includes("quarterly numbers"), "a private field never leaves the sealed dispatch")
        holds(!visible.includes("the secret figures"), "a private field never leaves the sealed dispatch")
        same(calls.length, 0)
      }))

    timed("a recorded read returns the same outcome and bytes on every replay, with one dispatch", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const read = {
          key: key("guest-run-7/step-3"),
          intent: { kind: "mail.list", dispatch: { mailbox: "inbox", query: "from:ada" } },
          holdMillis: 0
        } as const
        const provenance = new DispatchProvenance({ committedBy: "policy-auto", dispatchClass: "read" })
        const first = yield* toolSession(current, handlers, (outbox) => outbox.perform(read, provenance))
        same(first.emission.outcome, { ids: ["m-1", "inbox"] })
        same(new TextDecoder().decode(first.response), "listing 1")

        // A re-executed caller, after a restart, asks again under the same key.
        const replay = yield* toolSession(current, handlers, (outbox) => outbox.perform(read, provenance))
        const again = yield* toolSession(current, handlers, (outbox) =>
          Effect.all([outbox.perform(read, provenance), outbox.perform(read, provenance)], {
            concurrency: "unbounded"
          }))
        for (const performed of [replay, ...again]) {
          same(performed.emission.id, first.emission.id)
          same(performed.emission.outcome, first.emission.outcome)
          same([...performed.response], [...first.response])
        }
        same(calls.length, 1, "exactly one dispatch")

        // The key records one act. Asking it for something else is refused.
        const different = yield* toolSession(current, handlers, (outbox) =>
          Effect.flip(outbox.perform(
            { ...read, intent: { kind: "mail.list", dispatch: { mailbox: "inbox", query: "from:bob" } } },
            provenance
          )))
        same(different._tag, "IdempotencyConflict")
        same(calls.length, 1)
      }))

    timed("perform races to one dispatch and replays a failed act as failed", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const read = (name: string) => ({
          key: key(name),
          intent: { kind: "mail.list", dispatch: { mailbox: "inbox", query: "q" } },
          holdMillis: 0
        } as const)
        const raced = yield* toolSession(current, handlers, (outbox) =>
          Effect.all(
            Array.from({ length: 6 }, () => outbox.perform(read("race"), bySupervisor)),
            { concurrency: "unbounded" }
          ))
        same(new Set(raced.map((performed) => new TextDecoder().decode(performed.response))).size, 1)
        same(calls.length, 1)

        const failing = toolWire({ "mail.list": () => Effect.fail(new DispatchFailed({ reason: "reset" })) })
        const refusing = toolWire({ "mail.list": () => Effect.fail(new DispatchRefused({ reason: "no connection" })) })
        const uncertain = yield* toolSession(current, failing.handlers, (outbox) =>
          Effect.flip(outbox.perform(read("fails"), bySupervisor)))
        const refused = yield* toolSession(current, refusing.handlers, (outbox) =>
          Effect.flip(outbox.perform(read("refuses"), bySupervisor)))
        // Replays under a working wire report the recorded settlement and send nothing.
        const working = toolWire()
        const [uncertainAgain, refusedAgain] = yield* toolSession(current, working.handlers, (outbox) =>
          Effect.all([
            Effect.flip(outbox.perform(read("fails"), bySupervisor)),
            Effect.flip(outbox.perform(read("refuses"), bySupervisor))
          ]))
        same(
          [uncertain._tag, uncertainAgain._tag, refused._tag, refusedAgain._tag],
          ["EmissionDispatchUncertain", "EmissionDispatchUncertain", "EmissionRefused", "EmissionRefused"]
        )
        same(working.calls.length, 0)
      }))

    timed("a compensation is a new linked emission, staged once, for a committed act only", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const add = {
          key: key("label-1"),
          intent: { kind: "label.add", dispatch: { messageId: "m-9", label: "urgent" } },
          holdMillis: 0
        } as const
        const added = yield* toolSession(current, handlers, (outbox) => outbox.perform(add, bySupervisor))

        const answer = yield* toolSession(current, handlers, (outbox) =>
          outbox.compensate(added.emission, { holdMillis: 5_000 }))
        same([answer.kind, answer.state, answer.compensates], ["label.remove", "staged", added.emission.id])
        same(answer.kind === "label.remove" ? answer.summary.public : null, { label: "urgent" })
        same(calls.map((call) => call.tool), ["label.add"], "staging a compensation sends nothing")

        // Answering twice, after a restart, names the same emission.
        const [second, all] = yield* toolSession(current, handlers, (outbox, store) =>
          Effect.all([outbox.compensate(added.emission, { holdMillis: 5_000 }), store.list()]))
        same(second.id, answer.id)
        same(all.length, 2)

        // It is admitted and committed like any other emission, and then the
        // answering handler receives the input its contract declared.
        const removed = yield* toolSession(current, handlers, (outbox) => outbox.commit(answer.id, bySupervisor))
        same([removed.state, removed.compensates], ["committed", added.emission.id])
        same(calls.map((call) => [call.tool, call.input]), [
          ["label.add", { messageId: "m-9", label: "urgent" }],
          ["label.remove", { messageId: "m-9", label: "urgent" }]
        ])
        const after = yield* toolSession(current, handlers, (outbox) =>
          outbox.compensate(added.emission, { holdMillis: 5_000 }))
        same([after.id, after.state], [answer.id, "committed"], "an answered act is not answered again")
        same(calls.length, 2)
      }))

    timed("nothing but a committed, answerable emission can be compensated", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const staged = yield* toolSession(current, handlers, (outbox) =>
          outbox.stage({
            key: key("label-held"),
            intent: { kind: "label.add", dispatch: { messageId: "m-1", label: "later" } },
            holdMillis: 60_000
          }))
        const removed = yield* toolSession(current, handlers, (outbox) =>
          outbox.perform({
            key: key("remove-1"),
            intent: { kind: "label.remove", dispatch: { messageId: "m-1", label: "old" } },
            holdMillis: 0
          }, bySupervisor))
        // The types refuse both calls; a caller that casts past them is still refused.
        type Compensable = Parameters<Tools["compensate"]>[0]
        const [notCommitted, irreversible, unknown] = yield* toolSession(current, handlers, (outbox) =>
          Effect.all([
            Effect.flip(outbox.compensate(staged as unknown as Compensable, { holdMillis: 0 })),
            Effect.flip(outbox.compensate(removed.emission as unknown as Compensable, { holdMillis: 0 })),
            Effect.flip(outbox.compensate(
              { ...removed.emission, id: staged.id.replace(/.$/, "0") } as unknown as Compensable,
              { holdMillis: 0 }
            ))
          ]))
        same(
          [
            notCommitted._tag === "NotCompensable" ? notCommitted.reason : notCommitted._tag,
            irreversible._tag === "NotCompensable" ? irreversible.reason : irreversible._tag
          ],
          ["not-committed", "irreversible"]
        )
        holds(
          unknown._tag === "UnknownEmission" || unknown._tag === "NotCompensable",
          "a compensation is built from the stored record, not from the value passed in"
        )
        const all = yield* toolSession(current, handlers, (_, store) => store.list())
        same(all.length, 2, "no compensation was staged")
        same(calls.map((call) => call.tool), ["label.remove"])
      }))

    timed("a session exposes exactly the granted tools, performs reads and only stages the rest", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const grants = [
          toolGrant(MailList, { class: "read", commit: "auto", where: { mailbox: { equals: "inbox" } } }),
          toolGrant(MailSend, { where: { to: { endsWith: "@example.com" } } })
        ]
        const open = (runId: string) =>
          openToolSession(tools, { runId, grants, budget: { maxCalls: 10, maxInputBytes: 10_000 } })

        const first = yield* toolSession(current, handlers, () =>
          Effect.gen(function* () {
            const session = yield* open("run-1")
            same(Object.keys(session).sort(), ["mail.list", "mail.send"], "one method per granted tool")
            holds(Object.isFrozen(session), "a session cannot be given new methods")
            const listed = yield* session["mail.list"]({ mailbox: "inbox", query: "from:ada" })
            const sent = yield* session["mail.send"]({ to: "ada@example.com", subject: "hi", body: "secret" })
            return { listed, sent }
          }))
        same(first.listed._tag === "Performed" ? first.listed.outcome : first.listed._tag, { ids: ["m-1", "inbox"] })
        same([first.sent._tag, first.sent.state, "outcome" in first.sent], ["Staged", "staged", false])
        same(calls.map((call) => call.tool), ["mail.list"], "the write was recorded, not sent")

        // The guest is executed again from the top, after a restart.
        const again = yield* toolSession(current, handlers, () =>
          Effect.gen(function* () {
            const session = yield* open("run-1")
            const listed = yield* session["mail.list"]({ mailbox: "inbox", query: "from:ada" })
            const sent = yield* session["mail.send"]({ to: "ada@example.com", subject: "hi", body: "secret" })
            return { listed, sent }
          }))
        same(again.listed, first.listed, "a re-executed read gets the recorded result")
        same(again.sent.id, first.sent.id)
        same(calls.length, 1)

        // A supervisor commits the staged send. The guest still learns nothing from it.
        yield* toolSession(current, handlers, (outbox) => outbox.commit(first.sent.id, bySupervisor))
        const afterCommit = yield* toolSession(current, handlers, () =>
          Effect.gen(function* () {
            const session = yield* open("run-1")
            yield* session["mail.list"]({ mailbox: "inbox", query: "from:ada" })
            return yield* session["mail.send"]({ to: "ada@example.com", subject: "hi", body: "secret" })
          }))
        same([afterCommit._tag, afterCommit.state, "outcome" in afterCommit], ["Staged", "committed", false])
        same(calls.map((call) => call.tool), ["mail.list", "mail.send"])

        // Another run is another set of keys.
        const other = yield* toolSession(current, handlers, () =>
          Effect.flatMap(open("run-2"), (session) => session["mail.list"]({ mailbox: "inbox", query: "from:ada" })))
        same(other._tag === "Performed" ? other.id === first.listed.id : other._tag, false)
        same(calls.length, 3)
      }))

    timed("a session refuses what its grants do not cover and records nothing for it", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const grants = [
          toolGrant(MailList, { class: "read", commit: "auto", where: { mailbox: { equals: "inbox" } } }),
          toolGrant(MailSend, { where: { to: { endsWith: "@example.com" } } })
        ]
        const refusals = yield* toolSession(current, handlers, (_, store) =>
          Effect.gen(function* () {
            const session = yield* openToolSession(tools, {
              runId: "run-1",
              grants,
              budget: { maxCalls: 10, maxInputBytes: 10_000 }
            })
            // The grant set was copied: growing the caller's array grants nothing.
            grants.push(toolGrant(MailSend))
            const failures = yield* Effect.all([
              Effect.flip(session["mail.list"]({ mailbox: "drafts", query: "q" })),
              Effect.flip(session["mail.send"]({ to: "eve@elsewhere.test", subject: "s", body: "b" })),
              Effect.flip(session["mail.send"]({ to: "ada@example.com" } as never)),
              Effect.flip(session["mail.send"]({ to: 7, subject: "s", body: "b" } as never))
            ])
            return { failures, stored: yield* store.list(), names: Object.keys(session).sort() }
          }))
        same(refusals.failures.map((failure) => failure._tag), [
          "ToolCallNotGranted",
          "ToolCallNotGranted",
          "InvalidToolInput",
          "InvalidToolInput"
        ])
        same(refusals.stored.length, 0)
        same(refusals.names, ["mail.list", "mail.send"])
        same(calls.length, 0)

        // A read that is granted but not pre-authorized is staged like a write.
        const waiting = yield* toolSession(current, handlers, () =>
          Effect.flatMap(
            openToolSession(tools, {
              runId: "run-3",
              grants: [toolGrant(MailList, { class: "read" })],
              budget: { maxCalls: 1, maxInputBytes: 1_000 }
            }),
            (session) => session["mail.list"]({ mailbox: "inbox", query: "q" })
          ))
        same([waiting._tag, calls.length], ["Staged", 0])

        // A grant set that is invalid against the contracts opens no session at all.
        const invalid = yield* toolSession(current, handlers, () =>
          Effect.flip(openToolSession(tools, {
            runId: "run-4",
            grants: [new ToolGrantPolicy({ tool: "mail.send", where: { body: { equals: "x" } } })],
            budget: { maxCalls: 1, maxInputBytes: 1_000 }
          })))
        same(invalid._tag, "InvalidToolSession")
      }))

    timed("a session's budgets fail closed", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, handlers } = toolWire()
        const grants = [toolGrant(MailList, { class: "read", commit: "auto" })]
        const outcome = yield* toolSession(current, handlers, (_, store) =>
          Effect.gen(function* () {
            const counted = yield* openToolSession(tools, {
              runId: "calls",
              grants,
              budget: { maxCalls: 2, maxInputBytes: 10_000 }
            })
            const call = (query: string) => counted["mail.list"]({ mailbox: "inbox", query })
            yield* call("one")
            // A refused call still spends budget.
            yield* Effect.flip(counted["mail.list"]({ mailbox: 1 } as never))
            const overCalls = yield* Effect.flip(call("three"))

            const sized = yield* openToolSession(tools, {
              runId: "bytes",
              grants,
              budget: { maxCalls: 10, maxInputBytes: 60 }
            })
            yield* sized["mail.list"]({ mailbox: "inbox", query: "a" })
            const overBytes = yield* Effect.flip(sized["mail.list"]({ mailbox: "inbox", query: "x".repeat(40) }))
            return { overCalls, overBytes, stored: (yield* store.list()).length }
          }))
        same(
          [outcome.overCalls, outcome.overBytes].map((failure) =>
            failure._tag === "SessionBudgetExceeded" ? failure.budget : failure._tag),
          ["calls", "inputBytes"]
        )
        same([outcome.stored, calls.length], [2, 2], "nothing is recorded or sent past a budget")
      }))

    timed("a record that no longer decodes stops every operation on it, and sends nothing", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        yield* current.corruptRecord(staged.id)
        const failures = yield* session(current, wire, (outbox) =>
          Effect.all([
            Effect.flip(outbox.inspect(staged.id)),
            Effect.flip(outbox.commit(staged.id, bySupervisor)),
            Effect.flip(outbox.cancel(staged.id)),
            Effect.flip(outbox.stage(request("a"))),
            Effect.flip(outbox.pending),
            Effect.flip(outbox.flush)
          ])).pipe(Effect.result)
        // Either the kernel starts and refuses each operation, or it refuses to
        // start at all. Both are closed; neither reaches the wire.
        if (Result.isSuccess(failures)) {
          same(failures.success.map((failure) => failure._tag), [
            "OutboxStateCorrupt",
            "OutboxStateCorrupt",
            "OutboxStateCorrupt",
            "OutboxStateCorrupt",
            "OutboxStateCorrupt",
            "OutboxStateCorrupt"
          ])
        }
        same(calls.length, 0)
      }))

    timed("the Ledger converges to one entry per phase whichever write is lost", () =>
      Effect.gen(function* () {
        const expected = (a: EmissionId, b: EmissionId) =>
          [`cancel:${b}`, `commit:${a}`, `stage:${a}`, `stage:${b}`]

        /** One full history, a restart between every step, with one injected fault. */
        const history = (fault: { readonly ledgerCall?: number; readonly acknowledgeCall?: number }) =>
          Effect.gen(function* () {
            const current = yield* world
            const { calls, wire } = recordingWire()
            let ledgerCalls = 0
            let acknowledgeCalls = 0
            // The append is lost: the Ledger fails once, at the chosen call.
            const ledger = Layer.effect(
              Ledger,
              Effect.map(Ledger, (inner) =>
                Ledger.of({
                  entries: inner.entries,
                  record: (entry) =>
                    ledgerCalls++ === fault.ledgerCall
                      ? Effect.fail(new LedgerFailed({ operation: "record", cause: "Injected", reason: "lost append" }))
                      : inner.record(entry)
                }))
            ).pipe(Layer.provide(current.ledger))
            // The append lands but the process dies before it is marked.
            const store = Layer.effect(
              OutboxStore,
              Effect.map(OutboxStore, (inner) =>
                OutboxStore.of({
                  ...inner,
                  acknowledge: (id, phase) =>
                    acknowledgeCalls++ === fault.acknowledgeCall
                      ? Effect.die("process died after the Ledger append")
                      : inner.acknowledge(id, phase)
                }))
            ).pipe(Layer.provide(current.store))

            const step = <A, E>(body: (outbox: Outbox) => Effect.Effect<A, E>) =>
              session(current, wire, body, ledger, store).pipe(Effect.exit)
            yield* step((outbox) => outbox.stage(request("a")))
            yield* step((outbox) => Effect.flatMap(outbox.stage(request("a")), (a) => outbox.commit(a.id, bySupervisor)))
            yield* step((outbox) => outbox.stage(request("b", "bye", 60_000)))
            yield* step((outbox) => Effect.flatMap(outbox.stage(request("b", "bye", 60_000)), (b) => outbox.cancel(b.id)))

            // A healthy restart, and each emission is loaded once more.
            const [a, b, entries] = yield* session(current, wire, (outbox, _, healthy) =>
              Effect.all([
                outbox.stage(request("a")),
                outbox.stage(request("b", "bye", 60_000)),
                healthy.entries
              ]))
            const settled = yield* session(current, wire, (_, __, healthy) => healthy.entries)
            return { a, b, entries: acts(settled), early: acts(entries), calls: calls.length, ledgerCalls, acknowledgeCalls }
          })

        const clean = yield* history({})
        same([clean.a.state, clean.b.state], ["committed", "cancelled"])
        same([...clean.entries].sort(), expected(clean.a.id, clean.b.id))
        same(clean.calls, 1)
        holds(clean.ledgerCalls >= 4 && clean.acknowledgeCalls >= 4, "the history exercises every receipt")

        for (let call = 0; call < clean.ledgerCalls; call++) {
          const run = yield* history({ ledgerCall: call })
          same([...run.entries].sort(), expected(run.a.id, run.b.id), `Ledger append ${call} lost`)
          same([run.a.state, run.b.state, run.calls], ["committed", "cancelled", 1], `Ledger append ${call} lost`)
        }
        for (let call = 0; call < clean.acknowledgeCalls; call++) {
          const run = yield* history({ acknowledgeCall: call })
          same([...run.entries].sort(), expected(run.a.id, run.b.id), `mark ${call} lost`)
          same([run.a.state, run.b.state, run.calls], ["committed", "cancelled", 1], `mark ${call} lost`)
        }
      }), 120_000)

    timed("a substituted dispatch is refused before anything becomes irreversible", () =>
      Effect.gen(function* () {
        const current = yield* world
        const { calls, wire } = recordingWire()
        const staged = yield* session(current, wire, (outbox) => outbox.stage(request("a")))
        yield* current.tamperDispatch(staged.id)
        const failure = yield* session(current, wire, (outbox) =>
          Effect.flip(outbox.commit(staged.id, bySupervisor)))
        same(failure._tag, "OutboxStateCorrupt")
        const emission = yield* session(current, wire, (outbox) => outbox.inspect(staged.id))
        same(emission.state, "staged")
        same(calls.length, 0)
      }))
  })
}
