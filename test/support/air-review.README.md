# Current-language checking experiment

This test-only prototype reuses the production parser and AST. No production
runner imports it. Contract-owned SchemaModel shapes and Decoder proofs drive
checking; the evaluator retains dynamic checks permanently.

The intended property is preservation of modeled shapes and required exact-value
decoder proofs for accepted, unchanged programs, assuming immutable synchronous
total trusted schemas and decoding every host result at the boundary. Reaching
dynamic-type-error or refinement is a checker regression. The tests are empirical
evidence, not a mechanized proof, a production guarantee, or an IFC policy proof.
The corpus includes 10,000 accepted programs with randomized conforming receipts,
1,000 rejected mutations, and 1,000 independent expression/value/call-count oracles.

All existing statement forms are modeled: immutable bindings, conditionals,
list and range loops, assertions, expression statements and returns. Expressions
include arithmetic, durations, typed nullability, comparisons, boolean operations,
records, lists, projections and indexing. Arithmetic, indexing, ranges and asserts
may stop with their fixed production reasons. Statically certain arithmetic and
range failures can be rejected before running. Test-only decode(schema.name,value)
uses the trusted catalog; at(list,index) offers a nullable alternative to direct
indexing. Receipt.result requires done narrowing; decoder.value requires ok.

An unchanged decoded record preserves omitted optional fields and exact-value
proofs; reading an omitted field yields null. In a constructed input record, null
encodes as omission only when the contract field is optional and non-nullable.
Optional nullable fields send null. Literal unions retain their alternatives;
opaque schemas permit whole-value transport without invented field operations.

Call facts cover all branches and bound per-tool and per-site occurrences.
Capture fields and receipt states retain argument and control dependencies
transitively, including completed branches and prior loop iterations. A runtime
observer tests static per-field data/control and PC dependency supersets on every
generated call. Receipt ids, state and refusal fields have distinct origins.
Facts and observer values require separate data/control roles: selection adds
control to every descendant, decoder reconstruction preserves both roles, and
capture results retain input data and input/PC control separately. The aggregate
origins field is diagnostic only; policy consumers must use the explicit roles.
Argument-local control is combined with the call PC for outbound policy checking.

Typed host bindings decode before execution, contract flow.provides validates
unchanged decoded values, and nominal checks follow exact trusted Schema identity
across tool model paths. Non-JSON decoded fields retain validated encoded JSON
and the exact original trusted codec as opaque values. They support immutable
aliases, same-codec transport and equality; programs cannot project, concatenate,
calculate with or decode them. Trusted bindings and nullable/list fields preserve
that identity; malformed wire results stop before exposure. Review,
tracked execution and the existing runner must agree on the entire language
before replacement. Map-based facts are an experiment, not a persisted Plan.

Runtime stops are closed: host-result, budget, value-limit, out-of-plan,
arithmetic_failure, index_out_of_range, range_bound, assert_failed, and the two
defensive regression reasons dynamic-type-error/refinement. Malformed or defective
hosts cannot expose their error text. Real admission, approval, scheduling,
deadlines and uncertain outcomes remain kernel responsibilities.
