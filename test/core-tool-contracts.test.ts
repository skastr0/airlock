import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { Admission, defineIntentKind, defineOutbox, defineToolContract, Plan, ToolSummary } from "../src/core/index.ts"
import {
  exampleContracts,
  LabelAdd,
  LabelRemove,
  MailList,
  MailSend
} from "../src/core/testing/ExampleContracts.ts"

const { toolDispatchDecision, toolGrant, ToolGrantPolicy, validateToolGrants } = Admission

const send = (to: string) =>
  Result.getOrThrow(MailSend.summarize({ to, subject: "s", body: "b" }))
const list = (mailbox: string) =>
  Result.getOrThrow(MailList.summarize({ mailbox, query: "secret query" }))

describe("core: tool contracts", () => {
  it("requires exactly the four effect classes", () => {
    expect(Plan.PlanEffect.literals).toEqual(["capture", "invoke", "apply", "request"])
    const input = Schema.Struct({ value: Schema.String })
    const output = Schema.Struct({ ok: Schema.Boolean })
    for (const effect of Plan.PlanEffect.literals) {
      const contract = defineToolContract({ name: `tool.${effect}`, version: "1", input, output, effect })
      const summary = Result.getOrThrow(contract.summarize({ value: "private" }))
      expect(Schema.decodeUnknownSync(ToolSummary)(summary).effect).toBe(effect)
      expect(contract.effect).toBe(effect)
      expect(summary.public).toEqual({})
      expect(summary).not.toHaveProperty("emissionEffect")
      const { effect: _effect, ...omitted } = summary
      expect(() => Schema.decodeUnknownSync(ToolSummary)(omitted)).toThrow()
      expect(() => Schema.decodeUnknownSync(ToolSummary)({ ...summary, effect: "read" })).toThrow()
    }
    const missing = () => {
      // @ts-expect-error a contract must declare its effect
      return defineToolContract({ name: "missing", version: "1", input, output })
    }
    const obsolete = () => defineToolContract({
      name: "obsolete", version: "1", input, output,
      // @ts-expect-error read is no longer a contract effect
      effect: "read"
    })
    expect([missing, obsolete].every((declaration) => typeof declaration === "function")).toBe(true)
  })

  it("redacts by default and exposes only declared public fields", () => {
    expect(list("inbox")).toEqual({
      tool: "mail.list",
      version: "1",
      target: "tool:mail.list",
      effect: "capture",
      fields: ["mailbox", "query"],
      inputBytes: 42,
      public: { mailbox: "inbox" }
    })
    const NoPublic = defineToolContract({
      name: "vault.read",
      effect: "capture",
      version: "1",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean })
    })
    expect(Result.getOrThrow(NoPublic.summarize({ path: "/secret/key" })).public).toEqual({})
    expect(NoPublic.publicFields).toEqual([])
    expect(NoPublic.effect).toBe("capture")
    expect(NoPublic.compensate).toBeUndefined()
  })

  it("declares compensation only where the contract names an answer", () => {
    expect(LabelAdd.compensate?.kind).toBe("label.remove")
    expect(LabelAdd.compensate?.with).toBe(LabelRemove)
    expect(LabelAdd.compensate?.intent({
      dispatch: { messageId: "m", label: "l" },
      outcome: { added: true }
    })).toEqual({ messageId: "m", label: "l" })
    expect(MailSend.compensate).toBeUndefined()
    expect(LabelRemove.compensate).toBeUndefined()
  })

  it("matches a grant on the tool and on public argument values", () => {
    const company = toolGrant(MailSend, { id: "g/1", where: { to: { endsWith: "@example.com" } } })
    expect(Admission.fittingToolGrants([company], send("ada@example.com"))).toHaveLength(1)
    expect(Admission.fittingToolGrants([company], send("ada@elsewhere.test"))).toHaveLength(0)
    expect(Admission.fittingToolGrants([company], list("inbox"))).toHaveLength(0)

    const mailboxes = toolGrant(MailList, { id: "g/2", 
      when: "now",
      where: { mailbox: { oneOf: ["inbox", "archive"] } }
    })
    expect(toolDispatchDecision([mailboxes], exampleContracts, list("inbox"))).toMatchObject({
      _tag: "Now"
    })
    expect(toolDispatchDecision([mailboxes], exampleContracts, list("drafts"))).toMatchObject({
      _tag: "Refused"
    })
  })

  it("never permits request-now, even when the request declares compensation", () => {
    // Both an irreversible request and a compensated request require approval.
    const eager = new ToolGrantPolicy({ id: "eager", tool: "mail.send", when: "now" })
    expect(toolDispatchDecision([eager], exampleContracts, send("ada@example.com"))).toMatchObject({
      _tag: "Refused"
    })
    const label = Result.getOrThrow(LabelAdd.summarize({ messageId: "m", label: "l" }))
    const labelGrant = new ToolGrantPolicy({ id: "label", tool: "label.add", when: "now" })
    expect(toolDispatchDecision([labelGrant], exampleContracts, label)).toMatchObject({
      _tag: "Refused"
    })
    // A grant that says nothing is the floor: staged until a supervisor commits.
    expect(toolGrant(MailList, { id: "g/6" })).toMatchObject({ when: "approved" })
    expect(toolDispatchDecision([toolGrant(MailList, { id: "g/7" })], exampleContracts, list("inbox"))).toMatchObject({
      _tag: "Approved"
    })
  })

  it("refuses a grant on a private field, an unknown tool, or request-now", () => {
    // @ts-expect-error subject is not a public field of mail.send
    toolGrant(MailSend, { id: "g/3", where: { subject: { equals: "hi" } } })
    // @ts-expect-error query is not a public field of mail.list
    toolGrant(MailList, { id: "g/4", where: { query: { startsWith: "from:" } } })

    // The same grants arriving as data are rejected, and match nothing.
    const decode = Schema.decodeUnknownSync(ToolGrantPolicy)
    const onPrivate = decode({ id: "private", tool: "mail.send", where: { body: { equals: "x" } } })
    expect(validateToolGrants([onPrivate], exampleContracts)).toMatchObject({
      field: "policy.toolGrants[0].where.body"
    })
    expect(validateToolGrants([decode({ id: "unknown", tool: "mail.forward" })], exampleContracts)).toMatchObject({
      field: "policy.toolGrants[0].tool"
    })
    expect(
      validateToolGrants([decode({ id: "auto", tool: "label.add", when: "now" })], exampleContracts)
    ).toMatchObject({ field: "policy.toolGrants[0].when" })
    const valid = toolGrant(MailList, { id: "g/5", when: "now" })
    expect(toolDispatchDecision([valid, onPrivate], exampleContracts, list("inbox"))).toMatchObject({
      _tag: "Refused",
      reason: expect.stringContaining("invalid policy")
    })
  })

  it("refuses a registry whose compensation is not the registered kind", () => {
    // @ts-expect-error label.add compensates with label.remove, which is not registered
    expect(() => defineOutbox({ "label.add": LabelAdd })).toThrow(/label\.remove/)

    // The tag is registered, but by a different kind: refused at construction.
    const Impostor = defineIntentKind({
      tag: "label.remove",
      dispatch: Schema.Struct({ anything: Schema.String }),
      summary: Schema.Struct({ anything: Schema.String }),
      outcome: Schema.Struct({ ok: Schema.Boolean }),
      summarize: (dispatch) => Result.succeed(dispatch),
      target: () => "impostor"
    })
    expect(() => defineOutbox({ "label.add": LabelAdd, "label.remove": Impostor })).toThrow(
      /not the kind registered/
    )
    expect(Object.keys(defineOutbox(exampleContracts).kinds)).toHaveLength(4)
  })
})
