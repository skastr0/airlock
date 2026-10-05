import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer, Path } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { LedgerEntry } from "../src/core/ledger/Ledger.ts"
import { ledgerConformance } from "../src/core/testing/index.ts"
import { FileLedger, FileLedgerLive, ledgerLayer } from "../src/host/FileLedger.ts"

/** The fsynced JSONL ledger, seen through the core port, passes the core suite. */
ledgerConformance(
  { describe, test: it.effect },
  "file",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-file-ledger-" })
    return {
      ledger: ledgerLayer.pipe(
        Layer.provide(FileLedgerLive),
        Layer.provide(AirlockHome.layer(home)),
        Layer.provide(BunServices.layer)
      )
    }
  }).pipe(Effect.provide(BunServices.layer))
)

/**
 * How this adapter knows a key was already recorded without reading the
 * journal: a marker per key, and the journal length the markers cover.
 */
describe("file Ledger: replay check does not read the whole journal", () => {
  const entry = (key: string | undefined, ref = "emi_test") =>
    new LedgerEntry({
      at: DateTime.makeUnsafe(0),
      effect: "emission",
      act: "stage",
      ref,
      ...(key === undefined ? {} : { key })
    })

  const world = <A, E>(body: (paths: {
    readonly home: string
    readonly journal: string
    readonly keys: string
    /** A fresh ledger over the same home, as a new process would build. */
    readonly open: Effect.Effect<FileLedger["Service"], never, FileSystem.FileSystem | Path.Path>
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    Effect.scoped(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "airlock-ledger-keys-" })
      const journal = path.join(home, "ledger.jsonl")
      const open = Effect.provide(FileLedger, FileLedgerLive.pipe(Layer.provide(AirlockHome.layer(home)))).pipe(Effect.orDie)
      return yield* body({ home, journal, keys: `${journal}.keys`, open })
    })).pipe(Effect.provide(BunServices.layer))

  const keyedLines = (text: string, key: string) =>
    text.split("\n").filter((line) => line.includes(`"key":"${key}"`)).length

  it.effect("writes no key directory until a keyed entry is recorded", () =>
    world(({ keys, open }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const ledger = yield* open
      yield* ledger.record(entry(undefined))
      expect(yield* fs.exists(keys)).toBe(false)
      yield* ledger.record(entry("k:1"))
      expect((yield* fs.readDirectory(keys)).length).toBe(1)
    })))

  it.effect("a new process refuses a replay from the marker, with the journal unreadable as history", () =>
    world(({ journal, open }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* (yield* open).record(entry("k:1"))
      const before = yield* fs.readFileString(journal)
      // Replace everything already written with a line that carries no key.
      // A replay check that read the journal would now record k:1 again.
      yield* fs.writeFileString(journal, `${" ".repeat(before.length - 1)}\n`)
      yield* (yield* open).record(entry("k:1"))
      expect(keyedLines(yield* fs.readFileString(journal), "k:1")).toBe(0)
    })))

  it.effect("a lost marker is recovered from the journal past the covered length", () =>
    world(({ journal, keys, open }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* (yield* open).record(entry("k:1"))
      // The state a crash leaves: the entry is durable, its marker is not.
      yield* fs.rename(keys, path.join(path.dirname(keys), "markers-lost"))
      yield* (yield* open).record(entry("k:1"))
      yield* (yield* open).record(entry("k:2"))
      const text = yield* fs.readFileString(journal)
      expect(keyedLines(text, "k:1")).toBe(1)
      expect(keyedLines(text, "k:2")).toBe(1)
    })))

  it.effect("moves the covered length forward only with every key in it marked", () =>
    world(({ journal, keys, open }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const ledger = yield* open
      const detail = "x".repeat(1024)
      for (let n = 0; n < 80; n++) {
        yield* ledger.record(new LedgerEntry({ ...entry(`bulk:${n}`), detail }))
      }
      const scanned = Number(yield* fs.readFileString(path.join(keys, "scanned")))
      expect(scanned).toBeGreaterThan(64 * 1024)
      expect(scanned).toBeLessThanOrEqual((yield* fs.stat(journal)).size as unknown as number)
      // Every key replays as recorded in a new process.
      const reopened = yield* open
      for (let n = 0; n < 80; n++) yield* reopened.record(new LedgerEntry({ ...entry(`bulk:${n}`), detail }))
      expect((yield* reopened.entries).length).toBe(80)
    })))

  it.effect("sets stale markers aside when the journal is shorter than they cover", () =>
    world(({ home, journal, keys, open }) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* (yield* open).record(entry("k:1"))
      yield* fs.writeFileString(path.join(keys, "scanned"), "1000000")
      yield* (yield* open).record(entry("k:2"))
      expect(keyedLines(yield* fs.readFileString(journal), "k:2")).toBe(1)
      expect((yield* fs.readDirectory(home)).some((name) => name.startsWith("ledger.jsonl.keys.stale-"))).toBe(true)
    })))
})
