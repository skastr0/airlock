import { airlockClient, airlockDurableObject, AirlockError } from "@skastr0/airlock-cloudflare"
import { airlock, type Env, mailbox } from "./airlock.ts"

/**
 * The Durable Object: this one export is the whole server side of Airlock. It
 * runs Airlock programs (.air), admits every action they call against the
 * policy, and holds what they stage until a supervisor decides.
 *
 * `mailbox()` is only for the stand-in mail service: the object runs the
 * implementations, so only the object sees what they did.
 */
export class Airlock extends airlockDurableObject(airlock) {
  mailbox() {
    return mailbox
  }
}

const mailboxOf = (env: Env, session: string) =>
  (env.AIRLOCK.get(env.AIRLOCK.idFromName(session)) as { mailbox(): Promise<typeof mailbox> }).mailbox()

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json" } })

/**
 * The trusted side. In a real system this is your agent host and your approval
 * UI: the agent's code mode is `POST /run` with a program it wrote, and
 * `GET /tools` is what you put in its prompt. Here it is a few HTTP routes so
 * the example can be driven with curl.
 * Put it behind your own authentication: whoever can call it is the supervisor.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const name = url.searchParams.get("session") ?? "demo"
    const session = airlockClient(env.AIRLOCK, name)
    const body = request.method === "POST"
      ? await request.json().catch(() => ({})) as { runId?: string; source?: string; id?: string; plan?: string }
      : {}
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /tools": return json(await session.describe())
        case "POST /run": return json(await session.run({
          runId: body.runId ?? "",
          source: body.source ?? "",
          ...(body.plan === undefined ? {} : { plan: body.plan })
        }))
        case "POST /review": return json(await session.review({ source: body.source ?? "" }))
        case "POST /approve-plan": return json(await session.approvePlan(body.plan ?? ""))
        case "GET /pending": return json(await session.pending())
        case "POST /commit": return json(await session.commit(body.id ?? ""))
        case "POST /cancel": return json(await session.cancel(body.id ?? ""))
        case "POST /compensate": return json(await session.compensate(body.id ?? ""))
        case "GET /mailbox": return json(await mailboxOf(env, name))
        default: return json({ error: "not found" }, 404)
      }
    } catch (error) {
      if (error instanceof AirlockError) return json({ error: error.code, message: error.message }, 409)
      throw error
    }
  }
}
