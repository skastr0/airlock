import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { OutboxStore } from "../src/core/outbox/OutboxStore.ts"
import { DispatchProvenance, type EmissionId, ResponseCapture } from "../src/core/outbox/Records.ts"
import { outboxStoreConformance } from "../src/core/testing/index.ts"
import { instant, sealedDispatch, stagedRecord } from "../src/core/testing/Fixtures.ts"
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
    return {
      store: FileOutboxStore.layer.pipe(
        Layer.provide(AirlockHome.layer(home)),
        Layer.provide(BunServices.layer)
      ),
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
        Effect.provide(FileOutboxStore.layer.pipe(Layer.provide(AirlockHome.layer(home))))
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
