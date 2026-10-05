import { Schema } from "effect"
import { defineToolContract } from "../contract/ToolContract.ts"

/**
 * Four tool contracts in the shape a mail integration needs. They live outside
 * the kernel files on purpose: everything they do, a host or another package
 * can do without editing `src/core/outbox`.
 */

/** A read. Its mailbox is public; its query is not. */
export const MailList = defineToolContract({
  name: "mail.list",
  version: "1",
  input: Schema.Struct({ mailbox: Schema.String, query: Schema.String }),
  output: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  emissionEffect: "read",
  public: ["mailbox"]
})

/** Declares nothing about its effect and has no answer: an irreversible send. */
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

/** A mutation whose committed outcome is answered by removing the same label. */
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

export const exampleContracts = {
  "mail.list": MailList,
  "mail.send": MailSend,
  "label.add": LabelAdd,
  "label.remove": LabelRemove
} as const
