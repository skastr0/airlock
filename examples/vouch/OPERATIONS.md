# Vouch as Airlock's first adoption corpus

This inventory translates the real state-preserving replacement flow in
`../vouch/assets/box-runtime-v1.py` into Airlock's generic machine physics.
Vouch supplies workload evidence, never Airlock vocabulary.

The executable proof is [`../../scripts/prove-vouch.ts`](../../scripts/prove-vouch.ts).
It is deliberately safe: a fixed state archive and `/usr/bin/tar` operate in a
native-contained private workspace, while a `.invalid` replacement endpoint is
staged but never dispatched. It does not touch Vouch, OpenShell, a sandbox, or
the network.

## Concrete translation

| Vouch machine operation | Structured Airlock expression | Existing implementation remains owned by |
|---|---|---|
| inspect `hermes-state.tgz` | `file.inspect({ path: local_archive })` | filesystem |
| invoke `openshell sandbox upload ...` | `process.run({ executable: openshell, args: [...], cwd: workspace, stdin: "discard" })` | OpenShell |
| invoke remote Python restore | structured `process.run` of OpenShell, whose argv names `/usr/bin/python3` and the helper; the remote command is not a local descendant grant | OpenShell and Python |
| inspect command exit, stdout, stderr | named `Invoke` stream artifacts plus its receipt | Airlock process seam |
| parse and validate the last JSON line | pure program computation over the JSON receipt file | Airlock language/program |
| extract tar members | structured `Invoke` of `/usr/bin/tar`, or of the existing Python helper when collision-skipping semantics are required | tar or Python |
| create an online SQLite snapshot | structured `Invoke` of the existing helper or `sqlite3` executable | SQLite/Python |
| download a sandbox artifact | structured `Invoke` of OpenShell | OpenShell |
| replace a live local backup | `process.run` against a private Cell, then `file.copy` / `Apply.merge` | Cell proposes; Hold installs |
| remove or replace managed local state | `file.copy` / `file.move` / `file.write`; displaced bytes enter Hold | Hold |
| delete/recreate a remote machine | `http.stage`, then a privileged Outbox commit | remote realm adapter |
| poll health with a deadline | bounded program control over repeated structured invocations | Airlock program/runtime |
| retain a durable receipt | Plan node receipts plus Hold/Outbox Ledger entries | Airlock runtime |

No row requires `archive.extract`, `sqlite.backup`, `sandbox.upload`, or another
Vouch-shaped Airlock action. Application semantics stay in the existing
programs. Airlock owns admission, execution bounds, local finality, external
staging, and evidence.

## What the runnable proof covers

The proof executes one admitted Plan with all four candidate Plan nodes:

1. `Capture` reads a state archive through an explicit path grant.
2. The archive artifact becomes stdin to `Invoke`; `/usr/bin/tar -xzf -`
   receives bytes through explicit Plan dataflow, with separate argument atoms,
   in a macOS native-contained Cell with network denied.
3. A second `Capture`, after `Invoke` but before `Apply`, proves the live
   `SOUL.md` was not changed by the process.
4. `Apply.merge` installs the single private `hermes` directory delta through
   Hold.
5. `RequestExternal` stages a body-bearing replacement request in Outbox.
6. The proof confirms no fetch occurred, the private dispatch document is
   mode `0600`, every node has a receipt and admitted resource identity, and
   Hold undo restores the exact prior directory.

The test also verifies that the restore-introduced session disappears on undo,
so recovery evidence covers a directory topology change rather than only a
same-size file overwrite.

## Operation classes not yet proved end to end

These are implementation gaps or acceptance work, not evidence for new
Airlock physics:

- A real OpenShell invocation needs its executable identity, config/helpers,
  Unix sockets or endpoints, descendants, and credentials represented by an
  enforceable execution closure.
- The checked-in controller programs therefore mark OpenShell calls as
  `compatibility`; the native-contained claim remains limited to local,
  no-network work until an endpoint broker exists.
- Native-contained macOS currently denies all network for this path; it does
  not yet broker an allowlisted endpoint to a Cell.
- Outbox dispatch supports HTTP. A staged external command/remote-realm Plan
  transport is still required for OpenShell-style non-HTTP control paths.
- The VM-enclosed macOS profile is intentionally unavailable in this build.
- Vouch's SQLite online backup and member-by-member permission-collision
  behavior remain semantics of the existing Python helper. They need a real
  OpenShell fixture run, not an Airlock reimplementation.
- Receipt decoding and bounded polling exist as program composition concerns;
  this proof validates receipts from the embedding harness instead of running
  the entire replacement loop through the evolving Airlock program frontend.
- The native Cell permits ambient host reads. This proof establishes write and
  network fences, not confidentiality.
- Cell merge currently commits top-level regular-file or directory deltas.
  Hardlinks, special files, foreign live writers, ACL/xattr fidelity, and
  multi-entry atomicity remain outside this evidence.
- Private Cell workspace retention/reaping and crash injection across this
  exact Vouch flow need acceptance tests.

The next Vouch gate is therefore concrete: run the same admitted contracts
against a disposable OpenShell sandbox, with a fixture containing a live
SQLite database and an unwritable image-owned collision, while keeping the
remote machine disposable and the external replacement request staged.

## Expanded host-operation acceptance

[`host-workflow.air`](host-workflow.air) and
[`../../scripts/prove-vouch-operations.ts`](../../scripts/prove-vouch-operations.ts)
exercise the high-frequency Unix shapes found in the current 6k+ line Vouch
runtime without copying its application vocabulary into Airlock:

| Vouch source evidence | Generic operation proved |
|---|---|
| `box-runtime-v1.py:2888-2947` | bounded process-group execution, captured output, timeout, cancellation, and output budget |
| `box-runtime-v1.py:2989-3024` | absolute executable plus distinct argv atoms for an OpenShell-shaped invocation |
| `box-runtime-v1.py:5853-5953` | inspect a state tree, invoke existing `tar`, inspect its result, and stage a backup with file copy/move |
| `box-runtime-v1.py:5956-6027` | explicit stdin/stdout artifact flow and structured receipts around existing restore machinery |
| `box-runtime-v1.py:6041-6129` | recoverable local transition plus an inert external replacement/event intent |

The proof runs a native-contained `tar` overwrite against a private workspace,
applies its delta through Hold, stages an HTTP intent without dispatching it,
and restores the exact prior archive bytes by act id. It also passes `tar`
member output into `wc` as an artifact rather than a textual pipe, and
round-trips a realistic OpenShell-shaped argv vector through `/usr/bin/printf`
without invoking a shell.

This extends, rather than replaces, `prove-vouch.ts`: the original proof covers
restore of a directory topology; the operation proof covers the surrounding
host orchestration and process-lifecycle contracts.
