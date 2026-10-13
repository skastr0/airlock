import * as Cloudflare from "alchemy/Cloudflare"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { startLocal } from "../../../examples/cloudflare/local.ts"
import { airlockBindings, airlockCompatibility } from "../src/alchemy/index.ts"

/**
 * `examples/cloudflare`, exactly as a user would write it, run in real
 * workerd with no `nodejs_compat`. The guest is `triage.air`, the Airlock
 * program shipped with the example.
 *
 * `examples/cloudflare/local.ts` starts workerd with the binding read off the
 * Alchemy recipe the example deploys with, so the recipe and what is proven
 * here cannot drift apart.
 *
 * `AIRLOCK_EXAMPLE_URL` points the same checks at a fresh deployment instead;
 * a used one fails them, since the mailbox and the Outbox keep earlier runs.
 */
const deployed = process.env.AIRLOCK_EXAMPLE_URL
const workerd = deployed === undefined ? await startLocal() : undefined
afterAll(() => workerd?.dispose())

const request = async <Result>(method: "GET" | "POST", path: string, body?: unknown): Promise<Result> => {
  const init = { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
  const response = workerd === undefined
    ? await fetch(`${deployed}${path}`, init)
    : await workerd.dispatchFetch(`http://example.test${path}`, init)
  return (await response.json()) as Result
}

const triage = await readFile(join(import.meta.dirname, "..", "..", "..", "examples", "cloudflare", "triage.air"), "utf8")

describe("the Alchemy recipe", () => {
  it("declares exactly the Durable Object, under the name the Worker reads", () => {
    const bindings = airlockBindings()
    expect(Object.keys(bindings)).toEqual(["AIRLOCK"])
    expect(bindings.AIRLOCK).toMatchObject({ className: "Airlock" })
    expect(Cloudflare.isDurableObjectLike(bindings.AIRLOCK)).toBe(true)
    expect(airlockCompatibility.flags).toEqual([])
  })

  it("follows the names it is given", () => {
    const named = airlockBindings({ object: "BOX", className: "MailAirlock" })
    expect(Object.keys(named)).toEqual(["BOX"])
    expect(named.BOX).toMatchObject({ className: "MailAirlock" })
  })

  it("is what the example's stack is built from", async () => {
    const stack = await import("../../../examples/cloudflare/alchemy.run.ts")
    expect(stack.default).toBeDefined()
  })
})

describe("examples/cloudflare in workerd", () => {
  type Entry = { readonly did: string; readonly detail: string }
  type View = { readonly id: string; readonly kind: string; readonly state: string; readonly compensates?: string }
  type Outcome = {
    readonly ok: boolean
    readonly result?: unknown
    readonly reason?: string
    readonly toolCalls: number
  }
  const did = async (session: string) => (await request<ReadonlyArray<Entry>>("GET", `/mailbox?session=${session}`)).map((entry) => entry.did)
  const run = (session: string, runId: string, source: string) =>
    request<Outcome>("POST", `/run?session=${session}`, { runId, source })

  it("tells the trusted side what a program can call", async () => {
    const tools = await request<{
      actions: ReadonlyArray<{ name: string; input: string; returns: string }>
      description: string
    }>("GET", "/tools")
    expect(tools.actions.map((action) => [action.name, action.returns])).toEqual([
      ["label.add", "staged"],
      ["mail.list", "result"],
      ["mail.read", "result"],
      ["mail.send", "staged"]
    ])
    expect(tools.actions[1]).toMatchObject({
      input: "{ mailbox: string }",
      result: "{ messages: [{ id: string, from: string, subject: string, unread: boolean }] }"
    })
    expect(tools.actions[3]?.input).toBe("{ to: string, subject: string, body: string }")
    expect(tools.description).toContain("An Airlock program (.air)")
  })

  it("runs triage.air: the reads happen, the writes wait, a supervisor decides, and a replay sends nothing twice", async () => {
    const first = await run("demo", "run-1", triage)
    expect(first).toMatchObject({ ok: true, result: { triaged: "inbox" }, toolCalls: 4 })
    expect((first.result as { seen: ReadonlyArray<{ id: string }> }).seen.map((message) => message.id)).toEqual(["m1", "m2", "m3"])
    // Only the unread message from billing was read. Nothing was labelled or sent.
    expect(await request("GET", "/mailbox")).toEqual([
      { did: "listed", detail: "inbox" },
      { did: "read", detail: "m1" }
    ])

    const pending = await request<ReadonlyArray<View & { summary?: unknown }>>("GET", "/pending")
    expect(pending.map((emission) => [emission.kind, emission.state]).sort()).toEqual([
      ["label.add", "staged"],
      ["mail.send", "staged"]
    ])
    const ids = {
      label: pending.find((emission) => emission.kind === "label.add")!.id,
      mail: pending.find((emission) => emission.kind === "mail.send")!.id
    }

    const sent = await request<View>("POST", "/commit", { id: ids.mail })
    expect(sent).toMatchObject({ state: "committed", outcome: { messageId: "message-3" } })
    expect(await request("POST", "/commit", { id: ids.mail })).toMatchObject({ error: "not-pending" })

    const labelled = await request<View>("POST", "/commit", { id: ids.label })
    expect(labelled.state).toBe("committed")
    const undo = await request<View>("POST", "/compensate", { id: ids.label })
    expect(undo).toMatchObject({ kind: "label.remove", state: "staged", compensates: ids.label })
    expect(await request<View>("POST", "/cancel", { id: undo.id })).toMatchObject({ state: "cancelled" })
    expect(await request("POST", "/compensate", { id: ids.mail })).toMatchObject({ error: "not-compensable" })

    const replay = await run("demo", "run-1", triage)
    expect(replay).toEqual(first)
    expect(await request("GET", "/mailbox")).toEqual([
      { did: "listed", detail: "inbox" },
      { did: "read", detail: "m1" },
      { did: "sent", detail: `Fwd: Invoice 1042 is overdue to finance@example.com (${ids.mail})` },
      { did: "labelled", detail: "m1 billing" }
    ])
    expect(await request("GET", "/pending")).toEqual([])
  })

  it("refuses before the run a program whose fixed call the policy does not grant, naming the call and why", async () => {
    const before = await did("other")
    const outcome = await run("other", "run-2", `
      let sent = mail.send({ to: "eve@elsewhere.test", subject: "s", body: "b" })
      if sent.state == "refused" { return sent.refusal }
      return "sent"`)
    expect(outcome).toEqual({
      ok: false,
      reason: "review_refused",
      toolCalls: 0,
      refusals: [{ nodeId: "call:1", field: "$", reason: "grant" }]
    })
    // Nothing was done and nothing waits for approval.
    expect(await did("other")).toEqual(before)
    expect(await request("GET", "/pending?session=other")).toEqual([])
  })

  it("stops a program at the policy's call budget, and refuses before the run one whose loops could pass the loop budget", async () => {
    const before = (await did("budget")).length
    const calls = await run("budget", "run-3", `
      for index in 0..9 { mail.list({ mailbox: "inbox" }) }
      return "finished"`)
    expect(calls).toEqual({ ok: false, reason: "tool_call_limit", toolCalls: 9 })
    expect((await did("budget")).length).toBe(before + 8)
    const loop = await run("budget", "run-4", `
      for index in 0..5000 { let twice = index * 2 }
      return mail.list({ mailbox: "inbox" })`)
    expect(loop).toEqual({ ok: false, reason: "review_refused", toolCalls: 0, refusals: [{ nodeId: "$", field: "$", reason: "bound" }] })
    expect((await did("budget")).length).toBe(before + 8)
  })

  it("stops a program that only computes at its step budget, which deployed Workers need: their clock stands still while it runs", async () => {
    const before = await did("compute")
    const heavy = Array.from({ length: 119 }, (_, index) => `index * ${index + 1}`).join(" + ")
    const outcome = await run("compute", "run-5", `
      for index in 0..999 { let heavy = ${heavy} }
      return mail.list({ mailbox: "inbox" })`)
    expect(outcome).toMatchObject({ ok: false, reason: "step_limit", toolCalls: 0 })
    expect(await did("compute")).toEqual(before)
  })
})
