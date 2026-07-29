# Airlock — macOS-first v1 architecture

> Status: accepted product direction and candidate implementation architecture.
> Only the two laws in `DESIGN.md` are frozen repository invariants today.
> Sections marked **v1 contract** define release gates, not claims about the
> current implementation.
>
> This document separates established product intent, current repository
> commitments, candidate mechanics, and open questions. Its purpose is to make
> the whole idea legible enough to criticize before more invariants are frozen.

## Abstract

Airlock is an agent-only runtime and language for Unix machine work. It removes
ambient shell authority from the agent, replaces textual command construction
with typed action calls and handles, and lowers machine work into four
operational nodes: Capture, Invoke, Apply, and RequestExternal. Airlock does not
reimplement Unix tools. It composes them, surrounds them with recoverable local
state and cancellable external intent, and records durable receipts.

macOS is the first release target. `vm-enclosed` is the broad
shell-replacement profile for arbitrary existing tools; `native-contained` is
the lower-overhead subset whose guarantees the native backend can actually
enforce. The zero-configuration `compatibility` profile preserves the ratchet
law and makes no containment claim.

## 1. The thesis

Airlock is an agent-only programming language and machine runtime.

In an Airlock-enabled agent harness, the agent is not given Bash, zsh, a
terminal, a generic process launcher, direct filesystem mutation, or raw
network access. It is given Airlock. Airlock becomes the sole reference
monitor for agent-originated machine effects.

This does not make Airlock the highest authority on the machine. The operating
system, administrator, and grant issuer remain outside and above it. It means
that there is no second path by which the agent can affect the machine.

Airlock seeks measured task-level shell capability parity for agents, not
shell syntax parity and not human-shell ergonomics:

> Within a published platform and profile envelope, an agent should complete
> representative Unix work without direct shell authority, while destructive,
> ambiguous, and prematurely irreversible paths become structurally
> constrained.

Airlock is not a new operating system, kernel, archive library, package
manager, Git implementation, database, or replacement for the Unix ecosystem.
Existing programs remain the implementations:

```text
tar stays tar
git stays git
sqlite3 stays sqlite3
curl stays curl
docker stays docker
openshell stays openshell
```

Airlock supplies the language, terms, authority model, execution chamber,
recovery mechanics, external-effect staging, and durable evidence around those
programs.

The runtime and domain model are implemented with Effect. Airlock programs are
written in Airlock and executed by the Airlock runtime. Small platform-native
workers may provide OS primitives that Effect or Bun cannot expose directly,
but they do not define language semantics or extend Airlock's physics.

Airlock should replace Bash, Python, Ruby, and TypeScript as agent
orchestration glue in agent harnesses. It does not need to replace those
ecosystems as computational libraries. An existing Python helper may run inside
a constrained Airlock cell when its libraries are genuinely useful; the agent
still orchestrates it, grants its resources, handles its result, and applies
its effects through Airlock.

Vouch is the first adoption and acceptance corpus, not a source of Airlock
vocabulary. Its vertical slice must lower only through general Unix actions,
and a held-out unrelated repository corpus must follow it to expose overfitting.
OpenShell, Hermes, sandboxes, and Vouch policies remain ordinary compositions
over that ontology.

## 2. What Airlock changes

Shell currently collapses several independent concerns into one textual act:

```text
command construction
+ executable resolution
+ authority acquisition
+ execution
+ local finality
+ external finality
```

For an agent, a line of shell can therefore be both an imprecise request and
an immediate exercise of ambient machine authority.

Airlock separates those concerns:

```text
agent source
  → typed action call
  → inert plan
  → resource resolution
  → authority admission
  → supervised execution
  → gated local/external effects
  → durable receipts
```

Airlock does not need to infer the agent's true intent. It changes the physical
path from an expression to a world effect.

## 3. Epistemic status

This document uses four levels deliberately:

- **Established intent** — repeatedly and emphatically stated product
  direction.
- **Current commitment** — a law already present in the repository and guarded
  by implementation or tests.
- **v1 contract** — a falsifiable condition that the macOS release must meet;
  it is not evidence that the current prototype meets it.
- **Candidate architecture** — the strongest design model so far, still
  subject to counterexamples.
- **Open question** — a decision that does not yet have enough evidence to
  become a contract or invariant.

The agent-only purpose and the reuse of existing Unix programs are established
intent.

The single reaper unlink site and the ratchet posture are current repository
commitments. The current prototype also has a single Outbox network site; the
v1 contract strengthens that observation into a brokered dispatch seam.

The macOS-first target, Vouch-first adoption order, three named profiles, and
the measurable acceptance threshold are v1 contracts.

The precise Schema shapes, handle taxonomy, Plan interpreter, language
surface, Cell implementation, label lattice, endpoint broker, and remote
protocol remain candidate architecture until implementation and adversarial
evidence earn them.

| subject | status at this revision |
|---|---|
| only the reaper unlinks | current invariant |
| ratchet law | current invariant |
| Hold and Outbox domain nuclei | implemented, narrower than v1 |
| Ledger | implemented prototype, not yet a crash-safe Journal |
| four Plan nodes and closed runtime operations | candidate contract |
| VM and native macOS containment | v1 contract, implementation evidence pending |
| information-flow enforcement | v1 contract, implementation evidence pending |
| custom language syntax | open pending corpus measurement |
| remote realms and Linux portability | post-v1 direction |

## 4. The compact physics

The four effect classes in `DESIGN.md` map directly to four Plan constructors:

1. **Capture / observation** — information enters an Airlock program.
2. **Invoke / computation** — existing code runs inside an Airlock-owned Cell.
3. **Apply / mutation** — managed local durable state changes through Hold.
4. **RequestExternal / emission** — agent intent may enter Outbox as inert
   staged data.

Pure computation and composition are language semantics, not additional world
effects.

Capture, Apply, and eventual dispatch cross boundaries. Invoke is the execution
enclosure. RequestExternal lowers first to a local durable `StageExternal`
transition; the privileged `DispatchExternal` runtime operation is the actual
unmanaged crossing. Keeping those events distinct prevents a staged request
from being misreported as a send.

```text
PlanNode       = Capture | Invoke | Apply | RequestExternal
BoundaryEffect = Capture | Apply | DispatchExternal
Executor       = Cell(ExecutionClosure)
```

An action can involve several boundary effects. The labels are not mutually
exclusive categories assigned to an entire command.

Conceptually:

```text
Program<A> =
    Pure<A>
  | Capture<Source, A>
  | Invoke<Execution, CellReport>
  | Apply<LocalDelta>
  | RequestExternal<ExternalIntent>
  | Compose<Programs, A>
```

The hypothesis to test is:

> Every supported Unix machine operation can lower into Capture, Invoke,
> Apply, and RequestExternal and the closed runtime algebra without adding
> another authority source, destructive site, or external gateway.

The architecture keeps several independent axes separate:

| Question | Airlock concept |
|---|---|
| What crosses a world boundary? | Capture, Apply, DispatchExternal |
| How does existing code run? | Invoke inside Cell |
| What may this run touch? | Grants, handles, Admission |
| How are operations composed? | Airlock language and Plan IR |
| What actually happened? | Receipts and Journal |
| Which behavior is admitted automatically? | Profile and policy |
| How does a particular Unix tool become convenient? | Inert tool definition |

### Core terms at a glance

- **Program** — Airlock source: pure composition plus calls to actions.
- **Action** — a typed named operation that lowers into the closed Plan
  algebra.
- **Definition** — inert declarative data describing a tool-backed action.
- **PlanDraft** — an effect manifest with unresolved authority requirements.
- **Plan** — an admitted executable manifest containing resolved handles.
- **Grant** — authority supplied from outside the agent program.
- **Handle** — a runtime-minted, typed reference to classified authority.
- **Realm** — a boundary inside which one Airlock runtime can enforce stated
  guarantees.
- **Cell** — the owned process and private-filesystem enclosure for Invoke.
- **ExecutionClosure** — the complete transitive code/config/descendant set
  and authority contract owned by a Cell.
- **Artifact** — immutable content referenced by digest.
- **LocalDelta** — proposed managed-state transitions, not yet live.
- **Hold** — the exclusive recovery mechanism and authority for Apply.
- **ExternalIntent** — a frozen endpoint-bearing invocation awaiting dispatch.
- **Outbox** — the exclusive staging and dispatch authority for external
  intents.
- **EndpointLease** — a bounded, revocable broker grant created only for an
  admitted Outbox commit.
- **InformationLabel** — confidentiality, integrity, and provenance attached
  conservatively at node boundaries.
- **Receipt** — one immutable transition fact and its evidence references.
- **Journal** — durable ordered receipt storage and derived runtime state.
- **Reaper** — the sole authority for irreversibly discarding retained
  recovery material.
- **Profile** — admission and lifecycle policy over the same underlying
  physics.

## 5. Capture: information enters

```text
Capture(specification) → Observed<Value>
```

Capture includes:

- File contents and metadata
- Directory listings
- Environment values
- Time and randomness
- Process and system state
- Standard input
- Child-process output
- External responses

An observed value carries node-boundary provenance:

```text
value or artifact reference
source handle
source identity
realm
observation time
digest or resource version
size
sensitivity labels
producing plan node, when derived
```

Airlock does not claim per-byte taint tracking through arbitrary native
programs. When a process transforms several inputs, its output is attributed
to the producing node and its declared/captured inputs. That is useful,
implementable provenance without pretending to understand arbitrary binary
semantics.

A downstream plan may bind itself to an observed resource identity or digest.
Immediately before the dependent action, Airlock revalidates the bound
precondition. If it changed, Airlock reports drift.

This reduces time-of-check/time-of-use hazards for handles and preconditions
Airlock actually bound. It does not claim to eliminate every dynamic lookup an
arbitrary executable may perform.

Reading from an external endpoint is not Capture alone. It first requires an
external interaction, followed by Capture of the response.

PII detection, prompt-injection screening, secret classification, and
information-flow restrictions are policy over observations. They are not new
physics.

## 6. Invoke: execution inside the chamber

```text
Invoke {
  executable: ExecutableHandle
  args: List<Value>
  cwd: DirectoryHandle
  env: Map<String, ValueOrSecretReference>
  stdin: StreamSpec
  stdout: StreamSpec
  stderr: StreamSpec
  timeout: Duration
  readable: Set<ResourceHandle>
  writable: Set<ResourceHandle>
  endpoints: Set<EndpointHandle>
  limits: ExecutionLimits
}
```

The canonical `run`/`Invoke` command contract is:

```text
{ executable, args, stdin, stdout, stderr, timeout }
```

`executable` is a separate runtime-minted handle or resolved absolute identity.
`args` contains only the program arguments; it never repeats the executable as
element zero. Working directory, environment, handles, labels, Cell profile,
and resource budgets are explicit surrounding execution fields rather than
ambient process state.

Airlock owns:

- Executable resolution and identity
- Argument-vector construction
- Working directory
- Constructed environment
- Configuration and inherited descriptors
- Standard streams and process graphs
- The complete descendant process tree
- Signals, deadlines, and cancellation
- CPU, memory, process, output, disk, and descriptor budgets
- Filesystem and endpoint authority
- Exit status, captured output, and resource usage

There is no ambient command-string interpreter. The foundational execution
form is an executable handle plus a separate argument array.

Writable resources are presented through a private view. The executable may
use its own libraries, hooks, descendants, and normal algorithms inside that
view, to the extent admitted by its execution contract. When it exits, Airlock
produces a `CellReport` and, when requested, a proposed `LocalDelta`. The
process does not merge that delta into live managed state.

A process may unlink disposable files inside its private view. Absence reaches
live state only through `Apply` and `Hold`.

Network or other endpoint authority is absent from an ordinary local cell. An
endpoint-bearing invocation must first become an `ExternalIntent` in Outbox.

Pipelines are process graphs inside a cell. Streams are explicitly owned:

```text
capture sink       → Capture
managed file sink  → artifact followed by Apply
process pipe       → internal Cell stream
TTY/socket/device  → external endpoint
```

Background descendants cannot silently outlive the Cell. They are cancelled
with the owned process tree. Deliberate detachment is an external act toward a
scheduler or service manager.

### Executable admission is more than a binary allowlist

Many ordinary programs are meta-execution surfaces:

- Shells and language interpreters
- `find -exec`, `xargs`, and `awk system()`
- Git hooks, aliases, filters, pagers, editors, and credential helpers
- Package lifecycle scripts
- Build systems and compilers
- Shebang interpreter chains
- Tool plugins and user configuration

An `ExecutableHandle` therefore identifies an executable and an execution
contract. In enclosed mode the contract can constrain:

- Descendant execution
- Executable and shebang resolution
- Environment and configuration discovery
- Hook, plugin, helper, pager, and editor behavior
- Readable and writable resources
- Endpoint and protocol access
- Secrets
- Resource budgets

The OS Cell boundary remains the enforcement source. A tool definition's
declared footprint is not trusted as enforcement.

### Execution closure

**v1 contract.** Airlock admits and owns an execution closure, not merely a
binary pathname or digest:

```text
ExecutionClosure {
  root/image identity
  executable and loader/shebang chain
  permitted descendant resolution
  dynamic library policy
  configuration and environment policy
  hook, plugin, helper, pager, editor, and credential-helper policy
  readable, writable, endpoint, and secret handles
  inherited descriptor policy
  limits and lifetime
}
```

The closure is transitive. It includes every descendant and every executor
selected through `exec`, shebangs, loaders, hooks, build systems, package
scripts, plugins, aliases, helpers, pagers, editors, interpreters, or
configuration discovered by the invocation.

In `native-contained`, admission must pre-bind an executable identity or the
backend must mediate each later execution. Unknown or unmediated execution is
denied. In `vm-enclosed`, unknown guest execution may be admitted because its
authority remains bounded by the VM realm and host brokers; it does not gain
host authority merely because a new guest binary runs.

No inherited descriptor, environment value, `PATH` entry, config lookup,
daemonization technique, foreign-process attachment, or background job may
escape the closure. A Cell reaches a terminal state only after all descendants
have exited or the runner has terminated them. A deliberately persistent
process becomes an owned long-lived Cell with explicit lifetime and sibling
endpoint handles; detachment is never accidental.

PTYs and REPLs are allowed only as explicit Cell streams. They retain the
containment guarantee but provide coarser semantic attribution: the receipt can
say which bytes entered which owned interpreter, not what each byte meant.

## 7. Apply: managed local state changes

```text
Apply(LocalDelta) → HoldReceipt
```

A local delta describes desired resource bindings rather than commands such as
`rm`, `cp`, or `mv`:

```text
resource address
expected previous identity and state
desired new binding, metadata, or absence
```

Examples:

```text
remove(path)             → path becomes absent
write(path, artifact)    → path becomes artifact
mkdir(path)              → path becomes directory
move(a, b)               → a absent; b receives a
set_metadata(path, data) → path receives supported metadata state
merge(cell_delta)        → finite collection of transitions
```

Before a live binding is displaced, its recoverable prior state enters
`Hold`. New state is staged and installed through namespace replacement.
Undo is itself another recoverable displacement; it never blindly destroys
whatever currently occupies the target.

Current repository commitment:

> Every live mutation verb is a rename through Hold.
>
> Only `Hold.reap` may irreversibly unlink retained live-state material.

Every live mutation surface must lower through Hold. There is no second direct
write path for native actions, cells, tools, or remote orchestration.

Apply is available only where Airlock can honestly provide its recovery
physics. A pathname is a locator, not a resource classification. It might
resolve to:

- A local regular file, directory, or symlink
- A hardlink topology
- A FIFO or Unix socket
- A device
- procfs or sysfs
- NFS, SMB, or a FUSE mount
- Another remote or virtual filesystem

The first class can potentially be a managed local object. The others are
external endpoints or unsupported resources unless a backend proves stronger
semantics.

An initial operational envelope may support only quiescent regular files,
directories, symlinks, selected metadata, and supported local filesystems.
Regular-file shape alone is insufficient: a SQLite database with active
WAL/SHM sidecars, an append-only log with a foreign writer, or a daemon-owned
mailbox is live protocol state. Airlock must refuse it, use a format-aware
action, or advertise a weaker guarantee.

Hardlinks, ACLs, xattrs, ownership, sparse files, open descriptors,
cross-volume moves, liveness, advisory locks, and filesystem-specific identity
require explicit semantics and fixtures.

Unsupported cases fail structurally. They do not borrow the word
"undoable."

Hold payloads must reside on a filesystem where the required rename guarantee
holds, generally through per-volume or per-realm hold depots. A global hold
directory alone cannot guarantee atomic cross-volume rename.

Apply does not promise that an arbitrary multi-path plan is an ACID
transaction. It promises explicit, recoverable transitions with honest
partial outcomes.

Large deltas may be applied as one transaction group with an aggregated
receipt that references per-resource evidence. Batching may reduce journal and
rename overhead, but it cannot hide partial application, weaken expected-state
checks, or introduce a second live mutation path. Recovery windows and
reap-eligibility are explicit in receipts so disk-pressure policy cannot
silently shorten the advertised guarantee.

## 8. Request external intent; dispatch across the boundary

```text
RequestExternal(ExternalIntent) → StagedOutboxReceipt
```

An endpoint is any consequential authority not controlled by the current
Hold:

- TCP and Unix sockets
- DNS and proxy resolution
- Docker and database daemons
- Service managers and schedulers
- Foreign processes
- Remote filesystems and machines
- TTYs, printers, clipboards, and hardware devices

The staged value may be a protocol request, but for arbitrary Unix tools it is
usually a frozen invocation:

```text
ExternalIntent {
  executable identity and execution contract
  args, environment, streams, timeout, and limits
  artifact references
  admitted endpoint handles
  idempotency evidence
}
```

Before commit, it is inert and cancellable. `RequestExternal` therefore lowers
to a local durable staging transition, not an unmanaged effect. Commit is the
sole gateway that may activate endpoint authority and dispatch the invocation.

Current repository commitment:

> `Outbox.commit` is the only component that can grant external dispatch
> authority.

The eventual child process may perform the socket system calls, but only a
commit can create a process carrying endpoint authority.

Candidate states are:

```text
staged
cancelled
dispatching
completed
failed
uncertain
```

Once dispatch begins, Airlock can cancel its owned process and close its
connections. It cannot guarantee that the external recipient did nothing.
Cancellation is not reversal. `uncertain` is therefore a first-class outcome.

An uncertain external act is never automatically retried without
protocol-backed idempotency evidence.

Staging an opaque networked executable freezes the invocation, not necessarily
every wire action it will perform. A process might make several requests,
follow redirects, resolve names, or open several admitted connections. Unless
Airlock mediates the protocol through its own broker, its honest receipt says:

> This invocation was dispatched with this endpoint authority.

It does not say:

> This exact high-level request was the only external effect.

Base Airlock does not implement HTTP, Docker, PostgreSQL, or other
application-protocol libraries. It stages and supervises existing executable
implementations. Airlock's own authenticated realm transport is runtime
infrastructure, not a user-facing replacement for those tools.

### Endpoint brokerage

**v1 contract.** Contained processes receive no ambient host networking and no
raw host Unix socket. `Outbox.commit` asks the EndpointBroker for a bounded
lease tied to one admitted intent:

```text
EndpointLease {
  intent and plan identity
  destination selector
  protocol class
  DNS/redirect/proxy policy
  connection, byte, and time budgets
  confidentiality release ceiling
  expiry and revocation
}
```

The broker owns destination resolution, DNS, redirects, loopback and link-local
decisions, proxy configuration, connection limits, and actual-destination
receipts. Every redirect or new connection is checked independently.
`localhost` inside a VM means the guest, never the host. Host Unix sockets are
not mounted into a contained realm. Brokered Unix-socket protocols must reject
or terminate descriptor import such as `SCM_RIGHTS`; otherwise the peer could
mint authority outside Airlock handles.

`vm-enclosed` routes guest egress through a host broker/gateway and can support
opaque existing network tools under hostname/port/protocol-class leases.
`native-contained` supports only endpoint classes for which the native backend
can enforce the lease; other networked actions are unavailable rather than
silently receiving raw networking.

The broker supervises existing protocol implementations; it does not make
Airlock an HTTP, Git, SSH, Docker, or database reimplementation. A
transport-level lease earns only an invocation-level receipt. A protocol
broker may earn a more precise receipt and idempotency claim, but only for the
protocol it actually mediates.

High-value credentials should remain non-extractable where possible:

```text
CredentialCapability + frozen request → brokered authenticated act
```

Raw secret projection to an executable remains a compatibility fallback and
is reported as such.

### The two-door rule

The implementable form of "both doors never open at once" is:

> A process never holds live managed-state mutation authority and unmanaged
> endpoint authority at the same time.

A networked process that also writes files runs as follows:

```text
1. Freeze and stage its external invocation.
2. Build a private writable view.
3. Commit the external intent and grant admitted endpoints.
4. Run the process while all local writes remain private.
5. Close endpoint authority and finish the external phase.
6. Capture its result and derive the local delta.
7. Validate and Apply that delta separately through Hold.
```

The external phase and local merge are deliberately not presented as atomic.
If dispatch succeeds and local merge fails, the receipt says so.

The two-door rule does not by itself prevent exfiltration or cross-plan
authority flow. Confidential reads plus endpoint writes are governed by
information labels, and writes that influence later privileged execution are
governed by persistent-authority rules.

## 9. Pure composition and the Airlock language

Airlock programs compose the four operational nodes with pure language forms.
A candidate language needs:

- Immutable typed values
- Text, bytes, numbers, booleans, records, lists, maps, options, and results
- Paths, realms, durations, instants, artifacts, handles, and receipts
- Schemas and structured decoding
- Pure functions and transformations
- Sequence, branching, and matching
- Finite iteration and bounded parallelism
- Structured error handling
- Deadlines, cancellation, and cleanup scopes
- Effect-aware retry and polling
- Process graphs and explicit streams
- Calls to native and defined actions

The language should not have:

- Shell interpolation or command substitution
- Implicit globbing or word splitting
- Ambient executable lookup
- Ambient working directory or inherited environment
- `eval`
- Executable extension hooks
- An unstructured shell escape
- A conversion from a path, URL, or executable string directly into authority

The syntax is optimized for model generation, schema discovery, deterministic
parsing, and structured errors. It is not optimized for human interactive
abbreviation.

Control forms do not create new physics:

```text
pipeline       → process graph and stream wiring
if / match     → plan selection
loop / map     → repeated composition
parallel       → bounded scheduling
timeout        → execution policy
retry          → receipt-aware control policy
finally        → scoped cleanup composition
```

A Capture may materialize the next concrete plan fragment. The whole future
does not need to be known before the first observation, but each effectful
fragment is resolved and admitted before it executes.

The minimum pure-language expressiveness remains an open design problem. It
must be large enough to replace real orchestration scripts without growing
into another general-purpose library ecosystem.

## 10. Native actions

Airlock ships native actions only where the runtime itself owns the necessary
physics.

A provisional Unix-grounded surface includes:

```text
Observation
  stat, list, read, resolve

Managed local state
  write, create, remove, move, copy, link, set supported metadata

Execution and streams
  invoke, capture, pipe, wait, signal owned process, cancel
```

These names are surface constructors over Capture, Invoke, and Apply. They are
not additional physics.

Airlock does not ship native archive extraction, Git operations, SQLite
backups, Docker workflows, package installation, or OpenShell behavior.

## 11. Tool definitions

A tool definition is inert declarative data that adds a typed action vocabulary
over an existing executable:

```text
definition identity and version
compatible executable identities
input and output schemas
action signatures
declarative argument/environment/stream templates
resource requirements
expected effect footprint
declarative result decoder
```

A tar definition may expose an `unpack` action, but it lowers to `Invoke(tar)`
followed by `Apply(cell_delta)`. Airlock still knows nothing about archive
parsing.

An OpenShell definition may expose a `sandbox_upload` action, but it lowers to
a staged OpenShell invocation followed by Capture of its result. Airlock
still knows nothing about sandboxes or uploads.

Definitions may be discovered from built-in, installed, user, and project
locations. Discovery is not authority, and a known location is not by itself
trust.

A definition cannot:

- Execute code while loading
- Contain JavaScript, TypeScript, native callbacks, or install hooks
- Register a new Plan node or effect category
- Mint an executable, path, endpoint, process, or secret handle
- Add another network gateway
- Add another live mutation or unlink site
- Bypass Plan, Cell, Hold, Outbox, or receipts

Definitions state requirements. Grants provide authority. The runtime enforces
the actual boundary.

Tool-definition provenance, precedence, locking, signing, and declarative
decoder power remain open.

## 12. Actions, plans, grants, and handles

The canonical contract pipeline is:

```text
ActionCall
  → ActionDefinition
  → PlanDraft
  → Admission
  → Plan
  → Receipts
```

### Action call

An `ActionCall` is an agent request to invoke a named native or defined action
with typed input data.

### Action definition

An `ActionDefinition` validates the input and lowers it into a `PlanDraft`. It
adds vocabulary but no physics or authority.

### Plan draft

A `PlanDraft` is inert data containing effect nodes and unresolved resource
requirements.

### Grant

A `Grant` is authority supplied by the harness, operator, policy issuer, or
parent runtime. It is bounded by:

```text
principal
resource selector
realm
rights
constraints
lifetime
issuer
```

Effective authority is the intersection:

```text
host ceiling
∩ harness grant
∩ session grant
∩ plan request
∩ cell profile
```

A project or child plan may narrow inherited authority. Widening requires an
external grant issuer.

### Handle

A `Handle` is a runtime-minted reference to a concrete, classified resource:

```text
PathHandle<Realm, Kind>
ExecutableHandle<Realm, Contract>
EndpointHandle<Realm>
StreamHandle
SecretHandle
ArtifactHandle
OwnedProcessHandle
```

A locator remains data until resolved under an existing grant. Paths, URLs,
executable names, environment values, and definition names do not confer
authority merely by being strings.

A handle records or refers to:

```text
resource identity
realm
resource kind
rights
constraints
lifetime
issuer/grant
public provenance
```

### Admission

Admission resolves every requirement to a handle, classifies the resource,
checks applicable grants, evaluates dangerous authority combinations, and
produces an executable `Plan`.

Authority is compositional. Individually plausible grants can create a much
stronger capability:

```text
sensitive read + endpoint write     → exfiltration channel
writable config + trusted executable → future code execution
Docker socket + constrained arguments → daemon-level authority
secret + arbitrary executable + net  → intentional secret disclosure
```

Admission must evaluate combinations, not only individual handles.

### Persistent authority cannot be laundered

**v1 contract.** Filesystem state composes authority across time. A plan with
no network can write `.git/hooks`, a build script, package configuration, a
shell startup file, a tool plugin, an executable, or a launch agent; a later
plan could otherwise execute those bytes with stronger grants.

Airlock classifies execution-adjacent and authority-bearing resources,
including:

```text
executables and executable search paths
tool definitions and policy
Airlock runtime, journal, hold, and outbox state
hooks, plugins, helpers, build and package lifecycle scripts
shell/tool/SCM configuration and credential helpers
launch agents, schedulers, services, and login/startup configuration
credentials, trust stores, and grant sources
```

An `Apply` may write such a resource only under its explicit resource kind and
policy. Persistence does not upgrade integrity. Later resolution considers the
stored provenance and integrity label even across runs and restarts.

An agent-origin `Apply` cannot create a grant, policy issuer, trusted
definition, trusted executable, trusted configuration, declassification, or
endorsement. Promotion requires an external supervisor capability, a
separately admitted transition, and a durable receipt. Where a head tool
supports it, its execution closure suppresses ambient configuration and hooks
instead of trusting project-controlled defaults.

Admission evaluates dangerous combinations across plans as well as within one
Plan. Receipts are evidence, not a substitute for preventing a known
authority-laundering path.

## 13. Plan IR

Every native action and tool action lowers into one versioned, canonical Plan
IR:

```text
Plan {
  schema_version
  plan_id
  action_reference
  nodes
  dependency_edges
  resolved_handles
  expected_resource_identities
  authority_admission
  policy_digest
  definition_digests
  budgets
  plan_digest
}
```

The closed operational node set is:

```text
Capture
Invoke
Apply
RequestExternal
```

Pure calculations and control flow compose nodes but cannot add a
world-changing site.

Plans are plain, Schema-validated data. They can be hashed, inspected, stored,
compared, delegated, signed, denied, or resumed. The runtime does not execute
unadmitted PlanDrafts or trust client-supplied authority claims.

Dynamic observation may produce a child plan. The child is independently
resolved and admitted before execution.

A plan is not automatically a database transaction. It may finish as:

```text
succeeded
failed
cancelled
partial
uncertain
recovery-required
```

### Two closed algebras and one total interpreter

The agent-program algebra is closed:

```text
PlanNode = Capture | Invoke | Apply | RequestExternal
```

The trusted runtime transition algebra is separately closed:

```text
RuntimeOp =
    Observe
  | SpawnContained
  | ProposeDelta
  | HoldTransition
  | StageExternal
  | DispatchExternal
  | AppendReceipt
  | Reconcile
  | Reap
```

Resolution, Admission, denial, and policy evaluation decide whether an inert
draft becomes an admitted Plan; they do not exercise agent-held world
authority. Lifecycle operations such as dispatch, undo, reconciliation, and
reaping are requested by programs or supervisors but performed only by their
trusted runtime authorities.

The interpreter contract is total:

```text
interpret : AdmittedPlan → RuntimeProgram<RunReceipt>
```

| Plan node | required runtime lowering |
|---|---|
| `Capture` | `Observe` then `AppendReceipt` |
| `Invoke` | `SpawnContained`, optional `ProposeDelta`, then `AppendReceipt` |
| `Apply` | `HoldTransition` then `AppendReceipt` |
| `RequestExternal` | `StageExternal`; policy-authorized commit may later perform `DispatchExternal`; each transition appends a receipt |

`Reconcile` and `Reap` are administrative transitions associated with prior
receipts, not extra agent-program nodes. Undo lowers to another recoverable
`Apply`.

Every Plan constructor must have one explicit lowering and every runtime world
effect must cite an originating Plan node or an authorized administrative
transition. Schema decoding rejects unknown variants. Tool definitions,
profiles, platform adapters, and integrations cannot add constructors or call
terminal authorities directly.

Terminal-authority laws:

- `DispatchExternal` is reachable only inside `Outbox.commit`.
- `HoldTransition` owns every replacement of a managed live binding.
- `Reap` is the only irreversible discard of retained recovery material.
- Every transition is journaled with its typed success, failure, partial, or
  uncertain outcome.

The canonical versioned contract is summarized in
[`docs/contracts/plan-runtime.md`](docs/contracts/plan-runtime.md).

## 14. Artifacts, streams, and secrets

Large values are stored as content-addressed artifacts rather than embedded in
plans or receipts.

Streams are explicit sources and sinks. No descriptor is inherited merely
because the parent process happened to have it open.

Secrets are opaque handles. Secret bytes do not appear in:

- Source
- Plan IR
- Outbox metadata
- Receipts
- Logs
- Error messages
- Captured output, unless an admitted executable leaks them

Secrets should be projected through the narrowest interface supported by the
existing tool, such as a sealed descriptor or scoped temporary file.
Environment injection is a compatibility fallback when the tool requires it.

Once a secret is disclosed to an executable, Airlock cannot protect it from
that executable inside the executable's admitted output and endpoint
authority. Secret admission therefore depends on executable identity and the
complete authority combination.

### Confidentiality and integrity labels

**v1 contract.** Values and authority-bearing resources carry coarse,
node-level labels:

```text
Labeled<T> {
  value or artifact reference
  confidentiality
  integrity
  provenance
}

Confidentiality = public < project < private < secret
Integrity       = untrusted < project < operator < runtime
```

Labels attach to observations, artifacts, streams, secrets, definitions,
executables, handles, endpoint sinks, and derived outputs. Combining values
joins confidentiality upward and integrity downward. Output from arbitrary
native computation conservatively inherits the joined confidentiality and
lowest relevant integrity of its declared/captured inputs, executable closure,
and producing node.

Endpoint sinks declare a confidentiality release ceiling. Authority-bearing
control inputs—definitions, policy, executable/config resolution, grants, and
promotion decisions—declare a minimum integrity. Admission rejects a flow that
exceeds either boundary.

Declassification lowers confidentiality; endorsement raises integrity. They
are distinct external supervisor capabilities, never methods on ordinary
agent values. Each is narrowly scoped and durably receipted. Giving secret
bytes to an arbitrary executable is recorded as disclosure, not disguised as
a safe label transformation.

Compatibility mode records labels but does not introduce new default
restrictions, preserving the ratchet. Selected enclosed profiles enforce the
label policy supplied by the harness.

Airlock does not claim per-byte dynamic taint through arbitrary binaries.
Node-level conservative propagation is the v1 guarantee. More precise
protocol- or format-aware actions may earn more precise labels with their own
evidence.

## 15. Realms

A realm is a boundary within which an Airlock runtime can enforce a declared
set of guarantees.

The local runtime may provide Apply/Hold semantics for supported local storage.
A remote machine running Airlock can accept a realm-scoped PlanDraft, resolve
it against its own policy, execute it locally, and return receipts.

Caller-supplied handles are requests in the destination realm, not imported
authority. The remote runtime independently admits them.

Without a cooperating remote Airlock runtime:

- SSH is an endpoint.
- OpenShell is an endpoint.
- Docker is an endpoint.
- A database daemon is an endpoint.
- A remote filesystem is an endpoint or unsupported.

The local runtime can stage, dispatch, cancel, and receipt those interactions.
It cannot claim the remote state is undoable.

Distributed Airlock does not imply a distributed transaction. Each realm has
its own Hold, Outbox, journal, uncertainty, and recovery.

Remote transport requires peer authentication, request integrity, replay
protection, Plan/Receipt correlation, and explicit ambiguous outcomes.

## 16. Runtime architecture

```text
Agent
  │ Airlock source / ActionCall
  ▼
Harness connector
  │ authenticated structured RPC
  ▼
Airlock runtime / daemon
  ├─ Language frontend
  ├─ Definition registry
  ├─ Planner
  ├─ Resolver
  ├─ Admission / policy
  ├─ Label flow
  ├─ Scheduler
  ├─ Capture service
  ├─ Cell runner
  ├─ Hold
  ├─ Outbox
  ├─ Endpoint broker
  ├─ Artifact store
  ├─ Journal / receipt views
  ├─ Reaper
  └─ Realm transport
       │
       ├─ supported local filesystem
       ├─ existing Unix executables
       ├─ admitted external endpoints
       └─ remote Airlock runtimes
```

### Language frontend

Parses, type-checks, and evaluates pure Airlock code. It produces action calls
and plan fragments, not direct world effects.

### Definition registry

Loads inert native and tool-action contracts with provenance and version
identity.

### Planner

Lowers action calls into canonical PlanDrafts.

### Resolver

Resolves locators, executables, mounts, endpoints, and realms into classified
resource candidates.

### Admission

Intersects requests with grants and policy, binds identities and budgets, and
produces executable Plans.

### Label flow

Conservatively propagates confidentiality, integrity, and provenance and
requires separately granted declassification or endorsement transitions.

### Scheduler

Owns dependency order, bounded parallelism, cancellation propagation, and
recovery/resumption.

### Capture service

Produces provenance-bearing observations and artifacts.

### Cell runner

Owns existing executable execution, private writable views, process
descendants, descriptors, streams, limits, and CellReports.

### Hold

Is the exclusive authority for applying and undoing managed local transitions.

### Outbox

Is the exclusive authority for staging, cancelling, claiming, and dispatching
external intents.

### Endpoint broker

Issues and enforces bounded leases only for Outbox commits and records actual
destinations and limits at the precision its transport or protocol mediation
earns.

### Artifact store

Stores immutable content referenced by plans, deltas, observations, and
receipts.

### Journal

Durably records transition facts. Current state is a view derived from those
facts, not an optimistic mutable status field.

### Reaper

Is the only principal permitted to irreversibly discard retained recovery
material.

### Realm transport

Delegates requests to another independently enforcing Airlock runtime.

Hold and Outbox are the earned domain nuclei: they already use Schema-typed
contracts, tagged failures, explicit invariants, and independent tests. Their
full v1 certification remains pending. Plan/runtime state machines, Journal,
Cell, labels, and broker seams are candidates until their operational
envelopes survive the acceptance corpus. Runtime orchestration and CLI/RPC
wiring remain local, disposable glue.

## 17. End-to-end execution lifecycle

A representative run proceeds as follows:

1. The agent submits Airlock source or a typed ActionCall.
2. The runtime parses and validates the input.
3. The definition registry resolves the exact native or tool action version.
4. The planner lowers it into a PlanDraft.
5. The resolver classifies requested paths, executables, endpoints, secrets,
   mounts, streams, execution-adjacent resources, labels, and realms.
6. Admission intersects those requirements with the effective grants and
   profile.
7. The runtime binds resource identities, executable identities, policy,
   budgets, and definition digests into a Plan.
8. The Plan and initial transition are durably persisted.
9. Each bound precondition is revalidated immediately before dependent use.
10. Capture nodes produce provenance-bearing values and may materialize child
    plans.
11. Local Invoke nodes run without endpoint authority against private writable
    views.
12. Endpoint-bearing Invoke nodes are frozen and staged as ExternalIntents.
13. Outbox commit obtains a bounded EndpointBroker lease and launches the
    external invocation with only that authority.
14. The Cell runner supervises every descendant, stream, deadline, and budget.
15. Endpoint authority closes when the external phase terminates or is
    cancelled.
16. The runtime captures status, output, artifacts, usage, and any local
    delta.
17. The delta is validated against the admitted writable envelope, bound
    identities, information labels, execution-adjacent resource policy, and
    cross-plan provenance.
18. Hold retains displaced live state and applies the admitted transition.
19. Every transition appends a durable receipt.
20. Later operations may inspect, cancel, reconcile, undo, or reap according
    to their own authority and policy.

The program may request lifecycle transitions, but only the corresponding
runtime authority can perform the actual dispatch, merge, or reaping act.
The exact delegation of commit authority between program, harness, and
supervisor remains policy rather than a new effect.

## 18. State machines and receipts

Receipts are immutable transition facts. The journal validates legal
transitions and sequence order before appending them.

Candidate lifecycle:

```text
Plan
  draft → admitted | denied
  admitted → running
  running → succeeded | failed | cancelled | partial | uncertain

Capture
  planned → observed | denied | failed | drifted

Cell
  ready → running
  running → exited | cancelled | failed | lost

Apply / Hold
  proposed → applied | conflicted | recovery-required
  applied → undone | reaped
  recovery-required → applied | undone | quarantined

External intent
  staged → cancelled
  staged → dispatching
  dispatching → completed | failed | uncertain
```

Every receipt includes or references:

```text
run, plan, and node identity
monotonic sequence
resolved public resource identities
input and output digests
definition and policy digests
state transition and timestamp
exit status and resource usage
Capture, CellReport, Hold, Outbox, and Artifact evidence
cancellation state
external uncertainty
recovery status
typed error, when present
```

Recovery appends new facts; it does not rewrite history. Crash reconciliation
must resolve an interrupted transition as completed, safely retryable,
recovery-required, or uncertain. It must not guess.

Interaction failures remain typed values. Illegal internal transitions and
impossible digest mismatches are defects.

## 19. Errors

A representative error model includes:

```text
ParseError
SchemaError
UnknownAction
DefinitionError
ResolutionError
AuthorizationDenied
GrantRevoked
UnsupportedResource
DriftDetected
FenceUnavailable
BoundaryViolation
CaptureFailed
ProcessFailed
ProcessLost
ResourceLimitExceeded
DeltaConflict
HoldFailed
UndoConflict
RecoveryRequired
DispatchFailed
DispatchUncertain
Cancelled
JournalFailed
RealmUnavailable
```

These remain distinct. Generic error wrapping must not erase whether an action
was denied, failed safely, partially applied, lost, or may have crossed an
external boundary.

## 20. Operating profiles

**v1 contract.** All profiles use the same versioned schemas, Plan algebra,
runtime algebra, Hold, Outbox, Journal, labels, and receipt vocabulary. They
differ in admission, enforcement backend, and automatic lifecycle policy.
Profile selection occurs outside the agent program. There is no silent
downgrade between profiles.

### Compatibility profile

`compatibility` preserves the repository's ratchet direction:

- Broad structured invocation authority
- Unknown tools may run in a deliberately loose tier
- Bash-equivalent capability within the invoking user's host authority
- Recovery, staging, receipts, and visibility where they do not break
  compatibility
- Restrictions accrue only when selected

Compatibility does not require giving the agent an actual shell tool. It may
mean that Airlock accepts broadly resolved executable invocations.

Compatibility provides migration and coverage. It does not make the same
containment claim as either contained profile. If it automatically flushes
expired outbox entries, it is a flight recorder with a cancellation window,
not an affirmative external gate; its capability report says so.

### VM-enclosed profile

`vm-enclosed` is the default macOS shell-replacement posture for arbitrary
existing Unix tools:

- The harness exposes only Airlock.
- The agent cannot select or change the profile.
- Each session or admitted persistent Cell runs in an Airlock-owned macOS VM
  with an identified base image.
- The guest receives private working views, not ambient host mounts.
- Host files and directories enter through typed file/artifact brokers and
  return only as proposed deltas.
- Guest networking reaches only the EndpointBroker; host loopback, Unix
  sockets, keychain, launchd, Docker, foreign processes, and devices are absent
  unless a dedicated broker grants a typed capability.
- Unknown guest tools and descendants may run inside the execution closure;
  their authority cannot exceed the VM realm and broker leases.
- Endpoint authority appears only after Outbox commit.
- Local host changes merge only through Hold.
- A missing VM or broker enforcement primitive fails closed.

The VM kernel boundary provides the broadest v1 compatibility envelope. It
does not protect against a compromised hypervisor/host administrator and does
not make remote effects reversible.

### Native-contained profile

`native-contained` is a lower-overhead macOS profile for a narrower, advertised
capability set:

- Airlock constructs a private APFS-backed writable view.
- The native backend controls the executable closure, environment,
  descriptors, descendants, deadlines, and resource budgets.
- Host reads, writes, and endpoint classes are admitted explicitly.
- Networked actions use only endpoint classes the native broker can enforce.
- Unknown execution, unmediated config discovery, unsupported resource
  semantics, and unavailable isolation fail explicitly.
- Every private delta still merges through Hold.
- No capability report or documentation describes this profile as
  VM-equivalent.

Native-contained is selected for measured performance-sensitive workflows
whose complete mediation can be demonstrated. Other tasks route to
`vm-enclosed` or remain unavailable; they do not fall back to compatibility.

### macOS profile matrix

| property | compatibility | vm-enclosed | native-contained |
|---|---|---|---|
| zero-config default | yes | no | no |
| containment claim | none | VM realm + broker seams | advertised native subset |
| arbitrary existing tools | broad host authority | broad guest authority | only enforceable closure |
| host filesystem | ambient user authority | brokered handles/deltas | admitted native handles/private view |
| host network/sockets | ambient user authority | endpoint broker only | brokerable classes only |
| unknown descendants | observed where possible | contained in guest | denied unless mediated |
| label enforcement | observe-only by default | enforced by harness policy | enforced for advertised subset |
| live merge | Hold where supported | Hold only | Hold only |
| unavailable enforcement | no containment promise | fail closed | fail closed |

Every installation publishes `airlock capabilities --profile <name>` with the
active backend, supported resource and endpoint classes, known coarsenings, and
proof/evidence version.

Time-based automatic external dispatch, if it exists in compatibility mode,
should not be assumed safe for enclosed agents. In enclosed mode the commit
policy should be explicit and supplied by the harness or supervising
authority.

## 21. Threat model

### Untrusted

- Model output and Airlock source
- Action inputs and argument data
- Project files and malicious instructions in them
- Tool definitions
- Executable output and downloaded artifacts
- Existing executables beyond the authority they are deliberately granted

### Trusted base

- The OS isolation primitives used by the active backend
- The Airlock runtime and reference monitor
- The grant/policy issuer
- Durable Hold, Outbox, Artifact, and Journal storage
- The integrity of admitted executable and definition identities

### Protected against

- Mistaken or prompt-injected plans exceeding granted authority
- Shell and argument injection caused by textual command construction
- Irrecoverable loss of supported managed local state during the Hold window
- External dispatch before the applicable commit policy
- Unowned descendant processes and unbounded execution
- Silent drift of bound resources
- Tool definitions minting authority
- Agent-origin persistent state silently becoming trusted execution or policy
- Confidential data crossing a sink without an admitted release
- Agent values declassifying confidentiality or endorsing integrity
- Contained code importing authority through host sockets or inherited
  descriptors
- Crash recovery inventing a successful or failed external outcome
- Agent bypass through a second harness tool

### Not protected against

- Kernel, hypervisor, root, administrator, or physical compromise
- A bypass exposed by the harness outside Airlock
- Semantic malice fully contained inside deliberately broad grants
- Confidentiality after a secret is intentionally given to an executable that
  also has an output channel
- Remote consequences after dispatch
- Undo after recovery material is reaped or lost
- Unsupported filesystem or device semantics
- Supply-chain trustworthiness merely because a binary is installed
- Correctness of a tool definition's semantic claims
- Side channels beyond the OS backend's stated envelope

Airlock is not an intent oracle. Granting a sensitive directory, an arbitrary
executable, and a network endpoint is an intentional exfiltration-capable
authority bundle even if each item looked reasonable alone.

## 22. Enforcement floor

Enclosed mode deserves its name only when all of these are true:

- The harness provides complete mediation: no alternate filesystem, process,
  shell, network, Docker, SSH, or privileged tool path.
- The agent cannot mutate policy, trusted definitions, admitted executable
  identities, daemon state, holds, the journal, or the runtime.
- Process containment covers every descendant and inherited descriptor.
- Filesystem resolution is identity-safe against symlink and mount races.
- Private writable views and delta generation have a tested operational
  envelope.
- Endpoint isolation includes raw network, DNS, loopback, Unix sockets,
  inherited sockets, and alternate resolver paths to the advertised degree.
- VM-enclosed exposes no ambient host shared folder, host loopback, clipboard,
  keychain, device, or management channel.
- Every executable descendant and dynamically selected helper remains in the
  execution closure until termination.
- Persistent agent-origin state cannot resolve later as trusted authority
  without an external endorsement receipt.
- Confidentiality release and integrity promotion are enforced at admitted
  sinks and authority-bearing control inputs.
- Hold, Outbox, and journal transitions are durable, locked, and recoverable
  under crashes and concurrency.
- Resource budgets prevent a Cell or retained Hold set from taking down the
  host.
- Secrets cannot leak through serialization, logs, or automatic capture.
- Missing platform enforcement produces an explicit refusal.
- Remote realms authenticate and independently authorize every request.

Platform support should advertise actual guarantees rather than a single
portable marketing label.

## 23. Implementation architecture

Airlock uses Pristine Components, Messy Integrations: pristine domain
capabilities, rigorous interaction seams, disposable integration glue.

### Domain capabilities

Domain capabilities own stable meaning and executable invariants:

```text
Planner
Admission
Hold
Outbox
ArtifactStore
Journal
LabelFlow
```

Hold and Outbox are the implemented nuclei. They have real Schema types,
tagged failures, and construction tests, but their v1 operational envelopes
remain uncertified until crash, concurrency, same-volume, and broker tests
pass. Planner, Admission, ArtifactStore, Journal, and LabelFlow are candidate
components. A name in this diagram does not grant pristine status.

A capability earns or keeps component status only when its bounded context,
narrow typed contract, executable invariants, counterexamples, operational
envelope, owner/consumers, and non-goals are explicit. A production
counterexample can narrow, version, or demote it.

### Interaction seams

The versioned Plan, Runtime transition, Receipt, Grant, Handle, CellReport,
LocalDelta, ExternalIntent, EndpointLease, and capability-report contracts are
candidate rigorous seams. They earn pristine status only after their schemas,
consumers, transition witnesses, failure semantics, and operational envelopes
survive the v1 corpus. Ordering, authorization, idempotency, retry,
cancellation, uncertainty, crash reconciliation, and trace/receipt correlation
live here, never only in an adapter.

Every boundary is Schema-first: decode unknown data once, then operate on the
typed value. Expected failures use tagged domain errors in the `E` channel;
required capabilities appear in Effect service requirements. Invalid state
transitions should be unconstructable where possible and runtime-validated
where distributed reality prevents that.

### Disposable adapters and glue

Platform and integration implementations remain local and plastic:

```text
macOS VM backend
native macOS process/sandbox backend
APFS private-view and Hold backend
endpoint-broker transports
CLI and local RPC
definition-file discovery
Vouch harness connector
future Linux and remote-realm adapters
```

These are ordinary Effect `Layer` implementations behind narrow services.
Repetition is allowed. They must be observable, tested, and owned, but they do
not earn generic integration frameworks or policy branches. New knowledge
found in the glue is harvested into a domain capability or seam only after its
semantics repeat and stabilize.

The planner and transition validators are pure where possible. Hold, Outbox,
CellRunner, ArtifactStore, Journal, EndpointBroker, and RealmTransport are
effectful services behind Layers.

One `ManagedRuntime` owns the composed services. CLI and RPC surfaces are thin
clients. The daemon decodes and revalidates every submitted plan and never
trusts client-generated authority claims.

Likely deployment:

```text
airlock client / agent connector
  → authenticated local IPC
airlockd
  → unprivileged orchestration and durable state
minimal privileged/platform worker
  → cell, namespace, filesystem, and network primitives
reaper / outbox dispatcher
  → narrowly separated terminal authorities
```

The exact process split is platform-dependent. Privilege should be separated
where practical, and no privileged reconfiguration surface should be exposed
to the agent.

Durable local state likely needs a transactional journal with leases/claims,
plus recoverable filesystem capsules around operations SQLite cannot make
atomic. Storage choice remains subordinate to the state-machine contract.

## 24. macOS installation and later remote machines

macOS v1 installs as one coherent runtime on Apple silicon. The agent-facing
surface exposes:

```text
capabilities
schema
plan
run
inspect
cancel
undo
reconcile
```

These are structured RPC/tool operations, not an interactive human shell.

An installation contains:

- Runtime and local connector
- Versioned Plan and Receipt schemas
- Native action pack
- Installed tool-definition packs
- Project definition discovery
- Hold, artifact, outbox, and journal storage
- Recovery/reaper operation
- Platform capability report
- Optional remote-realm transport

The first proof target is a local macOS agent using `vm-enclosed`, followed by
the advertised `native-contained` subset. The installer performs a capability
probe before a contained profile is selected and never marks a backend
available because a binary merely exists.

The exact VM, APFS, process, and native sandbox mechanisms remain adapter
choices. Their capability report must state what was tested, which resources
are brokered, which semantics are coarsened, and what is unavailable. See
[`docs/macos-v1.md`](docs/macos-v1.md).

Linux and remote machines follow the macOS v1 contract. Backends may use
different primitives—reflinks, overlays, namespaces, Landlock-style
constraints, APFS clones, native sandbox policies—but expose the same Plan and
Receipt seams with honest profile-specific capabilities or reject unavailable
guarantees.

A remote Airlock runtime is another reference monitor, not merely a command
transport. It receives a plan request, maps requirements to local grants,
executes under its own profile, and returns correlated receipts.

## 25. Unix decomposition examples

| Unix work | Candidate lowering |
|---|---|
| `cat`, `stat`, `ls` | Capture directly or read-only Invoke followed by Capture |
| `grep`, `jq`, `rg` | Invoke plus captured output |
| `rm -rf path` | Apply `path → absent` |
| `cp`, `mv`, write | Apply a local delta |
| `chmod`, links, metadata | Apply if supported; otherwise explicit refusal |
| `tar -x` | Invoke tar in private view, then Apply delta |
| Pipeline | Process graph inside Invoke |
| `stdout > file` | Capture artifact, then Apply |
| `stdout > /dev/tty` | External endpoint |
| `curl` | RequestExternal, then Capture result |
| `curl -o file` | RequestExternal, Invoke, Capture, then Apply |
| `git commit` | Invoke in private repository view, then Apply |
| `git push` | RequestExternal for Git invocation, then Capture |
| `npm install` | RequestExternal for networked Cell, then Apply private-tree delta |
| `docker build` | RequestExternal toward Docker endpoint |
| Signal owned child | Cell supervision |
| Signal foreign process | External endpoint |
| `systemctl`, cron, launchd | External endpoint |
| NFS/FUSE/device write | External endpoint or unsupported |
| Clock, environment, randomness | Capture |
| Sleep and timeout | Execution control |
| CPU/RAM/disk consumption | Cell and retention budgets |

## 26. Validation

The architecture is not validated by elegant diagrams. It needs adversarial,
stateful evidence.

### Construction properties

- Only `Hold.reap` irreversibly unlinks retained live-state material.
- Only Outbox commit can activate external endpoint authority.
- Every existing executable is launched through Cell.
- Every live managed-state change is applied through Hold.
- Every descendant remains inside its admitted execution closure.
- Tool definitions are inert and cannot mint authority.
- Every executable plan contains handles rather than authority-bearing free
  strings.
- Persisted agent bytes cannot become trusted authority without a separately
  receipted supervisor endorsement.
- Contained endpoint authority is a bounded broker lease created only at
  Outbox commit.
- Confidentiality cannot be lowered and integrity cannot be raised by an
  ordinary agent action.
- Every world effect has a durable state transition and receipt.

### State-machine and crash tests

- Fault injection at every Hold, Apply, Outbox, and journal transition.
- Recovery never invents success or failure.
- Concurrent acknowledged mutations retain all required versions.
- Concurrent commits have one claimant and do not double-dispatch.
- Crash after possible dispatch produces `uncertain`.
- Uncertain effects are never implicitly retried.
- Undo never silently overwrites a newer conflicting binding.

### Isolation tests

- Shell/interpreter nesting and descendant execution
- Git hooks, package scripts, plugins, pagers, editors, and helpers
- Environment, config, and credential inheritance
- Symlink, hardlink, mount, and descriptor races
- DNS, proxies, loopback, Unix sockets, and inherited sockets
- Background jobs and daemonization
- Devices, procfs/sysfs, NFS, and FUSE
- Docker and database sockets
- Unix-socket descriptor passing and host-socket absence
- Persistent hooks, build scripts, launch agents, executable paths, and
  cross-plan configuration laundering
- Confidential-read plus endpoint-write flow; explicit declassification and
  endorsement boundaries
- VM host-bridge, shared-folder, clipboard, keychain, and loopback escape
- Secret redaction and output limits
- CPU, memory, process, disk, descriptor, and retention exhaustion

### macOS v1 shell-replacement acceptance

The release claim is:

> Airlock macOS v1 replaces most shell usage for agents within its published
> `vm-enclosed` capability envelope.

That claim is earned only when all of the following hold:

1. The fixed corpus contains at least 50 real multi-step agent tasks across
   repository inspection/search, editing, structured data, pipelines and
   process control, build/test, archives, Git, package managers, HTTP/API
   work, long-running owned processes, and the Vouch vertical slice.
2. The evaluated agent receives only Airlock: no shell, terminal, generic
   process launcher, direct filesystem tool, raw network tool, SSH, Docker
   socket, or alternate harness escape.
3. At least 90% of the full corpus and 80% of every non-excluded workload
   family completes in `vm-enclosed` without an escape request. The complete
   Vouch vertical slice passes.
4. Every capability advertised by `native-contained` passes its corresponding
   task; unsupported families are explicit and do not count as supported.
5. Construction gates pass without exception: one reaper unlink authority,
   one Outbox dispatch authority, every live mutation through Hold, every
   executable through Cell, and every world effect correlated to a receipt.
6. Adversarial containment, execution-closure, persistent-authority,
   information-flow, endpoint-bypass, crash, concurrency, and
   duplicate-dispatch suites pass.
7. Every supported mutation fixture restores the required bytes and metadata
   after cancellation and injected crash. Recovery never invents an outcome.
8. Three clean end-to-end repetitions pass on every published macOS/backend
   combination.

The evidence bundle records the corpus version, task result, profile and
capability report, Plan and policy digests, receipts, escape count, failure
classification, recovery result, latency, resource use, and comparison with
the direct-shell baseline.

Interactive full-screen human TUIs, GUI automation, kernel/administrator work,
unsupported devices or live foreign-process state, and remote systems without
a cooperating Airlock realm are outside the v1 denominator and named in the
published result.

The full executable contract and confidence vocabulary live in
[`docs/acceptance.md`](docs/acceptance.md). A lower score may be reported as
developer-preview evidence but cannot be rounded into the release claim.

## 27. Build order

1. Freeze the versioned Plan/Runtime/Receipt seams and lower every current
   action through the total interpreter.
2. Harden Hold, Outbox, and Journal durability, locking, same-volume behavior,
   recovery, concurrency, and honest uncertainty.
3. Add resource classification, grants, handles, expected identities, labels,
   execution-adjacent resources, and cross-plan admission.
4. Add Capture for files, metadata, environment, and process streams.
5. Build the macOS VM backend with private working views, complete descendant
   ownership, no ambient host mounts, and delta reporting.
6. Merge every VM delta through Hold.
7. Build the EndpointBroker and stage a complete endpoint-bearing invocation
   through Outbox before commit creates its lease.
8. Run the Vouch snapshot/upload/restore/validate/replace vertical slice in
   `vm-enclosed` without a Vouch-specific Plan node.
9. Add the native macOS backend for its enforceable subset and publish the
   capability difference.
10. Add inert definitions from observed Vouch and repository work, plus one
    unrelated held-out workload to contest the vocabulary.
11. Implement the smallest measured Airlock language over the same Plan
    algebra; the parser cannot add runtime authority.
12. Run the full shell-free acceptance and hostile corpus with fault
    injection, then publish the evidence bundle.
13. Remove direct shell authority from the first Vouch agent harness only
    after the release gate passes.
14. Port the same contracts to Linux and remote Airlock realms.

The parser should not outrun the Plan and runtime contracts. A beautiful DSL
over an ambiguous effect kernel would merely make the wrong system easier to
use.

## 28. Non-goals

Airlock is not:

- A shell for humans
- A new kernel or operating system
- A reimplementation of existing Unix libraries and tools
- A Vouch-, OpenShell-, archive-, package-manager-, or registry-specific
  abstraction
- A promise that arbitrary remote effects are undoable
- A distributed ACID transaction system
- An exactly-once network protocol
- An intent oracle
- A guarantee against kernel or administrator compromise
- A claim that cancellation reverses already-observed external effects
- A supply-chain security product merely because executables are admitted
- A complete semantic model of every Unix program

## 29. Decisions that should remain open

Before freezing more contracts, the project still needs evidence around:

- Exact pure-language expressiveness and concrete syntax
- Dynamic plan-fragment and result-reference representation
- Rights, selector, delegation, revocation, and policy vocabulary
- Full resource taxonomy
- Filesystem identity, hardlink, metadata, mount, and conflict semantics
- Managed-state liveness detection and format-aware actions
- Atomic grouping and locking for multi-path Apply
- Exact macOS VM image lifecycle and native containment envelope
- Which high-frequency endpoints earn protocol-aware brokerage
- Tool-definition discovery, provenance, versioning, and signing
- Declarative lowering and result-decoder power
- Persistent Cell, checkpoint, owned sibling endpoint, PTY, and REPL semantics
- Secret projection versus non-extractable credential capabilities
- Journal storage, fsync protocol, compaction, and tamper evidence
- Post-crash process and dispatch reconciliation
- Artifact and Hold retention
- Remote-realm authentication and receipt federation
- The exact selectors and thresholds for confidentiality, integrity,
  execution-adjacent resources, declassification, and endorsement
- Batch-delta and receipt aggregation performance without weaker attribution

These are missing implementation contracts and operational-envelope questions.
So far, none requires a fifth physics category.

## 30. Review brief

Reviewers should attack this design rather than polish it.

Please answer:

1. Name a legitimate Unix operation that cannot decompose into Capture,
   Invoke, Apply, and RequestExternal.
2. Show a path by which an enclosed agent or descendant can acquire ambient
   authority not represented by a handle.
3. Identify a claimed guarantee that cannot be enforced on Linux or macOS.
4. Show a resource currently classified as managed local state that should
   instead be an endpoint or unsupported.
5. Show an external outcome for which the state machine is dishonest.
6. Find a tool definition capable of minting authority or adding physics.
7. Find a valid agent workflow that requires shell textual semantics rather
   than structured process, stream, and control composition.
8. Identify the smallest additional primitive required by a Vouch workflow,
   then show why it cannot be composed from the existing model.
9. Describe how the model behaves across crash, cancellation, duplicate
   submission, and concurrent mutation.
10. State the exact evidence you would require before removing an agent's
    direct shell permission.

## 31. Adoption judgment

Architecturally, yes: Airlock is a credible replacement for direct shell
authority in agent harnesses. The macOS v1 contract makes that judgment
falsifiable rather than universal.

Its strongest insight is not "safe Bash." It is:

> Agents author Airlock; Airlock composes Unix.

That preserves the extraordinary Unix ecosystem while replacing ambient
authority and textual indirection with explicit plans, handles, enclosure,
recoverable local changes, staged external authority, and receipts.

Implementation-wise, the original prototype is not by itself the replacement.
It demonstrates the Hold and Outbox nuclei. The release claim remains
unearned until Plan/runtime interpretation, complete mediation, resource and
label classification, persistent-authority controls, endpoint brokerage,
durable concurrency, crash reconciliation, macOS VM/native enforcement, the
agent surface, and the acceptance evidence exist together.

The recommended adoption path is:

```text
observe Vouch and unrelated agent work
→ shadow-translate it through the Plan algebra
→ run the Vouch vertical slice in vm-enclosed
→ merge live changes only through Hold
→ dispatch only through Outbox and the EndpointBroker
→ prove execution closure, labels, and cross-plan integrity
→ clear the published shell-free corpus
→ remove direct shell authority from the Vouch harness
→ expand native-contained and later platform support from measured demand
```

Once `vm-enclosed` clears every enforcement and parity gate, direct shell
permission disappears completely from the evaluated agent harness. Bash and
other Unix programs may continue to exist inside a Cell for compatibility, but
the agent no longer possesses their ambient authority or uses them as its
orchestration language.
