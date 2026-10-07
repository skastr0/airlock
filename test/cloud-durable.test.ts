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
  // Provided by the Workers runtime.
  external: ["cloudflare:workers"],
  logLevel: "silent"
})).outputFiles[0]!.text

const persist = await mkdtemp(join(tmpdir(), "airlock-cloud-"))
const instances = new Set<Miniflare>()
/** One workerd process over the persisted storage. A second one is a restart. */
const start = (storage = persist) => {
  const instance = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: "2026-07-08",
    durableObjects: {
      CONFORMANCE: { className: "ConformanceObject", useSQLite: true },
      AIRLOCK: { className: "ExampleAirlock", useSQLite: true }
    },
    // The Worker Loader binding the guest runner uses. No nodejs_compat anywhere.
    workerLoaders: { LOADER: {} },
    bindings: { MAIL_TOKEN: "token-canary" },
    durableObjectsPersist: storage
  })
  instances.add(instance)
  return instance
}
const stop = async (instance: Miniflare) => {
  instances.delete(instance)
  await instance.dispose()
}
const call = async <Result>(instance: Miniflare, path: string, body?: unknown): Promise<Result> =>
  (await (await instance.dispatchFetch(`http://airlock.test${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })).json()) as Result

const workerd = start()
const names = await call<ReadonlyArray<string>>(workerd, "/tests?object=listing")

afterAll(async () => {
  // A stray workerd would disturb the load-sensitive lock tests.
  for (const instance of [...instances]) await stop(instance).catch(() => undefined)
  await rm(persist, { recursive: true, force: true })
})

describe("cloud: conformance inside workerd", () => {
  it("found the four suites", () => {
    expect(names.length).toBeGreaterThanOrEqual(58)
    for (const suite of ["OutboxStore conformance", "Ledger conformance", "Outbox conformance"]) {
      expect(names.some((name) => name.startsWith(`${suite}: Durable Object SQLite`))).toBe(true)
    }
    expect(names.some((name) => name.startsWith("GuestRunner conformance: Worker Loader isolate"))).toBe(true)
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

describe("cloud: a user's Airlock as a Durable Object", () => {
  type Outcome = { readonly ok: boolean; readonly result?: unknown; readonly reason?: string; readonly toolCalls: number }
  type View = { readonly id: string; readonly kind: string; readonly state: string; readonly [field: string]: unknown }
  const guest = `
    const inbox = await tools.mail.list({ mailbox: "inbox", query: "is:unread" });
    const sent = await tools.mail.send({ to: "ada@example.com", subject: "unread", body: "you have " + inbox.ids.length });
    const labelled = await tools.label.add({ messageId: inbox.ids[0], label: "triaged" });
    return { inbox, sent: sent.staged, labelled: labelled.staged, sendId: sent.id, labelId: labelled.id };`

  it("describes exactly the granted tools", async () => {
    const described = await call<{ tools: ReadonlyArray<string>; declaration: string; description: string }>(
      workerd,
      "/airlock/describe?object=describe"
    )
    expect(described.tools).toEqual(["label.add", "mail.list", "mail.send"])
    expect(described.declaration).toContain("list(input: { mailbox: string; query: string })")
    expect(described.declaration).not.toContain("remove")
    expect(described.description).toContain("tools.mail.send(input)")
  })

  it("runs a guest in an isolate, stages its writes, lets a supervisor commit, and replays", async () => {
    const object = "?object=flow"
    const remote = () => call<ReadonlyArray<{ tool: string; detail: string }>>(workerd, "/airlock/remote")
    const start = (await remote()).length
    const first = await call<Outcome>(workerd, `/airlock/run${object}`, { runId: "run-1", source: guest })
    expect(first).toMatchObject({
      ok: true,
      result: { inbox: { ids: ["inbox-1", "inbox-2"] }, sent: true, labelled: true },
      toolCalls: 3
    })
    const ids = first.result as { readonly sendId: string; readonly labelId: string }
    // The run reached the remote side once, for the read. Nothing it staged was sent.
    expect((await remote()).slice(start).map((entry) => entry.tool)).toEqual(["mail.list"])
    const before = (await remote()).length

    const pending = await call<ReadonlyArray<View>>(workerd, `/airlock/pending${object}`)
    expect(pending.map((emission) => emission.kind).sort()).toEqual(["label.add", "mail.send"])

    const sent = await call<View>(workerd, `/airlock/commit${object}`, { id: ids.sendId })
    expect(sent).toMatchObject({ state: "committed", outcome: { messageId: expect.stringMatching(/^sent-/) } })
    const labelled = await call<View>(workerd, `/airlock/commit${object}`, { id: ids.labelId })
    expect(labelled.state).toBe("committed")
    const answer = await call<View>(workerd, `/airlock/compensate${object}`, { id: ids.labelId })
    expect(answer).toMatchObject({ kind: "label.remove", state: "staged", compensates: ids.labelId })
    const twice = await call<{ failed: boolean; code: string; message: string }>(
      workerd,
      `/airlock/commit${object}`,
      { id: ids.sendId }
    )
    expect(twice).toMatchObject({ failed: true, code: "not-pending" })

    // The implementation ran in the object, with the Worker's secret and the emission's key.
    const seen = (await remote()).slice(before)
    expect(seen.map((entry) => entry.tool)).toEqual(["mail.send", "label.add"])
    expect(seen[0]?.detail).toBe(`ada@example.com with token-canary as ${ids.sendId}`)
    expect(JSON.stringify([first, pending, sent, labelled, answer])).not.toContain("token-canary")

    // The guest is executed again from the top: recorded results, nothing sent again.
    const replay = await call<Outcome>(workerd, `/airlock/run${object}`, { runId: "run-1", source: guest })
    expect(replay.result).toEqual(first.result)
    expect((await remote()).length).toBe(before + 2)
  })

  it("keeps the guest inside its grants and its isolate", async () => {
    const run = (source: string) =>
      call<Outcome>(workerd, "/airlock/run?object=limits", { runId: crypto.randomUUID(), source })
    const outside = await run(`
      try { await tools.mail.send({ to: "eve@elsewhere.test", subject: "s", body: "b" }); return "sent"; }
      catch (error) { return error.message; }`)
    expect(outside.result).toBe("mail.send is not allowed: `to` is not allowed by grant \"support-replies\"")
    expect(await run("return typeof tools.label.remove")).toMatchObject({ ok: true, result: "undefined" })
    expect(await run(`
      try { await fetch("https://example.com/"); return "reached"; } catch { return "blocked"; }`))
      .toMatchObject({ ok: true, result: "blocked" })
    // A budget of 8 calls in the policy: the ninth fails the run, caught or not.
    expect(await run(`
      for (let index = 0; index < 9; index++) {
        try { await tools.mail.list({ mailbox: "inbox", query: String(index) }); } catch {}
      }
      return "finished";`)).toMatchObject({ ok: false, reason: "tool_call_limit" })
    expect(await run("return { get secret() { return 1; } }")).toMatchObject({ ok: false, reason: "invalid_output" })
    expect(await run(`await tools.mail.list({ mailbox: "inbox", query: "x".repeat(20000) }); return 1;`))
      .toMatchObject({ ok: false, reason: "tool_input_limit" })
  })
})
