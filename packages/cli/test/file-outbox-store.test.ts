import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { canonicalExactJson } from "@skastr0/airlock"
import { OutboxStore } from "@skastr0/airlock"
import { DispatchProvenance, type EmissionId, ResponseCapture } from "@skastr0/airlock"
import { outboxStoreConformance } from "@skastr0/airlock/testing"
import { instant, sealedDispatch, stagedRecord } from "@skastr0/airlock/testing"
import { FileLedgerLive, ledgerLayer } from "../src/host/FileLedger.ts"
import * as FileOutboxStore from "../src/host/FileOutboxStore.ts"

/**
 * The file adapter earns its place under the kernel by passing the same
 * conformance suite as every other OutboxStore. Each world is one fresh
 * Airlock home; building the Layer again reopens the same directory.
 */
outboxStoreConformance(
  { describe, test: it.effect },
  "file",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-outbox-store-" })
    const outbox = path.join(home, "outbox")
    // One home: the store's captures are lines of this same ledger journal.
    const host = AirlockHome.layer(home).pipe(Layer.provideMerge(BunServices.layer))
    return {
      store: FileOutboxStore.layer.pipe(Layer.provide(FileLedgerLive), Layer.provide(host)),
      ledger: ledgerLayer.pipe(Layer.provide(FileLedgerLive), Layer.provide(host)),
      corruptRecord: (id: EmissionId) =>
        Effect.gen(function* () {
          const directory = (yield* fs.readDirectory(outbox)).find((entry) =>
            entry.startsWith(`${id}.`)
          )
          if (directory === undefined) return yield* Effect.die(`no state directory for ${id}`)
          const state = directory.slice(id.length + 1)
          yield* fs.writeFileString(
            path.join(outbox, directory, `record.${state}.json`),
            "{ not a record"
          )
        })
    }
  }).pipe(Effect.provide(BunServices.layer))
)

/**
 * A record is read back as the values it was written with. JSON text written
 * the ordinary way turns negative zero into zero, which is a different value
 * to an exact refinement and to a digest.
 */
describe("file OutboxStore: a record survives a restart as exactly the values it held", () => {
  const same = (left: unknown, right: unknown): boolean =>
    typeof left === "object" && left !== null && typeof right === "object" && right !== null
      ? Array.isArray(left) === Array.isArray(right) &&
        JSON.stringify(Object.keys(left)) === JSON.stringify(Object.keys(right)) &&
        Object.keys(left).every((key) => same((left as never)[key], (right as never)[key]))
      : Object.is(left, right)

  it.effect("stage, commit, reopen: every leaf of the summary and the outcome is the same value", () =>
    Effect.scoped(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-outbox-exact-" })
      const store = FileOutboxStore.layer.pipe(Layer.provide(FileLedgerLive), Layer.provide(AirlockHome.layer(home)))
      /** Each use opens the home again, as a new process would. */
      const open = <A, E>(use: (store: OutboxStore["Service"]) => Effect.Effect<A, E>) =>
        Effect.flatMap(OutboxStore, use).pipe(Effect.provide(store))

      const values = {
        negativeZero: -0, inList: [-0, 0, [-0]], nested: { zero: -0 },
        beyondSafe: 2 ** 53 + 2, huge: 1e21, tiny: 5e-324, fraction: 0.1 + 0.2,
        astral: "\u{1f512}", loneSurrogate: "a\ud800b", controls: "\u0000\u2028\"\\",
        zebra: 1, alpha: 2, "10": "ten", "9": "nine", empty: {}, none: [], nothing: null
      }
      const record = stagedRecord(7, { summary: values })
      yield* open((opened) => opened.putIfAbsent(record, sealedDispatch()))
      const staged = Option.getOrThrow(yield* open((opened) => opened.read(record.id)))
      expect(same(staged.summary, { summary: values })).toBe(true)

      yield* open((opened) => opened.transition(record.id, "staged", {
        state: "committing",
        provenance: new DispatchProvenance({ committedBy: "supervisor" }),
        committingAt: instant(10)
      }))
      const response = new Uint8Array([0, 255])
      yield* open((opened) => opened.transition(record.id, "committing", {
        state: "committed",
        outcome: { value: -0, all: values },
        capture: new ResponseCapture({ retainedBytes: response.byteLength, truncated: false, limitBytes: 65_536 }),
        completedAt: instant(20),
        response
      }))
      yield* open((opened) => opened.acknowledge(record.id, "commit"))

      const committed = Option.getOrThrow(yield* open((opened) => opened.read(record.id)))
      if (committed.state !== "committed") throw new Error("the emission did not commit")
      const outcome = committed.outcome as { readonly value: number; readonly all: typeof values }
      expect(Object.is(outcome.value, -0)).toBe(true)
      expect(Object.is(outcome.all.inList[0], -0)).toBe(true)
      expect(Object.is(outcome.all.inList[1], 0)).toBe(true)
      expect(same(outcome, { value: -0, all: values })).toBe(true)
      expect(same(committed.summary, { summary: values })).toBe(true)
      // The same value has the same exact canonical text, and so the same digest.
      expect(canonicalExactJson(outcome)).toBe(canonicalExactJson({ value: -0, all: values }))
      expect(canonicalExactJson(outcome)).not.toBe(canonicalExactJson({ value: 0, all: values }))
    })).pipe(Effect.provide(BunServices.layer)))
})

/**
 * Where this adapter keeps things, which the port does not say: a settled
 * emission leaves the outbox root, and nothing that asks for unsettled
 * emissions reads history.
 */
describe("file OutboxStore: settled emissions leave the scanned root", () => {
  const world = <A, E>(body: (paths: { readonly outbox: string; readonly settled: string }) => Effect.Effect<A, E, OutboxStore | FileSystem.FileSystem | Path.Path>) =>
    Effect.scoped(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-outbox-settled-" })
      const outbox = path.join(home, "outbox")
      return yield* body({ outbox, settled: path.join(outbox, "settled") }).pipe(
        Effect.provide(FileOutboxStore.layer.pipe(Layer.provide(FileLedgerLive), Layer.provide(AirlockHome.layer(home))))
      )
    })).pipe(Effect.provide(BunServices.layer))

  /** Stage, commit and write every receipt: the emission is then settled. */
  const settleOne = (n: number) =>
    Effect.gen(function* () {
      const store = yield* OutboxStore
      const record = stagedRecord(n)
      yield* store.putIfAbsent(record, sealedDispatch())
      yield* store.acknowledge(record.id, "stage")
      yield* store.transition(record.id, "staged", {
        state: "committing",
        provenance: new DispatchProvenance({ committedBy: "supervisor" }),
        committingAt: instant(10)
      })
      const response = new TextEncoder().encode("kept")
      yield* store.transition(record.id, "committing", {
        state: "committed",
        outcome: { ok: true },
        capture: new ResponseCapture({ retainedBytes: response.byteLength, truncated: false, limitBytes: 65_536 }),
        completedAt: instant(20),
        response
      })
      return record.id
    })

  it.effect("moves an emission out of the root once it is terminal and owes no receipt", () =>
    world(({ outbox, settled }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* OutboxStore
      const id = yield* settleOne(1)
      // Committed, but its commit receipt is still owed: it stays in the root.
      expect(yield* fs.exists(`${outbox}/${id}.committed`)).toBe(true)
      expect((yield* store.listOwing).map((record) => record.id)).toEqual([id])
      yield* store.acknowledge(id, "commit")
      expect(yield* fs.exists(`${outbox}/${id}.committed`)).toBe(false)
      expect(yield* fs.exists(`${settled}/${id}.committed`)).toBe(true)
      // Everything by id still answers from the settled location.
      expect(Option.map(yield* store.read(id), (record) => record.state)).toEqual(Option.some("committed"))
      expect((yield* store.readDispatch(id)).canonical).toBe(sealedDispatch().canonical)
      expect(Option.map(yield* store.readResponse(id), (bytes) => new TextDecoder().decode(bytes))).toEqual(Option.some("kept"))
      const replay = yield* store.putIfAbsent(stagedRecord(1), sealedDispatch())
      expect(replay).toMatchObject({ created: false, record: { state: "committed" } })
      expect(yield* store.listOwing).toEqual([])
      expect((yield* store.list("committed")).map((record) => record.id)).toEqual([id])
    })))

  it.effect("does not read history to answer for unsettled emissions", () =>
    world(({ settled }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* OutboxStore
      const open = stagedRecord(2)
      yield* store.putIfAbsent(open, sealedDispatch())
      // A settled directory whose record does not decode. Anything that read
      // history would fail on it.
      const broken = `${settled}/emi_${"f".repeat(32)}.committed`
      yield* fs.makeDirectory(broken, { recursive: true })
      yield* fs.writeFileString(`${broken}/record.committed.json`, "{ not a record")
      expect((yield* store.list("staged")).map((record) => record.id)).toEqual([open.id])
      expect(yield* store.list("committing")).toEqual([])
      expect((yield* store.listOwing).map((record) => record.id)).toEqual([open.id])
      expect(Option.isSome(yield* store.read(open.id))).toBe(true)
      // Asking for history does read it, and fails closed on the damage.
      const all = yield* store.list().pipe(Effect.flip)
      expect(all._tag).toBe("OutboxStateCorrupt")
    })))

  it.effect("moves a settled emission again if it is found back in the root", () =>
    world(({ outbox, settled }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* OutboxStore
      const id = yield* settleOne(3)
      yield* store.acknowledge(id, "commit")
      // The state a crash leaves when the move itself was lost.
      yield* fs.rename(`${settled}/${id}.committed`, `${outbox}/${id}.committed`)
      expect(yield* store.listOwing).toEqual([])
      expect(yield* fs.exists(`${outbox}/${id}.committed`)).toBe(false)
      expect(yield* fs.exists(`${settled}/${id}.committed`)).toBe(true)
    })))

  it.effect("fails closed when one id has a directory in the root and another settled", () =>
    world(({ outbox, settled }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* OutboxStore
      const id = yield* settleOne(4)
      yield* store.acknowledge(id, "commit")
      yield* fs.makeDirectory(`${outbox}/${id}.staged`)
      const read = yield* store.read(id).pipe(Effect.flip)
      expect(read).toMatchObject({ _tag: "OutboxStateCorrupt", reason: "more than one state directory" })
    })))
})
