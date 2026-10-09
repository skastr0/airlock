import * as Cloudflare from "alchemy/Cloudflare"
import { afterAll, describe, expect, it } from "vitest"
import { startLocal } from "../examples/cloudflare/local.ts"
import { airlockBindings, airlockCompatibility } from "../src/alchemy/index.ts"

/**
 * `examples/cloudflare`, exactly as a user would write it, run in real
 * workerd with no `nodejs_compat`: a guest run in an isolate, a staged send,
 * a supervisor's commit, and a replay.
 *
 * `examples/cloudflare/local.ts` starts workerd with the bindings read off the
 * Alchemy recipe the example deploys with, so the recipe and what is proven
 * here cannot drift apart.
 */
const workerd = await startLocal()
afterAll(() => workerd.dispose())

const request = async <Result>(method: "GET" | "POST", path: string, body?: unknown): Promise<Result> =>
  (await (await workerd.dispatchFetch(`http://example.test${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })).json()) as Result

const guest = `
  const inbox = await tools.mail.list({ mailbox: "inbox", query: "is:unread" });
  const draft = await tools.mail.send({
    to: "ada@example.com",
    subject: "Unread mail",
    body: "You have " + inbox.ids.length + " unread messages."
  });
  return { unread: inbox.ids.length, waiting: draft.id };`

describe("the Alchemy recipe", () => {
  it("declares exactly the Durable Object and the Worker Loader, under the names the Worker reads", () => {
    const bindings = airlockBindings()
    expect(bindings.AIRLOCK).toMatchObject({ className: "Airlock" })
    expect(Cloudflare.isDurableObjectLike(bindings.AIRLOCK)).toBe(true)
    expect(Cloudflare.isWorkerLoader(bindings.LOADER)).toBe(true)
    expect(Object.keys(airlockBindings())).toEqual(["AIRLOCK", "LOADER"])
    expect(airlockCompatibility.flags).toEqual([])
  })

  it("follows the names it is given and refuses one name for both bindings", () => {
    const named = airlockBindings({ object: "BOX", loader: "GUESTS", className: "MailAirlock" })
    expect(Object.keys(named)).toEqual(["BOX", "GUESTS"])
    expect(named.BOX).toMatchObject({ className: "MailAirlock" })
    expect(Cloudflare.isWorkerLoader(named.GUESTS)).toBe(true)
    expect(() => airlockBindings({ object: "SAME", loader: "SAME" })).toThrow("both bound as SAME")
  })

  it("is what the example's stack is built from", async () => {
    const stack = await import("../examples/cloudflare/alchemy.run.ts")
    expect(stack.default).toBeDefined()
  })
})

describe("examples/cloudflare in workerd", () => {
  type Entry = { readonly did: string; readonly detail: string }
  type View = { readonly id: string; readonly kind: string; readonly state: string }

  it("tells the trusted side what the guest can call", async () => {
    const tools = await request<{ tools: ReadonlyArray<string>; declaration: string }>("GET", "/tools")
    expect(tools.tools).toEqual(["label.add", "mail.list", "mail.send"])
    expect(tools.declaration).toContain("send(input: { to: string; subject: string; body: string })")
  })

  it("runs the guest, holds its send for a supervisor, sends on commit, and replays", async () => {
    const first = await request<{ ok: boolean; result: { unread: number; waiting: string }; toolCalls: number }>(
      "POST",
      "/run",
      { runId: "run-1", source: guest }
    )
    expect(first).toMatchObject({ ok: true, result: { unread: 2 }, toolCalls: 2 })
    expect((await request<ReadonlyArray<Entry>>("GET", "/mailbox")).map((entry) => entry.did)).toEqual(["listed"])

    const pending = await request<ReadonlyArray<View>>("GET", "/pending")
    expect(pending).toMatchObject([{ id: first.result.waiting, kind: "mail.send", state: "staged" }])

    const sent = await request<View>("POST", "/commit", { id: first.result.waiting })
    expect(sent).toMatchObject({ state: "committed", outcome: { messageId: "message-2" } })
    expect(await request("POST", "/commit", { id: first.result.waiting })).toMatchObject({ error: "not-pending" })

    const replay = await request<typeof first>("POST", "/run", { runId: "run-1", source: guest })
    expect(replay).toEqual(first)
    const mailbox = await request<ReadonlyArray<Entry>>("GET", "/mailbox")
    expect(mailbox.map((entry) => entry.did)).toEqual(["listed", "sent"])
    expect(await request("GET", "/pending")).toEqual([])
  })

  it("refuses what the policy does not grant, in a sentence the guest can read", async () => {
    const outcome = await request<{ result: string }>("POST", "/run?session=other", {
      runId: "run-2",
      source: `
        try { await tools.mail.send({ to: "eve@elsewhere.test", subject: "s", body: "b" }); return "sent"; }
        catch (error) { return error.message; }`
    })
    expect(outcome.result).toBe("mail.send is not allowed: `to` is not allowed by grant \"company-mail\"")
  })
})
