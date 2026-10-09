#!/usr/bin/env bun
/**
 * What one granted-now read costs on this machine.
 *
 *   bun scripts/measure-capture.ts [count]
 *
 * Two numbers, each over a fresh Airlock home:
 *
 *   store   OutboxStore.putCapture alone: the lock, one journal line, one flush.
 *   read    guest.call("file.read") through the kernel: admission, binding the
 *           path, the read itself, and the same one-line record.
 *
 * The flush is `fsync`, as the ledger has always used. On macOS that hands
 * the bytes to the drive without forcing the drive's own cache
 * (`F_FULLFSYNC` does that and costs far more); the output says so.
 */
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import * as AirlockHome from "../src/AirlockHome.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { LedgerEntry } from "../src/core/ledger/Ledger.ts"
import { CapturedEmission } from "../src/core/outbox/Capture.ts"
import { IdempotencyKey } from "../src/core/outbox/Identifiers.ts"
import { OutboxStore } from "../src/core/outbox/OutboxStore.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { digestOf, emissionId, instant } from "../src/core/testing/Fixtures.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { Hold } from "../src/Hold.ts"
import { HoldLive } from "../src/HoldLive.ts"
import { FileArtifacts, FileArtifactsLive } from "../src/host/FileArtifacts.ts"
import { FileLedgerLive, ledgerLayer } from "../src/host/FileLedger.ts"
import * as FileOutboxStore from "../src/host/FileOutboxStore.ts"
import { HeldCalls, HeldCallsConfig, HeldCallsLive } from "../src/host/HeldCalls.ts"
import { localAirlock } from "../src/host/LocalAirlock.ts"
import { localRecovery } from "../src/host/LocalRecovery.ts"
import { localToolHost } from "../src/host/LocalToolHost.ts"
import { FileRead, NativeFileSystem, NativeFileSystemLive, NativeFilesystemConfig } from "../src/native/index.ts"

const count = Number(process.argv[2] ?? 300)
const warmUp = 20

const report = (label: string, millis: ReadonlyArray<number>) => {
  const sorted = [...millis].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(2)
  console.log(`${label.padEnd(6)} n=${millis.length}  p50 ${at(0.5)} ms  p90 ${at(0.9)} ms  p99 ${at(0.99)} ms`)
}

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now()
    yield* effect
    return performance.now() - started
  })

const capture = (n: number) => {
  const record = new CapturedEmission({
    state: "captured", id: emissionId(n), key: IdempotencyKey.make(`capture-${n}`),
    kind: "probe", dispatchDigest: digestOf("a"), requestDigest: digestOf("b"), summary: { tool: "probe" },
    admission: {
      policyDigest: digestOf("c"), grantIds: ["read"],
      execution: { runId: "run", tool: "probe", version: "1", effect: "capture", when: "now", retention: "digest", resources: [] }
    },
    outcome: { state: "done", digest: digestOf("d") },
    completedAt: instant(n), ledgered: ["capture"]
  })
  const receipt = new LedgerEntry({ at: record.completedAt, effect: "observation", act: "capture", ref: record.id, key: `${record.id}:capture` })
  return { record, result: { digest: digestOf("d") }, receipt }
}

const storeOnly = Effect.gen(function* () {
  const store = yield* OutboxStore
  const put = (n: number) => {
    const one = capture(n)
    return store.putCapture(one.record, one.result, one.receipt)
  }
  for (let n = 1; n <= warmUp; n++) yield* put(n)
  const millis: Array<number> = []
  for (let n = 0; n < count; n++) millis.push(yield* timed(put(1_000 + n)))
  report("store", millis)
})

const wholeRead = (workspace: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.writeFileString(path.join(workspace, "note.txt"), "a small file\n")
    const services = { calls: yield* HeldCalls, hold: yield* Hold, files: yield* NativeFileSystem, artifacts: yield* FileArtifacts }
    const unused = <A>(what: string) => new Proxy({}, { get: () => { throw new Error(`${what} is not used here`) } }) as A
    const airlock = localAirlock({
      services: {
        ...services, process: unused("the process runner"), cell: unused("the Cell"),
        workspace, environment: {}, confiningProfiles: [], responseLimitBytes: 65_536
      },
      host: yield* localToolHost({ workspace, confiningProfiles: [], recovery: localRecovery(services.calls) }),
      policy: toolPolicy({
        toolGrants: [toolGrant(FileRead, { id: "read", when: "now" })],
        resources: { path: [workspace] },
        budget: { maxCalls: warmUp + count, maxInputBytes: 10_000_000 }
      })
    })
    yield* Effect.gen(function* () {
      const guest = yield* airlock.guest({ runId: "measure", env: undefined })
      const read = guest.call("file.read", { path: "note.txt", format: "text" }).pipe(
        Effect.tap((receipt) => receipt.state === "done" ? Effect.void : Effect.die(new Error(`read did not complete: ${JSON.stringify(receipt)}`)))
      )
      for (let n = 0; n < warmUp; n++) yield* read
      const millis: Array<number> = []
      for (let n = 0; n < count; n++) millis.push(yield* timed(read))
      report("read", millis)
    }).pipe(Effect.provide(airlock.layer(undefined)))
  })

const home = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "airlock-measure-" }))
    const workspace = path.join(root, "workspace")
    yield* fs.makeDirectory(workspace)
    return { workspace, layer: AirlockHome.layer(path.join(root, name)) }
  })

const journal = Layer.mergeAll(FileOutboxStore.layer, ledgerLayer).pipe(Layer.provideMerge(FileLedgerLive))

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  console.log(`flush: fsync${process.platform === "darwin" ? " (macOS: not F_FULLFSYNC, the drive's own cache is not forced)" : ""}`)
  const first = yield* home("store-home")
  yield* storeOnly.pipe(Effect.provide(journal.pipe(Layer.provide(first.layer))))
  const second = yield* home("read-home")
  yield* wholeRead(second.workspace).pipe(Effect.provide(Layer.mergeAll(journal, WebCrypto.layer).pipe(
    Layer.provideMerge(HeldCallsLive(new HeldCallsConfig({ retentionMillis: 60_000 }))),
    Layer.provideMerge(FileArtifactsLive),
    Layer.provideMerge(NativeFileSystemLive(new NativeFilesystemConfig({ workspace: second.workspace }))),
    Layer.provideMerge(HoldLive),
    Layer.provideMerge(FileLedgerLive),
    Layer.provideMerge(second.layer)
  )))
})).pipe(Effect.provide(BunServices.layer)) as Effect.Effect<void>)
