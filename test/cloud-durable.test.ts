import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { expectedTranscript } from "../src/core/testing/index.ts"

/**
 * The Durable Object adapters, judged inside real workerd.
 *
 * The test Worker (`test/cloud/worker.ts`) is bundled for a neutral platform
 * and loaded with no `nodejs_compat`. Each conformance test runs in its own
 * SQLite-backed Durable Object, reached over HTTP; this file only starts
 * workerd, asks which tests exist, and reports each one.
 */
const repository = resolve(import.meta.dirname, "..")

const script = (await build({
  entryPoints: [join(repository, "test", "cloud", "worker.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import"],
  target: "es2022",
  logLevel: "silent"
})).outputFiles[0]!.text

const persist = await mkdtemp(join(tmpdir(), "airlock-cloud-"))
const instances = new Set<Miniflare>()
/** One workerd process over the persisted storage. A second one is a restart. */
const start = (storage = persist) => {
  const instance = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: "2026-07-08",
    durableObjects: { CONFORMANCE: { className: "ConformanceObject", useSQLite: true } },
    durableObjectsPersist: storage
  })
  instances.add(instance)
  return instance
}
const stop = async (instance: Miniflare) => {
  instances.delete(instance)
  await instance.dispose()
}
const call = async <Result>(instance: Miniflare, path: string): Promise<Result> =>
  (await (await instance.dispatchFetch(`http://airlock.test${path}`, { method: "POST" })).json()) as Result

const workerd = start()
const names = await call<ReadonlyArray<string>>(workerd, "/tests?object=listing")

afterAll(async () => {
  // A stray workerd would disturb the load-sensitive lock tests.
  for (const instance of [...instances]) await stop(instance).catch(() => undefined)
  await rm(persist, { recursive: true, force: true })
})

describe("cloud: conformance inside workerd", () => {
  it("found the three suites", () => {
    expect(names.length).toBeGreaterThanOrEqual(43)
    for (const suite of ["OutboxStore conformance", "Ledger conformance", "Outbox conformance"]) {
      expect(names.some((name) => name.startsWith(`${suite}: Durable Object SQLite`))).toBe(true)
    }
  })

  for (const [index, name] of names.entries()) {
    it(name, async () => {
      const result = await call<{ readonly ok: boolean; readonly error?: string }>(
        workerd,
        `/run?object=test-${index}&index=${index}`
      )
      expect(result.error).toBeUndefined()
      expect(result.ok).toBe(true)
    }, 60_000)
  }
})

describe("cloud: the worked example and a restart", () => {
  it("produces the reference transcript on the Durable Object adapters", async () => {
    expect(await call(workerd, "/worked-example?object=worked-example")).toEqual(expectedTranscript)
  })

  it("returns a recorded read after workerd is stopped and started over the same storage", async () => {
    type Read = {
      readonly id: string
      readonly ids: ReadonlyArray<string>
      readonly response: string
      readonly dispatchedInThisProcess: number
    }
    // Its own storage directory, so two workerd processes never share one.
    const storage = await mkdtemp(join(tmpdir(), "airlock-cloud-restart-"))
    const first = start(storage)
    const before = await call<Read>(first, "/recorded-read?object=restart")
    expect(before.dispatchedInThisProcess).toBe(1)
    await stop(first)

    // A new process: nothing in memory survives, only the object's SQLite storage.
    const second = start(storage)
    const after = await call<Read>(second, "/recorded-read?object=restart")
    await stop(second)
    await rm(storage, { recursive: true, force: true })
    expect(after.dispatchedInThisProcess).toBe(0)
    expect([after.id, after.ids, after.response]).toEqual([before.id, before.ids, before.response])
  }, 60_000)
})
