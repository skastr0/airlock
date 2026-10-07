import { airlockClient, airlockDurableObject, AirlockError } from "@skastr0/airlock/cloud"
import { airlock, type Env, mailbox } from "./airlock.ts"

/** The Durable Object: this one export is the whole server side of Airlock. */
export const Airlock = airlockDurableObject(airlock, { loader: (env: Env) => env.LOADER })

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json" } })

/**
 * The trusted side. In a real system this is your agent host and your approval
 * UI; here it is a few HTTP routes so the example can be driven with curl.
 * Put it behind your own authentication: whoever can call it is the supervisor.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const session = airlockClient(env.AIRLOCK, url.searchParams.get("session") ?? "demo")
    const body = request.method === "POST"
      ? await request.json().catch(() => ({})) as { runId?: string; source?: string; id?: string }
      : {}
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /tools": return json(await session.describe())
        case "POST /run": return json(await session.run({ runId: body.runId ?? "", source: body.source ?? "" }))
        case "GET /pending": return json(await session.pending())
        case "POST /commit": return json(await session.commit(body.id ?? ""))
        case "POST /cancel": return json(await session.cancel(body.id ?? ""))
        case "POST /compensate": return json(await session.compensate(body.id ?? ""))
        case "GET /mailbox": return json(mailbox)
        default: return json({ error: "not found" }, 404)
      }
    } catch (error) {
      if (error instanceof AirlockError) return json({ error: error.code, message: error.message }, 409)
      throw error
    }
  }
}
