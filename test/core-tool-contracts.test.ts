import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { Admission, defineIntentKind, defineOutbox, defineToolContract } from "../src/core/index.ts"
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
  it("redacts by default and exposes only declared public fields", () => {
    expect(list("inbox")).toEqual({
      tool: "mail.list",
      version: "1",
      target: "tool:mail.list",
      emissionEffect: "read",
      fields: ["mailbox", "query"],
      inputBytes: 42,
      public: { mailbox: "inbox" }
    })
    const NoPublic = defineToolContract({
      name: "vault.read",
      version: "1",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean })
    })
    expect(Result.getOrThrow(NoPublic.summarize({ path: "/secret/key" })).public).toEqual({})
    expect(NoPublic.publicFields).toEqual([])
    expect(NoPublic.emissionEffect).toBeUndefined()
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
    const company = toolGrant(MailSend, { where: { to: { endsWith: "@example.com" } } })
    expect(Admission.fittingToolGrants([company], send("ada@example.com"))).toHaveLength(1)
    expect(Admission.fittingToolGrants([company], send("ada@elsewhere.test"))).toHaveLength(0)
    expect(Admission.fittingToolGrants([company], list("inbox"))).toHaveLength(0)

    const mailboxes = toolGrant(MailList, {
      class: "read",
      commit: "auto",
      where: { mailbox: { oneOf: ["inbox", "archive"] } }
    })
    expect(toolDispatchDecision([mailboxes], exampleContracts, list("inbox"))).toMatchObject({
      _tag: "AutoCommit",
      effectiveClass: "read"
    })
    expect(toolDispatchDecision([mailboxes], exampleContracts, list("drafts"))).toMatchObject({
      _tag: "AwaitSupervisor"
    })
  })

  it("never auto-commits a tool that does not describe itself as a read", () => {
    // mail.send claims nothing, so it is an irreversible send whatever the grant says.
    const eager = new ToolGrantPolicy({ tool: "mail.send", class: "read", commit: "auto" })
    expect(toolDispatchDecision([eager], exampleContracts, send("ada@example.com"))).toMatchObject({
      _tag: "AwaitSupervisor"
    })
    const label = Result.getOrThrow(LabelAdd.summarize({ messageId: "m", label: "l" }))
    const labelGrant = new ToolGrantPolicy({ tool: "label.add", class: "read", commit: "auto" })
    expect(toolDispatchDecision([labelGrant], exampleContracts, label)).toMatchObject({
      _tag: "AwaitSupervisor"
    })
    // A grant that says nothing is the floor: staged until a supervisor commits.
    expect(toolGrant(MailList)).toMatchObject({ class: "irreversible-send", commit: "supervisor" })
    expect(toolDispatchDecision([toolGrant(MailList)], exampleContracts, list("inbox"))).toMatchObject({
      _tag: "AwaitSupervisor"
    })
  })

  it("refuses a grant on a private field, an unknown tool, or a non-read auto-commit", () => {
    // @ts-expect-error subject is not a public field of mail.send
    toolGrant(MailSend, { where: { subject: { equals: "hi" } } })
    // @ts-expect-error query is not a public field of mail.list
    toolGrant(MailList, { where: { query: { startsWith: "from:" } } })

    // The same grants arriving as data are rejected, and match nothing.
    const decode = Schema.decodeUnknownSync(ToolGrantPolicy)
    const onPrivate = decode({ tool: "mail.send", where: { body: { equals: "x" } } })
    expect(validateToolGrants([onPrivate], exampleContracts)).toMatchObject({
      field: "policy.toolGrants[0].where.body"
    })
    expect(validateToolGrants([decode({ tool: "mail.forward" })], exampleContracts)).toMatchObject({
      field: "policy.toolGrants[0].tool"
    })
    expect(
      validateToolGrants([decode({ tool: "label.add", class: "mutate", commit: "auto" })], exampleContracts)
    ).toMatchObject({ field: "policy.toolGrants[0].commit" })
    const valid = toolGrant(MailList, { class: "read", commit: "auto" })
    expect(toolDispatchDecision([valid, onPrivate], exampleContracts, list("inbox"))).toMatchObject({
      _tag: "AwaitSupervisor",
      reason: "policy tool grants are invalid"
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
