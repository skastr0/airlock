import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { canonicalJson } from "@skastr0/airlock"
import { Ledger, LedgerEntry } from "@skastr0/airlock"
import { CapturedEmission, type StoredCaptureResult } from "@skastr0/airlock"
import { IdempotencyKey } from "@skastr0/airlock"
import { OutboxStore } from "@skastr0/airlock"
import { digestOf, emissionId, instant } from "@skastr0/airlock/testing"
import { FileLedgerLive, ledgerLayer } from "../src/host/FileLedger.ts"
import * as FileOutboxStore from "../src/host/FileOutboxStore.ts"

/**
 * On this host a capture is one line of the ledger journal, and that line is
 * the capture. These are the crash cases the port cannot express: what a
 * reopened home answers when the write was cut short, and when everything
 * derived from the journal is lost or lies.
 */

const capture = (n: number) => {
  const record = new CapturedEmission({
    state: "captured", id: emissionId(n), key: IdempotencyKey.make(`capture-${n}`),
    kind: "probe", dispatchDigest: digestOf("a"), requestDigest: digestOf("b"), summary: { tool: "probe" },
    admission: {
      policyDigest: digestOf("c"), grantIds: ["read"],
      execution: { runId: "run", tool: "probe", version: "1", effect: "capture", when: "now", retention: "keep", resources: [] }
    },
    outcome: { state: "done", digest: digestOf("d") },
    completedAt: instant(n), ledgered: ["capture"]
  })
  const result: StoredCaptureResult = { digest: digestOf("d"), value: { kept: `value ${n}` }, response: new Uint8Array([0, 255, n]) }
  const receipt = new LedgerEntry({ at: record.completedAt, effect: "observation", act: "capture", ref: record.id, key: `${record.id}:capture` })
  return { record, result, receipt }
}

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly home: string
  readonly journal: string
  /** Each use opens the home again, as a new process would. */
  readonly open: <B, F>(use: (store: OutboxStore["Service"], ledger: Ledger["Service"]) => Effect.Effect<B, F>) => Effect.Effect<B, F>
}) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-capture-journal-" })
    const host = AirlockHome.layer(home).pipe(Layer.provideMerge(BunServices.layer))
    const layer = Layer.mergeAll(FileOutboxStore.layer, ledgerLayer).pipe(Layer.provide(FileLedgerLive), Layer.provide(host))
    return yield* body({
      fs, home, journal: path.join(home, "ledger.jsonl"),
      open: (use) => Effect.gen(function* () {
        return yield* use(yield* OutboxStore, yield* Ledger)
      }).pipe(Effect.provide(layer), Effect.orDie) as never
    })
  })).pipe(Effect.provide(BunServices.layer))

const answers = (store: OutboxStore["Service"], ledger: Ledger["Service"], id: ReturnType<typeof emissionId>) =>
  Effect.gen(function* () {
    return {
      record: Option.map(yield* store.read(id), (record) => record.state),
      result: Option.map(yield* store.readCapture(id), (result) => result.value),
      listed: (yield* store.list("captured")).map((record) => record.id).filter((listed) => listed === id),
      receipts: (yield* ledger.entries).filter((entry) => entry.ref === id).map((entry) => entry.key)
    }
  })

const whole = (id: string) => ({
  record: Option.some("captured"), result: Option.some({ kept: expect.any(String) }), listed: [id], receipts: [`${id}:capture`]
})
const nothing = { record: Option.none(), result: Option.none(), listed: [], receipts: [] }

describe("file host: a capture is one journal line", () => {
  it.effect("writes one line to the ledger journal and nothing anywhere else", () =>
    world(({ fs, home, journal, open }) => Effect.gen(function* () {
      const one = capture(1)
      yield* open((store) => store.putCapture(one.record, one.result, one.receipt))
      const lines = (yield* fs.readFileString(journal)).split("\n").filter((line) => line.length > 0)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toMatchObject({ act: "capture", ref: one.record.id, carried: { record: { state: "captured" } } })
      // No per-capture record exists beside the journal.
      expect(yield* fs.readDirectory(`${home}/outbox`)).toEqual([])
      expect(yield* open((store, ledger) => answers(store, ledger, one.record.id))).toEqual(whole(one.record.id))
    })))

  it.effect("a write cut short is nothing recorded, and the same key captures again", () =>
    world(({ fs, journal, open }) => Effect.gen(function* () {
      const [one, two] = [capture(1), capture(2)]
      yield* open((store) => store.putCapture(one.record, one.result, one.receipt))
      const complete = yield* fs.readFileString(journal)
      // The second capture's line, as a crash would leave it: half its bytes.
      yield* open((store) => store.putCapture(two.record, two.result, two.receipt))
      const both = yield* fs.readFileString(journal)
      const torn = both.slice(0, complete.length + Math.floor((both.length - complete.length) / 2))
      yield* fs.remove(`${journal}.keys`, { recursive: true })
      yield* fs.writeFileString(journal, torn)

      // The first open reports the cut and sets the fragment aside; it is not a record.
      yield* open((store) => store.read(two.record.id)).pipe(Effect.exit)
      expect(yield* fs.readFileString(journal)).toBe(complete)
      expect(yield* open((store, ledger) => answers(store, ledger, two.record.id))).toEqual(nothing)
      expect(yield* open((store, ledger) => answers(store, ledger, one.record.id))).toEqual(whole(one.record.id))

      expect((yield* open((store) => store.putCapture(two.record, two.result, two.receipt))).created).toBe(true)
      expect(yield* open((store, ledger) => answers(store, ledger, two.record.id))).toMatchObject({
        record: Option.some("captured"), receipts: [`${two.record.id}:capture`]
      })
    })))

  it.effect("a crash after the write and before anything derived loses nothing and records nothing twice", () =>
    world(({ fs, journal, open }) => Effect.gen(function* () {
      const one = capture(1)
      yield* open((store) => store.putCapture(one.record, one.result, one.receipt))
      // Everything derived from the journal is gone.
      yield* fs.remove(`${journal}.keys`, { recursive: true })
      expect(yield* open((store, ledger) => answers(store, ledger, one.record.id))).toEqual(whole(one.record.id))
      yield* fs.remove(`${journal}.keys`, { recursive: true })
      expect((yield* open((store) => store.putCapture(one.record, one.result, one.receipt))).created).toBe(false)
      expect((yield* fs.readFileString(journal)).split("\n").filter((line) => line.length > 0)).toHaveLength(1)
    })))

  it.effect("what is derived is never believed over the journal", () =>
    world(({ fs, journal, open }) => Effect.gen(function* () {
      const [one, two] = [capture(1), capture(2)]
      yield* open((store) => store.putCapture(one.record, one.result, one.receipt))
      yield* open((store) => store.putCapture(two.record, two.result, two.receipt))
      // Every locator now points at the other capture's line, or at nothing.
      const keys = `${journal}.keys`
      const markers = (yield* fs.readDirectory(keys)).filter((name) => name !== "scanned")
      const contents = yield* Effect.forEach(markers, (name) => fs.readFileString(`${keys}/${name}`))
      yield* fs.writeFileString(`${keys}/${markers[0]}`, contents[1]!)
      yield* fs.writeFileString(`${keys}/${markers[1]}`, "999999 12")
      for (const held of [one, two]) {
        const answer = yield* open((store, ledger) => answers(store, ledger, held.record.id))
        expect(answer.record).toEqual(Option.some("captured"))
        expect(answer.result).toEqual(Option.some(held.result.value))
        expect(answer.receipts).toEqual([`${held.record.id}:capture`])
      }
    })))

  it.effect("a kept result comes back as exactly the value it was, with the digest it had", () =>
    world(({ open }) => Effect.gen(function* () {
      // Every kind of value a text encoding is known to change or reorder.
      const value = {
        negativeZero: -0, inList: [-0, 0, [-0]], nested: { deep: { zero: -0 } },
        beyondSafe: 2 ** 53 + 2, huge: 1e21, tiny: 5e-324, largest: Number.MAX_VALUE, fraction: 0.1 + 0.2,
        astral: "\u{1f512}\u{10ffff}", loneSurrogate: "a\ud800b", controls: "\u0000\u001f\u2028\u2029\\\"",
        zebra: 1, alpha: 2, "10": "ten", "9": "nine", "": "empty key", empty: {}, none: [], nothing: null
      }
      // An own key with this name, as JSON text gives one (a literal would set the prototype).
      Object.defineProperty(value, "__proto__", { value: "own key", enumerable: true, writable: true, configurable: true })
      const base = capture(7)
      const held = { ...base, result: { digest: digestOf("d"), value: value as never } }
      yield* open((store) => store.putCapture(held.record, held.result, held.receipt))
      const back = Option.getOrThrow(yield* open((store) => store.readCapture(held.record.id))).value
      const same = (left: unknown, right: unknown): boolean =>
        typeof left === "object" && left !== null && typeof right === "object" && right !== null
          ? Array.isArray(left) === Array.isArray(right) &&
            JSON.stringify(Object.keys(left)) === JSON.stringify(Object.keys(right)) &&
            Object.keys(left).every((key) => same((left as never)[key], (right as never)[key]))
          : Object.is(left, right)
      expect(same(back, value)).toBe(true)
      expect(Object.is((back as typeof value).negativeZero, -0)).toBe(true)
      expect(Object.is((back as typeof value).inList[0], -0)).toBe(true)
      expect(Object.is((back as typeof value).inList[1], 0)).toBe(true)
      expect(Object.getOwnPropertyNames(back)).toContain("__proto__")
      expect(canonicalJson(back as never)).toBe(canonicalJson(value as never))
    })))

  it.effect("a line whose every byte landed except its terminator is a whole capture", () =>
    world(({ fs, journal, open }) => Effect.gen(function* () {
      const one = capture(1)
      yield* open((store) => store.putCapture(one.record, one.result, one.receipt))
      const complete = yield* fs.readFileString(journal)
      yield* fs.remove(`${journal}.keys`, { recursive: true })
      yield* fs.writeFileString(journal, complete.slice(0, -1))
      expect(yield* open((store, ledger) => answers(store, ledger, one.record.id))).toEqual(whole(one.record.id))
      expect(yield* fs.readFileString(journal)).toBe(complete)
    })))
})
