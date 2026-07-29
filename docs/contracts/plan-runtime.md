# Plan and runtime contract

> Status: candidate v1 seam. The algebra and laws are release obligations; the
> exact Schema fields remain versioned implementation work.

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
  → AdmittedPlan
  → total runtime interpretation
  → immutable Receipts
```

`PlanDraft` contains unresolved requirements and no authority. `AdmittedPlan`
contains runtime-minted handles, bound resource and executable identities,
policy/definition digests, budgets, labels, and a plan digest.

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

## Closed runtime algebra

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

## Terminal-authority laws

1. `HoldTransition` is the only way to replace a managed live binding.
2. `Reap` is the only way to irreversibly discard retained recovery material.
3. `DispatchExternal` is reachable only inside `Outbox.commit`.
4. Definitions and adapters cannot mint grants, handles, labels, endorsements,
   declassifications, Plan constructors, or runtime operations.
5. Every attempted transition produces a typed outcome and durable receipt.
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

One `ManagedRuntime` owns the composed services. CLI/RPC code decodes input and
calls the runtime; it does not duplicate planning or authority policy.

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
