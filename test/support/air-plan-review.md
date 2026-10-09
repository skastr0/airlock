# Test-only program review demonstration

Run `VITEST_MAX_WORKERS=2 bun run test test/program-review-demo.test.ts`.
The fixtures come from `air-review-fixtures.ts`; language-owned typed facts
feed the Plan in `air-plan-review.ts`. No production runner imports this code.

| Program | Report | Public-sink policy refuses | Private-mail policy |
| --- | --- | --- | --- |
| Forward with decoded recipient | One capture, one request, each at most once. Recipient depends on mailbox `from`; body on mailbox `body`; all send fields also depend on receipt state and decoder success. | All three send fields carry private confidentiality, including fixed subject through control flow. Recipient proof does not release data. | Review accepts; request content is dynamic and needs later approval of the exact batch. |
| Mailbox body in HTTP URL | One capture of mail, one capture of HTTP, each at most once. URL depends on mailbox body and receipt state. | Private data reaches the URL. Capture arguments are sinks too. | Still refused: HTTP sink remains public. |
| Private branch choosing fixed sends | Three call sites, but per-tool bounds are one mail capture and one send. Both sends have complete fixed arguments and private control dependencies. | All six argument flows across the two sends. Fixed text does not erase which send occurs. | Review accepts; both fixed alternatives are covered by program approval; each request is staged. |

Statically established for these fixtures: every syntactic call site is
enumerated, including unreachable branches; tools must be granted; all fixed
conditions must fit one grant; per-site and per-tool bounds are finite; value
and control labels join through the existing lattice; unknown labels and
missing sinks refuse review. The Plan holds these facts; there is no second
execution manifest. The initial approval identity binds source bytes,
bindings, trusted registry digest, grant and flow policy, semantics, and limits.

Checked by the runtime guard tests: Plan/node identity, next occurrence and
both bounds, exact fixed values, input codec, dynamic grants, labels and
exact-owned decoder proof, permitted provenance, and unchanged trusted
contract/decoder objects and tool grants. Any mismatch ends the guard permanently before it
returns an instance for recording or acting. Dynamic requests remain staged
even when validated. The guard rejects copied reports, copied value/control
wrappers and changed context. Arguments and control must be kernel-owned tracked values.

Not established here: host execution, persistent/replay approval storage,
physical resource identity, real network or filesystem behavior, and the
production runner's connection to this guard. The registry digest is an
explicit trusted fixture input; the demo does not fingerprint arbitrary
JavaScript schema functions. The checker input and source are supplied by
the trusted test; this prototype does not attest the checker or prove that
its input AST came from those bytes. Tracked dynamic values and control
labels must come from a trusted interpreter, not from a guest.

Review cannot know which receipt or decoder branch will occur, mailbox bytes,
remote success, resource drift, or whether a run will finish. Grant narrowing
on a dynamic recipient is an obligation checked later, not a static promise.
The HTTP fixture is refused by secrecy alone; the separate ruling against
query/fragment/body in a now-GET is not implemented in this demonstration.

Over-rejection is deliberate: the checker carries receipt/decoder and
branch/loop control to later statements, even where a finer termination
analysis might prove the dependency irrelevant. A fixed harmless subject or
a send after reconverging branches can therefore be refused. It also rejects
unsupported schema/arithmetic forms, rather than guessing a type or label.
An approval never implies declassification or endorsement; the private-mail
policy is a separately supplied supervisor flow policy permitting private
data at that sink, with untrusted integrity, not an automatic label lowering.

## Deliberate author rules

The additional tests use the contract-owned `releaseRule` and
`composeFlowRules` declarations. `Plan.rules` contains the author rules;
every argument's `flows` lists exact source identity, data/control mode,
original and effective labels, and applied rule IDs. Original value labels
are preserved. Refusal explanations name the exact origin, sink policy and
smallest proposed conditional release or endorsement. Suggestions never
install rules or give a program authority.

`rules: [bodyRelease]` releases only `mail.read.result.body` as data into
`mail.send.body`, conditioned on a `companyRecipient` proof on this call's
exact `to` argument. The forward program still refuses recipient and control
flows, including control into its fixed subject. `rules: companyForward` is
the explicit reusable author choice that accepts the example: the set names
two data releases and six control releases (receipt state and decoded
recipient into each send field), all conditioned on the same exact recipient
proof. The control grants deliberately reveal whether the send happens.
Neither set opens HTTP URLs or mailbox-body-dependent branch choices.

At runtime a scoped release additionally requires kernel-owned exact origin
tags on data/control, verifies each component against its original source
envelope, and checks the sibling proof again. Wrong-field substitutions,
unidentified private provenance and copied proofs stop the guard. The
accepted forward still has dynamic content and stays staged for later exact
batch approval. This is a test-only demonstration of author rules, not a
persisted supervisor authorization or a production tracking interpreter.
The simple origin resolver intentionally refuses nested/list paths; those
need the language seat's typed origin tree. Transitive call-argument/control
origins must also be supplied by that checker/interpreter bridge.
