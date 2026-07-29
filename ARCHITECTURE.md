# Airlock architecture

> Status: implementation map plus design direction.
>
> This document separates repository laws, implemented behavior, release
> acceptance conditions, candidate design, and open questions. Only the two
> laws in [`DESIGN.md`](DESIGN.md) are frozen architectural invariants.

## Summary

Airlock is a macOS-first runtime and small language for agent-authored Unix
machine work. An Airlock program calls typed, generic actions. Those actions
lower to a closed four-node Plan, pass through admission, and are interpreted
by trusted services that observe files, run existing programs, apply
recoverable local changes, or stage external intent.

The current implementation has two usable execution profiles:

- `compatibility` runs structured executable-plus-argument requests with the
  invoking user's host authority and makes no containment claim.
- `native-contained` runs supported work in a private macOS workspace under a
  Seatbelt profile, denies live-workspace writes and network, computes a delta,
  and applies admitted top-level file/directory changes through Hold.

The native profile is deliberately narrower than a VM. It permits ambient host
reads so existing loaders and Unix programs work; it therefore does not provide
confidentiality. A VM-enclosed backend is a future stronger backend, not the
gate for macOS v1.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Law** | Frozen repository invariant guarded by construction tests. |
| **Implemented** | Present in the current source and exercised by named tests. |
| **Acceptance condition** | Evidence required before a public claim; not evidence that the condition already holds. |
| **Design direction** | Intended product shape that may guide work but is not a repository law. |
| **Candidate** | A concrete mechanism or contract still seeking integration or adversarial evidence. |
| **Open question** | Intentionally unresolved; code and docs must not treat it as settled. |

### Current status at a glance

| Subject | Status and evidence boundary |
| --- | --- |
| only the reaper unlinks | **Law**; a test counts one `fs.remove` site in `src/`, inside `Hold.reap` |
| zero-config Bash capability parity; restrictions are opt-in | **Law**; compatibility is the CLI default and native containment requires explicit profile/policy input |
| external wire site | **Implemented construction property**; the sole `fetch` site is lexically inside `Outbox.commit` |
| four Plan nodes | **Implemented candidate seam**; `Capture`, `Invoke`, `Apply`, and `RequestExternal` have Schema models, ordering, admission, and runtime interpretation |
| Airlock program runner | **Implemented**; `airlock run` parses, evaluates, lowers, admits, and executes native actions |
| compatibility profile | **Implemented**; no containment claim |
| native-contained profile | **Implemented narrow subset**; private view, source-write fence, network denial, delta/Apply path |
| VM-enclosed profile | **Future design direction**; the CLI and runtime refuse it because no backend is installed |
| Hold | **Implemented domain nucleus**; files/directories, same-volume rename admission, bounded cross-process locking, staged journal promotion, and undo conflict handling |
| Outbox | **Implemented domain nucleus**; durable HTTP stage/cancel/commit, bounded cross-process locking, and honest `uncertain` recovery |
| Ledger | **Implemented append-only prototype**; not established as a fully crash-safe Journal |
| labels | **Implemented pure candidate**; lattice, sink checks, scoped declassification/endorsement, and tests exist, but the runtime does not yet enforce them end to end |
| endpoint broker | **Candidate, not implemented**; current native Cells deny network and Outbox dispatches HTTP itself |
| complete execution closure | **Acceptance condition, not established** |
| Vouch evidence | **Implemented local proofs**; one restore/apply/stage/undo fixture plus a 12-action host-operation workflow, not a real OpenShell or remote replacement |
| macOS distribution | **Implemented local release path**; paired supervisor/agent binaries are hashed, ad-hoc signed, verified, transactionally installed, and probed; Developer ID signing and notarization remain release gates |
| shell-replacement confidence | **Not earned**; the checked-in fixtures are useful but not a representative corpus, complete crash matrix, or red-team result |

## Product direction

Airlock remains generic and Unix-shaped:

```text
agent program
  → typed action call
  → inert PlanDraft
  → AdmissionPolicy
  → admitted Plan
  → runtime interpretation
  → receipts and artifacts
```

Existing programs retain application semantics:

```text
tar stays tar
git stays git
sqlite3 stays sqlite3
curl stays curl
openshell stays openshell
```

Airlock owns structured invocation, authority admission, the private execution
view, managed-state finality, external staging, and evidence. It does not
become an archive library, Git implementation, package manager, database
engine, or Vouch-specific runtime.

The target agent surface is Airlock rather than a direct shell. That is a
design direction and acceptance goal. The current repository proves useful
vertical slices, not broad shell replacement.

## The two laws

### Only the reaper unlinks

Every managed live mutation displaces filesystem bindings by rename. Prior
state enters Hold before removal or replacement. Undo also preserves a
conflicting current binding rather than destroying it.

`Hold.reap` contains the only irreversible removal site in `src/`. The law
applies to unique bytes in managed live state. A process may remove disposable
files inside a private Cell view because that absence cannot reach live state
until a separate `Apply` transition passes through Hold.

### The ratchet law

Zero-configuration behavior preserves broad Bash-like host capability. Safety
that does not remove capability—structured argv, staging, recovery material,
receipts, and visibility—may be present by default. Restrictions require an
explicit profile or policy and can only narrow authority.

Consequences in the current CLI:

- `compatibility` is the default;
- `native-contained` program execution requires `AIRLOCK_POLICY_FILE`;
- the policy profile must equal the selected CLI profile;
- `vm-enclosed` is refused rather than mapped to a weaker backend; and
- unknown tools are not rejected merely because the definition registry is
  incomplete.

## Four effect classes and the Plan seam

The candidate closed Plan algebra is implemented as:

```text
PlanNode = Capture | Invoke | Apply | RequestExternal
```

| Node | Role | Current interpreter behavior |
| --- | --- | --- |
| `Capture` | observation enters the program | captures supported file data/artifacts |
| `Invoke` | existing code computes | runs through compatibility `ProcessRunner` or the native `Cell` |
| `Apply` | managed local state changes | delegates supported transitions to Hold |
| `RequestExternal` | external intent is requested | stages a durable HTTP request in Outbox; it does not dispatch |

Pure expressions, `let`, `if`, finite literal `for`, `assert`, records, lists,
and return values compose these nodes without creating another world-effect
constructor.

The executable contract is structured:

```text
{
  executable,
  args,
  cwd,
  env,
  stdin,
  stdout,
  stderr,
  timeout,
  outputLimit,
  cellProfile
}
```

`executable` is separate from `args`; there is no command-string form,
interpolation, word splitting, command substitution, or implicit shell.

### Current native action vocabulary

```text
Capture
  file.inspect
  file.read
  file.list
  file.glob
  file.stat

Apply
  file.write
  file.remove
  file.move
  file.copy
  file.mkdir

Invoke
  process.run

RequestExternal
  http.stage
```

Definitions may add typed names over existing executables, but they are JSON
data. The loader validates fixed locations and duplicate identities; the
lowerer resolves literal/input templates and produces the same native action
and Plan shapes. Definitions cannot execute while loading, mint grants, or add
Plan constructors. Definition discovery and lowering are implemented
components; end-to-end invocation of an installed defined action from the
program frontend remains integration work.

## Authority and admission

An action first produces a `PlanDraft` with resource requirements. Admission
decodes a supervisor policy and binds each requirement to grants, handles,
resource identities, a policy digest, and an admitted Plan.

The current `AdmissionPolicy` includes:

```text
schemaVersion
profile
principal
realm
admittedBy
grantTtlMillis?
pathAllowlist
executableAllowlist
endpointAllowlist
```

Compatibility admits broad undeclared host work under the ratchet. Contained
profiles require their executable, path, and endpoint requirements to fit the
policy. Handles carry lexical bindings and public provenance, and grant
expiration is rechecked before use.

This is not yet a complete reference-monitor proof. Current admission does not
establish path identity against all symlink/mount races, a transitive
execution closure, cross-plan authority laundering, or end-to-end label
enforcement.

## Execution profiles

### Compatibility: implemented

Compatibility uses the structured `ProcessRunner` directly:

- the executable is an explicit value;
- arguments are distinct atoms;
- cwd, environment overlay, stdin, streams, timeout, and output limit are
  explicit;
- the runner owns a process group, waits for same-group descendants, captures
  a receipt, and bounds timeout, cancellation, and output; and
- the process otherwise has the invoking user's ambient host reads, writes,
  network, configuration, descendants, and descriptors.

It is a migration and coverage profile. It is not containment.

### Native-contained: implemented narrow subset

The current native Cell:

1. fingerprints the source workspace;
2. creates a fresh same-volume private workspace using clone or copy;
3. runs `/usr/bin/sandbox-exec` with a generated Seatbelt profile;
4. permits `process*` and ambient `file-read*`;
5. permits writes only in the private workspace, declared temporary
   directories, and `/dev/null`;
6. denies `network*`;
7. runs the requested executable in the private workspace;
8. fingerprints the live and private trees;
9. reports private delta candidates and any live drift; and
10. leaves live mutation to a later `Apply.merge`.

Before the first live mutation, the runtime revalidates the Cell baseline and
preflights every delta entry. The current merge envelope is top-level regular
files and directories. Symlinks, special files, unsupported topology, overlap,
source drift, and target drift are refused. Each accepted entry is installed
or removed through Hold.

The profile's precise limitations matter:

- ambient host reads are allowed, so confidentiality is not provided;
- process-group cancellation is bounded but not proven against every
  daemonization or descendant-escape technique;
- the Seatbelt policy allows process execution and does not pre-bind every
  loader, helper, hook, plugin, or config-selected executable;
- network is denied rather than brokered;
- a multi-entry merge performs individually recoverable Hold transitions but
  is not claimed as one atomic transaction;
- private Cell retention and crash reconciliation are incomplete; and
- ACLs, xattrs, hardlinks, sparse files, special files, mounts, live writers,
  and protocol state remain outside the established envelope.

### VM-enclosed: future stronger backend

No VM Cell backend is bundled. `airlock doctor` reports it as not provided,
and `airlock exec/run --profile vm-enclosed` refuses host fallback.

A future VM backend may provide stronger confidentiality, broader unknown-tool
containment, guest-only ambient authority, and brokered host seams. Those are
design goals, not current behavior and not a macOS v1 release gate.

## Managed local state: Hold

Hold is an Effect service with Schema values and tagged failures. Its public
operations include remove, overwrite, replace-from-stage, undo, list held
acts, and reap.

Implemented properties include:

- same-volume admission before a managed rename;
- protection for filesystem root and Airlock state;
- file/directory modeling with fail-closed symlink handling on replacement;
- prepared/held/restored journal states and startup reconciliation;
- expected-state checks for undo conflicts;
- recoverable replacement of an occupied target;
- no direct unlink in native filesystem actions; and
- one construction-counted irreversible removal site in `Hold.reap`.

The Hold root is protected by a bounded, cancellable cross-process
exclusive-file lease.
Journal publication stages and syncs a candidate before rename, startup picks
the best valid journal candidate, and recovery can promote a staged-only
candidate after an injected publication failure. Tests exercise competing
processes, interrupted waiters, stale-owner reclamation, and bounded
lock-directory growth.

The current evidence still does not establish crash safety at every filesystem
and kernel point, every overlapping Apply/undo/reap schedule, metadata
fidelity, live protocol-state safety, or atomic multi-entry Apply.

## External intent: Outbox

Outbox stores a redacted public manifest and an owner-only private HTTP
dispatch document. Staging writes durable local state and a Ledger entry.
Cancellation renames staged state without contacting the network.

Outbox uses the same bounded, cancellable Airlock-home exclusive-file lease to
serialize stage, claim, and recovery transitions across processes. A recovered
`committing` directory remains `uncertain`; the lease does not turn ambiguous
external delivery into a retryable success/failure result.

`Outbox.commit` performs the only wire-capable call:

- it claims a staged entry by renaming it to `committing`;
- reads the private request;
- uses `fetch` with `redirect: "manual"`;
- cancels the response body rather than buffering attacker-controlled bytes;
- records completed, failed, or uncertain outcome; and
- treats a recovered `committing` directory as `uncertain`.

This is an HTTP dispatcher, not the candidate EndpointBroker. It does not yet
mediate DNS rebinding, proxies, every redirect, host loopback, Unix sockets,
descriptor passing, protocol idempotency, credential capabilities, or
contained-process egress. Native Cells currently receive no network at all.

## Programs, artifacts, and receipts

`airlock run` is the current integrated path:

```text
source + JSON bindings
  → parser/evaluator
  → canonical native action
  → PlanDraft
  → Admission
  → Runtime
  → result + Plan summary + artifact metadata
```

Captured and generated bytes move as explicit artifacts. A later Invoke can
bind an artifact as stdin, and a later `http.stage` can bind body data. The CLI
returns artifact identity, media type, byte length, and provenance; it does
not copy artifact bytes into the JSON summary.

Runtime node receipts record sequence, node state, admitted resource
identities, input digests, and output artifact references. Hold and Outbox also
append domain entries to Ledger. Ledger is useful evidence but is not yet a
fully specified fsync, locking, compaction, or tamper-evident Journal.

Program results have a versioned `succeeded | failed | partial` envelope. If a
later action or language assertion fails, the CLI exits nonzero while retaining
the completed action records, Plan drafts, artifact metadata, and a typed
failure phase/cause. This is an honest partial execution report; it does not
make the sequence transactional or prove that a failing runtime node has a
durable receipt after every crash point.

The installed `airlock-agent` entrypoint intentionally exposes a narrower
surface than the supervisor binary: program/schema/capability and read-only
state inspection remain available, while raw exec, direct mutation,
dispatch/cancel, undo/reap, and flush are absent. Its program commands have no
agent-controlled profile option; the supervisor may pin
`AIRLOCK_AGENT_PROFILE`, with compatibility as the default. Programs can
request structured Invoke/Apply nodes inside that profile. A node-level
downgrade is denied with a failed `RuntimeCapabilityDenied` receipt rather
than executed. This is evidence for the intended harness boundary, not proof
that an external harness supplied no alternate machine-effect tool.

## Effect and PCMI strata

Airlock uses Effect as the typed substrate and follows Pristine Components,
Messy Integrations (PCMI):

> Pristine capabilities, rigorous seams, disposable glue.

### Domain capabilities

Stable meaning belongs in narrow services and pure modules:

- Hold and Outbox are implemented nuclei with Schema contracts, tagged
  failures, and executable invariants.
- Plan, Admission, native action lowering, label flow, and tool-definition
  lowering are implemented candidate capabilities whose boundaries still need
  corpus and adversarial evidence.
- Ledger is an implemented prototype, not yet a certified Journal.

Pristine status is earned and revocable. A component name is not proof that
its operational envelope is complete.

### Interaction seams

Plan nodes, requirements, grants, handles, artifacts, Cell reports, deltas,
receipts, Outbox transitions, and capability reports are Schema-first. Expected
failures use tagged errors in Effect's typed error channel. Service
requirements expose capabilities at composition time.

Ordering, authorization, cancellation, idempotency, uncertainty, crash
reconciliation, and receipt correlation belong in these seams. They must not
be reimplemented ad hoc in CLI or platform glue.

### Adapter implementations

The CLI, Bun process runner, Seatbelt profile renderer, APFS clone/copy logic,
definition file reader, Vouch harness, and future VM/broker implementations are
plastic adapters. They may be local and repetitive. They must remain tested
and observable, but they do not need generic integration frameworks.

The current CLI composes services through one Layer graph and `BunRuntime`.
It does not yet run a persistent daemon or expose the future local RPC surface.

## Security model: current guarantees and directions

Implemented, bounded properties:

- structured executable and argv data avoid shell-text construction;
- the native Cell separates private process writes from later live Apply;
- native Cell network is denied;
- Hold owns supported managed replacements;
- Outbox owns HTTP dispatch;
- profile mismatch and missing enforcement fail closed;
- tool definitions are inert data; and
- the pure label module prevents ordinary derivation from lowering
  confidentiality or raising integrity.

Acceptance conditions, not current guarantees:

- complete mediation by an agent harness with no alternate effect tool;
- complete transitive execution closure;
- identity-safe resource resolution under races;
- end-to-end confidentiality and integrity enforcement;
- persistent authority-laundering prevention across runs;
- endpoint brokerage for contained work;
- exhaustive crash-safe and concurrent durable transitions beyond the
  bounded Hold/Outbox evidence already present; and
- resource-exhaustion containment.

See [`docs/security-model.md`](docs/security-model.md) for the precise boundary.

## Vouch evidence

Vouch is the first workload, not an ontology. The proof in
`scripts/prove-vouch.ts` constructs and admits one generic restore Plan:

```text
Capture archive
  → Invoke /usr/bin/tar in native Cell
  → Capture live state before Apply
  → Apply private delta through Hold
  → RequestExternal staged in Outbox
  → Hold undo
```

The fixture proves that the process did not change live state before Apply,
that the restore delta installs and can be undone, that the replacement request
remains staged with zero fetch calls, and that node/resource receipts exist.

The second proof, `scripts/prove-vouch-operations.ts`, executes a checked-in
Airlock program with 12 actions and 16 Plan nodes. It covers file
capture/list/glob, native mkdir, tar snapshot and listing, an artifact pipe,
OpenShell-shaped argv atoms, copy/move/remove, staged HTTP, targeted undo,
timeout, cancellation, and a 128-byte output-limit partial process receipt.
Its CLI receipt schema is versioned.

Neither proof runs Vouch or OpenShell, a remote sandbox, a live SQLite backup,
unwritable collision handling, endpoint brokerage, dispatch, or an actual
replacement. Together they are stronger local evidence for the generic
decomposition and native host path, not a representative corpus or strong
confidence in the full product.

## macOS v1 acceptance direction

macOS v1 is judged on what this release implements:

- compatibility preserves the zero-config capability ratchet and reports no
  containment;
- native-contained must pass every task it advertises, fail unsupported work
  explicitly, and never downgrade; and
- the agent-only acceptance corpus must measure real task completion without
  direct shell or alternate effect authority.

The future VM backend may later widen the enforceable set and strengthen
confidentiality. It is not used to postpone or manufacture the v1 claim.

No strong claim is available today. The repository has targeted cross-process
lock/recovery tests and a small parity suite, but still lacks the full frozen
corpus, repeated platform runs, exhaustive fault/overlap campaigns, and
adversarial security evidence described in
[`docs/acceptance.md`](docs/acceptance.md).

## Open questions

The following remain unresolved:

- the smallest model-reliable Airlock language beyond current implemented
  forms;
- exact path, hardlink, metadata, mount, liveness, and multi-entry transaction
  semantics;
- persistent Cell lifetime, cleanup, and checkpoint semantics;
- end-to-end artifact storage and Journal durability protocol;
- selector, issuance, revocation, and persistence semantics for labels and
  supervisor capabilities;
- execution-adjacent resource classification across runs;
- protocol-aware endpoint brokerage and non-extractable credentials;
- tool-definition signing, precedence, distribution, and decoder power;
- remote-realm authentication and ambiguous-result reconciliation;
- the VM image/backend and which stronger guarantees it can actually support;
  and
- the representative and hostile corpora that determine where native
  containment has earned a claim.

An open question may narrow or version a candidate seam. It may not weaken the
two laws or silently create another mutation, dispatch, or authority path.

## Non-goals

Airlock does not:

- reimplement Unix tools or their application protocols;
- infer an agent's true intent;
- promise that external effects are reversible or exactly once;
- provide a distributed transaction;
- protect against kernel, administrator, hypervisor, or physical compromise;
- treat installed code or definitions as trustworthy by existence;
- claim confidentiality from the current native profile;
- claim a VM that is not implemented; or
- describe the current Vouch/parity fixtures as a representative corpus.
