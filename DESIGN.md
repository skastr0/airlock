# Airlock — design

Airlock is the chamber between agents and the world. It is an agent-oriented
runtime and language for Unix machine work: agents author structured actions;
Airlock composes existing Unix programs inside controlled execution, makes
local changes recoverable, stages external effects before dispatch, and records
receipts.

The founding incident was an installer test that derived a write path from the
wrong root and truncated a real database through Bash `>`—one character, no
preview, no recovery. Airlock exists so that class of event is recoverable by
default without requiring the user to model every tool in advance.

## Status vocabulary

This file deliberately distinguishes what is already law from what is still a
design target:

- **Invariant** — implemented repository law; changing it requires an explicit
  architecture decision and corresponding construction test.
- **v1 contract** — an acceptance condition for a named platform/envelope; it
  is not a claim that the current code already satisfies it.
- **Design direction** — intended product shape; useful for sequencing work,
  but neither a law nor a present-tense capability claim.
- **Candidate** — a concrete contract or mechanism awaiting enough
  implementation or adversarial evidence.
- **Open question** — intentionally unresolved; it must not be treated as an
  invariant by code or documentation.

The two laws below are the only frozen architectural invariants today. The
four-class model and four-node Plan are implemented candidate seams. The
current macOS and Linux profiles, runtime interpretation, labels, and tool
definitions have narrower evidence envelopes described below; none becomes a
third law.

## The four effect classes

Airlock's falsifiable design hypothesis is that agent-originated Unix work can
be decomposed into four effect classes. The classes map one-to-one onto the
candidate closed Plan algebra:

| effect class | Plan node | meaning | physics |
|---|---|---|---|
| **observation** | `Capture` | information enters the program | provenance attaches at entry; candidate label flow carries confidentiality/integrity |
| **computation** | `Invoke` | existing code runs | the selected profile runs it in a Cell; native v1 fences exact executable edges, while a complete closure remains design direction |
| **mutation** | `Apply` | managed local state changes | displaced state enters Hold; live absence is applied only through Hold |
| **emission** | `RequestExternal` | agent requests an unmanaged effect | admitted intent is staged in Outbox; only an authorized commit exercises wire-dispatch authority |

Within the mediated Plan path, `Capture` and `Apply` cross managed boundaries;
privileged `DispatchExternal`, not `RequestExternal`, crosses the unmanaged
boundary. `Invoke` runs computation under the selected profile and may propose
or consume the other three. This is a refinement of the four classes, not a
replacement for them.

The algebra classifies Airlock-owned effects. A compatibility `Invoke`
deliberately gives its child the invoking user's ambient host authority. Writes
or network calls performed inside that child are not mediated as `Apply` or
`RequestExternal` and receive no Hold, Outbox, or containment guarantee.

## The two laws

### 1. Only the reaper unlinks

Every Airlock-owned managed mutation verb is a rename through Hold. Before a
managed live binding is removed or replaced, its prior state is renamed into a
same-volume hold. Undo is itself recoverable: if undo must clear a target, that
target is displaced into Hold rather than destroyed.

`Hold.reap` is the single irreversible unlink authority in the codebase. A
construction test rejects a second unlink site.

Disposable files may be unlinked inside an isolated private or VM filesystem.
That absence cannot reach managed live state except through `Apply` and Hold.
The law concerns unique bytes in managed live state:

> damage = irreversible loss of the last copy of unique managed bytes

This is a construction law for Airlock's mutation surface, not a claim that
Airlock intercepts syscalls made by an ambient compatibility subprocess. Such a
subprocess is outside the managed recovery envelope by design.

### 2. The ratchet law

Zero-configuration behavior preserves broad Bash-like host capability. Safety
that is compatibility-free—planning, staging, recovery material, receipts, and
visibility—may accrue by default. Restrictions on scope, endpoints, execution,
labels, merge, or retention are enabled only when the user or harness selects
them.

Capability here means that the compatibility child retains broad host access.
It does not mean that effects performed inside that child acquire Hold or
Outbox finality.

The ratchet has one direction: an explicit profile may narrow authority; an
agent program cannot widen it. Missing enforcement never causes a selected
contained profile to silently fall back to compatibility.

Corollary:

> curation never gates capability in compatibility mode

Unknown tools may run in its loosest applicable tier with receipts. Curated
definitions remove friction and improve precision; the registry has no
completeness obligation.

## Two-phase everywhere

| operation | agent-visible phase | terminal authority |
|---|---|---|
| remove or replace | propose an `Apply` delta | Hold installs it; Reaper later discards recovery material |
| external request | stage an `ExternalIntent` | `Outbox.commit` dispatches the currently supported HTTP intent; a supervisor policy may pre-authorize that commit for endpoint grants it classed `read` — the program cannot select this — and the auto-commit routes through the same `Outbox.commit` authority |
| contained arbitrary code | run against a private view | Cell reports a delta; Hold applies it separately |
| remote machine work | delegate a realm-scoped Plan request | the remote Airlock independently admits and executes it |

An external effect has no undo after the recipient observes it. Delayed
dispatch is cancellation of queued intent, not reversal of a send. If dispatch
may have happened, the honest result is `uncertain`, never an automatic retry.

## Host-native v1

Airlock implements one physics model on macOS and Linux across two profiles:

- **`compatibility`** — zero-config, broad Unix capability, recovery and
  receipts where compatible; no containment claim.
- **`native-contained`** — a lower-overhead, opt-in profile for the subset the
  active host backend can enforce. Both backends provide a private writable
  workspace, deny live-host writes and network, fence declared direct
  executable edges, and leave mutation to Hold-backed Apply. Unsupported or
  unavailable mechanisms fail explicitly. Ambient host reads remain allowed,
  so this profile is neither confidential nor VM-equivalent.

macOS uses APFS clone/copy plus Seatbelt. Linux uses a clone-or-copy,
Bubblewrap 0.12+ namespaces and pinned mounts, Landlock ABI 2+ executable-object
rules, and a libseccomp launcher. These are different mechanisms with separately
reported caveats; neither platform borrows claims from the other.

Profile choice is an explicit ratchet turn. All profiles use the same
Schema-validated contracts, Plan algebra, runtime algebra, Hold, Outbox, and
receipt vocabulary. See [the macOS runtime contract](docs/macos-v1.md) and
[the Linux runtime contract](docs/linux-v1.md).

`vm-enclosed` is future design direction. The current CLI reports that the
backend is unavailable and refuses it rather than falling back. A future VM
may widen the enforceable workload and strengthen confidentiality, but it is
not the default profile or a host-native release prerequisite.

## Plan algebra and runtime vocabulary

The implemented candidate **Plan algebra** is exactly:

```text
PlanNode = Capture | Invoke | Apply | RequestExternal
```

The architecture describes the following **runtime-operation vocabulary** for
interpreting admitted plans:

```text
RuntimeOp =
    ClaimPlan
  | Observe
  | SpawnContained
  | ProposeDelta
  | HoldTransition
  | StageExternal
  | ClaimExternal
  | DispatchExternal
  | CancelExternal
  | AppendReceipt
  | Reconcile
  | Reap
```

`ClaimPlan` is distinct from the Outbox's `ClaimExternal`. Before any node
adapter or world operation, Runtime requires a persistent run journal and
serializes one Plan identity through a kernel-backed claim. Once a `running` or
later snapshot exists, concurrent or sequential reuse of the same admitted Plan
fails with the tagged `RuntimeExecutionClaimRejected`; a recovered nonterminal
snapshot is evidence of prior execution, not permission to replay it.

Definitions, profiles, platform adapters, and project integrations cannot add
Plan constructors or terminal-authority paths informally. Every Plan node must
lower totally to runtime operations. For Airlock-owned external intent,
`ClaimExternal` and `DispatchExternal` are reachable only through
`Outbox.commit`; `CancelExternal` is a supervisor transition available only
before a claim; `HoldTransition` is the only Airlock-owned managed live binding
replacement path; `Reap` is the only irreversible discard path for retained
managed bytes.

`Invoke` accepts the structured
`{ executable, args, stdin, stdout, stderr, timeoutMs }` contract.
`executable` is separate from `args`; the argument array never embeds the
executable as element zero. There is no command-string execution form.
Language aliases may normalize `timeout` or `hold` at the program boundary,
but the admitted plan sees the canonical field names above.

The runtime uses Effect: data and wire boundaries are Schema-first, expected
failures are tagged in the typed error channel, capability requirements are
visible in service contracts, and the CLI composes the service Layers into one
scoped `ManagedRuntime` backed by `BunContext`, disposing it through `finally`.
A persistent managed daemon remains future work.

## Component discipline

Airlock follows **Pristine Components, Messy Integrations**:

| stratum | v1 posture |
|---|---|
| domain capabilities | narrow Effect services, Schema-first values, tagged failures, executable invariants |
| interaction seams | versioned Plan/Receipt schemas, authorization, ordering, idempotency, crash and uncertainty semantics |
| platform/project adapters | local, repetitive, observable, and disposable `Layer` implementations |

Hold and Outbox are earned nuclei because they already encode real invariants
and have executable tests. They now serialize recovery transitions across
processes with a bounded, cancellable, recoverable exclusive-file lease. Hold
durably stages and promotes its journal, including recovery from a staged-only
candidate; Outbox serializes stage/claim/recovery through the same Airlock-home
lock boundary. Ledger serializes append/recovery, syncs file and directory
state, and preserves typed quarantine evidence for an invalid tail. This is
real bounded durability and concurrency evidence, not certification of every
crash point, filesystem, overlapping-operation schedule, or a complete
multi-component Journal.

Plan, Cell, EndpointBroker, label flow, VM/native backends, and tool
definitions remain candidates until real integrations and adversarial tests
earn narrower component boundaries.

The host native adapters, APFS/copy workspace glue, Linux launcher, CLI/RPC
wiring, and Vouch integration remain local glue. Policy, authorization,
ordering, idempotency, retry, uncertainty, and receipt semantics never live
only in that glue.

## Security gates and stronger directions

Each host release claims only mechanisms advertised by its selected profile.
The following contracts become release gates when the corresponding stronger
capability or claim is advertised; an unadvertised capability may remain future
direction, but must fail explicitly rather than borrow a stronger description:

- **Executable edges and execution closure** — native v1 fences the admitted
  root and exact descendant executable paths. A stronger complete-closure claim
  must additionally bind the loader/shebang chain, descendants, helpers, hooks,
  plugins, pagers, editors, credential helpers, lifecycle scripts, and
  config-selected executors for their owned lifetime.
- **Persistent authority safety** — a claim that later stronger work is safe
  must prevent agent-origin bytes from becoming trusted executables,
  definitions, policy, grants, launch configuration, hooks, or credential
  sources merely because they persist and are consumed later.
- **Endpoint brokerage** — this gate applies only when contained networking is
  advertised. The current native profile denies network and current
  `Outbox.commit` dispatches bounded HTTP itself. A dispatch-class slice now
  exists with fixture evidence: supervisor-side endpoint grants whose
  `read`-class `commit: "auto"` entries auto-commit staged intents through the
  same `Outbox.commit`
  ([`docs/evidence/external-read-slice.md`](docs/evidence/external-read-slice.md)).
  The gate still applies unchanged before advertised contained networking or
  real vendor brokerage: a future broker would own DNS, redirects, proxying,
  loopback decisions, budgets, credential authority, and actual-destination
  receipts.
- **Information labels** — confidentiality or integrity claims require
  observations, artifacts, handles, definitions, executables, streams, and
  outputs to carry conservative labels. Declassification and endorsement are
  distinct supervisor-granted acts; agent code cannot mint either.

See [the security model](docs/security-model.md).

## Adoption and the v1 claim

Vouch is the first adoption corpus, not the source of Airlock's ontology. Its
snapshot, upload, restore, validate, and replace workflow must lower only to
general Airlock actions. An unrelated held-out repository workload follows it
to detect vocabulary overfitting.

The checked-in parity fixtures and two Vouch-derived local proofs now exercise
useful structured file, process, control-flow, Hold, Outbox, artifact, timeout,
cancellation, and output-limit paths. They do not form a representative
shell-replacement corpus and do not run a real OpenShell or remote replacement.
The corpus also includes agent-only repository search/pipeline, native editing,
archive, local Git, build/descendant, and recoverable recursive-removal
workloads. Inert definitions execute through the same generic Plan path; the
v2 definition schema also lowers `enqueue` actions onto the staged
`RequestExternal` seam with local fixture evidence, which concretizes the
definition contract while distribution and trust remain open.

Airlock may say that macOS v1 “replaces most shell usage for agents” only after
the published acceptance corpus clears all applicable construction,
containment, recovery, crash, label, and authority-laundering gates and at
least 90% of representative tasks complete with the agent receiving only
`airlock-agent`. Endpoint-broker gates apply only when contained networking is
advertised. Until then this sentence is a release target, not a product claim.

See [the macOS v1 acceptance contract](docs/acceptance.md) and
[the Vouch-first adoption plan](docs/vouch-first.md).

## Non-goals

Airlock does not:

- reimplement Unix tools or their application protocols;
- infer an agent's true intent;
- promise that remote effects are undoable or exactly once;
- provide a distributed transaction;
- protect against kernel, hypervisor, administrator, or physical compromise;
- treat an installed binary or definition as trustworthy by existence;
- require a curated model for every tool;
- expose an unstructured shell escape in the agent language; or
- claim native containment provides guarantees the active host backend cannot
  enforce.

## Open questions

The smallest useful language beyond the syntax already implemented, metadata
and hardlink semantics, tool-definition distribution and trust (the v2 schema
concretizes the definition document itself; signing, precedence, and
distribution do not follow from it), contained endpoint brokerage, complete
Journal protocol, and remote-realm transport remain open. They may be resolved only by implementation evidence without weakening
the two laws or creating a new effect or terminal-authority path accidentally.
