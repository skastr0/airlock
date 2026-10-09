import { defineAirlock, refused, toolGrant, toolPolicy } from "@skastr0/airlock/cloudflare"
import { LabelAdd, LabelRemove, MailList, MailRead, MailSend } from "./contracts.ts"

/** The Worker's bindings. `MAIL_TOKEN` is a secret; an Airlock program has no way to name it. */
export interface Env {
  readonly AIRLOCK: { idFromName(name: string): unknown; get(id: unknown): unknown }
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

const inbox = [
  { id: "m1", from: "billing@example.com", subject: "Invoice 1042 is overdue", unread: true, body: "Invoice 1042 for 310.00 was due on the 1st." },
  { id: "m2", from: "news@example.com", subject: "This week", unread: true, body: "Nothing that needs you." },
  { id: "m3", from: "billing@example.com", subject: "Receipt 1041", unread: false, body: "Paid, thank you." }
]

export const airlock = defineAirlock({
  contracts: [MailList, MailRead, MailSend, LabelAdd, LabelRemove],

  implement: {
    "mail.list": ({ mailbox: name }) => {
      mailbox.push({ did: "listed", detail: name })
      return { messages: inbox.map(({ id, from, subject, unread }) => ({ id, from, subject, unread })) }
    },
    "mail.read": ({ id }) => {
      const message = inbox.find((candidate) => candidate.id === id)
      if (message === undefined) return refused(`there is no message ${id}`)
      mailbox.push({ did: "read", detail: id })
      return { id, from: message.from, subject: message.subject, body: message.body }
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

  // What a program may do. Reading is granted `now`, and what was read is
  // kept, so a program run again sees the same inbox it saw the first time.
  // Mail and labels are granted `approved`: the program proposes them and a
  // person decides. Nothing else exists for it.
  policy: toolPolicy({
    budget: { maxCalls: 8, maxInputBytes: 16_384 },
    toolGrants: [
      toolGrant(MailList, { id: "read-inbox", when: "now", retention: "keep", where: { mailbox: { equals: "inbox" } } }),
      toolGrant(MailRead, { id: "read-mail", when: "now", retention: "keep" }),
      toolGrant(MailSend, { id: "company-mail", when: "approved", where: { to: { endsWith: "@example.com" } } }),
      toolGrant(LabelAdd, { id: "labels", when: "approved" })
    ]
  })
})
