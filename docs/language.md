# The .air type system

A `.air` program is small by design: `let`, `if`, `for`, `assert`, `return`,
records, lists, indexes, arithmetic, durations, and one way to call a tool,
`tool.name({ … })`. There are no imports, functions, computed tool names or
While loops. What makes the language worth having is not the syntax but what
is known about a program before it runs. This document describes that
knowledge as the code holds it today, and what is planned next. The code and
its tests are the source of truth; when they disagree with this file, this
file is wrong.

## The pipeline

Every run on every host goes through the same four gates
(`packages/airlock/src/runner/ProgramRunner.ts`):

```
parse ──▶ check ──▶ review ──▶ run
```

- **Parse** (`packages/airlock/src/language/lexer.ts`, `parser.ts`): source text becomes
  an abstract syntax tree. A lexical error is a `LanguageDiagnostic`.
- **Check** (`packages/airlock/src/language/check.ts`): the tree is typed against the
  granted tool contracts. A program that does not check is `invalid_code`,
  with the line and column and a fixed `fault` word, and nothing runs.
- **Review** (`packages/airlock/src/review/`): the checked program is lowered to a
  `ReviewedPlan` and measured against the policy's grants, sink policies and
  flow rules. A plan the policy refuses ends the run as `review_refused`,
  with the reasons, and nothing runs.
- **Run** (`packages/airlock/src/language/run.ts`): the evaluator executes under the
  plan guard. A call the Plan does not describe ends the run as
  `plan_mismatch`.

A fixed list of stop reasons covers every way a run can end
(`packages/airlock/src/runner/GuestRunner.ts`); program text never becomes a failure
message (`test/security-program-runner-fuzz.test.ts`).

## What the checker computes

For every expression the checker computes a `Fact`
(`packages/airlock/src/language/check.ts`):

- **a type**: string, number, boolean, null, duration, a record with known
  fields (which are optional), a bounded list, a union of cases, a nullable
  value, or an **opaque** value (a decoded value that is not JSON, carried by
  its codec identity); the checker never invents an `any`;
- **data origins**: which tool results the value's payload came from;
- **control origins**: which values decided the paths that produced it;
- **refinements**: which trusted decoders have proven its shape;
- **a constant**, when the value is folded to an exact literal.

Types come from the contracts' schema models, not from the guest's claims.
A contract whose schema uses a model the checker does not support fails the
check closed (`unsupported schema …`); the checker is never permissive by
default.

The checker bounds every call a program can make — per tool and per call
site, across every branch and loop iteration, computed to a fixed point — and
rejects a shadowed binding in any branch, reachable or not, before anything
runs. Constants are folded exactly, including the sign of zero: the language
distinguishes `0` from `-0` because the contracts' exact-value checks do.

## Receipts narrow

Every call returns one receipt with `state: "done" | "staged" | "refused"`
(`packages/airlock/src/contract/Receipt.ts`). A refused call is a value the program can
read and branch on; running out of budget, a deadline or a host fault still
ends the run.

The checker narrows on the state: inside
`if receipt.state == "done" { … }`, and only there, `receipt.result` is
readable, because only the `done` case has a result. The same narrowing works
on literal equality over unions, on `null` tests, and through `!`, `&&` and
`||` (`test/language-check.test.ts`).

## Proofs: trusted decoders

A **trusted decoder** (`packages/airlock/src/contract/Decoder.ts`) is a named, versioned
validator the host supplies. Running a value through one attaches a proof to
that exact value; a proof survives aliasing and projection and is lost by any
transformation the checker cannot see. A sink that requires a proof refuses
an unproven value, and the runtime re-checks every proof before a handler
runs (`test/core-decoders.test.ts`, `planGuard`'s `proof` failure).

A decoded value that is not JSON — a date, a rich object — crosses as
**opaque**: its validated JSON is retained, it can be handed whole to the same
codec, and it exposes no field or arithmetic operations
(`packages/airlock/src/language/check.ts`, the `opaque` kind).

## Labels and flow

Every value carries an information label (`packages/airlock/src/labels/Labels.ts`): a
confidentiality (`public < project < private < secret`) and an integrity
(`untrusted < project < operator < runtime`), plus the provenance of the
origins it came from. Labels join conservatively: secrecy rises, integrity
falls.

Review checks every call argument against a **sink policy**: a field can only
receive data at or below its confidentiality ceiling and at or above its
minimum integrity. Data and control roles are tracked separately — the index
a program selected with stays a control influence on what it selected — and
at run time each argument arrives with an authenticated **role witness**
(`packages/airlock/src/contract/RoleWitness.ts`) that the host issued; a copied, stale or
misattributed witness never separates a role
(`test/security-role-witness.test.ts`).

When a flow is refused, review explains the edge and can suggest the rule
that would allow it — an `allowWith` suggestion in the report. Installing it
is always the supervisor's act: a flow rule (`packages/airlock/src/contract/FlowRules.ts`)
is a named, monotone transition (a confidentiality release or an integrity
endorsement) written into the policy by a person
(`test/security-flow-rules.test.ts`).

## The Plan a supervisor reviews

Review lowers the checked program into a `ReviewedPlan`
(`airlock/plan/v1`, `packages/airlock/src/review/Review.ts`): one node per call site,
each with its tool, version, effect class, source offset, maximum occurrences,
and one envelope per argument — the fixed value when it is constant, its data
and control dependencies, its label, its required proofs, and its flow
obligations. The plan is bound to its context by a digest of the source, the
bindings, the registry of contracts and decoders, the grants, the labels and
the limits; any of those changing makes a different plan.

Approval follows the effect:

| effect | what approving the plan covers |
|---|---|
| `capture` | the call runs under the plan without waiting again |
| `request`, content fully fixed | the session commits it under the plan once staged |
| `request`, content not known at review | staged; a person approves the exact bytes as a batch after they exist |
| `apply`, `invoke` | never committed by the plan; the grant's own `when` decides (`now` at once, or staged for a person) |

Nothing can validate data that does not exist yet, so no approval ever covers
unseen content. At run time `planGuard` holds each call to its node before
any handler runs — occurrence counts, fixed values, proofs, labels — and a
mismatch ends the run (`test/core-plan-approval.test.ts`,
`test/plan-flow-roles.test.ts`, `test/plan-selection-review.test.ts`).

## Bounds

A program runs inside limits every host sets (`packages/airlock/src/runner/Bounds.ts`):
source size, steps, nesting depth, value nodes, total string units, loop
iterations, tool calls, input and output bytes, plan size, and a wall-clock
deadline that is checked between steps. Each exhausted bound is one fixed
stop reason. The same runner runs on the CLI and in the Durable Object; the
host supplies only the tool surface.

## What is next

The roadmap, in the order it is likely to be asked for:

1. **A soundness claim.** The direction is a type system that is sound and
   much smaller than TypeScript's, over plain syntax — no FP notation for its
   own sake (that path was explored and set aside on Oct 9). What is missing
   is the stated invariant — *what it means for the checker to be sound
   about a run* — and evidence at that level. Today's evidence is structural:
   a seeded corpus of hostile and generated programs agrees with independent
   value and call-count oracles (`test/security-program-runner-fuzz.test.ts`),
   and unsupported schema kinds fail closed. Until the invariant is stated,
   no soundness is claimed.
2. **Pure operations.** `.air` cannot yet filter a list, count it, turn a
   number into text, or test a record for a missing field. The decided
   direction is a small set of pure operations for exactly these — no user
   code, no escape hatch — with the exact names and syntax to be settled by
   one ruling, with examples, because it is the language itself.
3. **Closed schema coverage.** The checker maps contract schemas into its
   fact model and refuses what it does not know. The supported set should
   become a closed representation in the contract lane, so a contract that
   would fail closed is a type error at definition time, not a review-time
   refusal.
4. **Replay keyed by the Plan.** Running the same run id again returns
   recorded receipts instead of calling again, but replay matches calls by
   their order in the run, not by Plan node. Keying replay to the plan makes
   a replayed run fail closed against the exact reviewed calls.

## Further reading

- [`usage.md`](usage.md): writing and running programs, the policy, the
  person's commands.
- [`security-model.md`](security-model.md): the threat model around the
  language.
- [`decisions.md`](decisions.md): the decision log, with the rulings behind
  each item above.
