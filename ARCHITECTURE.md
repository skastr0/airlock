# Airlock architecture

This document describes the code as it is built. The code and its tests are
the source of truth; when they disagree with this file, this file is wrong.
Nothing here is a frozen rule. Properties Airlock relies on are enforced by
types and by tests, and each one below names the test that holds it.

## What Airlock is

Airlock runs agent code mode: an agent writes a small `.air` program, and
Airlock holds every call that program makes to a policy a person wrote. Each
call either runs at once, waits for a person, or is refused. It gives three
things for the effects routed through it:

- **Managed local changes are recoverable.** A replaced or removed file or
  directory is renamed into a hold, and can be restored until it is reaped.
- **External requests are two-phase.** A request is staged durably and sends
  nothing; a separate, authorized commit performs it exactly once. No request
  ever runs on its own.
- **Every act leaves a receipt** in an append-only ledger: one shape,
  `state: "done" | "staged" | "refused"`.

### The pipeline

Every program, on every host, goes through the same gates
(`packages/airlock/src/runner/ProgramRunner.ts`):

```
parse ──▶ check ──▶ review ──▶ run
```

Before anything runs, the program is **checked** against the granted tool
contracts (a program that does not type is `invalid_code`, and nothing has
run) and **reviewed** into a `ReviewedPlan` measured against the policy (a
refused plan is `review_refused`, and nothing has run). While it runs, each
call is held to its node in that Plan; a call the Plan does not describe ends
the run as `plan_mismatch`. A person can approve a Plan ahead of time, which
covers reads and fully fixed requests; content-dependent requests are approved
as an exact batch after they exist. [`docs/language.md`](docs/language.md)
describes this in full.

### Effect classes

A tool contract declares one effect class
(`packages/airlock/src/contract/ToolContract.ts`), which is also a Plan node kind
(`packages/airlock/src/plan/Plan.ts`):

| effect | what happens | may run at once |
|---|---|---|
| `capture` | information enters the program | yes, when granted |
| `invoke` | an existing executable runs, as separate executable and argument atoms | only in a confining profile |
| `apply` | managed local state changes through Hold | yes: Hold keeps what it replaces |
| `request` | an external request is staged in the Outbox | never: a person always decides |

### Execution profiles

`compatibility` runs a process with the invoking user's ambient authority; its
calls are not mediated, so a compatibility `process.run` may only ever run
when a person approves it. `native-contained` is an explicit opt-in that runs
computation in a private workspace with a platform sandbox (Seatbelt on macOS;
Bubblewrap, Landlock and seccomp on Linux) and merges what it changed back
through Hold. A profile is chosen by the policy a supervisor wrote; a program
cannot select one, and an unsupported one (`vm-enclosed`) is refused rather
than falling back.

With no policy file, the CLI grants the workspace's file tools only
(`packages/cli/src/cli.ts` `workspacePolicy`): a process or the network needs a
policy that grants it.

## Two halves: a kernel and a host

```
packages/airlock/       the kernel: storage-agnostic, runs anywhere Effect runs
packages/cloudflare/    the cloud host: Durable Object storage and RPC
packages/cli/           the local host: files, processes, the operating system, the CLI
```

### The kernel, `packages/airlock`

The kernel imports only `effect` and its own files. It names no Node or Bun
module, no platform package and no host global, so the same code runs under
Bun, in a browser-style isolate, or in a Cloudflare Worker. It is published as
`@skastr0/airlock`, with conformance suites and in-memory adapters at
`@skastr0/airlock/testing`.

It contains:

- **The pure modules**: `domain`, `plan`, `labels` (the confidentiality and
  integrity lattice), `language` (the `.air` lexer, parser, checker and
  evaluator).
- **`contract`**: tool contracts, the one receipt shape, trusted decoders and
  their proofs, flow rules, and role witnesses.
- **`session`**: the `ToolPolicy` document a supervisor writes, and the
  `ToolSession` that admits each call, expires grants, captures and stages.
- **`admission`**: grants, shared resource ceilings, and their matchers.
- **`review`**: the checker's facts lowered into the `ReviewedPlan` a
  supervisor approves and a run is held to.
- **`runner`**: the bounded program runner — parse, check, review, run — with
  fixed stop reasons and a hostile-corpus fuzz suite.
- **`Canonical`**: canonical JSON and SHA-256 digests over `effect/Crypto`.
  Identity and digests are computed here once, so every host derives the same
  value for the same content.
- **The Outbox kernel** (`outbox/`): the emission lifecycle, staging, commit,
  cancellation, capture, recovery and Ledger convergence.
- **The ports** the kernel needs from a host, as Effect services.

### Tool contracts and the session

A host declares its tools with `defineAirlock` and `defineToolContract`: a
name, a version, an effect class, the input and output schemas, which fields
are public, which fields are resources, and the flow facts — where a result's
label comes from, which argument fields are sinks, and which require a
decoder's proof. The kernel sees only this surface, plus the `GuestSurface`
boundary a program calls through.

A session is opened from a `ToolPolicy`: tool grants under a shared resource
ceiling per kind, a budget, sink policies, and named flow rules. Each call is
admitted against its grant; grants carry `validUntil` and stop forward work
when they lapse. The policy is a document: it can be stored, sealed, and named
by its digest (`packages/airlock/src/session/ToolPolicy.ts`, `ToolSession.ts`).

### The ports

| port | what it is | what a host supplies |
|---|---|---|
| `OutboxStore` | a transactional emission store: put-if-absent by id, read, compare-and-set transition, acknowledge, bounded response blob, list by state, and one `exclusive` section | durable storage and a way to serialize holders |
| `Ledger` | append-only receipts; a keyed entry is recorded exactly once however often it is recorded | durable append and read |
| `Dispatcher` | the wire: one handler per intent kind | the code that actually reaches the outside world |
| `effect/Crypto` | digests and randomness | the platform's implementation |

Time comes from the Effect `Clock`. A store adapter persists the records the
kernel hands it and returns them unchanged; it never encodes dispatch
material, hashes anything, or decides what a state contains. The kernel builds
every next record itself (`advance`, `acknowledge`), so the only thing an
adapter decides is how to make "read, change, write" atomic.

### The emission lifecycle

```
staged ──▶ committing ──▶ committed
   │            └───────▶ uncertain
   └──────▶ cancelled
```

One table (`outbox/Lifecycle.ts`) is the whole truth about which moves exist.
The store's `transition(id, from, arrival)` is typed by it, so an illegal move
does not compile (`test/core-typestate.test.ts`), and the same table drives
the runtime check.

- **Staging is replay-idempotent.** The caller supplies an idempotency key; the
  emission id is derived from it by digest. Staging the same key with the same
  content returns the existing emission in whatever state it has reached. The
  same key with different content is an `IdempotencyConflict`. A key is stored
  and listed, so it must not carry a URL or a secret.
- **`uncertain` is terminal.** Once a dispatch may have reached the wire and
  its result is unknown, Airlock never sends it again. A `committing` record
  found at startup is settled as `uncertain`.
- **The Ledger converges.** Each record remembers which of its receipts have
  been written. Any path that loads an emission writes the receipts it still
  owes first, so a lost Ledger append or a crash between the store and the
  Ledger is repaired on the next touch, without a second dispatch.

### Wire authority is a value

Reaching the outside world requires a `DispatchPermit`. The permit is minted
in exactly one place, the kernel's `commit`, and only after `staged →
committing` has been persisted; it is revoked when that dispatch settles. Its
brand never leaves the kernel module, so no other code can construct one.

A `Dispatcher` is a record with one handler per registered intent kind, and a
handler receives the permit with the request. A kind without a handler does
not compile. Before acting, a handler calls `consumePermit` with the kind and
canonical encoded dispatch: only the staged bytes match, and only one use can
succeed, even while the permit remains live. Checks run when the handler's
Effect executes, so an Effect built before revocation cannot act afterwards
(`test/core-permit.test.ts`, `test/http-dispatcher.test.ts`,
`test/security-dispatch-permit.test.ts`).

### Intent kinds

The set of things an Outbox can send is closed at the type level and extended
by declaration. An intent kind supplies a tag, the private dispatch schema,
the redacted public summary, the outcome schema, and the canonical target a
grant is matched against. `defineOutbox({ ...kinds })` returns the Outbox
service, its Dispatcher service and the kernel Layer for exactly those kinds.
HTTP is one kind (`outbox/HttpIntent.ts`); adding another is declaring it and
writing its handler, with no kernel edit.

### Conformance

Each port ships a suite in `packages/airlock/src/testing` that takes a Layer and registers
the invariant tests: durable put-if-absent, compare-and-set under races,
terminal states, response bound, exclusive sections, idempotent replay,
uncertain never retried, corrupt or tampered state failing closed, and a
crash-point sweep that loses each Ledger write and each mark in turn. The
suites take the test runner as an argument, so the kernel depends on no test
framework. An adapter is fit to run under the kernel when it passes them; the
in-memory reference adapters, this host's file adapters, and the Cloudflare
Durable Object adapters pass the same suites.

## The host

Everything shaped like a file, a process or an operating system lives outside
`packages/airlock/src`.

### Adapters for the kernel's ports, `src/host`

- **`FileOutboxStore`**: one directory per emission, named `<id>.<state>`,
  holding the record for that state, the sealed dispatch and the response
  capture. A state change writes and syncs what the new state needs inside the
  directory and then renames the directory; the rename is the compare-and-set,
  and a crash before it leaves the previous state intact. Sections and single
  operations are serialized across processes with kernel-held file leases.
- **`FileLedger`**: an fsynced JSONL journal under a cross-process lease. A
  torn final record that still decodes is completed; one that does not is
  quarantined beside the journal before the journal is shortened. The module
  provides the kernel's `Ledger` port and also a richer service that Hold and
  the CLI use to report those cases.
- **`HttpDispatcher`**: the handler for the HTTP kind and the only place in
  the repository that calls the network. It refuses a permit that is not live,
  never follows a redirect, and retains at most the kernel's response bound.

`src/Outbox.ts` composes them: the kernel for this host's kinds over the file
store, the file ledger and the HTTP handler.

### Hold

Hold is a host component: its subject is filesystem bytes. A managed change is
a rename into `hold/<act>/`, journaled so that a crash between the rename and
the receipt is reconciled at the next start. `Hold.reap` is the only place a
retained payload is deleted, and it refuses anything kept for fewer than seven
days — the time every `done` receipt promises in its `heldUntil`. Reviewed
changes (`src/change`) freeze a candidate and a baseline, apply by exact
digest, and undo against what was installed.

### This machine, and the CLI

- **Filesystem tools** (`src/host/FilesystemTools.ts`) implement the file
  contracts, `process.run`, `http.get` and `http.stage`: file changes through
  Hold, a contained process in a Cell whose changes merge back through Hold,
  a read over the wire, a request only staged.
- **Filesystem host** (`src/host/FilesystemHost.ts`) binds every path and
  executable a call names to the physical object it means, and decides which
  grants may run at once on this machine.
- **The CLI** (`airlock`, `airlock-agent`) is a client of the kernel, like
  Cloudflare: it runs and reviews `.air` programs, and the person's binary
  alone has the deciding verbs (`pending`, `inspect`, `commit`, `cancel`,
  `undo`, `reap`, `ledger`, `approve-plan`). `airlock-agent` has no command
  that decides. A verified seal pins the policy and narrows the command graph
  to what the operator signed; no seal can grant a deciding verb
  (`test/cli.test.ts`, `test/sealed-cli.test.ts`, `test/seal-startup.test.ts`).

### The Cloudflare host

`packages/cloudflare` is a second host over the same kernel
(`@skastr0/airlock-cloudflare`):

- **`DurableOutboxStore` / `DurableLedger`** put the OutboxStore and Ledger
  ports over Durable Object SQLite storage. They run the kernel's conformance
  suites inside workerd, including the crash-point sweep
  (`packages/cloudflare/test/cloudflare-durable.test.ts`).
- **`AirlockObject`** is the Durable Object a user's Worker exports: it holds
  the contracts, the implementations and the policy, evaluates one program at
  a time with a bounded waiting line, and exposes the supervisor routes
  (`approve`, `cancel`) and the guest routes (`describe`, `run`, `review`).
  There is no second isolate and no loader: `.air` is evaluated inside the
  object. The routes have no built-in login; putting one in front is the
  owner's job.
- **`src/alchemy`** is the deploy-side recipe (`airlockBindings`) for Alchemy
  users; it is not part of the runtime package.
- `examples/cloudflare` is the end-to-end walk: contracts, implementations, a
  policy, and a triage program run against a live deployment.

## Properties and the tests that hold them

| property | held by |
|---|---|
| The kernel imports only `effect` and itself, and names no host global | `test/core-boundary.test.ts` |
| The kernel bundles with no Node built-in and runs with no `process`, `Bun`, `Buffer` or `require` | `scripts/prove-core-portable.ts` (part of `bun run verify`) |
| `./core` and `./core/testing` work by package name with no platform Layer | `test/core-exports.test.ts` |
| Illegal lifecycle moves, a missing handler and a handwritten permit do not compile | `test/core-typestate.test.ts` |
| A permit is minted in one place, after the committing transition, and revoked after | `test/core-permit.test.ts` |
| Exactly one network call exists, in the host HTTP handler, after the permit check; none in the kernel | `test/authority-sites.test.ts` |
| Exactly one deletion site exists, in `Hold.reap` | `test/authority-sites.test.ts` |
| Every program is checked and reviewed before anything runs, and a call outside the Plan ends the run | `test/language-check.test.ts`, `test/core-plan-approval.test.ts`, `test/cloudflare-durable.test.ts` |
| A grant can only narrow its policy's ceilings, and a request is never `now`, even when it declares compensation | `test/core-tool-grants.test.ts`, `test/core-resource-policy.test.ts`, `test/core-tool-contracts.test.ts` |
| The file store, the file ledger and the two together satisfy the kernel's ports | `test/file-outbox-store.test.ts`, `test/file-ledger.test.ts`, `test/file-outbox.test.ts` |
| The Durable Object adapters pass the same conformance suites, including restart recovery | `test/cloudflare-durable.test.ts` |
| Hostile and generated programs end in fixed reasons and leak no host text | `test/security-program-runner-fuzz.test.ts` |
| The HTTP wire sends nothing at staging, refuses forged and settled permits, does not follow redirects, bounds the response, and keeps header values, query values and the body out of everything but the sealed dispatch | `test/http-dispatcher.test.ts` |

`bun run verify` runs the typecheck, the test suite, the Bun and platform
integration gates, and the portability proofs.

## Adding to Airlock

- **A new host** (for example another cloud): write Layers for
  `OutboxStore`, `Ledger`, the `Dispatcher` handlers and `effect/Crypto`, and
  run the conformance suites against them. Nothing in `packages/airlock/src` changes; the
  Cloudflare host in `src/cloudflare` is the worked example.
- **A new thing to send**: declare an intent kind, add it to `defineOutbox`,
  and write its handler. The compiler lists every place that must change.
- **A new tool**: declare its contract (name, version, effect, schemas,
  resources, flow facts) and write its implementation on the host. A policy
  grants it; until then it does not exist for a program.
- **A new restriction**: a narrower grant or a new ceiling in the policy. A
  grant can only narrow; the default stays workspace-only.

## Further reading

- [`docs/usage.md`](docs/usage.md): the language, the policy and the person's
  commands.
- [`docs/language.md`](docs/language.md): the type system, review, and its
  roadmap.
- [`docs/decisions.md`](docs/decisions.md): the decision log.
- [`docs/changes.md`](docs/changes.md): reviewed local changes.
- [`docs/security-model.md`](docs/security-model.md): what is and is not
  defended.
- [`docs/macos-v1.md`](docs/macos-v1.md), [`docs/linux-v1.md`](docs/linux-v1.md):
  the platform sandboxes.
- [`docs/rfc`](docs/rfc) and [`docs/evidence`](docs/evidence): design history
  and recorded proof runs. They describe what was true when they were written.
