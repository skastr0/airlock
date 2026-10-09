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
 * The test Worker (`test/cloudflare/worker.ts`) is bundled for a neutral platform
 * and loaded with no `nodejs_compat`. Each conformance test runs in its own
 * SQLite-backed Durable Object, reached over HTTP; this file only starts
 * workerd, asks which tests exist, and reports each one.
 */
const repository = resolve(import.meta.dirname, "..")

const script = (await build({
  entryPoints: [join(repository, "test", "cloudflare", "worker.ts")],
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
      AIRLOCK: { className: "ExampleAirlock", useSQLite: true },
      ALARMED: { className: "AlarmedAirlock", useSQLite: true },
      QUEUED: { className: "QueuedAirlock", useSQLite: true }
    },
    // No Worker Loader and no nodejs_compat: a program is evaluated in the object itself.
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
    expect(names.some((name) => name.startsWith("GuestRunner conformance: Airlock programs in a Durable Object"))).toBe(true)
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
    let inbox = mail.list({ mailbox: "inbox", query: "is:unread" })
    let sent = mail.send({ to: "ada@example.com", subject: "unread", body: "the first is " + inbox.ids[0] })
    let labelled = label.add({ messageId: inbox.ids[0], label: "triaged" })
    return { inbox: inbox, sent: sent.staged, labelled: labelled.staged, sendId: sent.id, labelId: labelled.id }`

  it("describes exactly the granted actions, their shapes and which are staged", async () => {
    const described = await call<{
      actions: ReadonlyArray<{ name: string; input: string; result: string; returns: string }>
      description: string
    }>(workerd, "/airlock/describe?object=describe")
    expect(described.actions.map((action) => [action.name, action.returns])).toEqual([
      ["label.add", "staged"],
      ["mail.list", "result"],
      ["mail.send", "staged"]
    ])
    expect(described.actions[1]).toMatchObject({ input: "{ mailbox: string, query: string }", result: "{ ids: [string] }" })
    expect(described.description).toContain("An Airlock program (.air)")
    expect(described.description).toContain("- mail.send({ to: string, subject: string, body: string }) -> { staged: true, id: string, state: string }.")
    expect(JSON.stringify(described)).not.toContain("label.remove(")
  })

  it("runs an Airlock program, stages its writes, lets a supervisor commit, and replays", async () => {
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

  it("keeps a program inside its grants, its budgets and the language", async () => {
    type Failed = Outcome & { readonly refusal?: { tool: string; code: string; message: string }; readonly fault?: string }
    const run = (source: string) =>
      call<Failed>(workerd, "/airlock/run?object=limits", { runId: crypto.randomUUID(), source })
    const remote = () => call<ReadonlyArray<unknown>>(workerd, "/airlock/remote")
    const before = (await remote()).length

    const outside = await run(`mail.send({ to: "eve@elsewhere.test", subject: "s", body: "b" })\nreturn "sent"`)
    expect(outside).toEqual({
      ok: false,
      reason: "tool_refused",
      toolCalls: 1,
      refusal: {
        tool: "mail.send",
        code: "not-allowed",
        message: "mail.send is not allowed: `to` is not allowed by grant \"support-replies\""
      }
    })
    // A tool the policy does not grant, and the things another language would offer, are not there.
    expect(await run(`label.remove({ messageId: "m", label: "l" })`)).toMatchObject({
      reason: "tool_refused",
      refusal: { code: "unknown-tool" }
    })
    expect(await run(`fetch("https://example.com/")`)).toMatchObject({ reason: "tool_refused", refusal: { code: "unknown-tool" } })
    expect(await run("return env.MAIL_TOKEN")).toMatchObject({ reason: "execution_failed", fault: "unbound-name" })
    expect(await run("return await fetch(1)")).toMatchObject({ reason: "invalid_code" })
    expect((await remote()).length).toBe(before)

    // A budget of 8 calls in the policy: the ninth ends the run.
    expect(await run(`for index in 0..9 { mail.list({ mailbox: "inbox", query: "q" }) }\nreturn "finished"`))
      .toMatchObject({ ok: false, reason: "tool_call_limit" })
    expect((await remote()).length).toBe(before + 8)
    expect(await run(`for index in 0..5000 { let twice = index * 2 }\nreturn "finished"`))
      .toMatchObject({ ok: false, reason: "loop_limit" })
    expect(await run(`assert 1 == 2, "token-canary"`)).toEqual({
      ok: false,
      reason: "assert_failed",
      toolCalls: 0,
      at: { line: 1, column: 1 }
    })
    const big = Array.from({ length: 12 }, (_, index) => `let s${index + 1} = s${index} + s${index}`).join("\n")
    expect(await run(`let s0 = "xxxxxxxx"\n${big}\nmail.list({ mailbox: "inbox", query: s12 })`))
      .toMatchObject({ ok: false, reason: "value_limit" })
    expect((await remote()).length).toBe(before + 8)
  })
})

describe("cloud: one program at a time", () => {
  type Outcome = { readonly ok?: boolean; readonly failed?: boolean; readonly code?: string; readonly reason?: string }
  const slow = `return mail.list({ mailbox: "slow", query: "q" })`

  it("runs programs in turn, holds a bounded line, refuses the rest, and keeps the supervisor available", async () => {
    const remote = () => call<ReadonlyArray<{ tool: string; detail: string }>>(workerd, "/airlock/remote")
    const before = (await remote()).length
    const runs = ["a", "b", "c", "d"].map((runId) =>
      call<Outcome>(workerd, "/queued/run?object=line", { runId, source: slow }))
    // While programs are running and waiting, a supervisor's call is answered.
    const pending = await call<ReadonlyArray<unknown>>(workerd, "/queued/pending?object=line")
    expect(pending).toEqual([])
    const outcomes = await Promise.all(runs)
    expect(outcomes.filter((outcome) => outcome.ok === true).length).toBe(2)
    expect(outcomes.filter((outcome) => outcome.failed === true).map((outcome) => outcome.code)).toEqual(["busy", "busy"])
    // The two that ran did not overlap: each provider call started and ended before the next began.
    expect((await remote()).slice(before).map((entry) => entry.detail)).toEqual([
      "slow started", "slow", "slow started", "slow"
    ])
    // The line is free again afterwards.
    expect(await call<Outcome>(workerd, "/queued/run?object=line", { runId: "e", source: "return 1" }))
      .toMatchObject({ ok: true, result: 1 })
  }, 30_000)

  it("refuses a source too large to be a program before it can wait in the line", async () => {
    const outcome = await call<Outcome>(workerd, "/queued/run?object=large", { runId: "big", source: "#".repeat(200_000) })
    expect(outcome).toEqual({ ok: false, reason: "invalid_code", toolCalls: 0 })
  })
})

describe("cloud: the recovery alarm", () => {
  it("settles a dispatch the object died in, with nobody calling it", async () => {
    const storage = await mkdtemp(join(tmpdir(), "airlock-cloud-alarm-"))
    const first = start(storage)
    const run = await call<{ result: { id: string } }>(first, "/alarmed/run?object=alarmed", {
      runId: "run-1",
      source: `let sent = mail.send({ to: "hang@example.com", subject: "s", body: "b" })\nreturn { id: sent.id }`
    })
    // The provider never answers: the commit is in flight when the process dies.
    void call(first, "/alarmed/commit?object=alarmed", { id: run.result.id }).catch(() => undefined)
    const states = (instance: Miniflare) => call<ReadonlyArray<string>>(instance, "/alarmed/states")
    await expect.poll(() => states(first), { timeout: 5_000 }).toEqual(["committing"])
    await stop(first)

    const second = start(storage)
    // Only raw storage is read here; the Airlock is opened by its alarm alone.
    await expect.poll(() => states(second), { timeout: 15_000, interval: 250 }).toEqual(["uncertain"])
    const view = await call<{ state: string }>(second, "/alarmed/inspect?object=alarmed", { id: run.result.id })
    expect(view.state).toBe("uncertain")
    await rm(storage, { recursive: true, force: true })
  }, 40_000)

  it("commits nothing on a timer: a staged write is still staged after the alarm time", async () => {
    const run = await call<{ result: { id: string } }>(workerd, "/alarmed/run?object=alarmed", {
      runId: "run-quiet",
      source: `let sent = mail.send({ to: "ada@example.com", subject: "s", body: "b" })\nreturn { id: sent.id }`
    })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    const view = await call<{ state: string }>(workerd, "/alarmed/inspect?object=alarmed", { id: run.result.id })
    expect(view.state).toBe("staged")
  }, 20_000)
})
