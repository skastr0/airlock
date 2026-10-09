# Airlock on Cloudflare

An agent's code runs in a throwaway isolate with no network and no secrets.
The only things it can touch are the tools you grant it. Reads happen at once;
writes wait until a supervisor commits them. Everything is recorded, and a run
that is executed again gets its recorded results instead of acting twice.

You write four files:

| File | What it is | Lines |
| --- | --- | --- |
| `src/contracts.ts` | What each tool takes and returns | 43 |
| `src/airlock.ts` | What each tool does, and what the guest may do | 58 |
| `src/worker.ts` | The Durable Object export and your trusted routes | 38 |
| `alchemy.run.ts` | The Worker and its bindings on Cloudflare | 24 |

The three Worker files import from `@skastr0/airlock/cloudflare` and nothing
else. `alchemy.run.ts` adds `@skastr0/airlock/alchemy`, Alchemy and Effect.
`local.ts` is tooling that runs the example on your machine; you would not
write it.

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

No Cloudflare account is needed. This starts the Worker in workerd, the
runtime Cloudflare runs, with a SQLite Durable Object, a Worker Loader and a
`MAIL_TOKEN` variable:

```sh
git clone https://github.com/skastr0/airlock && cd airlock
bun install
bun examples/cloudflare/local.ts
```

Then, in another terminal:

```sh
curl localhost:8787/tools
curl -X POST localhost:8787/run -d '{"runId":"run-1","source":"return await tools.mail.send({ to: \"ada@example.com\", subject: \"Hello\", body: \"Hi\" })"}'
curl localhost:8787/pending
curl -X POST localhost:8787/commit -d '{"id":"<the id from /pending>"}'
curl localhost:8787/mailbox
```

`PORT=9000 bun examples/cloudflare/local.ts` picks another port. The same
setup is walked by a test, `bunx vitest run test/cloudflare-example.test.ts`.
No `nodejs_compat` flag is used anywhere.

## Deploy it

`alchemy.run.ts` declares the Worker. The Airlock part of it is one line,
`...airlockBindings()`, which adds the Durable Object (bound as `AIRLOCK`,
class `Airlock`, SQLite-backed) and the Worker Loader (bound as `LOADER`).
`airlockBindings({ object, loader, className })` renames them.

```sh
cd examples/cloudflare
bun --bun ../../node_modules/alchemy/bin/cli.js profile edit --profile default --add Cloudflare
MAIL_TOKEN=... bun --bun ../../node_modules/alchemy/bin/cli.js deploy
```

Alchemy needs a Cloudflare account for `deploy` and for its own `dev`
command, which is why the local run above does not go through it. This
repository has never deployed the example: the recipe is checked by loading
the stack and by starting workerd from the same bindings, not against a live
account.

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

Each of these is checked in workerd by `test/cloudflare-durable.test.ts`:

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
