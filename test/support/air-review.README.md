# Current-syntax checking experiment

This test-only prototype reuses the current `.air` parser and AST. No production
runner imports it. `air-review.ts` checks lexical bindings, tool inputs, closed
receipt handling, trusted decoder refinements, call ceilings, and field/control
origins. `air-review-evaluator.ts` interprets accepted trees with dynamic checks
permanently enabled. Schema shapes and exact-value proofs come from the contract
lane's `SchemaModel` and `Decoder`, rather than guest annotations.

The intended claim is preservation of modeled value shapes and required decoder
proofs for accepted programs in this subset, provided registered schemas/decoders
are trusted, immutable, synchronous and total, and every tool result is decoded
at the boundary. An accepted program should not hit `dynamic-type-error` or
`refinement`; those outcomes are checker bugs, not ordinary refusals. This is an
empirical hypothesis, not a mechanized proof or a claim about the production
runner, arbitrary schemas, all hosts, resource admission, or information-flow
policy enforcement. The seeded generator exercises 10,000 accepted programs
with randomized schema-conforming done/staged/refused results; 1,000 mutated
programs must fail review. Keep every discovered counterexample as a regression.

Supported syntax is immutable `let`, boolean `if`/`else`, finite-list `for`,
`return`, static `tool.name({record})` calls, safe indexing, scalar comparisons,
string concatenation and boolean operators. `decode(schema.name, value)` is the
only experiment-specific call, interpreted through the trusted catalog.
`receipt.result` is accessible only after narrowing `state` to `done`;
`decoded.value` only in `ok`; indexing and optional output fields return
`some`/`none`. Records have exact types, so missing and extra input fields fail.
No guest null, casts, mutation, recursive functions, schema declarations,
proof constructors or inferred `any` are accepted.

The prototype deliberately rejects generic schema unions, opaque schemas,
optional encoded input fields, range loops, assertions, durations and numeric
arithmetic. Checked schema nodes retain nominal requirements; unsupported
dynamic nominal transport is rejected rather than structurally guessed.
Finite-list lengths are guarded by the explicit host maximum and may terminate
with `value-limit`. Numeric division and overflow need a total Result surface
before arithmetic can enter this subset. This rejects some useful programs;
it does not silently widen their types.

Runtime stops are closed: `host-result` for failed/malformed/non-JSON host
responses (including invalid codec transforms); `budget` for consumed iteration,
call or evaluator-work ceilings; `value-limit` for oversized boundary lists;
`out-of-plan` for an unknown reviewed call; `dynamic-type-error` and `refinement`
are retained defensive checks whose occurrence on an accepted unchanged tree is
a regression. Grant refusal and staging are ordinary receipt values. Real host
deadline, abort and uncertain outcomes still belong to the production kernel;
this fixture host does not implement scheduling, admission or approvals.

`Review.expressionFacts` and `calls` form the provisional bridge to the review
seat. Source offsets identify call sites; origins retain field and control
dependencies. Decoder constant folding uses actual `decodeValue`; decoder
success retains its input origins. Joins intersect proofs recursively. The
bridge uses Maps for the experiment, not a persisted Plan contract. Plan
digests, exact-byte batch approval, physical-resource resolution, per-field
policy checks and runtime call-envelope enforcement remain the review/kernel
lanes' responsibilities.
