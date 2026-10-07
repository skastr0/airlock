import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/**
 * `examples/cloudflare`, exactly as a user would write it, run in real
 * workerd with no `nodejs_compat`: a guest run in an isolate, a staged send,
 * a supervisor's commit, and a replay.
 */
const repository = resolve(import.meta.dirname, "..")

const script = (await build({
  entryPoints: [join(repository, "examples", "cloudflare", "src", "worker.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import"],
  target: "es2022",
  // The example imports the package by name; inside this repository that is this file.
  alias: { "@skastr0/airlock/cloud": join(repository, "src", "cloud", "index.ts") },
  external: ["cloudflare:workers"],
  logLevel: "silent"
})).outputFiles[0]!.text

const workerd = new Miniflare({
  modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
  compatibilityDate: "2026-07-08",
  durableObjects: { AIRLOCK: { className: "Airlock", useSQLite: true } },
  workerLoaders: { LOADER: {} },
  bindings: { MAIL_TOKEN: "example-token" }
})
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
