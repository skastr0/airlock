import { defineAirlock, refused, toolGrant, toolPolicy, type WorkerLoader } from "@skastr0/airlock/cloud"
import { LabelAdd, LabelRemove, MailList, MailSend } from "./contracts.ts"

/** The Worker's bindings. `MAIL_TOKEN` is a secret; a guest never sees it. */
export interface Env {
  readonly AIRLOCK: { idFromName(name: string): unknown; get(id: unknown): unknown }
  readonly LOADER: WorkerLoader
  readonly MAIL_TOKEN: string
}

/**
 * A stand-in for a real mail API, so the example runs with no account. A real
 * implementation calls the provider here, with `env.MAIL_TOKEN` and
 * `idempotencyKey`, for example:
 *
 *   const response = await fetch("https://mail.example/v1/send", {
 *     method: "POST",
 *     signal,
 *     headers: { authorization: `Bearer ${env.MAIL_TOKEN}`, "idempotency-key": idempotencyKey },
 *     body: JSON.stringify(input)
 *   })
 */
export const mailbox: Array<{ readonly did: string; readonly detail: string }> = []

export const airlock = defineAirlock({
  contracts: [MailList, MailSend, LabelAdd, LabelRemove],

  implement: {
    "mail.list": ({ mailbox: name }) => {
      mailbox.push({ did: "listed", detail: name })
      return { ids: [`${name}-1`, `${name}-2`] }
    },
    "mail.send": ({ to, subject }, { env, idempotencyKey }: { env: Env; idempotencyKey: string }) => {
      if (env.MAIL_TOKEN === "") return refused("the mail connection is not configured")
      mailbox.push({ did: "sent", detail: `${subject} to ${to} (${idempotencyKey})` })
      return { messageId: `message-${mailbox.length}` }
    },
    "label.add": ({ messageId, label }) => {
      mailbox.push({ did: "labelled", detail: `${messageId} ${label}` })
      return { added: true }
    },
    "label.remove": ({ messageId, label }) => {
      mailbox.push({ did: "unlabelled", detail: `${messageId} ${label}` })
      return { removed: true }
    }
  },

  // What this guest may do: read the inbox without asking, propose mail to the
  // company's own addresses, propose labels. Nothing else exists for it.
  policy: toolPolicy({
    budget: { maxCalls: 8, maxInputBytes: 16_384 },
    toolGrants: [
      toolGrant(MailList, { id: "read-inbox", class: "read", commit: "auto", where: { mailbox: { equals: "inbox" } } }),
      toolGrant(MailSend, { id: "company-mail", where: { to: { endsWith: "@example.com" } } }),
      toolGrant(LabelAdd, { id: "labels", class: "mutate" })
    ]
  })
})
