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
- **v1 contract** — acceptance condition for the first macOS release; it is not
  a claim that the current code already satisfies it.
- **Candidate** — current design direction awaiting implementation evidence.
- **Open question** — intentionally unresolved; it must not be treated as an
  invariant by code or documentation.

The two laws below are the only frozen architectural invariants today. The
four-class model, macOS profiles, Plan/runtime algebras, information labels,
and tool-definition model are v1 contracts or candidates until their evidence
gates pass.

## The four effect classes

Everything an agent asks a Unix machine to do decomposes into four effect
classes. The classes map one-to-one onto the candidate closed Plan algebra:

| effect class | Plan node | meaning | physics |
|---|---|---|---|
| **observation** | `Capture` | information enters the program | provenance and confidentiality/integrity labels attach at entry |
| **computation** | `Invoke` | existing code runs | the complete execution closure runs inside a Cell |
| **mutation** | `Apply` | managed local state changes | displaced state enters Hold; live absence is applied only through Hold |
| **emission** | `RequestExternal` | agent requests an unmanaged effect | intent is staged in Outbox; endpoint authority appears only at commit |

`Capture` and `Apply` cross managed boundaries; privileged
`DispatchExternal`, not `RequestExternal`, crosses the unmanaged boundary.
`Invoke` encloses computation that may propose or consume the other three.
This is a refinement of the four classes, not a replacement for them.

## The two laws

### 1. Only the reaper unlinks

Every live mutation verb is a rename through Hold. Before a live binding is
removed or replaced, its prior state is renamed into a same-volume hold. Undo
is itself recoverable: if undo must clear a target, that target is displaced
into Hold rather than destroyed.

`Hold.reap` is the single irreversible unlink authority in the codebase. A
construction test rejects a second unlink site.

Disposable files may be unlinked inside an isolated private or VM filesystem.
That absence cannot reach managed live state except through `Apply` and Hold.
The law concerns unique bytes in managed live state:

> damage = irreversible loss of the last copy of unique managed bytes

### 2. The ratchet law

Zero-configuration behavior preserves Bash capability parity. Safety that is
compatibility-free—planning, staging, recovery material, receipts, and
visibility—may accrue by default. Restrictions on scope, endpoints, execution,
labels, merge, or retention are enabled only when the user or harness selects
them.

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
| external request or process | stage an `ExternalIntent` | `Outbox.commit` issues a bounded endpoint lease and dispatches |
| arbitrary code | run against a private view | Cell reports a delta; Hold applies it separately |
| remote machine work | delegate a realm-scoped Plan request | the remote Airlock independently admits and executes it |

An external effect has no undo after the recipient observes it. Delayed
dispatch is cancellation of queued intent, not reversal of a send. If dispatch
may have happened, the honest result is `uncertain`, never an automatic retry.

## macOS-first v1

The first release targets macOS, with Apple silicon as the primary tested
platform and an x86_64 build target, and uses one physics model across three
explicit profiles:

- **`compatibility`** — zero-config, broad Unix capability, recovery and
  receipts where compatible; no containment claim.
- **`vm-enclosed`** — the default agent shell-replacement profile. Arbitrary
  existing programs run in an Airlock-owned macOS VM. Host files, secrets, and
  endpoints are reachable only through typed brokers.
- **`native-contained`** — a lower-overhead profile for the subset that the
  native macOS backend can enforce with private APFS views, controlled process
  execution, descriptors, and brokered endpoints. Unsupported capabilities
  fail explicitly; this profile is not described as VM-equivalent.

Profile choice is an explicit ratchet turn. All profiles use the same
Schema-validated contracts, Plan algebra, runtime algebra, Hold, Outbox, and
receipt vocabulary. See [the macOS runtime contract](docs/macos-v1.md).

## Two closed algebras

The candidate **Plan algebra** is exactly:

```text
PlanNode = Capture | Invoke | Apply | RequestExternal
```

The candidate **runtime algebra** contains the terminal operations needed to
interpret admitted plans:

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

Definitions, profiles, platform adapters, and project integrations cannot add
constructors to either algebra. Every Plan node must lower totally to runtime
operations. `DispatchExternal` is reachable only through `Outbox.commit`;
`HoldTransition` is the only live binding replacement path; `Reap` is the only
irreversible discard path.

`Invoke` accepts the structured
`{ executable, args, stdin, stdout, stderr, timeout }` contract.
`executable` is separate from `args`; the argument array never embeds the
executable as element zero. There is no command-string execution form.

The runtime uses Effect: data and wire boundaries are Schema-first, expected
failures are tagged in the typed error channel, capability requirements are
visible in service contracts, and one managed runtime owns the composed
layers.

## Component discipline

Airlock follows **Pristine Components, Messy Integrations**:

| stratum | v1 posture |
|---|---|
| domain capabilities | narrow Effect services, Schema-first values, tagged failures, executable invariants |
| interaction seams | versioned Plan/Receipt schemas, authorization, ordering, idempotency, crash and uncertainty semantics |
| platform/project adapters | local, repetitive, observable, and disposable `Layer` implementations |

Hold and Outbox are earned nuclei because they already encode real invariants
and have executable tests. They are not yet certified as complete v1
components: their durability, concurrency, same-volume, and crash envelopes
must still pass the acceptance contract. Ledger is a working prototype seam.
Plan, Cell, EndpointBroker, label flow, VM/native backends, and tool
definitions remain candidates until real integrations and adversarial tests
earn narrower component boundaries.

The macOS VM adapter, native sandbox adapter, APFS adapter, CLI/RPC wiring, and
Vouch integration remain local glue. Policy, authorization, ordering,
idempotency, retry, uncertainty, and receipt semantics never live only in that
glue.

## Security contracts for v1

The macOS release must make these candidates executable:

- **Execution closure** — an invocation owns its executable, loader/shebang
  chain, descendants, helpers, hooks, plugins, pagers, editors, credential
  helpers, lifecycle scripts, and config-selected executors until all exit or
  are terminated.
- **No authority laundering** — agent-origin bytes do not become trusted
  executables, definitions, policy, grants, launch configuration, hooks, or
  credential sources merely because they persist and are consumed later.
- **Endpoint brokerage** — contained code receives no ambient host network or
  host Unix-socket authority. An Outbox commit issues a bounded endpoint lease;
  the broker owns DNS, redirects, proxying, loopback decisions, budgets, and
  actual-destination receipts.
- **Information labels** — observations, artifacts, handles, definitions,
  executables, streams, and outputs carry conservative confidentiality and
  integrity labels. Declassification and endorsement are distinct
  supervisor-granted acts; agent code cannot mint either.

See [the security model](docs/security-model.md).

## Adoption and the v1 claim

Vouch is the first adoption corpus, not the source of Airlock's ontology. Its
snapshot, upload, restore, validate, and replace workflow must lower only to
general Airlock actions. An unrelated held-out repository workload follows it
to detect vocabulary overfitting.

Airlock may say that macOS v1 “replaces most shell usage for agents” only after
the published acceptance corpus clears all construction, containment,
recovery, crash, endpoint, label, and authority-laundering gates and at least
90% of representative tasks complete with the agent receiving only Airlock.
Until then this sentence is a release target, not a product claim.

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
- claim native containment provides guarantees the active macOS backend cannot
  enforce.

## Open questions

The concrete Airlock syntax, the smallest useful pure language, metadata and
hardlink semantics, tool-definition distribution, native network enforcement
envelope, journal storage protocol, and remote-realm transport remain open.
They may be resolved only by implementation evidence without weakening the two
laws or extending the two algebras accidentally.
