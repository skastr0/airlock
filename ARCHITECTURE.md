# Airlock architecture

> Status: implementation map plus design direction.
>
> This document separates repository laws, implemented behavior, release
> acceptance conditions, candidate design, and open questions. Only the two
> laws in [`DESIGN.md`](DESIGN.md) are frozen architectural invariants.

## Summary

Airlock is a macOS-first, agent-only runtime for Unix machine work. In the
intended harness, the agent does not receive Bash, a terminal, a generic
process tool, or a second filesystem/network path. It receives Airlock. An
Airlock program calls typed, generic actions; those actions lower to a closed
four-node Plan, pass through admission, and are interpreted by trusted
services that observe files, run existing programs, apply recoverable local
changes, or stage external intent.

This is not a human shell project and “replace shell” does not mean copying
shell syntax or interactive job control. It means preserving task-level access
to legitimate Unix work for an agent while moving authority, finality, and
evidence out of ambient command text.

Airlock does not replace Unix algorithms:

```text
tar stays tar
git stays git
sqlite3 stays sqlite3
curl stays curl
openshell stays openshell
```

Airlock owns the structured invocation and the physics around it. The existing
program still owns archive parsing, version-control semantics, SQL, HTTP, or
remote-sandbox behavior.

The current implementation has two usable execution profiles:

- `compatibility` runs structured executable-plus-argument requests with the
  invoking user's host authority and makes no containment claim.
- `native-contained` runs supported work in a private macOS workspace under a
  Seatbelt profile, fences declared executable edges, denies live-workspace
  writes and network, computes a delta, and applies admitted top-level
  file/directory changes through Hold.

The native profile is deliberately narrower than a VM. It permits ambient host
reads so existing loaders and Unix programs work; it therefore does not provide
confidentiality. A VM-enclosed backend is a future stronger backend, not the
gate for macOS v1.

### Why macOS first

macOS is the first product environment, not a portability afterthought.
Developer Macs commonly place an agent beside valuable personal credentials,
repositories, databases, and application state under one user identity. VPS
work already tends to arrive with a VM, container, or disposable-machine
boundary; on a Mac, the missing agent-specific boundary is often the immediate
problem.

Starting on macOS also forces the contracts to meet the real platform:
canonical path aliases, APFS clone/copy behavior, Seatbelt's actual limits,
codesigning, local installation, and ordinary developer tooling. The result is
not assumed to be stronger than Linux. Native macOS containment is explicitly
weaker in several dimensions, especially confidential reads and complete
execution closure. Platform adapters may differ later; Plan, authority,
Hold/Outbox finality, and receipt semantics should not.

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
| Airlock-owned external wire site | **Implemented construction property**; the sole runtime `fetch` site is lexically inside `Outbox.commit`; compatibility children retain ambient network and receive no Outbox mediation claim |
| four Plan nodes | **Implemented candidate seam**; `Capture`, `Invoke`, `Apply`, and `RequestExternal` have Schema models, ordering, admission, and runtime interpretation |
| agent/runtime algebra split | **Implemented in the integrated program path, candidate as a complete reference monitor**; agents author action calls and Plans, while admission, Outbox claim/dispatch/cancel, Hold, reconciliation, and reap remain trusted transitions |
| execution authority | **Implemented candidate seam**; Runtime accepts only `ExecutionAuthority` (closed Plan plus retained Grants/bindings), rejects malformed authority, and refreshes closure, Grant lifetime, and handles immediately before each runnable node |
| single-use Plan execution | **Implemented interaction seam**; a persistent run journal plus kernel-backed per-Plan claim precedes adapter work, and any durable prior snapshot rejects concurrent or sequential replay |
| Airlock program runner | **Implemented**; `airlock run` parses, evaluates, lowers, admits, and executes native actions |
| agent-only binary | **Implemented product boundary**; `airlock-agent` omits terminal-authority maintenance commands, but the external harness must still prove that it exposed no alternate effect path |
| compatibility profile | **Implemented**; no containment claim |
| native-contained profile | **Implemented narrow subset**; private view, source-write fence, network denial, delta/Apply path |
| native executable-edge fence | **Implemented bounded mechanism**; root `invoke` and root-scoped descendant `execute` requirements lower to exact Seatbelt `process-exec` paths, with resolved binding evidence in Cell/Runtime receipts |
| in-process interpretation boundary | **Implemented and proved as a limitation**; an admitted `/bin/bash` can source agent-owned `BASH_ENV` without another exec, while its live-write and network attempts remain denied and private writes remain a delta |
| native workspace identity | **Implemented at the trusted CLI boundary**; native execution canonicalizes the workspace and existing absolute policy scopes before admission, while general path-race-safe resource identity remains incomplete |
| private Cell lifecycle | **Implemented normal path**; exact Cell workspace identity is transferred to a non-undoable runtime-private Hold act on completion, failure, or cancellation, then only Reaper may discard it |
| VM-enclosed profile | **Future design direction**; the CLI and runtime refuse it because no backend is installed |
| Hold | **Implemented domain nucleus**; files/directories, same-volume rename admission, bounded cross-process locking, staged journal promotion, undo conflict handling, and typed Reaper cancellation recovery after confirmed removal |
| Outbox | **Implemented domain nucleus**; durable HTTP stage/cancel/commit, bounded cross-process locking, and honest `uncertain` recovery |
| Ledger | **Implemented durable append seam**; cross-process locking, file/directory sync, and typed torn-tail repair/quarantine are established, but a complete compaction/tamper-evident multi-component Journal is not |
| labels | **Implemented pure candidate**; lattice, sink checks, scoped declassification/endorsement, and tests exist, but the runtime does not yet enforce them end to end |
| endpoint broker | **Candidate, not implemented**; current native Cells deny network and Outbox dispatches HTTP itself |
| complete execution closure | **Acceptance condition, not established** |
| inert tool definitions | **Implemented v1 integration**; accepted JSON definitions lower invoke-only actions totally through the same Plan/admission/runtime path and cannot mint authority |
| agent discovery and compact output | **Implemented agent UX seam**; native action JSON Schemas derive from the decoding Schemas, `run`/`eval --compact` projects evidence, and recent-run listing is bounded to 1–100 entries |
| Vouch evidence | **Implemented local proofs**; one restore/apply/stage/undo fixture plus a 12-action host-operation workflow, not a real OpenShell or remote replacement |
| Unix contract corpus | **Implemented contract-shape evidence**; 72 accepted shapes across 10 families parse, decode, lower, validate, and compatibility-admit, with 8 explicit unsupported classes; they are not executed tasks or model-success evidence |
| 50-execution agent proof | **Implemented repeatability evidence**; 10 deterministic scripted cases run five times each through real agent CLI subprocesses (40 compatibility, 10 native-contained), not 50 unique/model-generated tasks, a shell A/B, or a holdout corpus |
| macOS distribution | **Implemented local release path**; paired supervisor/agent binaries are hashed, ad-hoc signed, verified, transactionally installed, and probed; Developer ID signing and notarization remain release gates |
| shell-replacement confidence | **Not earned**; the checked-in fixtures are useful but not a representative corpus, complete crash matrix, or red-team result |

## Product direction

Airlock remains generic, Unix-shaped, and independent of Vouch:

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

The Plan IR and the runtime are the center of the product. The Airlock DSL is
one agent-oriented frontend over that seam, not the authority boundary itself.
Structured RPC/tool calls and future frontends may produce the same
`PlanDraft`; none may bypass admission or invent runtime operations. The
current small language is implemented, but its syntax and pure composition
forms should evolve from measured model-generation success, token cost, error
rate, and task completion—not from a goal of resembling a human shell.

The target agent surface is `airlock-agent` rather than a direct shell. That is
a design direction and acceptance goal. The current repository proves useful
vertical slices, not broad shell replacement.

## The two laws

### Only the reaper unlinks

Every Airlock-owned managed live mutation displaces filesystem bindings by
rename. Prior state enters Hold before removal or replacement. Undo also
preserves a conflicting current binding rather than destroying it.

`Hold.reap` contains the only irreversible removal site in `src/`. The law
applies to unique bytes in managed live state. A process may remove disposable
files inside a private Cell view because that absence cannot reach live state
until a separate `Apply` transition passes through Hold.

The law governs Airlock's managed mutation surface. A compatibility child runs
with ambient host authority and may issue filesystem syscalls that Airlock does
not mediate as `Apply`; those effects are outside Hold's recovery contract.

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

There are two related algebras. Keeping them separate prevents a privileged
runtime transition from accidentally becoming an agent-language primitive.

The candidate closed **agent Plan algebra** is implemented as:

```text
PlanNode = Capture | Invoke | Apply | RequestExternal
```

“Closed” describes the Schema and interpreter surface. Completeness across
representative Unix work remains a falsifiable hypothesis: a workload that
cannot lower honestly is evidence to narrow or version the algebra, not a
reason to declare the counterexample covered by fiat.

| Node | Role | Current interpreter behavior |
| --- | --- | --- |
| `Capture` | observation enters the program | captures supported file data/artifacts |
| `Invoke` | existing code computes | runs through compatibility `ProcessRunner` or the native `Cell` |
| `Apply` | managed local state changes | delegates supported transitions to Hold |
| `RequestExternal` | external intent is requested | stages a durable HTTP request in Outbox; it does not dispatch |

Pure expressions, `let`, `if`, finite literal `for`, `assert`, records, lists,
and return values compose these nodes without creating another world-effect
constructor.

The **trusted runtime transition algebra** is not agent-authored:

```text
RuntimeTransition =
    Resolve | Admit | Bind | Revalidate | ClaimPlan
  | Observe | Spawn | ProposeDelta | HoldTransition | StageExternal
  | ClaimExternal | DispatchExternal | CancelExternal
  | AppendReceipt | Reconcile | Reap | Deny

Outbox.commit = ClaimExternal → DispatchExternal
Outbox.cancel = CancelExternal  // staged only
```

`ClaimPlan` is a different authority boundary from `ClaimExternal`. Runtime
requires a persistent run journal, acquires a kernel-backed claim for the Plan
identity before node adapter or world work, and durably publishes `running`
before executing nodes. Any existing snapshot—including recovered `running`,
`finalizing`, or terminal state—causes a tagged
`RuntimeExecutionClaimRejected` instead of replay. The claim serializes
contenders; the journal makes the Plan identity single-use across later
processes.

This is not a fifth Plan node. It is the reference monitor's state-transition
vocabulary. In particular:

- `Apply` asks for managed mutation; Hold performs the live binding
  transition.
- `RequestExternal` asks for inert durable intent; `Outbox.commit` performs
  `ClaimExternal` and then `DispatchExternal`.
- `CancelExternal` is a supervisor transition that is legal only before an
  Outbox claim.
- undo and reconciliation are supervisor/runtime transitions.
- only the supervisor-facing surface can commit, cancel, undo, or reap;
  reconciliation remains runtime-owned and may run during startup.

An agent may construct a request that reaches one of these transitions only
through a closed, admitted Plan. A tool definition, platform adapter, or
project integration cannot add another mutation or dispatch gateway.

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

### Terms

| Term | Meaning |
| --- | --- |
| **ActionCall** | Agent-facing typed request. It has no authority by itself. |
| **PlanDraft** | Inert four-node graph plus complete modeled resource requirements and definition digests. |
| **AdmissionPolicy** | Supervisor input describing the profile and authority selectors that may be granted. |
| **Grant** | Time-bounded or policy-lifetime authority issued by Admission for one principal, realm, selector, rights set, and constraints. |
| **Handle** | Runtime reference that binds one admitted requirement to one Grant and public provenance. |
| **ExecutionAuthority** | The only Runtime input for execution: closed Plan, retained Grants, exact handle resolutions, per-node bindings, policy/profile identity, and closure digest carried together. |
| **Executable edge set** | The implemented root executable plus exact descendant executable paths admitted for that root. It is narrower than a full execution closure. |
| **Cell** | Owned computation environment. It may produce artifacts and a private delta; it does not install that delta into managed live state. |
| **Artifact** | Explicit bytes plus digest, media type, and provenance used for Plan dataflow. |
| **Hold act** | Recovery material and transition record for a managed binding or runtime-private workspace. |
| **ExternalIntent** | Durable, cancellable-before-dispatch request stored by Outbox. |
| **Receipt** | Evidence of what Airlock admitted, attempted, observed, staged, or changed; not a semantic proof that an opaque program did the intended thing. |

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
data. The v1 schema requires exactly one absolute executable selector per
definition and accepts only `invoke` lowering. The loader validates known
locations, callable names, duplicate identities, schemas, templates, limits,
result decoders, and the declared footprint. For every accepted v1 action,
lowering is total: it produces an existing structured Invoke action and
PlanDraft or returns a typed rejection. Definition and Plan digests bind the
selected data into the execution report.

Definitions cannot execute while loading, contain callbacks, discover an
executable, mint grants, add Plan constructors, dispatch, or bypass runtime
result validation. They may request modeled resources; Admission alone decides
whether those requests receive Grants. Installed definitions now execute end
to end through the same program, Plan, Admission, Runtime, and Schema-decoder
path. This is an extension mechanism for vocabulary and contracts, not for
physics.

Native action discovery is generated from the same Effect Schemas that decode
those actions, rather than a parallel handwritten schema catalog. The agent
surface can request one action schema directly. `run` and `eval` also provide a
compact, deduplicated projection of action, Plan, node, artifact, and failure
evidence; process output and the returned program value remain subject to their
own configured limits rather than a separate compact-output byte ceiling.
Recent-run listing defaults to ten snapshots and accepts an explicit bound from
1 through 100.

Unknown programs remain available through structured `process.run` in
compatibility. Curated definitions improve model affordance and precision;
they are not a completeness gate.

### Design direction: bounded machine discovery

A machine-wide tool-search failure exposed two safety axes that should not be
collapsed. **Scope invention** is an agent silently widening a search root,
following a new mount or symlink domain, or substituting a machine-wide
enumeration for the supervisor's requested scope. It can happen through
read-only operations. **Destructiveness** concerns mutation, finality, and
recovery. A narrowly authorized removal may be destructive while a read-only
`find /` invents scope. Hold physics addresses the former; it does not by
itself make the latter legitimate.

The candidate discovery path should prefer supervisor-known facts before
machine traversal:

1. resolve from a supervisor-known executable inventory;
2. resolve installed inert tool definitions;
3. resolve supervisor/harness-known skill manifests; then
4. if still necessary, request a bounded `Capture` traversal.

A bounded traversal contract should make its search authority legible:

```text
root
maximum depth
maximum entries inspected
maximum results returned
maximum bytes observed or returned
maximum elapsed time
symlink-following posture
mount-crossing posture
```

Budget exhaustion should return a typed result that lets the agent request
explicit supervisor escalation. It must not silently widen the root, follow
additional mounts, or switch to an ambient search path.

This is a **design direction**, not an implemented feature or a new law.
Current `file.glob` does not expose this complete multi-budget traversal
contract. The current native Cell also permits ambient host reads, so a strict
discovery profile must not grant generic `find` or an interpreter merely to
perform discovery: either can traverse outside the modeled `Capture` scope
from inside the admitted process. Compatibility may retain those broad ambient
tools under the ratchet, but then Airlock makes no containment or bounded-
discovery claim for their reads.

### Finality: Hold and Outbox

Hold and Outbox model different boundaries:

```text
local:    private work → proposed delta → Hold-backed live transition
external: request       → staged intent  → privileged dispatch
```

For a supported Airlock-managed local binding, Airlock can retain the displaced
state and make a later restoration possible. Recovery material remains until
Reaper performs the sole irreversible discard. “Recoverable” is bounded by that
material, filesystem envelope, retention policy, and intervening conflicts; it
is not a claim that a multi-path operation is ACID or that compatibility-child
writes are intercepted.

For an external effect, Airlock can cancel only while the intent remains
staged. Once dispatch starts, it cannot promise reversal or exactly once. A
crash after the recipient may have observed the request yields `uncertain`,
and uncertainty is not silently retried. This local-recovery/external-staging
duality is the product's finality model; it is more precise than calling every
effect “undoable.”

## Authority and admission

An action first produces a `PlanDraft` with resource requirements. Admission
decodes a supervisor policy and binds each requirement to grants, handles,
resource identities, a policy digest, and an admitted Plan. The integrated
program path then binds that result as `ExecutionAuthority`; a bare
`ActionCall`, definition, or `PlanDraft` is never authority.

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
executableEdges?
endpointAllowlist
```

Compatibility admits the Plan's declared requirements without an allowlist
restriction under the ratchet; the invoked process may then use ambient host
authority that is not modeled by those requirements. Contained profiles
require their executable, path, and endpoint requirements to fit the policy.

Consequently, writes or network calls made internally by a compatibility child
are not converted into `Apply` or `RequestExternal`, do not pass through Hold or
Outbox, and receive no containment, recovery, cancellation, or dispatch-
uncertainty guarantee from Airlock.

The implemented v1 closure enumerates every authority-bearing operand that the
current Plan schema models:

| Node | Modeled authority operands |
| --- | --- |
| `Capture(file)` | locator `read` |
| `Invoke` | root executable `invoke`; each declared descendant executable `execute`; explicit cwd `read` |
| `Apply` | target `write`; copy source `read`; move source `read + write` |
| `RequestExternal` | endpoint `connect + emit` |

The endpoint rights on `RequestExternal` admit one inert intent and bind its
declared destination. They are not a socket or wire capability held by agent
code. Only a separately authorized Outbox commit may exercise runtime dispatch
authority.

Admission rejects unused requirements, duplicate identities/rights, missing
operand requirements, and handles that do not exactly match their retained
Grant. `ExecutionAuthority` carries the Plan, Grants, bindings, policy/profile
identity, and a closure digest together. Runtime accepts this authority value,
not a bare Plan. Before each dependency-ready node, it revalidates the closure
and optional Grant lifetime and refreshes the node's handles. Tampering or
expiry produces a failed `RuntimeAuthorityInvalid` node receipt without calling
the filesystem, process, Hold, or Outbox adapter; dependents then cancel.

For native-contained work, `executableEdges` binds each descendant selector to
one separately admitted root. A descendant-only `execute` Grant cannot select
that helper as a later root Invoke. Compatibility accepts declared
requirements without applying this restriction, preserving the ratchet.

“Every modeled operand” is deliberately narrower than “every resource the
executable may use.” The edge set fences new exec transitions, but argv may
name paths, dynamic libraries load through file reads, an admitted interpreter
may execute data in-process, environment and configuration can select behavior,
and descriptors or credentials may introduce other authority. Full execution
closure and general identity-safe binding remain acceptance work.

For native program execution, the trusted CLI now canonicalizes the selected
workspace and existing absolute policy scopes before admission, replaces the
conventional `workspace` binding with that canonical identity, and refuses a
symlink-ancestor alias unless the supervisor grants the physical directory.
Runtime separately binds the exact generated private Cell directory to the
Cell receipt by device/inode before retaining it. These close the demonstrated
workspace-alias and lifecycle substitution paths; they do not make Admission a
general symlink-, mount-, or rename-race-safe resolver for every resource.

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

1. receives the canonical workspace identity bound at the trusted CLI seam;
2. fingerprints the source workspace;
3. creates a fresh same-volume private workspace using clone or copy;
4. registers that exact path for lifecycle retention;
5. runs `/usr/bin/sandbox-exec` with a generated Seatbelt profile;
6. permits process fork and exact `process-exec` paths for the admitted root
   and its root-scoped declared descendants;
7. permits ambient `file-read*`;
8. creates a private per-Invoke temp directory, exports it through `TMPDIR`,
   `TMP`, and `TEMP`, and excludes it from the proposed delta;
9. permits writes only in the private workspace, declared temporary
   directories, and `/dev/null`;
10. denies `network*`;
11. runs the requested executable in the private workspace;
12. fingerprints the live and private trees;
13. reports private delta candidates and any live drift;
14. leaves live mutation to a later `Apply.merge`; and
15. on completion, typed failure, or cancellation, verifies the Cell-reported
    private directory identity and transfers it into Hold as
    `purpose: runtime-private`.

Before the first live mutation, the runtime revalidates the Cell baseline and
preflights every delta entry. The current merge envelope is top-level regular
files and directories. Symlinks, special files, unsupported topology, overlap,
source drift, and target drift are refused. Each accepted entry is installed
or removed through Hold.

The profile's precise limitations matter:

- ambient host reads are allowed, so confidentiality is not provided;
- process-group cancellation is bounded but not proven against every
  daemonization or descendant-escape technique;
- exact executable-edge fencing does not mediate dynamic-library loads,
  agent-owned code interpreted in-process, configuration, plugins, or other
  behavior that occurs without a new exec;
- external executable binding records requested, launch, and allowed paths but
  does not yet bind immutable code bytes across path replacement races;
- network is denied rather than brokered;
- a multi-entry merge performs individually recoverable Hold transitions but
  is not claimed as one atomic transaction;
- runtime-private trees remain retained until a supervisor reaps them, and a
  process crash before lifecycle finalization still needs startup
  reconciliation; and
- ACLs, xattrs, hardlinks, sparse files, special files, mounts, live writers,
  and protocol state remain outside the established envelope.

Runtime-private Hold acts are visible in lifecycle receipts, excluded from
ordinary “undo last,” and not directly undoable. Runtime never sweeps a path
prefix; it transfers only the registered exact identity. Reaper remains the
only operation that discards the retained tree.

The mechanism is intentionally expensive today. A measured repository no-op
before retirement took about 6.1 seconds and created about 212 MiB of logical
private-tree data for one Invoke. Retirement itself is a same-volume rename,
but each Invoke still pays for private-view construction and multiple
full-tree fingerprints; changed clone pages or copy fallback consume storage
until reap. Persistent Cells, incremental fingerprints, batching, and working
set/checkpoint semantics are open performance work, not hidden v1 properties.

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
- atomic no-replace installation/restoration on macOS through
  `renamex_np(RENAME_EXCL)`, with a typed fail-closed platform capability;
- protection for filesystem root and Airlock state;
- file/directory modeling with fail-closed symlink handling on replacement;
- journaled runtime-private staging reserved before native adapters populate
  candidate files/directories;
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
lock-directory growth. The direct mechanism proof launches 16 independent Bun
processes against one stable lock inode; every contender completes, a separate
kernel `O_EXCL` sentinel records no overlap, and the Schema-decoded event trace
has maximum occupancy exactly one. The replacing rename used to publish a
journal replica is deliberately separate from the no-replace primitive used
to install live managed bytes. A concurrent foreign target is preserved and
returned as a typed conflict rather than overwritten.

Native write/copy/move/mkdir glue no longer creates an untracked staging path.
It asks Hold to reserve a runtime-private act first, then populates the supplied
stage and installs through the ordinary replacement transition. A failed,
interrupted, or abandoned population remains enumerable recovery material for
Reaper rather than orphan adapter state.

Reaper cancellation has an explicit terminal boundary. Waiting for the Hold
lease remains interruptible and leaves the act held. After Reaper takes
terminal removal authority, removal and directory sync are uninterruptible.
If cancellation interrupts the subsequent Ledger publication, the operation
returns `HoldReapRecoveryRequired` with `phase: "ledger"`, confirmed current
removal, and the exact reaped/current evidence rather than reporting a normal
failure that could invite an unsafe retry. This characterizes the tested
cancellation windows; it does not establish every crash point.

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

For Airlock-owned `RequestExternal` intents, `Outbox.commit` performs the only
runtime wire-capable call:

- it claims a staged entry by renaming it to `committing`;
- reads the private request;
- uses `fetch` with `redirect: "manual"`;
- cancels the response body rather than buffering attacker-controlled bytes;
- records completed, failed, or uncertain outcome; and
- treats a recovered `committing` directory as `uncertain`.

The commit first claims staged state; cancellation is legal only before that
claim. This is an HTTP dispatcher, not the candidate EndpointBroker. It does
not yet mediate DNS rebinding, proxies, every redirect, host loopback, Unix
sockets, descriptor passing, protocol idempotency, credential capabilities, or
contained-process egress. Native Cells currently receive no network at all.
Compatibility children retain ambient host network, so their own sends are not
Outbox dispatches and carry none of these staging or uncertainty guarantees.

## Programs, artifacts, and receipts

`airlock run` is the current integrated path:

```text
source + JSON bindings
  → parser/evaluator
  → canonical native action or accepted inert definition action
  → PlanDraft
  → Admission
  → ExecutionAuthority
  → trusted action/runtime adapter
  → result + Plan summary + artifact metadata
```

Captured and generated bytes move as explicit artifacts. A later Invoke can
bind an artifact as stdin, and a later `http.stage` can bind body data. The CLI
returns artifact identity, media type, byte length, and provenance; it does
not copy artifact bytes into the JSON summary.

Runtime node receipts record sequence, node state, admitted resource
identities, input digests, and output artifact references. Hold and Outbox also
append domain entries to Ledger. Ledger now serializes cross-process appends,
fsyncs the file and parent directory, repairs a valid torn final newline, and
durably quarantines an invalid tail with typed evidence. It is still not a
fully specified compaction or tamper-evident multi-component Journal.
Native Runtime results also carry typed lifecycle receipts for the exact
private workspace that was held, already absent, or failed retention.

Runtime's separate persistent run journal publishes `running`, `finalizing`,
and terminal snapshots. A SHA-256-derived per-Plan claim file under its
`.claims` directory is held through the full lifecycle with the kernel-backed
exclusive-file lease. Missing persistent storage, claim acquisition failure,
or a prior snapshot is reported as `RuntimeExecutionClaimRejected` with
`persistent-journal-required`, `acquire`, or `replay`; no node adapter runs on
those paths.

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

## Execution closure and cross-plan flow

The implemented native mechanism is an **executable edge set**:

```text
root executable (`invoke`)
  → exact descendant executable paths for that root (`execute`)
```

Admission prevents a descendant-only Grant from becoming root authority.
Seatbelt permits fork but grants `process-exec` only to the resolved paths in
that set. Workspace-local executables are rebased into the private view;
receipts retain requested, launch, allowed-path, role, and rebase evidence.
This blocks an undeclared helper exec and is useful containment. It is not a
semantic description of all code that runs.

An executable path or binary digest is not a complete description of what
runs. The stronger candidate contract is a full **execution closure**:

```text
root/image identity
+ executable identity and interpreter/shebang chain
+ loader and dynamic-library policy
+ environment and configuration policy
+ descendants, helpers, hooks, plugins, pagers, editors, lifecycle scripts
+ filesystem, endpoint, stream, artifact, and credential Grants
+ budgets, expiry, cancellation, and receipt obligations
```

The current native Cell does not bind this full closure. Dynamic libraries and
configuration arrive through allowed file reads; an admitted interpreter can
execute agent-owned bytes in-process; plugins may execute within an already
admitted process; external executable paths may race with mutable code bytes;
and process-group ownership does not prove every daemonization path.
Definitions describe invoke contracts but do not attest the opaque program or
its transitive dependencies.

The checked-in Bun proof makes this boundary concrete: `/bin/bash`, admitted
as the only executable, sources an agent-owned `BASH_ENV` without a second
exec. Seatbelt still denies the sourced code's live-workspace write and
loopback connection, while its private write appears as the sole delta. That
successful proof is evidence for executable-edge fencing plus resource
confinement, not evidence of a full execution closure.

Authority also composes across time. A low-network/no-network Plan can write a
Git hook, package lifecycle script, build file, rc file, executable, trust
store, or credential-helper configuration. A later Plan with stronger
authority can consume those persisted bytes. Per-Plan admission cannot detect
that history merely by inspecting the later executable path.

This **persistent authority laundering** problem is a first-class design
pressure, not a new law with a presumed complete solution. Candidate
mitigations include:

- classifying execution-adjacent paths distinctly from ordinary project data;
- tool contracts that disable or bind ambient config, hooks, helpers, pagers,
  editors, and lifecycle scripts;
- conservative provenance/integrity on derived artifacts;
- explicit supervisor endorsement before untrusted bytes become trusted
  execution, policy, definition, or credential material; and
- immutable execution roots or VM images for stronger profiles.

### Confidentiality and integrity direction

The candidate information-flow component uses two independent orderings:

```text
Confidentiality: public < project < private < secret
Integrity:       untrusted < project < operator < runtime
```

Derivation moves conservatively: an output takes the highest confidentiality
of its inputs and the lowest integrity of its inputs. Ordinary computation
cannot silently declassify confidential data or endorse untrusted data. An
external sink would require a scoped declassification capability when its
ceiling is lower; a trusted executable/config/policy sink would require a
separate endorsement capability when its floor is higher.

This need not imply byte-level taint tracking. Node/artifact labels can provide
a useful conservative first contract. Today the pure Schema-first lattice,
checks, and typed transition receipts exist, but Plans, Cells, Outbox, and
persisted filesystem state do not propagate or enforce them end to end.
Accordingly Airlock does not yet prevent confidential-read plus external-write
exfiltration or untrusted-write plus later privileged-execution laundering.

### Endpoint and credential brokerage

Contained network and high-value credentials are future capabilities. The
candidate EndpointBroker would own DNS, redirects, proxy selection, loopback
and link-local policy, Unix-socket and descriptor-import policy, byte/time
budgets, revocation, and receipts for the actual destination. It would grant a
bounded dispatch lease, not ambient sockets. Current native Cells instead deny
network, and current Outbox dispatches a bounded HTTP intent itself.

For credentials, the preferred stronger shape is a non-extractable capability:
“sign this admitted request” or “attach this credential only to this admitted
destination,” rather than handing raw secret bytes to an opaque executable.
Raw secret projection may remain a compatibility mechanism, but once an
executable receives those bytes Airlock cannot claim to prevent their
disclosure through another admitted channel. Neither broker is implemented.

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
- Ledger is an implemented durable append seam with bounded recovery evidence,
  not yet a complete compaction or tamper-evident multi-component Journal.

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

The current CLI composes services through one application Layer graph and
runtime. It does not yet run a persistent daemon or expose the future local RPC
surface.

## Security model: current guarantees and directions

Implemented, bounded properties:

- structured executable and argv data avoid shell-text construction;
- the integrated program seam retains and validates the exact
  Plan/Grant/Handle closure as `ExecutionAuthority`;
- native Admission separates root `invoke` from root-scoped descendant
  `execute`, and Seatbelt fences new execs to the resolved executable edge set;
- Cell and Runtime receipts retain executable binding roles and resolved path
  evidence;
- native workspace aliases are canonicalized before admission and the
  conventional workspace binding is supervisor-owned;
- the native Cell separates private process writes from later live Apply;
- each native Invoke receives a private temp directory whose runtime-owned
  path is excluded from the proposed merge delta;
- native Cell network is denied;
- exact private Cell directories enter runtime-private Hold lifecycle on the
  normal completion/failure/cancellation path;
- Hold owns supported managed replacements;
- Outbox owns HTTP dispatch;
- profile mismatch and missing enforcement fail closed;
- accepted v1 tool definitions are inert invoke-only data with total lowering
  into the existing Plan path; and
- the pure label module prevents ordinary derivation from lowering
  confidentiality or raising integrity.

Acceptance conditions, not current guarantees:

- complete mediation by an agent harness with no alternate effect tool;
- complete transitive execution closure;
- immutable identity-safe resolution for every path, executable byte
  sequence, mount, and descriptor under races;
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

“Shell parity” here is task-level parity for agents inside a published
enforcement envelope. It does not mean human shell syntax, universal Unix
semantics, or that compatibility and native containment make the same claim.

macOS v1 is judged on what this release implements:

- compatibility preserves the zero-config capability ratchet and reports no
  containment;
- native-contained must pass every task it advertises, fail unsupported work
  explicitly, and never downgrade; and
- the agent-only acceptance corpus must measure real task completion without
  direct shell or alternate effect authority.

The repository now contains five different kinds of evidence that must not be
collapsed:

1. 72 Unix-informed **contract shapes** across 10 families parse, decode, lower
   to Plans, validate, and compatibility-admit. Eight unsupported classes are
   explicit. This shows breadth of the current vocabulary and contracts, not
   that a model completed 72 tasks or that the runtime executed them.
2. Eleven **executed parity workloads** comprise five foundational top-level
   file/process/control/native-rewrite fixtures, five agent-only repository,
   edit, archive, local-Git, and build-descendant fixtures, and one destructive
   native-removal fixture.
3. Two **Vouch-derived local proofs** exercise the generic restore and host
   workflow decomposition without running real Vouch/OpenShell remote work.
   Both pass as individual tests in the final integrated gate. No repeated-run
   report is checked in, so they are not described as repetition campaigns.
4. Bun/macOS boundary proofs exercise the private write/network/temp fence,
   exact executable descendants and shebang chains, and the admitted
   interpreter/in-process-code boundary.
5. One [**50-execution repeatability
   campaign**](docs/evidence/parity-50.md) launches the real agent CLI as a
   fresh Bun subprocess for exactly ten deterministic scripted cases, five
   repetitions each: 40 compatibility and 10 native-contained successes. The
   automated gate enforces a five-minute cold-campaign ceiling. It is not 50
   unique/model-generated tasks, a direct-shell A/B, or a held-out corpus.

The final integrated `bun run verify` gate passes 52 test files plus one
skipped file and 254 tests plus 16 skipped tests. Its explicit Bun/macOS
boundary suites pass 11 ProcessRunner, eight native Cell, seven
executable-edge, and nine in-process-boundary cases. These counts establish the
revision's tested baseline; they do not transform fixtures into representative
agent-task evidence.

The published native exclusions include unstructured command strings, symlink
Apply, special files/devices, mount mutation, interactive PTY/job control,
contained endpoint access, daemon/session escape, and remote-filesystem Apply.
The broader honest gap list also includes hardlink/ACL/xattr/sparse fidelity,
live foreign-writer or SQLite/WAL state, atomic multi-entry merge, complete
execution closure, confidentiality, endpoint/credential brokerage, root/GUI
administration, and crash recovery before Cell lifecycle finalization.

The future VM backend may later widen the enforceable set and strengthen
confidentiality. It is not used to postpone or manufacture the v1 claim.

No moderate or strong shell-replacement claim is available today. The current
evidence supports a usable, substantial local developer preview, but it lacks
the frozen 50-task model/harness corpus and direct-shell baseline, repeated
platform runs, exhaustive fault/overlap campaigns, and adversarial security
evidence described in
[`docs/acceptance.md`](docs/acceptance.md).

## Open questions

The following remain unresolved:

- the smallest model-reliable Airlock language beyond current implemented
  forms;
- exact path, hardlink, metadata, mount, liveness, and multi-entry transaction
  semantics;
- startup reconciliation for stranded Cells, plus persistent Cell,
  incremental working-set, and checkpoint semantics;
- end-to-end artifact storage and Journal durability protocol;
- selector, issuance, revocation, and persistence semantics for labels and
  supervisor capabilities;
- execution-adjacent resource classification across runs;
- immutable executable identity and full loader/config/plugin interpretation
  policy beyond the current exact executable-edge set;
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

- target human interactive shell use or reproduce shell textual semantics;
- reimplement Unix tools or their application protocols;
- infer an agent's true intent;
- claim universal Unix capability parity outside an advertised task/resource
  envelope;
- promise that external effects are reversible or exactly once;
- provide a distributed transaction;
- protect against kernel, administrator, hypervisor, or physical compromise;
- treat installed code or definitions as trustworthy by existence;
- claim confidentiality from the current native profile;
- claim a VM that is not implemented; or
- describe the current Vouch/parity fixtures as a representative corpus.
