import { defineToolContract, Schema } from "@skastr0/airlock/cloudflare"

const Summary = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  subject: Schema.String,
  unread: Schema.Boolean
})

/** Listing a mailbox: who wrote and about what, not the bodies. Which mailbox is public. */
export const MailList = defineToolContract({
  name: "mail.list",
  version: "1",
  input: Schema.Struct({ mailbox: Schema.String }),
  output: Schema.Struct({ messages: Schema.Array(Summary) }),
  effect: "capture",
  public: ["mailbox"]
})

/** Reading one message in full. */
export const MailRead = defineToolContract({
  name: "mail.read",
  version: "1",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, from: Schema.String, subject: Schema.String, body: Schema.String }),
  effect: "capture",
  public: []
})

/** Sending mail is a request with no declared compensation. */
export const MailSend = defineToolContract({
  name: "mail.send",
  effect: "request",
  version: "1",
  input: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }),
  output: Schema.Struct({ messageId: Schema.String }),
  public: ["to"]
})

export const LabelRemove = defineToolContract({
  name: "label.remove",
  version: "1",
  input: Schema.Struct({ messageId: Schema.String, label: Schema.String }),
  output: Schema.Struct({ removed: Schema.Boolean }),
  effect: "request",
  public: ["label"]
})

/** Adding a label can be answered by removing it again. */
export const LabelAdd = defineToolContract({
  name: "label.add",
  version: "1",
  input: Schema.Struct({ messageId: Schema.String, label: Schema.String }),
  output: Schema.Struct({ added: Schema.Boolean }),
  effect: "request",
  public: ["label"],
  compensate: {
    with: LabelRemove,
    intent: ({ dispatch }) => ({ messageId: dispatch.messageId, label: dispatch.label })
  }
})
