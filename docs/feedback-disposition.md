# Architecture feedback disposition

> Status: decision record. Review opinions are inputs; repository laws and
> executable evidence remain the authority.

This revision normalizes earlier reviews against the macOS implementation that
exists now. It distinguishes decisions from candidates and removes the
unimplemented VM backend from the v1 claim gate.

## Status corrections

### Preserved as repository laws

- **Only the reaper unlinks.** Every managed mutation remains a rename through
  Hold; `Hold.reap` owns the sole irreversible removal site.
- **The ratchet law.** Compatibility is zero-configuration and broad.
  Restrictions require explicit profile/policy input and cannot silently
  downgrade.

No review elevated another design preference to the same status.

### Established by current implementation

- structured executable-plus-argv execution without a command-string form;
- a parser/evaluator and `airlock run` path for effectful programs;
- generic native actions lowering to `Capture`, `Invoke`, `Apply`, and
  `RequestExternal`;
- Admission policies, grants, handles, and runtime interpretation;
- compatibility execution;
- a narrow native-contained macOS Cell with private writes, live-write denial,
  network denial, delta generation, drift checks, and Hold-backed Apply;
- durable HTTP Outbox staging with the wire site inside commit;
- bounded recoverable cross-process Hold/Outbox leases and staged Hold-journal
  promotion;
- same-process-group descendant waiting plus bounded timeout, cancellation,
  and output receipts;
- paired supervisor/agent macOS binaries with a reduced agent command surface;
- inert JSON tool-definition loading and lowering; and
- two Vouch-derived local proofs: restore/apply/stage/undo and a 12-action
  host-operation workflow.

These facts narrow the old statement that all Plan, language, Cell, native, and
Vouch paths were merely candidate architecture.

### Still candidate or acceptance work

- the four-node algebra as a complete account of the representative corpus;
- complete execution closure;
- end-to-end information-label enforcement;
- persistent authority-laundering prevention;
- endpoint brokerage and non-extractable credentials;
- a complete crash-safe concurrent Journal beyond the bounded Hold/Outbox
  evidence;
- atomic or explicitly partial multi-entry Apply semantics;
- a real Vouch/OpenShell remote replacement; and
- broad shell-free task coverage.

### Still open

- final language expressiveness beyond implemented forms;
- filesystem metadata, hardlink, liveness, mount, and batch semantics;
- label selector/issuance/revocation persistence;
- tool-definition provenance, signing, precedence, and distribution;
- remote-realm transport;
- protocol-aware endpoint classes; and
- the exact future VM backend and image lifecycle.

## Feedback adopted

### Keep Unix programs as implementations

Airlock remains a structured runtime around existing programs. Tar, Git,
SQLite, Python, OpenShell, and similar tools keep their application semantics.
Airlock owns admission, execution boundaries, recoverable local finality,
external staging, and receipts.

### Separate authoring from terminal authority

Agent-authored `RequestExternal` stages local intent. Only Outbox commit may
touch the wire. Agent-authored Apply requests a managed transition; Hold owns
the live replacement. Reaping remains a separate irreversible authority.

### Treat computation as enclosure

`Invoke` is computation inside a selected execution profile, not a fifth
world-boundary effect. Captures, proposed deltas, and external requests remain
explicit Plan dataflow.

### Scope capability claims

Universal Unix parity is not credible. Compatibility coverage and native
containment are reported separately:

- compatibility may earn broad structured-task coverage but no containment;
- native-contained may earn claims only for its published, tested capability
  matrix; and
- unsupported native work must fail without fallback.

### Make execution a closure

Executable identity alone is not enough for a strong security claim. Loaders,
shebangs, descendants, helpers, hooks, plugins, configuration, lifecycle
scripts, pagers, editors, credentials, environment, and descriptors belong in
the acceptance model.

The current native backend has not yet earned that complete-closure claim. It
allows `process*` and ambient file reads, so this remains an explicit gate.

### Keep information flow distinct

Separating network from live writes does not prevent confidential-read plus
external-write exfiltration or persisted low-integrity bytes from influencing
later stronger work. The pure label component is useful, but runtime
propagation, enforcement, capability authenticity, and cross-plan persistence
remain acceptance work.

### Keep endpoint claims honest

Current native Cells deny network. Current Outbox dispatches HTTP itself. No
general EndpointBroker exists. DNS, redirect, proxy, loopback, Unix-socket,
descriptor-passing, budget, credential, and actual-destination guarantees
cannot be claimed until a broker is implemented and tested.

### Treat liveness and granularity as resource semantics

A regular file can be live protocol state. SQLite WAL/SHM, foreign writers,
locks, active mailboxes, and multi-entry directory transitions require explicit
contracts. Individually recoverable renames do not automatically form an ACID
transaction.

## Adjudications changed by evidence

### macOS v1 is native-contained plus compatibility

Earlier architecture made `vm-enclosed` the broad v1 shell-replacement gate.
The repository now has a working narrow native backend and compatibility path,
while the VM backend is explicitly unavailable.

Decision:

- macOS v1 documents and evaluates compatibility and native-contained;
- native-contained claims are bounded by its capability matrix;
- VM-enclosed is a future stronger backend; and
- absence of a VM does not block an honest native v1, nor may a nonexistent VM
  be used to imply stronger v1 guarantees.

### Strong confidence remains unearned

The Vouch-derived proofs and four parity fixtures are real and useful, but they
are still a controlled local suite. The bounded lock/recovery tests do not
form a complete crash/concurrency campaign. There is no representative corpus
or red-team result. The correct current judgment is:

```text
usable developer preview — broad claim not yet earned
```

### Airlock remains the agent language

The checked-in parser, evaluator, native action resolver, and `airlock run`
path now establish a real language surface. Its current pure/control forms are
implemented; broader expressiveness is still evidence-led. The language
cannot add authority outside Plan, Admission, and Runtime.

### The rename/Reaper law remains

Suggestions to generalize recovery into backend-neutral snapshots or reflinks
were not adopted. Clone/copy may prepare a private Cell workspace, but managed
live finality still uses rename through Hold. Changing that requires an
explicit architecture decision and construction evidence.

### Curation does not gate compatibility

Tool definitions improve typed ergonomics but remain inert and incomplete by
design. Compatibility may run unknown tools. Native-contained may reject a
tool when its requested authority or execution shape exceeds the implemented
profile; that is enforcement, not a registry-completeness requirement.

## Effect and PCMI disposition

The architecture keeps three strata:

| Stratum | Current disposition |
| --- | --- |
| domain capabilities | Hold and Outbox are implemented nuclei with bounded durability/concurrency evidence; Plan, Admission, labels, native actions, and definitions are evidence-seeking candidates |
| interaction seams | Schema-first Plans, handles, artifacts, receipts, deltas, and tagged failures carry ordering/authority/uncertainty contracts |
| adapter glue | CLI, Bun process runner, Seatbelt/APFS glue, file readers, Vouch harness, and future broker/VM remain local and replaceable |

Effect supplies runtime Schema validation, tagged expected failures, explicit
service requirements, Layer composition, and scoped/cancellable execution.
PCMI does not excuse ambiguous glue: policy, authorization, ordering,
idempotency, crash semantics, and uncertainty belong in typed seams.

## Evidence next

The next decisions should be made from:

- a frozen shell-free task corpus and direct-shell baseline;
- a disposable real Vouch/OpenShell fixture;
- exhaustive fault injection and overlapping-operation tests beyond the
  bounded lease/journal cases already covered;
- hostile interpreter, config, descriptor, path-race, and resource tests;
- end-to-end label and persistent-authority workloads; and
- endpoint-broker evidence if contained networking is added.

Until those exist, the remaining candidates and open questions stay labeled as
such rather than becoming invariants by repetition in documentation.
