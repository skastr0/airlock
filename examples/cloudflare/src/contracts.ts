import { defineToolContract, Schema } from "@skastr0/airlock/cloud"

/** Reading the inbox. Which mailbox is public; the search query is not. */
export const MailList = defineToolContract({
  name: "mail.list",
  version: "1",
  input: Schema.Struct({ mailbox: Schema.String, query: Schema.String }),
  output: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  emissionEffect: "read",
  public: ["mailbox"]
})

/** Sending mail cannot be undone, so it declares no effect and no compensation. */
export const MailSend = defineToolContract({
  name: "mail.send",
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
  emissionEffect: "mutate",
  public: ["label"]
})

/** Adding a label can be answered by removing it again. */
export const LabelAdd = defineToolContract({
  name: "label.add",
  version: "1",
  input: Schema.Struct({ messageId: Schema.String, label: Schema.String }),
  output: Schema.Struct({ added: Schema.Boolean }),
  emissionEffect: "mutate",
  public: ["label"],
  compensate: {
    with: LabelRemove,
    intent: ({ dispatch }) => ({ messageId: dispatch.messageId, label: dispatch.label })
  }
})
