# macOS v1 acceptance contract

> Status: release gate. It defines which claims the current compatibility and
> native-contained implementation may earn. VM enclosure is future work and is
> not required for macOS v1.

## Permitted claims

Two claims are evaluated separately:

1. **Compatibility:** Airlock provides a structured, Unix-shaped alternative
   to direct shell orchestration while preserving broad host capability. This
   claim includes no containment.
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

- construction tests count one irreversible removal site and one Outbox wire
  site;
- compatibility CLI/program execution is tested;
- native-contained write and network fences are tested on macOS;
- the CLI runs an admitted native effectful program, applies its delta through
  Hold, and undoes it;
- a Vouch-derived native proof captures an archive, invokes `/usr/bin/tar`,
  proves live state was unchanged before Apply, applies and undoes a directory
  delta, and stages a replacement request without dispatch; and
- inert tool definitions load and lower to existing generic actions.

Evidence absent today:

- the frozen representative corpus and direct-shell baseline;
- repeated runs across every supported macOS build/architecture;
- full crash injection and concurrent mutation/commit campaigns;
- hostile execution-closure, path-race, descriptor, daemonization, and
  resource-exhaustion campaigns;
- end-to-end label and persistent-authority enforcement;
- contained endpoint brokerage; and
- a real Vouch/OpenShell remote replacement.

No confidence level above candidate is justified while those gaps remain.

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

Gates 1–8 have meaningful repository coverage now. Gate 9 is implemented for
the current runtime path but not established as a fully crash-safe Journal.
Gate 10 exists in the pure label component but is not enforced end to end.

## Native containment gates

The native claim additionally requires evidence that:

- the live workspace cannot be written during Invoke;
- network is denied for a no-network Cell;
- missing Seatbelt or private-view enforcement refuses execution;
- baseline drift blocks Apply;
- every advertised delta kind is revalidated and applied through Hold;
- unsupported topology and resource kinds fail closed;
- the owned process lifetime matches the published descendant limitations;
- ambient host reads are disclosed and no confidentiality claim is made;
- temp paths and inherited descriptors stay within the published envelope;
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

## Security and red-team gates

Test at least:

- shells/interpreters, shebangs, loaders, hooks, helpers, plugins, lifecycle
  scripts, pagers, editors, and ambient config;
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
would be.

## Evidence bundle

Each published run records:

```text
Airlock commit/build and corpus version
macOS build and hardware architecture
profile and capability-report digest
model/harness identity and task inputs
policy, Plan, definition, and artifact identities
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
