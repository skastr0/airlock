# Plan and runtime contract

> Status: implemented candidate seam. The current Schema fields and four-node
> interpretation run in the repository. Only the two laws in
> [`DESIGN.md`](../../DESIGN.md) are frozen invariants; the completeness of
> these algebras remains evidence-seeking.

## Purpose

An agent submits inert, typed requests. Only the trusted runtime owns lifecycle
and terminal authority. This document prevents the language, definitions,
platform backends, and project integrations from growing new effect paths.

## The authoring pipeline

```text
Airlock source or ActionCall
  → Schema decode
  → ActionDefinition lowering
  → PlanDraft
  → Resolution and Admission
  → admitted Plan
  → total runtime interpretation
  → versioned results, receipts, and artifacts
```

`PlanDraft` contains unresolved requirements and no authority. `AdmittedPlan`
is the architectural name for the implemented `Plan` after Admission. It
contains runtime-minted handles and resolutions, an authority admission,
definition digests, and a plan digest. Requirements may carry budgets and
label requirements; those are not standalone top-level `Plan` fields.

The canonical structured execution payload is:

```text
run {
  executable
  descendantExecutables
  args
  stdin
  stdout
  stderr
  timeout
}
```

`executable` is distinct from `args`; the argument array never embeds or
duplicates the executable as element zero. Working directory, environment,
Cell profile, resource handles, labels, and budgets are explicit surrounding
fields on the admitted Invoke contract. `descendantExecutables` is the exact
set of additional exec paths requested for this root in native-contained
execution. It is not the architecture's full execution closure. No
command-string form exists.

## Closed Plan algebra

The node set is closed as a Schema and interpreter contract. Its completeness
as an account of representative agent Unix work is a falsifiable candidate
hypothesis: a workload that cannot lower honestly is evidence to narrow or
version the algebra, not something to hide inside an existing constructor.

```text
PlanNode =
    Capture<CaptureSpec>
  | Invoke<InvokeSpec>
  | Apply<LocalDelta>
  | RequestExternal<ExternalIntent>
```

- `Capture` observes and labels information.
- `Invoke` computes in a Cell and may propose artifacts or a delta.
- `Apply` requests a recoverable managed-state transition.
- `RequestExternal` requests inert local Outbox state. It does not dispatch.

Compatibility is a coverage profile, not complete mediation. A compatibility
Invoke child retains ambient host authority; its internal writes and network
calls are not converted into `Apply` or `RequestExternal` and receive no Hold,
Outbox, or containment guarantee.

The endpoint requirement bound to `RequestExternal` authorizes admission and
staging of one declared intent. It is not a socket or wire capability exposed
to agent code. Wire-dispatch authority belongs to a later, separately
authorized commit.

Pure control and data transformations compose these nodes but cannot add
effect constructors.

The implemented `InvokeSpec` distinguishes root authority from descendant
authority:

```text
root executable       → invoke
declared descendants  → execute, scoped by policy to that root
```

Admission retains those roles in Grants and Handles. Native Cell receipts
record the requested, launch, and allowed paths for each binding. These are
executable-edge facts, not evidence that loaders, dynamic libraries,
configuration, plugins, or code interpreted in-process are fully modeled.

## Runtime-operation vocabulary

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

Resolution, Admission, denial, grant issuance/revocation, and policy evaluation
belong to the trusted authority plane. They decide whether a draft becomes an
admitted Plan; they are not agent-held effects.

`ClaimPlan` is the first trusted execution transition. The implemented Runtime
requires a persistent run journal, acquires a SHA-256-derived per-Plan claim
under the journal's `.claims` directory, and holds its kernel-backed exclusive
lease through the entire lifecycle. It publishes `running` before node adapter
work. Any existing `running`, `finalizing`, or terminal snapshot rejects
concurrent or sequential replay with `RuntimeExecutionClaimRejected`.
`persistent-journal-required`, `acquire`, and `replay` distinguish the refusal
phase.

Lifecycle operations such as claim/dispatch, pre-claim cancellation, undo,
reconciliation, and reaping may be requested only through their authorized
supervisor/runtime surfaces; they are not ordinary agent Plan constructors.
Only the corresponding trusted authority performs them. `Outbox.commit`
performs `ClaimExternal` before `DispatchExternal`; `CancelExternal` is legal
only while the intent remains staged. Undo is another recoverable Apply
transition, not ambient restoration authority held by the agent.

## Total lowering

```text
execute : ExecutionAuthority → ClaimPlan → RuntimeProgram<RunReceipt>
```

| Plan constructor | legal runtime lowering |
|---|---|
| `Capture` | `Observe → AppendReceipt` |
| `Invoke` | `SpawnContained → [ProposeDelta] → AppendReceipt` |
| `Apply` | `HoldTransition → AppendReceipt` |
| `RequestExternal` | `StageExternal → AppendReceipt`; a later authorized commit may perform `ClaimExternal → DispatchExternal → AppendReceipt` |

The complete administrative lowering is:

```text
Outbox.commit = ClaimExternal → DispatchExternal → AppendReceipt
Outbox.cancel = CancelExternal → AppendReceipt  // staged only
```

The interpreter must reject an unhandled constructor. A runtime world effect
without an originating Plan node or an authorized administrative transition
is a defect and a construction-test failure.

The current program-level result envelope is versioned and reports
`succeeded`, `failed`, or `partial`. On a later failure, it preserves completed
action request/result records, Plan drafts, artifacts, and a typed
phase/cause. That evidence describes completed work; it is not an all-or-
nothing transaction and does not satisfy the acceptance gate for a durable
receipt at every failed/crashed node transition. The separate run journal does
durably establish whether Plan execution started, entered Cell finalization, or
reached a recorded terminal state; it intentionally refuses replay rather than
inventing resume semantics for a recovered nonterminal snapshot.

## Authority obligations

Only obligations 1 and 2 below are the frozen repository laws: Reap owns
irreversible removal, and compatibility restrictions follow the ratchet.
The remaining items are implemented construction properties or candidate
seam obligations; they must not be promoted into additional laws by wording.

1. Airlock-owned managed mutation uses Hold rename transitions; `Reap` is the
   only way to irreversibly discard retained recovery material. Compatibility
   child syscalls are outside this managed surface.
2. Zero-config compatibility remains broad; selected restrictions can only
   narrow authority and cannot silently fall back.
3. Current Airlock-owned `RequestExternal` dispatch is reachable only inside
   `Outbox.commit`; compatibility subprocess network activity is ambient and
   outside this guarantee.
4. Candidate definitions and adapters must not mint grants, handles, labels, endorsements,
   declassifications, Plan constructors, or runtime operations.
5. Completed current runtime nodes produce typed outcomes and correlated
   receipts. A durable receipt for every attempted transition remains an
   acceptance gate.
6. `uncertain` is preserved when an external result cannot be known; it is
   never collapsed into success/failure or automatically retried without
   idempotency evidence.
7. In native-contained execution, root `invoke` and root-scoped descendant
   `execute` are distinct modeled rights. This is an implemented contract
   property, not a claim of complete execution closure.
8. Runtime requires persistent run-journal storage and claims a Plan identity
   before adapter work. Any durable prior snapshot rejects replay; it is not
   treated as permission to resume or repeat world effects.

## Schema-first seam

The wire/data contracts are Effect Schema values with:

- branded identifiers and digests;
- tagged union variants;
- explicit encoded forms and `schema_version`;
- `Schema.TaggedError` failures;
- no secret bytes in Plans, receipts, logs, or errors;
- exhaustive transition decoding;
- capability requirements in Effect service contracts.

The current CLI composes the service Layers into one scoped `ManagedRuntime`
backed by `BunContext` and disposes it through `finally`. CLI code decodes
input and calls the runtime; it does not duplicate planning or authority
policy. A persistent daemon that retains that runtime across requests remains
design direction, not current behavior.

## Contract change

A v1 contract change must name:

1. the counterexample;
2. whether the canonical algebra is narrowed or versioned;
3. every consumer and migration;
4. the construction/adversarial tests changed; and
5. the superseded surface to remove.

Compatibility aliases are not assumed. A fifth Plan or runtime constructor
requires evidence that the operation cannot compose from the existing
algebras without dishonesty.
