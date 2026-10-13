import { Effect, type Layer, type Scope } from "effect"
import { Ledger, LedgerEntry } from "../ledger/Ledger.ts"
import { type Runner, same } from "./Check.ts"
import { instant } from "./Fixtures.ts"

/** One isolated ledger for one test. Building `ledger` again is a restart. */
export interface LedgerWorld {
  readonly ledger: Layer.Layer<Ledger, unknown>
}

const entry = (n: number) =>
  new LedgerEntry({
    at: instant(n),
    effect: "emission",
    act: "stage",
    ref: `ref-${n}`,
    ...(n % 2 === 0 ? { detail: `detail ${n}` } : {})
  })

const refs = (entries: ReadonlyArray<LedgerEntry>) => entries.map((found) => found.ref)

/** The invariants every Ledger adapter must hold. */
export const ledgerConformance = (
  { describe, test }: Runner,
  name: string,
  world: Effect.Effect<LedgerWorld, unknown, Scope.Scope>
): void => {
  const session = <A, E>(
    current: LedgerWorld,
    body: (ledger: Ledger["Service"]) => Effect.Effect<A, E>
  ) => Effect.flatMap(Ledger, body).pipe(Effect.provide(current.ledger))

  describe(`Ledger conformance: ${name}`, () => {
    test("starts empty", () =>
      Effect.gen(function* () {
        const current = yield* world
        same(yield* session(current, (ledger) => ledger.entries), [])
      }))

    test("keeps every recorded entry, in order, across a restart", () =>
      Effect.gen(function* () {
        const current = yield* world
        yield* session(current, (ledger) =>
          Effect.forEach([1, 2, 3], (n) => ledger.record(entry(n)), { discard: true }))
        yield* session(current, (ledger) => ledger.record(entry(4)))
        const entries = yield* session(current, (ledger) => ledger.entries)
        same(refs(entries), ["ref-1", "ref-2", "ref-3", "ref-4"])
        same(entries.map((found) => found.detail), [undefined, "detail 2", undefined, "detail 4"])
        same(entries.map((found) => found.at.toString()), [1, 2, 3, 4].map((n) => instant(n).toString()))
      }))

    test("records a keyed entry exactly once, however often it is recorded", () =>
      Effect.gen(function* () {
        const current = yield* world
        const keyed = (n: number, key: string) => new LedgerEntry({ ...entry(n), key })
        yield* session(current, (ledger) =>
          Effect.forEach(
            [keyed(1, "emi:stage"), keyed(1, "emi:stage"), entry(2), entry(2), keyed(3, "emi:commit")],
            (item) => ledger.record(item),
            { discard: true }
          ))
        // A writer that crashed before learning its append landed records again.
        yield* session(current, (ledger) =>
          Effect.all(
            Array.from({ length: 6 }, (_, index) =>
              ledger.record(keyed(index % 2 === 0 ? 1 : 3, index % 2 === 0 ? "emi:stage" : "emi:commit"))),
            { concurrency: "unbounded", discard: true }
          ))
        const entries = yield* session(current, (ledger) => ledger.entries)
        same(refs(entries), ["ref-1", "ref-2", "ref-2", "ref-3"])
        same(entries.map((found) => found.key), ["emi:stage", undefined, undefined, "emi:commit"])
      }))

    test("loses no entry under concurrent recording", () =>
      Effect.gen(function* () {
        const current = yield* world
        yield* session(current, (ledger) =>
          Effect.forEach(
            Array.from({ length: 24 }, (_, index) => index),
            (n) => ledger.record(entry(n)),
            { concurrency: "unbounded", discard: true }
          ))
        const entries = yield* session(current, (ledger) => ledger.entries)
        same(refs(entries).sort(), Array.from({ length: 24 }, (_, index) => `ref-${index}`).sort())
      }))
  })
}
