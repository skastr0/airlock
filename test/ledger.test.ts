import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Ledger, LedgerDecodeError, LedgerLive } from "../src/Ledger.ts"
import { LedgerEntry } from "../src/domain.ts"

const layerFor = (home: string) =>
  LedgerLive.pipe(
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )

const world = <A, E>(
  body: (context: {
    readonly ledger: typeof Ledger.Service
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
    readonly home: string
  }) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmp = yield* fs.makeTempDirectoryScoped()
      const home = path.join(tmp, "airlock-home")
      const ledger = yield* Effect.provide(Ledger, layerFor(home))
      return yield* body({ ledger, fs, path, home })
    })
  ).pipe(Effect.provide(BunContext.layer))

const receipt = (ref: string) =>
  Effect.map(DateTime.now, (at) =>
    new LedgerEntry({
      at,
      effect: "mutation",
      act: "overwrite",
      ref
    })
  )

describe("Ledger — append-only receipts", () => {
  it.effect("a missing journal is an empty, valid history", () =>
    world(({ ledger }) =>
      Effect.gen(function* () {
        expect(yield* ledger.entries).toEqual([])
      })
    )
  )

  it.effect("records and reads schema-validated receipts", () =>
    world(({ ledger }) =>
      Effect.gen(function* () {
        yield* ledger.record(yield* receipt("first"))
        yield* ledger.record(yield* receipt("second"))
        expect((yield* ledger.entries).map((entry) => entry.ref)).toEqual([
          "first",
          "second"
        ])
      })
    )
  )

  it.effect("serializes concurrent appends in one runtime", () =>
    world(({ ledger }) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 32 }, (_, index) => `receipt-${index}`),
          (ref) =>
            receipt(ref).pipe(Effect.flatMap((entry) => ledger.record(entry))),
          { concurrency: "unbounded", discard: true }
        )
        expect(yield* ledger.entries).toHaveLength(32)
      })
    )
  )

  it.effect("rejects malformed persisted history with a typed line receipt", () =>
    world(({ fs, home, ledger, path }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(home, "ledger.jsonl"), "not-json\n")
        const error = yield* ledger.entries.pipe(Effect.flip)
        expect(error).toBeInstanceOf(LedgerDecodeError)
        expect(error._tag).toBe("LedgerDecodeError")
        if (error._tag === "LedgerDecodeError") {
          expect(error.line).toBe(1)
        }
      })
    )
  )
})

describe("AirlockHome — typed lifecycle", () => {
  it.effect("creates the persisted layout once and publishes absolute paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tmp = yield* fs.makeTempDirectoryScoped()
        const home = yield* Effect.provide(
          Effect.gen(function* () {
            return yield* AirlockHome.AirlockHome
          }),
          AirlockHome.layer(path.join(tmp, "realm"))
        )
        expect(home.home.startsWith("/")).toBe(true)
        expect(yield* fs.exists(home.holdDir)).toBe(true)
        expect(yield* fs.exists(home.outboxDir)).toBe(true)
      })
    ).pipe(Effect.provide(BunContext.layer))
  )
})
