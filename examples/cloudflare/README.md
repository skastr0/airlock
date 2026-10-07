# Airlock on Cloudflare

An agent's code runs in a throwaway isolate with no network and no secrets.
The only things it can touch are the tools you grant it. Reads happen at once;
writes wait until a supervisor commits them. Everything is recorded, and a run
that is executed again gets its recorded results instead of acting twice.

You write three things:

| File | What it is | Lines |
| --- | --- | --- |
| `src/contracts.ts` | What each tool takes and returns | 43 |
| `src/airlock.ts` | What each tool does, and what the guest may do | 58 |
| `src/worker.ts` | The Durable Object export and your trusted routes | 38 |

All three import from `@skastr0/airlock/cloud` and nothing else.

## What guest code looks like

```js
const inbox = await tools.mail.list({ mailbox: "inbox", query: "is:unread" });
const draft = await tools.mail.send({
  to: "ada@example.com",
  subject: "Unread mail",
  body: "You have " + inbox.ids.length + " unread messages."
});
return { unread: inbox.ids.length, waiting: draft.id };
```

`tools.mail.list` returns the mail. `tools.mail.send` returns a receipt
(`{ staged: true, id, ... }`): nothing has been sent. `GET /tools` returns a
TypeScript declaration and a short description of exactly the granted tools,
ready to put in a prompt.

## Run it locally

The example is proven in real workerd, the runtime Cloudflare runs, by a test
in this repository:

```sh
git clone https://github.com/skastr0/airlock && cd airlock
bun install
bunx vitest run test/cloud-example.test.ts
```

That test bundles `src/worker.ts` unchanged, starts workerd with a SQLite
Durable Object bound as `AIRLOCK`, a Worker Loader bound as `LOADER` and a
`MAIL_TOKEN` variable, and walks the flow below. No `nodejs_compat` flag is
needed.

## The flow

| Request | What happens |
| --- | --- |
| `GET /tools` | What the guest can call |
| `POST /run` `{ "runId", "source" }` | Runs guest source in a fresh isolate. The same `runId` again replays recorded results |
| `GET /pending` | Writes waiting for a decision |
| `POST /commit` `{ "id" }` | Sends one. A second commit answers `not-pending` |
| `POST /cancel` `{ "id" }` | Drops one |
| `POST /compensate` `{ "id" }` | Stages the declared undo of a committed write |
| `GET /mailbox` | What the stand-in mail service saw |

Whoever can reach these routes is the supervisor. Put your own authentication
in front of them.

## What the guest cannot do

Each of these is checked in workerd by `test/cloud-durable.test.ts`:

- reach the network (`fetch`, sockets), read a binding or a secret, import a
  Node module;
- call a tool the policy does not grant: it is not on `tools` at all;
- call a granted tool outside its grant: it gets a sentence such as
  ``mail.send is not allowed: `to` is not allowed by grant "company-mail"``;
- exceed the policy's call budget, send an oversized input, or return anything
  but bounded plain JSON: the run fails with a fixed reason code.

## Limits you should know

- **Worker Loader needs a paid Workers plan.** Cloudflare refuses the binding
  on a free plan at deploy time.
- **CPU limits are enforced by production Cloudflare, not by local workerd.**
  A guest stuck in a synchronous loop is stopped in production; on your
  machine it is not.
- **The deadline revokes, it does not kill.** When a run passes its wall-clock
  limit the host stops waiting and the guest's tools stop working. That is not
  proof the isolate stopped running.
- **The mail service here is a stand-in.** `src/airlock.ts` shows where a real
  call goes, with `env.MAIL_TOKEN` and the idempotency key.
- **Deployment is not covered yet.** An Alchemy recipe that declares the
  bindings is planned; nothing in this example deploys anything.
