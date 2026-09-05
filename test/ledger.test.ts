import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Schema } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AirlockHome from "../src/AirlockHome.ts"
import {
  Ledger,
  LedgerDecodeError,
  LedgerLive,
  LedgerQuarantineEvidence,
  LedgerTailQuarantined
} from "../src/Ledger.ts"
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

const encodeReceipt = Schema.encode(Schema.parseJson(LedgerEntry))
const decodeQuarantine = Schema.decode(
  Schema.parseJson(LedgerQuarantineEvidence)
)

const encodedReceipt = (ref: string) =>
  receipt(ref).pipe(Effect.flatMap(encodeReceipt))

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const waitForFile = async (file: string, timeoutMillis = 5_000) => {
  const deadline = Date.now() + timeoutMillis
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${file}`)
    }
    await delay(10)
  }
}

const childResult = (child: ChildProcess) => {
  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })
  return new Promise<Readonly<{ code: number; stderr: string }>>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve({ code: code ?? -1, stderr }))
    }
  )
}

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

  it.effect("recovers a schema-valid final record whose newline was torn", () =>
    world(({ fs, home, ledger, path }) =>
      Effect.gen(function* () {
        const first = yield* encodedReceipt("first")
        const recovered = yield* encodedReceipt("recovered")
        const ledgerFile = path.join(home, "ledger.jsonl")
        yield* fs.writeFileString(ledgerFile, `${first}\n${recovered}`)

        expect((yield* ledger.entries).map((entry) => entry.ref)).toEqual([
          "first",
          "recovered"
        ])
        expect(yield* fs.readFileString(ledgerFile)).toBe(
          `${first}\n${recovered}\n`
        )
      })
    )
  )

  it.effect("quarantines an invalid final fragment before repairing history", () =>
    world(({ fs, home, ledger, path }) =>
      Effect.gen(function* () {
        const first = yield* encodedReceipt("first")
        const fragment = '{"at":"torn'
        const ledgerFile = path.join(home, "ledger.jsonl")
        yield* fs.writeFileString(ledgerFile, `${first}\n${fragment}`)

        const error = yield* ledger.entries.pipe(Effect.flip)
        expect(error).toBeInstanceOf(LedgerTailQuarantined)
        expect(error._tag).toBe("LedgerTailQuarantined")
        if (error._tag !== "LedgerTailQuarantined") return

        expect(error.line).toBe(2)
        expect(error.offset).toBe(Buffer.byteLength(`${first}\n`))
        expect(error.bytes).toBe(Buffer.byteLength(fragment))
        expect(yield* fs.readFileString(ledgerFile)).toBe(`${first}\n`)

        const evidence = yield* fs.readFileString(error.quarantinePath).pipe(
          Effect.flatMap(decodeQuarantine)
        )
        expect(evidence).toMatchObject({
          schemaVersion: "airlock/ledger-quarantine/v1",
          path: ledgerFile,
          line: 2,
          offset: error.offset,
          bytes: error.bytes,
          sha256: error.sha256
        })
        expect(Buffer.from(evidence.rawBase64, "base64").toString("utf8")).toBe(
          fragment
        )

        expect((yield* ledger.entries).map((entry) => entry.ref)).toEqual([
          "first"
        ])
      })
    )
  )

  it.effect("does not rewrite or skip corruption in a complete middle record", () =>
    world(({ fs, home, ledger, path }) =>
      Effect.gen(function* () {
        const first = yield* encodedReceipt("first")
        const last = yield* encodedReceipt("last")
        const ledgerFile = path.join(home, "ledger.jsonl")
        const corrupt = `${first}\nnot-json\n${last}\n`
        yield* fs.writeFileString(ledgerFile, corrupt)

        const error = yield* ledger.entries.pipe(Effect.flip)
        expect(error).toBeInstanceOf(LedgerDecodeError)
        expect(error._tag).toBe("LedgerDecodeError")
        if (error._tag === "LedgerDecodeError") {
          expect(error.line).toBe(2)
        }
        expect(yield* fs.readFileString(ledgerFile)).toBe(corrupt)
        expect(
          (yield* fs.readDirectory(home)).filter((name) =>
            name.startsWith("ledger.jsonl.corrupt.")
          )
        ).toEqual([])
      })
    )
  )

  it.effect("reports a quarantined tail before a retry may append", () =>
    world(({ fs, home, ledger, path }) =>
      Effect.gen(function* () {
        const first = yield* encodedReceipt("first")
        const ledgerFile = path.join(home, "ledger.jsonl")
        yield* fs.writeFileString(ledgerFile, `${first}\n{"torn":`)

        const next = yield* receipt("next")
        const firstAttempt = yield* ledger.record(next).pipe(Effect.exit)
        expect(firstAttempt._tag).toBe("Failure")
        if (firstAttempt._tag === "Failure") {
          expect(firstAttempt.cause.toString()).toContain(
            "LedgerTailQuarantined"
          )
        }
        expect((yield* ledger.entries).map((entry) => entry.ref)).toEqual([
          "first"
        ])

        yield* ledger.record(next)
        expect((yield* ledger.entries).map((entry) => entry.ref)).toEqual([
          "first",
          "next"
        ])
      })
    )
  )
})

describe("Ledger — cross-process serialization", () => {
  it("waits for a kernel lease held by another process before appending", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "airlock-ledger-process-"))
    const home = join(temporary, "home")
    const ledgerFile = join(home, "ledger.jsonl")
    const lockFile = `${ledgerFile}.lock`
    const blockerReady = join(temporary, "blocker-ready")
    const writerReady = join(temporary, "writer-ready")
    const releaseBlocker = join(temporary, "release-blocker")
    await mkdir(home, { recursive: true })

    const blockerSource = `
      import { constants, existsSync } from "node:fs"
      import { open, writeFile } from "node:fs/promises"
      import { acquireLinuxFileLease } from ${JSON.stringify(new URL("../src/platform/linux/LinuxExclusiveFileLock.ts", import.meta.url).href)}
      const [lockFile, readyFile, releaseFile] = process.argv.slice(1)
      const O_EXLOCK = 0x20
      const handle = await open(
        lockFile,
        constants.O_RDWR | constants.O_CREAT |
          (process.platform === "darwin" ? O_EXLOCK : 0),
        0o600
      )
      if (process.platform === "linux" && !(await acquireLinuxFileLease(handle.fd))) {
        process.exit(75)
      }
      await writeFile(readyFile, "ready")
      const deadline = Date.now() + 10_000
      while (!existsSync(releaseFile) && Date.now() < deadline) {
        await Bun.sleep(5)
      }
      await handle.close()
    `
    const writerSource = `
      import { BunContext } from "@effect/platform-bun"
      import { DateTime, Effect, Layer } from "effect"
      import { writeFile } from "node:fs/promises"
      import * as AirlockHome from ${JSON.stringify(new URL("../src/AirlockHome.ts", import.meta.url).href)}
      import { Ledger, LedgerLive } from ${JSON.stringify(new URL("../src/Ledger.ts", import.meta.url).href)}
      import { LedgerEntry } from ${JSON.stringify(new URL("../src/domain.ts", import.meta.url).href)}
      const [home, readyFile] = process.argv.slice(1)
      const layer = LedgerLive.pipe(
        Layer.provideMerge(AirlockHome.layer(home)),
        Layer.provideMerge(BunContext.layer)
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const at = yield* DateTime.now
          yield* Effect.promise(() => writeFile(readyFile, "ready"))
          yield* ledger.record(new LedgerEntry({
            at,
            effect: "mutation",
            act: "overwrite",
            ref: "cross-process"
          }))
        }).pipe(Effect.provide(layer))
      )
    `

    const bunExecutable =
      process.env["BUN_INSTALL"] === undefined
        ? "bun"
        : join(process.env["BUN_INSTALL"], "bin", "bun")
    let blocker: ReturnType<typeof spawn> | undefined
    let writer: ReturnType<typeof spawn> | undefined
    try {
      blocker = spawn(
        bunExecutable,
        [
          "-e",
          blockerSource,
          "--",
          lockFile,
          blockerReady,
          releaseBlocker
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"]
        }
      )
      const blockerResult = childResult(blocker)
      await waitForFile(blockerReady)

      writer = spawn(
        bunExecutable,
        [
          "-e",
          writerSource,
          "--",
          home,
          writerReady
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"]
        }
      )
      const writerResult = childResult(writer)
      await waitForFile(writerReady)
      await delay(150)

      expect(writer.exitCode).toBeNull()
      expect(existsSync(ledgerFile)).toBe(false)

      await writeFile(releaseBlocker, "release")
      const [blocked, written] = await Promise.all([
        blockerResult,
        writerResult
      ])
      expect(blocked.code, blocked.stderr).toBe(0)
      expect(written.code, written.stderr).toBe(0)

      const persisted = await readFile(ledgerFile, "utf8")
      expect(persisted.endsWith("\n")).toBe(true)
      expect(JSON.parse(persisted)).toMatchObject({
        ref: "cross-process",
        act: "overwrite"
      })
    } finally {
      await writeFile(releaseBlocker, "release").catch(() => undefined)
      if (blocker?.exitCode === null) blocker.kill()
      if (writer?.exitCode === null) writer.kill()
      await rm(temporary, { recursive: true, force: true })
    }
  })
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
