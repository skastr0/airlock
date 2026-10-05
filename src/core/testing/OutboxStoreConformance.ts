import { Effect, type Layer, Option, Ref, Result, type Scope } from "effect"
import { OutboxStore } from "../outbox/OutboxStore.ts"
import { DispatchProvenance, type EmissionId, ResponseCapture } from "../outbox/Records.ts"
import { holds, type Runner, same } from "./Check.ts"
import { emissionId, encoded, instant, sealedDispatch, stagedRecord } from "./Fixtures.ts"

/**
 * One isolated store for one test. `store` is a Layer over that state, and
 * building it again is a restart: every test that says "after a restart" does
 * exactly that.
 */
export interface OutboxStoreWorld {
  readonly store: Layer.Layer<OutboxStore, unknown>
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

  describe(`OutboxStore conformance: ${name}`, () => {
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
        const [read, listed, put, moved, marked] = yield* session(current, (store) =>
          Effect.all([
            Effect.flip(store.read(record.id)),
            Effect.flip(store.list()),
            Effect.flip(store.putIfAbsent(record, sealedDispatch())),
            Effect.flip(store.transition(record.id, "staged", committing)),
            Effect.flip(store.acknowledge(record.id, "stage"))
          ]))
        same([read._tag, listed._tag, put._tag, moved._tag, marked._tag], [
          "OutboxStateCorrupt",
          "OutboxStateCorrupt",
          "OutboxStateCorrupt",
          "OutboxStateCorrupt",
          "OutboxStateCorrupt"
        ])
      }))
  })
}
