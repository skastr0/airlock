import { canonicalExactJson, exactJsonText } from "../ExactJson.ts"
import { sha256Text } from "../Canonical.ts"
import * as WebCrypto from "../WebCrypto.ts"
import { Effect, type Layer, Option, Ref, Result, Schema, type Scope } from "effect"
import { Ledger, LedgerEntry } from "../ledger/Ledger.ts"
import { CapturedEmission, StoredCaptureResult } from "../outbox/Capture.ts"
import { OutboxStore } from "../outbox/OutboxStore.ts"
import { DispatchProvenance, type EmissionId, IdempotencyKey, ResponseCapture, SealedDispatch, StagedEmission } from "../outbox/Records.ts"
import { holds, type Runner, same } from "./Check.ts"
import { digestOf, emissionId, encoded, instant, sealedDispatch, stagedRecord } from "./Fixtures.ts"

/**
 * One isolated store for one test. `store` is a Layer over that state, and
 * building it again is a restart: every test that says "after a restart" does
 * exactly that.
 */
export interface OutboxStoreWorld {
  readonly store: Layer.Layer<OutboxStore, unknown>
  readonly ledger: Layer.Layer<Ledger, unknown>
  /**
   * Damages the stored record for `id` so that it no longer decodes, the way
   * a bad disk or a hostile writer would. Required: an adapter that cannot be
   * shown to fail closed does not conform.
   */
  readonly corruptRecord: (id: EmissionId) => Effect.Effect<void, unknown>
}

type Store = OutboxStore["Service"]

const provenance = new DispatchProvenance({ committedBy: "supervisor" })
const committing = { state: "committing", provenance, committingAt: instant(10) } as const
const committed = (response: Uint8Array) => ({
  state: "committed",
  outcome: { ok: true },
  capture: new ResponseCapture({
    retainedBytes: response.byteLength,
    truncated: false,
    limitBytes: 65_536
  }),
  completedAt: instant(20),
  response
} as const)

/**
 * The invariants every OutboxStore adapter must hold. Call it from a test file
 * with a world factory; an adapter that passes may be used under the kernel.
 */
export const outboxStoreConformance = (
  { describe, test }: Runner,
  name: string,
  world: Effect.Effect<OutboxStoreWorld, unknown, Scope.Scope>
): void => {
  /** Each call builds the Layer again, so two calls are separated by a restart. */
  const session = <A, E>(
    current: OutboxStoreWorld,
    body: (store: Store) => Effect.Effect<A, E>
  ) => Effect.flatMap(OutboxStore, body).pipe(Effect.provide(current.store))

  const capture = (n: number, retention: "digest" | "keep" = "digest", state: "done" | "failed" | "refused" = "done") => {
    const record = new CapturedEmission({ state: "captured", id: emissionId(n), key: IdempotencyKey.make(`capture-${n}`),
      kind: "probe", dispatchDigest: digestOf("a"), requestDigest: digestOf("b"), summary: { tool: "probe" },
      admission: { policyDigest: digestOf("c"), grantIds: ["read"], execution: { runId: "run", tool: "probe", version: "1",
        effect: "capture", when: "now", retention, resources: [] } },
      outcome: state === "done" ? { state, digest: digestOf("d") } : { state, code: "read-failed", message: "read did not complete" },
      completedAt: instant(n), ledgered: ["capture"] })
    const result: StoredCaptureResult | undefined = state !== "done" ? undefined : retention === "keep"
      ? { digest: digestOf("d"), value: { private: "capture-secret-canary" }, response: new Uint8Array([0, 255]) }
      : { digest: digestOf("d") }
    const receipt = new LedgerEntry({ at: record.completedAt, effect: "observation", act: "capture", ref: record.id, key: `${record.id}:capture` })
    return { record, result, receipt }
  }
  const entries = (current: OutboxStoreWorld) => Effect.flatMap(Ledger, (ledger) => ledger.entries).pipe(Effect.provide(current.ledger))

  describe(`OutboxStore conformance: ${name}`, () => {
    test("publishes a completed capture, kept result and one receipt atomically across restart", () => Effect.gen(function* () {
      const current = yield* world
      const held = capture(101, "keep")
      const put = yield* session(current, (store) => store.putCapture(held.record, held.result, held.receipt))
      same(put.created, true)
      const [record, result, pending, owing] = yield* session(current, (store) => Effect.all([
        store.read(held.record.id), store.readCapture(held.record.id), store.list("staged"), store.listOwing ]))
      same(Option.map(record, encoded), Option.some(encoded(held.record)))
      same(Option.map(result, (value) => Schema.encodeSync(StoredCaptureResult)(value)), Option.some(Schema.encodeSync(StoredCaptureResult)(held.result!)))
      same(pending, [])
      same(owing, [])
      same((yield* entries(current)).map((entry) => [entry.act, entry.ref, entry.key]), [["capture", held.record.id, `${held.record.id}:capture`]])
      holds(!JSON.stringify(put.record).includes("capture-secret-canary"), "public records exclude kept values")
      holds(!JSON.stringify(yield* entries(current)).includes("capture-secret-canary"), "ledger excludes kept values")
    }))

    test("kept replay preserves exact encoded leaves and the first result digest on every host", () => Effect.gen(function* () {
      const current = yield* world
      const value = { z: -0, list: [-0, 0, 2 ** 53 + 2, 1e21, 5e-324, Number.MAX_VALUE],
        text: "😀\ud800\u0000\u2028\u2029", nested: JSON.parse('{"__proto__":{"zero":-0},"constructor":"safe"}') as Schema.Json }
      const digest = yield* sha256Text(canonicalExactJson(value)).pipe(Effect.provide(WebCrypto.layer))
      const held = capture(108, "keep")
      const record = new CapturedEmission({ ...held.record, outcome: { state: "done", digest, metadata: { zero: -0 } } })
      yield* session(current, (store) => store.putCapture(record, { digest, value, response: new Uint8Array([0, 255]) }, held.receipt))
      const result = yield* session(current, (store) => store.readCapture(record.id))
      holds(Option.isSome(result) && result.value.value !== undefined, "kept result survives restart")
      if (Option.isNone(result) || result.value.value === undefined) return
      same(exactJsonText(result.value.value), exactJsonText(value), "every original leaf survives encoding exactly")
      holds(Object.is((result.value.value as Record<string, Schema.Json>)["z"], -0), "negative zero stays negative zero")
      same(yield* sha256Text(canonicalExactJson(result.value.value)).pipe(Effect.provide(WebCrypto.layer)), digest)
      const read = yield* session(current, (store) => store.read(record.id))
      holds(Option.isSome(read) && read.value.state === "captured", "capture survives restart")
      if (Option.isSome(read) && read.value.state === "captured" && read.value.outcome.state === "done") {
        holds(Object.is((read.value.outcome.metadata as Record<string, Schema.Json>)["zero"], -0), "public metadata is exact too")
      }
    }))

    test("full-lifecycle records and sealed inputs preserve every exact JSON leaf across restarts", () => Effect.gen(function* () {
      const current = yield* world
      const value: Schema.Json = { zero: -0, list: [-0, 0, 2 ** 53 + 2, 1e21, 5e-324, Number.MAX_VALUE, 0.1 + 0.2],
        text: "😀\ud800\u0000\u2028\u2029\"\\", empty: {}, absent: null,
        nested: JSON.parse('{"__proto__":{"zero":-0},"constructor":"safe"}') as Schema.Json }
      const canonical = canonicalExactJson(value)
      const digest = yield* sha256Text(canonical).pipe(Effect.provide(WebCrypto.layer))
      const record = new StagedEmission({ ...stagedRecord(109, value), dispatchDigest: digest })
      yield* session(current, (store) => store.putIfAbsent(record, new SealedDispatch({ canonical, digest })))
      yield* session(current, (store) => store.transition(record.id, "staged", committing))
      yield* session(current, (store) => store.transition(record.id, "committing", { ...committed(new Uint8Array()), outcome: value }))
      const restored = yield* session(current, (store) => store.read(record.id))
      holds(Option.isSome(restored) && restored.value.state === "committed", "committed record survives restart")
      if (Option.isNone(restored) || restored.value.state !== "committed") return
      const assertLeaves = (actual: Schema.Json, expected: Schema.Json): void => {
        if (expected === null || typeof expected !== "object") {
          holds(Object.is(actual, expected), "each stored leaf preserves its exact value")
          return
        }
        holds(actual !== null && typeof actual === "object", "stored composite preserves its shape")
        same(Object.keys(actual!), Object.keys(expected), "stored keys keep their order")
        for (const key of Object.keys(expected)) assertLeaves((actual as Schema.JsonObject)[key]!, (expected as Schema.JsonObject)[key]!)
      }
      assertLeaves(restored.value.summary, value)
      assertLeaves(restored.value.outcome, value)
      same(yield* sha256Text(canonicalExactJson(restored.value.outcome)).pipe(Effect.provide(WebCrypto.layer)), digest)
      const sealed = yield* session(current, (store) => store.readDispatch(record.id))
      same(sealed.canonical, canonical)
      same(sealed.digest, digest)
      assertLeaves(JSON.parse(sealed.canonical) as Schema.Json, JSON.parse(canonical) as Schema.Json)
    }))

    test("captures one key once under racing publication and never replaces its private result", () => Effect.gen(function* () {
      const current = yield* world
      const held = capture(102, "keep")
      const puts = yield* session(current, (store) => Effect.all(Array.from({ length: 16 }, () =>
        store.putCapture(held.record, held.result, held.receipt)), { concurrency: "unbounded" }))
      same(puts.filter((put) => put.created).length, 1)
      const changed = { ...held.result!, value: { private: "replacement" } }
      same((yield* session(current, (store) => store.putCapture(held.record, changed, held.receipt))).created, false)
      same((yield* entries(current)).length, 1)
      const result = yield* session(current, (store) => store.readCapture(held.record.id))
      same(Option.map(result, (value) => value.value), Option.some(held.result!.value))
    }))

    test("digest retention stores no private result bytes and failed reads still have one capture receipt", () => Effect.gen(function* () {
      const current = yield* world
      for (const [n, state] of [[103, "done"], [104, "failed"], [105, "refused"]] as const) {
        const held = capture(n, "digest", state)
        yield* session(current, (store) => store.putCapture(held.record, held.result, held.receipt))
        const result = yield* session(current, (store) => store.readCapture(held.record.id))
        if (state === "done") same(Option.map(result, (value) => Object.keys(value)), Option.some(["digest"]))
        else holds(Option.isNone(result), "failed reads keep no result")
      }
      same((yield* entries(current)).map((entry) => entry.act), ["capture", "capture", "capture"])
    }))

    test("rejects invalid capture authority, retention and excessive bytes without partial publication", () => Effect.gen(function* () {
      const current = yield* world
      const held = capture(106)
      for (const bad of [
        { ...held, record: new CapturedEmission({ ...held.record, kind: "different-tool" }) },
        { ...held, result: { digest: digestOf("d"), value: "forbidden-digest-bytes" } },
        { ...held, result: { digest: digestOf("a") } },
        { ...capture(106, "keep"), result: { digest: digestOf("d"), value: "x".repeat(65536) } },
        { ...capture(106, "keep"), result: { digest: digestOf("d"), value: true, response: new Uint8Array(65537) } },
        { ...held, receipt: new LedgerEntry({ ...held.receipt, act: "commit" }) }
      ]) {
        holds(Result.isFailure(yield* session(current, (store) => store.putCapture(bad.record, bad.result, bad.receipt).pipe(Effect.result))), "invalid publication refuses")
        holds(Option.isNone(yield* session(current, (store) => store.read(held.record.id))), "invalid capture publishes no record")
        holds(Option.isNone(yield* session(current, (store) => store.readCapture(held.record.id))), "invalid capture publishes no payload")
        same(yield* entries(current), [])
      }
    }))

    test("a captured record cannot transition or collide into a staged act", () => Effect.gen(function* () {
      const current = yield* world
      const held = capture(107)
      yield* session(current, (store) => store.putCapture(held.record, held.result, held.receipt))
      const conflict = yield* session(current, (store) => store.transition(held.record.id, "staged", committing).pipe(Effect.flip))
      same(conflict._tag, "TransitionConflict")
      same((yield* session(current, (store) => store.putIfAbsent(stagedRecord(107), sealedDispatch()))).record.state, "captured")
      same((yield* entries(current)).length, 1)
    }))

    test("stores a staged emission durably and returns it unchanged", () =>
      Effect.gen(function* () {
        const current = yield* world
        const record = stagedRecord(1)
        const put = yield* session(current, (store) => store.putIfAbsent(record, sealedDispatch()))
        same(put.created, true)
        same(encoded(put.record), encoded(record))

        const [read, dispatch, unknown] = yield* session(current, (store) =>
          Effect.all([
            store.read(record.id),
            store.readDispatch(record.id),
            store.read(emissionId(999))
          ]))
        same(Option.map(read, encoded), Option.some(encoded(record)))
        same(dispatch.canonical, sealedDispatch().canonical)
        same(dispatch.digest, sealedDispatch().digest)
        holds(Option.isNone(unknown), "nothing is stored")
      }))

    test("never replaces an existing emission or its sealed dispatch", () =>
      Effect.gen(function* () {
        const current = yield* world
        const original = stagedRecord(1, { first: true })
        yield* session(current, (store) => store.putIfAbsent(original, sealedDispatch("{\"first\":true}")))
        const again = yield* session(current, (store) =>
          store.putIfAbsent(stagedRecord(1, { second: true }), sealedDispatch("{\"second\":true}")))
        same(again.created, false)
        same(encoded(again.record), encoded(original))

        yield* session(current, (store) => store.transition(original.id, "staged", committing))
        const afterMove = yield* session(current, (store) =>
          Effect.all([
            store.putIfAbsent(stagedRecord(1, { third: true }), sealedDispatch("{\"third\":true}")),
            store.readDispatch(original.id)
          ]))
        same(afterMove[0].created, false)
        same(afterMove[0].record.state, "committing")
        same(afterMove[1].canonical, "{\"first\":true}")
      }))

    test("reports an unknown emission rather than inventing one", () =>
      Effect.gen(function* () {
        const current = yield* world
        const [dispatch, moved, response] = yield* session(current, (store) =>
          Effect.all([
            Effect.flip(store.readDispatch(emissionId(7))),
            Effect.flip(store.transition(emissionId(7), "staged", committing)),
            store.readResponse(emissionId(7))
          ]))
        same(dispatch._tag, "UnknownEmission")
        same(moved._tag, "UnknownEmission")
        holds(Option.isNone(response), "nothing is stored")
      }))

    test("moves an emission only from the state the caller named", () =>
      Effect.gen(function* () {
        const current = yield* world
        const record = stagedRecord(1)
        yield* session(current, (store) => store.putIfAbsent(record, sealedDispatch()))
        const moved = yield* session(current, (store) => store.transition(record.id, "staged", committing))
        same(moved.state, "committing")
        same(moved.provenance.committedBy, "supervisor")

        const stale = yield* session(current, (store) =>
          Effect.flip(store.transition(record.id, "staged", { state: "cancelled", cancelledAt: instant(11) })))
        same(
          stale._tag === "TransitionConflict" ? [stale.expected, stale.actual] : stale._tag,
          ["staged", "committing"]
        )
        const still = yield* session(current, (store) => store.read(record.id))
        same(Option.map(still, (found) => found.state), Option.some("committing"))
      }))

    test("lets exactly one of many racing transitions win", () =>
      Effect.gen(function* () {
        const current = yield* world
        const record = stagedRecord(1)
        yield* session(current, (store) => store.putIfAbsent(record, sealedDispatch()))
        const results = yield* session(current, (store) =>
          Effect.all(
            Array.from({ length: 16 }, (_, index) =>
              Effect.result(
                index % 2 === 0
                  ? Effect.map(store.transition(record.id, "staged", committing), (won) => won.state)
                  : Effect.map(
                      store.transition(record.id, "staged", { state: "cancelled", cancelledAt: instant(11) }),
                      (won) => won.state
                    )
              )),
            { concurrency: "unbounded" }
          ))
        const winners = results.filter(Result.isSuccess)
        same(winners.length, 1)
        for (const result of results) {
          if (Result.isFailure(result)) same(result.failure._tag, "TransitionConflict")
        }
        const settled = yield* session(current, (store) => store.read(record.id))
        same(Option.map(settled, (found) => found.state), 
          Option.fromNullishOr(winners[0]?.success)
        )
      }))

    test("stores the response with the commit and never before it", () =>
      Effect.gen(function* () {
        const current = yield* world
        const record = stagedRecord(1)
        const bytes = new Uint8Array([1, 2, 3, 250])
        yield* session(current, (store) => store.putIfAbsent(record, sealedDispatch()))
        yield* session(current, (store) => store.transition(record.id, "staged", committing))
        holds(Option.isNone(yield* session(current, (store) => store.readResponse(record.id))), "nothing is stored")

        const done = yield* session(current, (store) =>
          store.transition(record.id, "committing", committed(bytes)))
        same(done.state, "committed")
        same(done.outcome, { ok: true })
        same(done.capture.retainedBytes, 4)
        holds(!("response" in done), "a record never carries response bytes")

        const response = yield* session(current, (store) => store.readResponse(record.id))
        same(Option.map(response, (found) => [...found]), Option.some([1, 2, 3, 250]))
      }))

    test("keeps terminal states where they are", () =>
      Effect.gen(function* () {
        const current = yield* world
        yield* session(current, (store) =>
          Effect.gen(function* () {
            for (const n of [1, 2, 3]) yield* store.putIfAbsent(stagedRecord(n), sealedDispatch())
            yield* store.transition(emissionId(1), "staged", { state: "cancelled", cancelledAt: instant(11) })
            yield* store.transition(emissionId(2), "staged", committing)
            yield* store.transition(emissionId(2), "committing", committed(new Uint8Array(0)))
            yield* store.transition(emissionId(3), "staged", committing)
            yield* store.transition(emissionId(3), "committing", {
              state: "uncertain",
              reason: "dispatch-failed",
              uncertainAt: instant(12)
            })
            yield* store.putIfAbsent(stagedRecord(4), sealedDispatch())
            yield* store.transition(emissionId(4), "staged", committing)
            const refused = yield* store.transition(emissionId(4), "committing", {
              state: "refused",
              reason: "not configured",
              refusedAt: instant(12)
            })
            same([refused.state, refused.reason], ["refused", "not configured"])
          }))
        const attempts = yield* session(current, (store) =>
          Effect.all([
            Effect.flip(store.transition(emissionId(1), "staged", committing)),
            Effect.flip(store.transition(emissionId(2), "committing", {
              state: "uncertain",
              reason: "dispatch-failed",
              uncertainAt: instant(13)
            })),
            Effect.flip(store.transition(emissionId(3), "committing", committed(new Uint8Array([9])))),
            Effect.flip(store.transition(emissionId(3), "staged", committing)),
            Effect.flip(store.transition(emissionId(4), "committing", committed(new Uint8Array([9])))),
            Effect.flip(store.transition(emissionId(4), "staged", committing))
          ]))
        same(attempts.map((attempt) => attempt._tag), [
          "TransitionConflict",
          "TransitionConflict",
          "TransitionConflict",
          "TransitionConflict",
          "TransitionConflict",
          "TransitionConflict"
        ])
        // The refused commit of the uncertain emission must not have left a blob behind.
        const stray = yield* session(current, (store) => store.readResponse(emissionId(3)))
        holds(Option.isNone(stray), "nothing is stored")
      }))

    test("marks a ledgered phase without changing state, once", () =>
      Effect.gen(function* () {
        const current = yield* world
        const record = stagedRecord(1)
        yield* session(current, (store) => store.putIfAbsent(record, sealedDispatch()))
        const marked = yield* session(current, (store) => store.acknowledge(record.id, "stage"))
        same([marked.state, marked.ledgered], ["staged", ["stage"]])
        yield* session(current, (store) => store.acknowledge(record.id, "stage"))
        const moved = yield* session(current, (store) => store.transition(record.id, "staged", committing))
        same(moved.ledgered, ["stage"], "a transition keeps what was already ledgered")
        const unknown = yield* session(current, (store) => Effect.flip(store.acknowledge(emissionId(9), "stage")))
        same(unknown._tag, "UnknownEmission")
        const reread = yield* session(current, (store) => store.read(record.id))
        same(Option.map(reread, (found) => found.ledgered), Option.some(["stage"]))
      }))

    test("lists exactly the emissions that still owe the Ledger a receipt", () =>
      Effect.gen(function* () {
        const current = yield* world
        const owing = (store: Store) =>
          Effect.map(store.listOwing, (records) => records.map((record) => record.id).sort())
        yield* session(current, (store) =>
          Effect.gen(function* () {
            for (const n of [1, 2, 3]) yield* store.putIfAbsent(stagedRecord(n), sealedDispatch())
            same(yield* owing(store), [emissionId(1), emissionId(2), emissionId(3)], "a stored emission owes its stage receipt")
            yield* store.acknowledge(emissionId(1), "stage")
            yield* store.acknowledge(emissionId(2), "stage")
            same(yield* owing(store), [emissionId(3)])
            // Settling owes one more receipt; an uncertain emission owes none.
            yield* store.transition(emissionId(1), "staged", committing)
            same(yield* owing(store), [emissionId(3)], "committing owes nothing new")
            yield* store.transition(emissionId(1), "committing", committed(new Uint8Array(0)))
            yield* store.transition(emissionId(2), "staged", { state: "cancelled", cancelledAt: instant(11) })
            same(yield* owing(store), [emissionId(1), emissionId(2), emissionId(3)])
          }))
        // After a restart, and as each receipt is marked, the list drains to nothing.
        yield* session(current, (store) =>
          Effect.gen(function* () {
            same(yield* owing(store), [emissionId(1), emissionId(2), emissionId(3)])
            yield* store.acknowledge(emissionId(1), "commit")
            yield* store.acknowledge(emissionId(2), "cancel")
            yield* store.acknowledge(emissionId(3), "stage")
            same(yield* owing(store), [])
            same((yield* store.list()).length, 3, "settled history is still there")
          }))
      }))

    test("lists by state", () =>
      Effect.gen(function* () {
        const current = yield* world
        yield* session(current, (store) =>
          Effect.gen(function* () {
            for (const n of [1, 2, 3]) yield* store.putIfAbsent(stagedRecord(n), sealedDispatch())
            yield* store.transition(emissionId(2), "staged", committing)
          }))
        const [all, staged, inFlight, done] = yield* session(current, (store) =>
          Effect.all([store.list(), store.list("staged"), store.list("committing"), store.list("committed")]))
        same(all.map((record) => record.id).sort(), [emissionId(1), emissionId(2), emissionId(3)])
        same(staged.map((record) => record.id).sort(), [emissionId(1), emissionId(3)])
        same(inFlight.map((record) => record.id), [emissionId(2)])
        same(done, [])
      }))

    test("runs exclusive sections one at a time", () =>
      Effect.gen(function* () {
        const current = yield* world
        const overlap = yield* session(current, (store) =>
          Effect.gen(function* () {
            const inside = yield* Ref.make(0)
            const worst = yield* Ref.make(0)
            const section = store.exclusive(
              Effect.gen(function* () {
                const now = yield* Ref.updateAndGet(inside, (count) => count + 1)
                yield* Ref.update(worst, (seen) => Math.max(seen, now))
                yield* Effect.yieldNow
                yield* Effect.yieldNow
                yield* Ref.update(inside, (count) => count - 1)
              })
            )
            yield* Effect.all(Array.from({ length: 8 }, () => section), { concurrency: "unbounded" })
            return yield* Ref.get(worst)
          }))
        same(overlap, 1)
      }))

    test("fails closed on a record that no longer decodes", () =>
      Effect.gen(function* () {
        const current = yield* world
        const record = stagedRecord(1)
        yield* session(current, (store) => store.putIfAbsent(record, sealedDispatch()))
        yield* current.corruptRecord(record.id)
        const [read, listed, put, moved, marked, owed] = yield* session(current, (store) =>
          Effect.all([
            Effect.flip(store.read(record.id)),
            Effect.flip(store.list()),
            Effect.flip(store.putIfAbsent(record, sealedDispatch())),
            Effect.flip(store.transition(record.id, "staged", committing)),
            Effect.flip(store.acknowledge(record.id, "stage")),
            Effect.flip(store.listOwing)
          ]))
        same([read._tag, listed._tag, put._tag, moved._tag, marked._tag, owed._tag], [
          "OutboxStateCorrupt",
          "OutboxStateCorrupt",
          "OutboxStateCorrupt",
          "OutboxStateCorrupt",
          "OutboxStateCorrupt",
          "OutboxStateCorrupt"
        ])
      }))
  })
}
