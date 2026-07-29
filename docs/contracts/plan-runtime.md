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
fields on the admitted Invoke contract. No command-string form exists.

## Closed Plan algebra

```text
PlanNode =
    Capture<CaptureSpec>
  | Invoke<ExecutionClosure>
  | Apply<LocalDelta>
  | RequestExternal<ExternalIntent>
```

- `Capture` observes and labels information.
- `Invoke` computes in a Cell and may propose artifacts or a delta.
- `Apply` requests a recoverable managed-state transition.
- `RequestExternal` requests inert local Outbox state. It does not dispatch.

Pure control and data transformations compose these nodes but cannot add
effect constructors.

## Runtime-operation vocabulary

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

Resolution, Admission, denial, grant issuance/revocation, and policy evaluation
belong to the trusted authority plane. They decide whether a draft becomes an
admitted Plan; they are not agent-held effects.

Lifecycle operations such as dispatch, undo, reconciliation, and reaping may
be requested by a program or supervisor, but only the corresponding trusted
runtime authority performs them. Undo is another recoverable Apply.

## Total lowering

```text
interpret : AdmittedPlan → RuntimeProgram<RunReceipt>
```

| Plan constructor | legal runtime lowering |
|---|---|
| `Capture` | `Observe → AppendReceipt` |
| `Invoke` | `SpawnContained → [ProposeDelta] → AppendReceipt` |
| `Apply` | `HoldTransition → AppendReceipt` |
| `RequestExternal` | `StageExternal → AppendReceipt`; a later authorized commit may perform `DispatchExternal → AppendReceipt` |

The interpreter must reject an unhandled constructor. A runtime world effect
without an originating Plan node or an authorized administrative transition
is a defect and a construction-test failure.

The current program-level result envelope is versioned and reports
`succeeded`, `failed`, or `partial`. On a later failure, it preserves completed
action request/result records, Plan drafts, artifacts, and a typed
phase/cause. That evidence describes completed work; it is not an all-or-
nothing transaction and does not satisfy the acceptance gate for a durable
receipt at every failed/crashed transition.

## Authority obligations

Only obligations 1 and 2 below are the frozen repository laws: Reap owns
irreversible removal, and compatibility restrictions follow the ratchet.
The remaining items are implemented construction properties or candidate
seam obligations; they must not be promoted into additional laws by wording.

1. Managed mutation uses Hold rename transitions; `Reap` is the only way to
   irreversibly discard retained recovery material.
2. Zero-config compatibility remains broad; selected restrictions can only
   narrow authority and cannot silently fall back.
3. Current external dispatch is reachable only inside `Outbox.commit`.
4. Candidate definitions and adapters must not mint grants, handles, labels, endorsements,
   declassifications, Plan constructors, or runtime operations.
5. Completed current runtime nodes produce typed outcomes and correlated
   receipts. A durable receipt for every attempted transition remains an
   acceptance gate.
6. `uncertain` is preserved when an external result cannot be known; it is
   never collapsed into success/failure or automatically retried without
   idempotency evidence.

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
