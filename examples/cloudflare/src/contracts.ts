import { defineToolContract, Schema } from "@skastr0/airlock-cloudflare"

/*
 * Virtual tools: no filesystem behind them, only the implementations in
 * `airlock.ts`. A machine's Airlock has filesystem tools instead; the Airlock
 * around them is the same.
 */

const Summary = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  subject: Schema.String,
  unread: Schema.Boolean
})

/**
 * Listing a mailbox: who wrote and about what, not the bodies. Which mailbox
 * is public. A page holds at most five messages, so review can bound what a
 * program does for each one.
 */
export const MailList = defineToolContract({
  name: "mail.list",
  version: "1",
  input: Schema.Struct({ mailbox: Schema.String }),
  output: Schema.Struct({ messages: Schema.Array(Summary).check(Schema.isMaxLength(5)) }),
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
