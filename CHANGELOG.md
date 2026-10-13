# Changelog

## 0.1.0

The first published release.

- **The `.air` language.** A small typed language an agent writes instead of
  calling tools one at a time. A whole program is checked before anything
  runs: an unknown tool or field, a wrong type or a call the policy cannot
  grant fails with the line and column, and no call is made. Every call
  returns one receipt, `done`, `staged` or `refused`, and a program may read
  a result only where it is known to be `done`. Each run has budgets for calls,
  input, results, loops, steps, values, output and time.
- **One policy.** A person names each tool a program may call, whether it runs
  at once (`now`) or waits for a person (`approved`), and the paths,
  executables and endpoints every call must fall inside. A request that sends
  anything out (`http.stage`) never runs at once; `http.get` only reads a
  granted endpoint, with no body and no query.
- **Review before running.** `airlock review` shows a program's Plan and its
  refusals without running it; `airlock approve-plan` approves that Plan once.
- **The person's commands.** `pending`, `inspect`, `commit`, `cancel`, `undo`,
  `reap` and `ledger`. `airlock-agent` has none of the commands that decide.
- **Recoverable changes.** File changes go through Hold, so `undo` puts back
  what a call replaced. Outbox stages a request and sends it exactly once,
  after a person commits it. Every act is recorded in an append-only Ledger.
- **Contained processes.** `process.run` with the `native-contained` profile
  runs in a private copy of the workspace with no network (Seatbelt on macOS;
  Bubblewrap, Landlock and seccomp on Linux) and merges back through Hold.
- **Sealed installs** pin the policy and commands into a signed grant.
- **Reviewed local changes** with `airlock change`.
- **Cloudflare.** `@skastr0/airlock/cloudflare` runs the same programs in a
  Durable Object over the same kernel, and `@skastr0/airlock/alchemy` declares
  its bindings for an Alchemy stack.
- **A portable kernel.** `@skastr0/airlock/core` imports only `effect`, and
  `@skastr0/airlock/core/testing` ships conformance suites for any host's
  storage.
