import { type Crypto, Effect, Layer } from "effect"
import { toolGrant } from "../admission/ToolGrant.ts"
import { Ledger } from "../ledger/Ledger.ts"
import type { DispatchHandlers } from "../outbox/Dispatcher.ts"
import { defineOutbox } from "../outbox/Outbox.ts"
import type { OutboxStore } from "../outbox/OutboxStore.ts"
import { DispatchProvenance } from "../outbox/Records.ts"
import { toolPolicy, toolPolicyDigest } from "../session/ToolPolicy.ts"
import { openToolSession } from "../session/ToolSession.ts"
import { exampleContracts, LabelAdd, MailList, MailSend } from "./ExampleContracts.ts"

/**
 * The whole path a hosted guest takes, end to end, on whatever adapters it is
 * given. It is the reference a new adapter or a new host wiring is checked
 * against: run it, and the transcript must equal `expectedTranscript`.
 *
 *   1. A session is opened from a fixed set of grants.
 *   2. The guest runs: a read is performed, a send and a label add are staged.
 *   3. A supervisor commits the send and the label add.
 *   4. The supervisor answers the label add with its compensation and commits it.
 *   5. The guest is executed again from the top under the same run id, after a
 *      restart. It gets the recorded read and the same receipts, and nothing is
 *      sent a second time.
 */

const mail = defineOutbox(exampleContracts)
type Handlers = DispatchHandlers<typeof mail.kinds>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The far side: a mailbox that counts how often each tool really ran. */
const makeMailbox = () => {
  const dispatched: Array<string> = []
  const done = <Outcome>(tool: string, outcome: Outcome, body: string) =>
    Effect.sync(() => {
      dispatched.push(tool)
      return { outcome, response: encoder.encode(body), truncated: false }
    })
  const handlers: Handlers = {
    "mail.list": ({ dispatch }) => done("mail.list", { ids: ["m-1", "m-2"] }, `2 messages in ${dispatch.mailbox}`),
    "mail.send": () => done("mail.send", { messageId: "sent-1" }, "queued"),
    "label.add": () => done("label.add", { added: true }, "labelled"),
    "label.remove": () => done("label.remove", { removed: true }, "unlabelled")
  }
  return { dispatched, handlers }
}

/** What the supervisor allows this guest: read the inbox freely, send only inside the company. */
const policy = toolPolicy({
  budget: { maxCalls: 8, maxInputBytes: 4_096 },
  toolGrants: [
    toolGrant(MailList, { id: "read-inbox", class: "read", commit: "auto", where: { mailbox: { equals: "inbox" } } }),
    toolGrant(MailSend, { id: "send-inside-company", where: { to: { endsWith: "@example.com" } } }),
    toolGrant(LabelAdd, { id: "label-messages", class: "mutate" })
  ]
})

const bySupervisor = new DispatchProvenance({ committedBy: "supervisor" })

export interface WorkedExampleAdapters {
  readonly store: Layer.Layer<OutboxStore, unknown>
  readonly ledger: Layer.Layer<Ledger, unknown>
  readonly crypto: Layer.Layer<Crypto.Crypto, unknown>
}

export const runWorkedExample = (adapters: WorkedExampleAdapters) =>
  Effect.gen(function* () {
    const mailbox = makeMailbox()
    /** One process lifetime. Calling it again is a restart over the same state. */
    const lifetime = <A, E>(
      body: Effect.Effect<A, E, typeof mail.Outbox.Identifier | Crypto.Crypto | Ledger>
    ) =>
      body.pipe(
        Effect.provide(
          mail.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                adapters.store,
                adapters.ledger,
                adapters.crypto,
                Layer.succeed(mail.Dispatcher, mailbox.handlers)
              )
            )
          )
        )
      )

    /** The guest program. It only ever sees the session. */
    const guest = Effect.gen(function* () {
      const session = yield* openToolSession(mail, {
        runId: "guest-run-1",
        policy
      })
      const listed = yield* session["mail.list"]({ mailbox: "inbox", query: "is:unread" })
      const sent = yield* session["mail.send"]({
        to: "ada@example.com",
        subject: "unread count",
        body: listed._tag === "Performed" ? `you have ${listed.outcome.ids.length}` : "unknown"
      })
      const labelled = yield* session["label.add"]({ messageId: "m-1", label: "triaged" })
      return {
        tools: Object.keys(session).sort(),
        listed: listed._tag === "Performed"
          ? { tag: listed._tag, ids: listed.outcome.ids, response: decoder.decode(listed.response) }
          : { tag: listed._tag },
        sent: { tag: sent._tag, state: sent.state, public: sent.summary.public },
        labelled: { tag: labelled._tag, state: labelled.state },
        ids: { sent: sent.id, labelled: labelled.id }
      }
    })

    // 1–2. The guest runs for the first time.
    const first = yield* lifetime(guest)
    const afterGuest = [...mailbox.dispatched]

    // 3–4. The supervisor acts on what the guest staged.
    const supervised = yield* lifetime(
      Effect.gen(function* () {
        const outbox = yield* mail.Outbox
        const sent = yield* outbox.commit(first.ids.sent, bySupervisor)
        const labelled = yield* outbox.commit(first.ids.labelled, bySupervisor)
        if (labelled.kind !== "label.add") return yield* Effect.die("the staged call was a label add")
        const answer = yield* outbox.compensate(labelled, { holdMillis: 0 })
        const answeredTwice = yield* outbox.compensate(labelled, { holdMillis: 0 })
        const removed = yield* outbox.commit(answer.id, bySupervisor)
        return {
          sent: sent.state,
          labelled: labelled.state,
          answer: { kind: answer.kind, compensates: answer.compensates === labelled.id },
          sameAnswer: answeredTwice.id === answer.id,
          removed: removed.state
        }
      })
    )

    // 5. The guest is executed again from the top, after a restart.
    const replay = yield* lifetime(guest)
    // Every emission the session staged names the policy and grant that admitted it.
    const admitted = yield* lifetime(
      Effect.gen(function* () {
        const outbox = yield* mail.Outbox
        const digest = yield* toolPolicyDigest(policy)
        const sent = yield* outbox.inspect(first.ids.sent)
        const labelled = yield* outbox.inspect(first.ids.labelled)
        return {
          underThisPolicy:
            sent.admission?.policyDigest === digest && labelled.admission?.policyDigest === digest,
          sent: sent.admission?.grantIds,
          labelled: labelled.admission?.grantIds
        }
      })
    )
    const receipts = yield* lifetime(
      Effect.map(Effect.flatMap(Ledger, (ledger) => ledger.entries), (entries) =>
        entries.map((entry) => entry.act))
    )

    return {
      tools: first.tools,
      first: { listed: first.listed, sent: first.sent, labelled: first.labelled },
      dispatchedByGuest: afterGuest,
      supervised,
      replay: { listed: replay.listed, sent: replay.sent, labelled: replay.labelled },
      sameEmissions: replay.ids.sent === first.ids.sent && replay.ids.labelled === first.ids.labelled,
      admitted,
      dispatched: [...mailbox.dispatched],
      receipts
    }
  })

/** What `runWorkedExample` returns on any conforming adapters. */
export const expectedTranscript = {
  tools: ["label.add", "mail.list", "mail.send"],
  first: {
    listed: { tag: "Performed", ids: ["m-1", "m-2"], response: "2 messages in inbox" },
    sent: { tag: "Staged", state: "staged", public: { to: "ada@example.com" } },
    labelled: { tag: "Staged", state: "staged" }
  },
  dispatchedByGuest: ["mail.list"],
  supervised: {
    sent: "committed",
    labelled: "committed",
    answer: { kind: "label.remove", compensates: true },
    sameAnswer: true,
    removed: "committed"
  },
  replay: {
    listed: { tag: "Performed", ids: ["m-1", "m-2"], response: "2 messages in inbox" },
    sent: { tag: "Staged", state: "committed", public: { to: "ada@example.com" } },
    labelled: { tag: "Staged", state: "committed" }
  },
  sameEmissions: true,
  admitted: { underThisPolicy: true, sent: ["send-inside-company"], labelled: ["label-messages"] },
  dispatched: ["mail.list", "mail.send", "label.add", "label.remove"],
  receipts: ["stage", "commit", "stage", "stage", "commit", "commit", "stage", "commit"]
} as const
