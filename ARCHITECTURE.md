# Airlock architecture

This document describes the code as it is built. The code and its tests are
the source of truth; when they disagree with this file, this file is wrong.
Nothing here is a frozen rule. Properties Airlock relies on are enforced by
types and by tests, and each one below names the test that holds it.

## What Airlock is

Airlock is an optional tool for consequential work an agent does on a machine.
It sits beside Bash, Python and ordinary Unix programs rather than replacing
them, and gives three things for the effects routed through it:

- **Managed local changes are recoverable.** A replaced or removed file or
  directory is renamed into a hold, and can be restored until it is reaped.
- **External requests are two-phase.** A request is staged durably and sends
  nothing; a separate, authorized commit performs it exactly once.
- **Every act leaves a receipt** in an append-only ledger.

Work is expressed as a Plan over four node kinds, one per effect class:

| effect class | Plan node | what happens |
|---|---|---|
| observation | `Capture` | information enters the program |
| computation | `Invoke` | an existing executable runs, as separate executable and argument atoms |
| mutation | `Apply` | managed local state changes through Hold |
| emission | `RequestExternal` | an external request is staged in the Outbox |

Execution has profiles. `compatibility` is the zero-configuration default and
is Bash parity: a child process keeps the invoking user's ambient authority,
and what it does on its own is not mediated. `native-contained` is an explicit
opt-in that runs computation in a private workspace with a platform sandbox
(Seatbelt on macOS; Bubblewrap, Landlock and seccomp on Linux). Restrictions
are opt-in; the default never becomes stricter than Bash.

## Two halves: a kernel and a host

```
src/core/     the kernel: storage-agnostic, runs anywhere Effect runs
src/          the host: files, processes, the operating system, the CLI
```

### The kernel, `src/core`

The kernel imports only `effect` and its own files. It names no Node or Bun
module, no platform package and no host global, so the same code runs under
Bun, in a browser-style isolate, or in a Cloudflare Worker. It is published as
`@skastr0/airlock/core`, with conformance suites and in-memory adapters at
`@skastr0/airlock/core/testing`.

It contains:

- **The pure modules**: `domain`, `plan`, `labels`, `language` (the `.air`
  parser and evaluator), `admission` (policy, grants, dispatch classes),
  `actions` (the native action catalog) and `tools` (tool definitions and
  their lowering to Plans).
- **`Canonical`**: canonical JSON and SHA-256 digests over `effect/Crypto`.
  Identity and digests are computed here once, so every host derives the same
  value for the same content.
- **The Outbox kernel** (`outbox/`): the emission lifecycle, staging, commit,
  cancellation, recovery and Ledger convergence.
- **The ports** the kernel needs from a host, as Effect services.

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
HTTP is one kind (`outbox/HttpIntent.ts`); adding another, such as a typed
tool action, is declaring it and writing its handler, with no kernel edit.

### Conformance

Each port ships a suite in `src/core/testing` that takes a Layer and registers
the invariant tests: durable put-if-absent, compare-and-set under races,
terminal states, response bound, exclusive sections, idempotent replay,
uncertain never retried, corrupt or tampered state failing closed, and a
crash-point sweep that loses each Ledger write and each mark in turn. The
suites take the test runner as an argument, so the kernel depends on no test
framework. An adapter is fit to run under the kernel when it passes them; the
in-memory reference adapters and this host's file adapters pass the same
suites.

## The host

Everything shaped like a file, a process or an operating system lives outside
`src/core`.

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
retained payload is deleted. Reviewed changes (`src/change`) freeze a
candidate and a baseline, apply by exact digest, and undo against what was
installed.

### Runtime, Program, CLI and daemon

- **Runtime** interprets an admitted Plan node by node: `Capture` and `Apply`
  through the native filesystem and Hold, `Invoke` through the process runner
  or a Cell, `RequestExternal` by staging in the Outbox (and committing inline
  only when the supervisor's policy pre-authorized that node).
- **Program** runs `.air` source: each action becomes a Plan fragment that is
  admitted and executed, and its result is projected back to the language.
- **CLI** (`airlock`, `airlock-agent`) is glue over those components. A
  verified seal narrows the command graph to what the operator signed.
- **Daemon** is the sealed supervisor loop: it commits pre-authorized read
  emissions and reaps, re-verifying the seal immediately before each terminal
  act.

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
| The file store, the file ledger and the two together satisfy the kernel's ports | `test/file-outbox-store.test.ts`, `test/file-ledger.test.ts`, `test/file-outbox.test.ts` |
| The HTTP wire sends nothing at staging, refuses forged and settled permits, does not follow redirects, bounds the response, and keeps header values, query values and the body out of everything but the sealed dispatch | `test/http-dispatcher.test.ts` |

`bun run verify` runs the typecheck, the test suite, the Bun and platform
integration gates, and the portability proof.

## Adding to Airlock

- **A new host** (for example a Durable Object): write Layers for
  `OutboxStore`, `Ledger`, the `Dispatcher` handlers and `effect/Crypto`, and
  run the three conformance suites against them. Nothing in `src/core`
  changes.
- **A new thing to send**: declare an intent kind, add it to `defineOutbox`,
  and write its handler. The compiler lists every place that must change.
- **A new restriction**: make it an opt-in profile or flag. The default stays
  Bash parity.

## Further reading

- [`docs/usage.md`](docs/usage.md): the language, actions, profiles and policy.
- [`docs/changes.md`](docs/changes.md): reviewed local changes.
- [`docs/security-model.md`](docs/security-model.md): what is and is not
  defended.
- [`docs/macos-v1.md`](docs/macos-v1.md), [`docs/linux-v1.md`](docs/linux-v1.md):
  the platform sandboxes.
- [`docs/rfc`](docs/rfc) and [`docs/evidence`](docs/evidence): design history
  and recorded proof runs. They describe what was true when they were written.
