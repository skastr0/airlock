# macOS v1 acceptance contract

> Status: release gate. It defines which claims the current compatibility and
> native-contained implementation may earn. VM enclosure is future work and is
> not required for macOS v1.

## Permitted claims

Two claims are evaluated separately:

1. **Compatibility:** Airlock provides a structured, Unix-shaped alternative
   to direct shell orchestration while preserving broad Bash-like host
   capability. Compatibility children retain ambient host authority; their
   internal writes and network sends are not Hold/Outbox-mediated. This claim
   includes no containment, recovery, cancellation, or external-uncertainty
   guarantee for those child effects.
2. **Native-contained:** Airlock can replace direct shell access for the
   published native-contained task and resource envelope on macOS, with
   managed local changes applied through Hold and unsupported capabilities
   refused explicitly.

“Replace direct shell access” means that the evaluated agent completes the
task while receiving only the Airlock connector. It does not mean universal
Unix semantics, VM-equivalent containment, confidentiality, or protection
outside the published native capability matrix.

The stronger phrase “replaces most shell usage for agents” remains unavailable
until representative task results support “most.” One local vertical slice is
not representative evidence.

## Current judgment

```text
usable developer preview — broad claim not yet earned
```

Evidence present today:

- the final integrated `bun run verify` gate passes 54 test files plus one
  skipped file and 283 tests plus 16 skipped tests;
- the four explicit Bun/macOS boundary gates pass: 11 ProcessRunner cases,
  eight native Cell cases, seven executable-edge cases, and nine in-process
  boundary cases;
- construction tests count one irreversible removal site and one Outbox wire
  site;
- compatibility CLI/program execution is tested;
- native-contained write and network fences are tested on macOS;
- native-contained proof covers a private Invoke temp workspace and keeps its
  bytes out of the live merge delta;
- Schema-decoded Bun proofs establish exact root/descendant executable-path
  fencing, declared shebang-chain behavior, and executable binding receipts;
- a separate Bun boundary proof shows that root-only `/bin/bash` can source
  agent-owned `BASH_ENV` in-process while live writes and loopback remain
  denied and the private write remains the sole delta;
- the CLI runs an admitted native effectful program, applies its delta through
  Hold, and undoes it;
- one Vouch-derived native proof captures an archive, invokes `/usr/bin/tar`,
  proves live state was unchanged before Apply, applies and undoes a directory
  delta, and stages a replacement request without dispatch;
- a second Vouch-derived program executes 12 generic host operations / 16 Plan
  nodes and separately proves process timeout, cancellation, and bounded-output
  receipts; both local proof tests pass in the final integrated gate, but no
  repeated-run report is checked in and neither becomes real remote
  Vouch/OpenShell evidence;
- five foundational top-level parity workloads exercise generic filesystem
  actions, explicit process pipelines, bounded range and captured-list control,
  and native-contained rewriting;
- five further agent-only corpus workloads exercise repository
  observation/search and artifact piping, native `sed`, tar, local Git, and
  `make` descendants;
- an eleventh destructive native workload proves recursive removal is
  Hold-backed and exactly undoable through the supervisor;
- a [separate repeatability campaign](evidence/parity-50.md) launches the real
  `airlock-agent` subprocess 50 times: exactly ten deterministic scripted cases
  repeated five times, with 40 compatibility and 10 native-contained
  successes under a five-minute automated-gate ceiling; these are not 50
  unique or model-generated tasks, a direct-shell A/B, or a held-out corpus;
- Hold and Outbox have bounded cross-process lease, stale-owner recovery, and
  journal/recovery tests, including cancellation of contended waiters without
  stealing the live owner;
- Reaper cancellation is characterized at its terminal boundary: waiting is
  cancellable without changing the held act, terminal removal plus directory
  sync is uninterruptible, and interrupted Ledger publication returns typed
  `HoldReapRecoveryRequired` evidence with the confirmed removal set;
- the shared `O_EXLOCK` mechanism has a direct macOS proof with 16 independent
  Bun processes, 16 distinct PIDs, every contender completing, no independent
  `O_EXCL` overlap violation, and maximum decoded event occupancy of one; and
- Runtime uses a persistent run journal and a SHA-256-derived, kernel-backed
  `O_EXLOCK` claim before adapter work, retains the claim through
  `running`/`finalizing`/terminal publication, and rejects concurrent or later
  replay as typed `RuntimeExecutionClaimRejected`; and
- the paired supervisor/agent macOS artifacts are locally ad-hoc signed,
  hashed, verified, installed, and probed as one release pair;
- a later program failure returns a nonzero, versioned partial report that
  retains completed action records, Plan drafts, artifacts, and typed failure
  context;
- native action discovery is generated from the same Effect Schemas that
  perform decoding, `run`/`eval --compact` returns a compact, deduplicated
  evidence projection while process output and program values retain their
  configured limits, and `runs --limit` is bounded to 1–100 snapshots; and
- inert tool definitions execute end to end through existing generic actions,
  Admission, Plans, Runtime, and Schema-decoded results;
- an [external-read fixture slice](evidence/external-read-slice.md) proves one
  vertical path — a staged `RequestExternal` auto-committed through the
  existing `Outbox.commit` under a supervisor `read`-class `commit: "auto"`
  grant — across 26 cases against a local fixture provider on one macOS host;
  it preserves the single wire site and is bounded evidence only, not a passed
  brokerage gate, real-provider evidence, or corpus evidence; and
- the separate [Linux native-contained evidence](evidence/linux-beachhead.md)
  now covers Linux platform primitives, containment, shared workloads, and
  local distribution. It neither borrows nor satisfies this document's
  macOS-specific acceptance gates.

Evidence absent today:

- the frozen representative corpus and direct-shell baseline;
- repeated runs across every supported macOS build/architecture;
- exhaustive crash injection and overlapping mutation/commit campaigns beyond
  the bounded recovery/locking evidence already present;
- the hostile corpus needed to move from bounded executable-edge evidence to a
  complete execution-closure claim, including dylib/config/plugin,
  executable-identity-race, descriptor, daemonization, and
  resource-exhaustion campaigns;
- end-to-end label and persistent-authority enforcement;
- contained endpoint brokerage; and
- a real Vouch/OpenShell remote replacement; and
- Developer ID signing, notarization, and public artifact provenance.

Direct unit/integration evidence establishes bounded properties:
construction-site counts, structured argv, explicit native refusal/fences,
staged-only Hold journal promotion, cross-process lease
serialization/reclamation, process-group waiting, and paired local artifact
verification. The 50/50 scripted campaign establishes repeatability of ten
known cases, not representative agent task completion. This does not meet this
contract's definition of strong confidence. Product-level shell-replacement
and security claims remain candidate because the corpus, direct-shell
baseline, platform, fault, and hostile gates are incomplete.

## Evaluation harness

For a shell-replacement evaluation, the agent receives only the Airlock schema
and connector. It has no:

- shell, terminal, command-string tool, or generic process launcher;
- direct read/write/search/filesystem tool;
- raw network, browser, SSH, Docker, or database-socket tool;
- alternate host RPC capable of machine effects; or
- authority to change profile, policy, grants, label promotions, Outbox
  commit policy, or reap policy.

The supervisor owns the profile and policy file. The same model, prompt,
fixture, budgets, and timeout are used for Airlock and direct-shell baselines.
Harness mediation is part of the evidence; repository tests alone cannot prove
that another tool was absent.

## Frozen corpus

Before a broad claim, freeze at least 50 real multi-step tasks spanning:

1. repository inspect, list, stat, read, search, and filtering;
2. file/directory create, edit, copy, move, remove, and undo;
3. JSON, text, tabular, archive, compression, and generated artifacts;
4. stdin/stdout/stderr, explicit pipes, exit status, timeouts, cancellation,
   bounded parallelism, and owned long-running processes;
5. formatter, compiler, test runner, build system, and interpreter work;
6. Git status/diff/branch/commit plus separately staged network work;
7. package-manager resolve/install/build, including lifecycle-script
   adversaries;
8. HTTP/API/download/upload and ambiguous dispatch fixtures;
9. quiescent structured-data work plus explicitly rejected live-state cases;
   and
10. the complete Vouch snapshot/upload/restore/validate/replace workflow.

At least 20% of tasks remain held out while vocabulary, examples, and tool
definitions are developed. After vocabulary freeze, an unrelated repository
workload tests whether Vouch shaped the ontology.

Every exclusion is published. Candidate exclusions include full-screen human
TUIs, GUI automation, administrator/root management, unsupported devices or
mounts, foreign live processes, and remote systems without a cooperating
realm.

## Quantitative gates

### Compatibility

- at least 90% completion across the full non-excluded corpus;
- at least 80% in each non-excluded task family;
- zero command-string escape added to the Airlock language; and
- latency/resource deltas published against direct shell.

This earns a structured-coverage claim only. It does not earn containment.

### Native-contained

- 100% pass for every task/capability the capability matrix advertises;
- every unsupported task classified explicitly before execution or at the
  first unavailable contract;
- zero silent fallback to compatibility;
- zero use of an alternate shell or effect tool;
- 100% pass for the native-contained Vouch subset; and
- latency/resource/retention costs published.

The denominator is the published native capability matrix, not every Unix
task. Expanding that matrix requires new evidence.

### Confidence

- **candidate** — one passing local run or fixture, with corpus or adversarial
  gates incomplete;
- **moderate** — one complete passing corpus plus all applicable construction,
  recovery, and adversarial gates on one published macOS/backend combination;
- **strong** — three clean repetitions on every published combination,
  including fresh state, fault injection, concurrent runs, and hostile cases.

Strong confidence requires corpus, crash, concurrency, and red-team evidence.
Passing `bun run verify` alone is candidate evidence.

## Construction gates

All applicable gates must pass:

1. `Hold.reap` owns the only irreversible removal of retained managed bytes.
2. Every supported live binding replacement uses Hold.
3. The only wire-capable site is inside `Outbox.commit`.
4. `RequestExternal` stages and cannot dispatch from program lowering.
5. Compatibility remains the zero-config profile.
6. A selected contained profile cannot downgrade.
7. Definitions/adapters cannot mint Plan constructors or authority.
8. Executable and args remain separate; no command-string form appears.
9. Every attempted Plan node has a typed outcome and correlated receipt.
10. Ordinary label derivation cannot lower confidentiality or raise
    integrity.
11. Persistent Runtime storage and a single-use Plan claim precede adapter or
    world work; a prior snapshot rejects replay.

Gates 1–8 and 11 have meaningful repository coverage now. Gate 9 is
implemented for completed current runtime nodes and versioned CLI results, but
a failing node does not yet have a proven durable crash-safe receipt path.
Gate 10 exists in the pure label component but is not enforced end to end.

## Native containment gates

The native claim additionally requires evidence that:

- the live workspace cannot be written during Invoke;
- network is denied for a no-network Cell;
- missing Seatbelt or private-view enforcement refuses execution;
- root `invoke` and root-scoped descendant `execute` authority cannot be
  exchanged, and undeclared descendant execs fail closed;
- executable receipts identify the requested/launch/allowed paths and
  root/descendant role at the precision the current resolver enforces;
- baseline drift blocks Apply;
- every advertised delta kind is revalidated and applied through Hold;
- unsupported topology and resource kinds fail closed;
- the owned process lifetime matches the published descendant limitations;
- ambient host reads are disclosed and no confidentiality claim is made;
- temp paths and inherited descriptors stay within the published envelope;
- admitted interpreters may execute agent-owned bytes in-process, but that
  behavior does not widen the Cell's write or network fence;
- output, process, disk, and retention budgets fail safely; and
- recovery after interruption never invents success.

If a later native endpoint broker is advertised, DNS, redirects, proxies,
loopback, link-local ranges, Unix sockets, descriptor passing, budgets, and
actual-destination receipts become mandatory gates for that capability. They
are not current native capabilities.

## Recovery, crash, and concurrency gates

Exercise failure at every Hold, Apply, Outbox, and Ledger/Journal transition:

- before and after each durable rename;
- before and after live replacement;
- during multi-entry merge;
- before dispatch, after dispatch may have begun, and after response receipt;
- during cancellation and startup reconciliation; and
- while overlapping Apply, undo, commit, cancel, and reap requests race.

Required outcomes:

- supported bytes and advertised metadata remain recoverable;
- a conflicting newer binding is never silently overwritten;
- acknowledged concurrent mutations retain the required versions;
- one emission has at most one dispatch claimant;
- possible dispatch becomes `uncertain`;
- uncertainty is not automatically retried without idempotency evidence; and
- multi-entry partial outcomes identify each completed transition.

Current evidence covers bounded cross-process Hold/Outbox serialization,
including a direct 16-process proof of the shared kernel lease; stale/dead
lease-owner reclamation; lock-directory bounds; recovered `committing`
uncertainty; promotion of a valid staged-only Hold journal; and Reaper
cancellation before terminal authority plus exact recovery evidence when
Ledger publication is interrupted after confirmed removal. The independent
sentinel and event trace prove one-holder mutual exclusion for that campaign.
They do not cover every Hold/Outbox/Reaper transition point and overlap listed
above.

## Security and red-team gates

Test at least:

- shells/interpreters, shebangs, loaders, hooks, helpers, plugins, lifecycle
  scripts, pagers, editors, and ambient config;
- dynamic-library and mutable-executable identity races that do not reduce to
  a new pathname-level exec;
- background jobs, daemonization, signals, inherited descriptors, PTYs, and
  output/resource floods;
- symlink, hardlink, mount, metadata, open-writer, live-WAL, and expected-state
  races within or adjacent to the supported envelope;
- persistent hooks/config/executables consumed by later stronger work;
- false declassification/endorsement and confidential-read plus endpoint
  combinations;
- tool definitions attempting executable callbacks, authority minting, or
  alternate lowering; and
- harness bypass through another machine-effect tool.

The current native profile intentionally permits ambient host reads. A test
showing that read is not a failure; a documentation claim of confidentiality
would be. Likewise, the successful `BASH_ENV` proof documents code interpreted
inside an admitted root process. It becomes a failure only if that code escapes
the published write/network/authority envelope or the result is mislabeled as
a complete execution closure.

## Evidence bundle

Each published run records:

```text
Airlock commit/build and corpus version
macOS build and hardware architecture
profile and capability-report digest
model/harness identity and task inputs
policy, Plan, definition, and artifact identities
executable root/descendant declarations and resolved binding evidence
per-task completion, escape, failure class, latency, and resources
Hold/Outbox/receipt evidence
fault-injection and concurrency schedule
direct-shell baseline
aggregate/family metrics and exclusions
```

Secrets and private content appear only as redacted identities or digests.

## Release judgment

A report must use one of:

- `claim earned — moderate confidence`;
- `claim earned — strong confidence`;
- `usable developer preview — broad claim not yet earned`; or
- `gate failed`, followed by the exact failures.

A task-completion percentage cannot compensate for a construction,
containment, recovery, uncertainty, or authority-boundary failure.
