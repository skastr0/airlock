# Airlock on Cloudflare

A code mode backed by Airlock. Your agent writes an **Airlock program (.air)**
instead of calling tools one at a time. The program can do one thing to the
world: call the actions you grant it. Reads happen at once; writes are only
recorded until a supervisor commits them. Everything is in a ledger, and a
program that is run again gets its recorded results instead of acting twice.

A read is recorded as one entry. By default Airlock keeps only a digest of
what was read, and a program run again reads again and fails if the answer
changed; a grant with `retention: "keep"` stores the result, so a second run
gets the first run's answer. The example keeps its mail reads.

Nothing leaves the system without a person. Each grant says when its tool
runs: `when: "now"` for reading, `when: "approved"` for everything that
changes something outside. Airlock refuses a policy that grants a request
`now`, so no policy, replay or timer can send mail or add a label by itself.

The language has no network, no file system, no imports and no way to name a
secret, so a program needs no sandbox: it is evaluated inside your Durable
Object, next to the Outbox that holds what it stages.

You write four files:

| File | What it is | Lines |
| --- | --- | --- |
| `src/contracts.ts` | What each tool takes and returns | 61 |
| `src/airlock.ts` | What each tool does, and what a program may do | 72 |
| `src/worker.ts` | The Durable Object export and your trusted routes | 44 |
| `alchemy.run.ts` | The Worker and its binding on Cloudflare | 24 |

The three Worker files import from `@skastr0/airlock/cloudflare` and nothing
else. `alchemy.run.ts` adds `@skastr0/airlock/alchemy`, Alchemy and Effect.
`local.ts` is tooling that runs the example on your machine; you would not
write it. `triage.air` is a program an agent might write.

## What a program looks like

`triage.air`:

```
let inbox = mail.list({ mailbox: "inbox" })
assert inbox.state == "done", "the inbox could not be read"

for message in inbox.result.messages {
  if message.unread && message.from == "billing@example.com" {
    let full = mail.read({ id: message.id })
    if full.state == "done" {
      label.add({ messageId: message.id, label: "billing" })
      mail.send({
        to: "finance@example.com",
        subject: "Fwd: " + full.result.subject,
        body: full.result.body
      })
    }
  }
}

return { triaged: "inbox", seen: inbox.result.messages }
```

Every call returns a receipt, and the program checks its `state` before it
reads anything else. `mail.list` and `mail.read` are granted `now`, so their
receipts are `done` and carry a `result`. `label.add` and `mail.send` are
granted `approved`: their receipts are `staged`, with an id and no result.
Nothing has been labelled or sent, and both wait in `GET /pending`. A call
outside the grants returns a `refused` receipt that says why.

`GET /tools` returns the granted actions, their input and result shapes, which
of them are staged, and a short description of the language, ready to put in
a prompt.

## Run it locally

No Cloudflare account is needed. This starts the Worker in workerd, the
runtime Cloudflare runs, with a SQLite Durable Object and a `MAIL_TOKEN`
variable:

```sh
git clone https://github.com/skastr0/airlock && cd airlock
bun install
bun examples/cloudflare/local.ts
```

Then, in another terminal:

```sh
cd examples/cloudflare
curl localhost:8787/tools
jq -n --rawfile source triage.air '{ runId: "run-1", source: $source }' | curl -X POST localhost:8787/run -d @-
curl localhost:8787/pending
curl -X POST localhost:8787/commit -d '{"id":"<an id from /pending>"}'
curl localhost:8787/mailbox
```

`PORT=9000 bun examples/cloudflare/local.ts` picks another port. The same
setup is walked by a test, `bunx vitest run test/cloudflare-example.test.ts`.
No `nodejs_compat` flag is used anywhere.

## Deploy it

`alchemy.run.ts` declares the Worker. The Airlock part of it is one line,
`...airlockBindings()`, which adds the Durable Object (bound as `AIRLOCK`,
class `Airlock`, SQLite-backed). `airlockBindings({ object, className })`
renames it. There is no other binding: no loader and no second Worker.

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
| `GET /tools` | What a program can call, and how to write one |
| `POST /run` `{ "runId", "source" }` | Runs an Airlock program. The same `runId` again replays recorded results |
| `GET /pending` | Writes waiting for a decision |
| `POST /commit` `{ "id" }` | Sends one. A second commit answers `not-pending` |
| `POST /cancel` `{ "id" }` | Drops one |
| `POST /compensate` `{ "id" }` | Stages the declared undo of a committed write |
| `GET /mailbox` | What the stand-in mail service saw |

Whoever can reach these routes is the supervisor. Put your own authentication
in front of them.

## What a program cannot do

Each of these is checked in workerd by `test/cloudflare-durable.test.ts` and
`test/security-isolated-runner.test.ts`:

- reach the network, a cache, a binding or a secret: `fetch(...)` is just an
  action nobody granted, and `env.MAIL_TOKEN` is a name that is not bound;
- call a tool the policy does not grant, or a granted tool outside its grant.
  Nothing happens, and the program gets a `refused` receipt with a sentence
  such as ``mail.send is not allowed: `to` is not allowed by grant "company-mail"``;
- exceed the policy's call budget, loop past the iteration budget, build a
  value past the size limits, send an oversized input or return an oversized
  result: the run fails with a fixed reason code;
- leak through an error: a failure carries a reason, a line and a column,
  never the program's own text.

## Limits you should know

- **A refusal is a receipt; a fault ends the program.** A program can branch
  on a `refused` receipt. A call that may have acted without Airlock knowing
  the result, or a host that cannot answer, ends the run with the reason
  `tool_failed`. The language has no way to catch that. Running the program
  again under the same `runId` returns the recorded results of calls that
  already ran.
- **The language is small.** There is no reassignment and a `let` inside a
  loop ends with the loop, so a program cannot build up a list or a count. It
  can read, branch, act on each item of a list, and return what it found.
- **A program runs in your Durable Object, not in an isolate.** What it
  computes is bounded by a step budget and a loop budget, and what it holds
  by size limits, so it cannot run forever or outgrow the object. One program
  runs at a time per object; a few wait and the rest are told to try again.
- **The mail service here is a stand-in.** `src/airlock.ts` shows where a real
  call goes, with `env.MAIL_TOKEN` and the idempotency key.
