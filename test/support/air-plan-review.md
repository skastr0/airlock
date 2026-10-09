# Test-only program review demonstration

Run `VITEST_MAX_WORKERS=2 bun run test test/program-review-demo.test.ts`.
The fixtures come from `air-review-fixtures.ts`; language-owned typed facts
feed the Plan in `air-plan-review.ts`. No production runner imports this code.
The three programs also execute through the evaluator's awaited guard hook:
refused reports reach no resolver, accepted forwarding returns exact-batch
approval, and a selected fixed send returns program approval. The resolver
is a test fixture; it sends no real mail or HTTP request.

| Program | Report | Public-sink policy refuses | Private-mail policy |
| --- | --- | --- | --- |
| Forward with decoded recipient | One capture, one request, each at most once. Recipient depends on mailbox `from`; body on mailbox `body`; all send fields also depend on receipt state and decoder success. | All three send fields carry private confidentiality, including fixed subject through control flow. Recipient proof does not release data. | Review accepts; request content is dynamic and needs later approval of the exact batch. |
| Mailbox body in HTTP URL | One capture of mail, one capture of HTTP, each at most once. URL depends on mailbox body and receipt state. | Private data reaches the URL. Capture arguments are sinks too. | Still refused: HTTP sink remains public. |
| Private branch choosing fixed sends | Three call sites, but per-tool bounds are one mail capture and one send. Both sends have complete fixed arguments and private control dependencies. | All six argument flows across the two sends. Fixed text does not erase which send occurs. | Review accepts; both fixed alternatives are covered by program approval; each request is staged. |

Statically established for these fixtures: every syntactic call site is
enumerated, including unreachable branches; tools must be granted; all fixed
conditions must fit one grant; per-site and per-tool bounds are finite; value
and control labels join through the existing lattice; unknown labels and
missing sinks refuse review. Mandatory `dataOrigins` and `controlOrigins`
from the checker lower separately: payload origins become `dependencies`;
local selection/decoder control joins call-wide branch/loop control in
`control`. Aggregate `origins` never supplies a missing role. A private index
choosing fixed public text is control, so a data release cannot authorize it.
The Plan holds these facts; there is no second
execution manifest. The initial approval identity binds source bytes,
bindings, trusted registry digest, grant and flow policy, semantics, and limits.

Checked by the runtime guard tests: Plan/node identity, next occurrence and
both bounds, exact fixed values, input codec, dynamic grants, labels and
exact-owned decoder proof, permitted provenance, and unchanged trusted
contract/decoder/binding-codec objects and tool grants. Any mismatch ends the guard permanently before it
returns an instance for recording or acting. Dynamic requests remain staged
even when validated. The guard rejects copied reports, copied tracked
value/PC tokens and changed context. Each field supplies an owned `value`
and optional `witness`, plus call-wide PC. The guard is configured with the
same authenticated issuer as the evaluator. Decoder proof stays on the
exact `value`; copying the outer field pair confers no new proof or label.
Data and joined local/global control must each fit their own raw source
envelope and exact origin tags, even when no author release is needed.

Not established here: host execution, persistent/replay approval storage,
physical resource identity, real network or filesystem behavior, and the
production runner's connection to this guard. The registry digest is an
explicit trusted fixture input; the demo does not fingerprint arbitrary
JavaScript schema functions. The checker input and source are supplied by
the trusted test; this prototype does not attest the checker or prove that
its input AST came from those bytes. Tracked dynamic values and control
labels must come from a trusted interpreter, not from a guest.

The contract-owned witness binds immutable data, selection and control
labels to the exact authentic value and a fresh execution issuer. Their
join must equal the token's aggregate label. The evaluator uses monotone
`addInfluence` to raise the token's aggregate secrecy while preserving the
same owned JSON and exact proof; the guard never re-mints a lower-label
value. It reads payload data from the valid witness and joins selection and
local control with call-wide PC. `beforeCall` awaits the guard before the
trusted test resolver runs. An end-to-end selected-recipient test retains
its proof, keeps private aggregate secrecy, and requires later exact-batch
approval; a copied witness stops before the resolver.

An absent, copied, wrong-value or older-execution witness yields no roles:
the guard conservatively treats the value's entire label as data. This can
refuse otherwise allowed control-only selections (`plan-flow-roles.test.ts`).
Invalid witnesses do not automatically refuse a call that already fits as
aggregate data. A copied issuer itself is rejected. The fresh issuer object,
not its textual run ID, supplies the execution boundary; the trusted host
must create it anew for every execution and retain its issuance authority.

Authentication proves which trusted issuer attached these roles, not that
an arbitrary producer classified every influence correctly. The issuer
must remain inaccessible to guests. A role claiming payload-only origins
as control is rejected by the separate Plan bounds, but when the same origin
is statically allowed in both roles its actual classification relies on the
trusted evaluator. Language and Plan properties check its observed roles
against static bounds. This is an exercised test-only bridge, not a
production runner or persisted authorization.

Checked language bindings are included in the approval digest independently
of the surface's binding JSON: encoded values, declared labels, and closed
encoded/decoded schema models are snapshotted, including unused bindings.
At runtime the exact binding codec and AST references must also match. The
trusted registry digest must identify binding codec implementations as well
as tools and decoders; structural models do not fingerprint arbitrary checks.
Changing a codec implementation requires a new registry digest and review.
Adding, removing, or changing a binding ends an existing guard before a call.

Review cannot know which receipt or decoder branch will occur, mailbox bytes,
remote success, resource drift, or whether a run will finish. Grant narrowing
on a dynamic recipient is an obligation checked later, not a static promise.
The HTTP fixture is refused by secrecy alone; the separate ruling against
query/fragment/body in a now-GET is not implemented in this demonstration.

Over-rejection is deliberate: the checker carries receipt/decoder and
branch/loop control to later statements, even where a finer termination
analysis might prove the dependency irrelevant. A fixed harmless subject or
a send after reconverging branches can therefore be refused. It also rejects
unknown flow origins, rather than guessing a type or label.
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

At runtime every call requires kernel-owned exact origin
tags on data/control, verifies each component against its original source
envelope, and checks the sibling proof again. Wrong-field substitutions,
unidentified private provenance and copied proofs stop the guard. The
accepted forward still has dynamic content and stays staged for later exact
batch approval. This is a test-only demonstration of author rules, not a
persisted supervisor authorization or a production tracking interpreter.
The simple origin resolver intentionally refuses nested/list paths; those
need the language seat's typed origin tree. Transitive call-argument/control
origins must also be supplied by that checker/interpreter bridge.
Receipt IDs, refusal code/message, `wayBack` fields and binding paths are
distinct origins that this resolver cannot yet represent. Even a supplied
public label cannot authorize them; they refuse as `unknown-label`. A rule
for receipt state never releases those metadata values. This rejects
reasonable binding-dependent programs until the typed source bridge lands.
Opaque whole tool inputs retain one `$` argument with their dependencies in
the report and refuse as `argument-shape`: the current instance guard fits
modeled field maps only. An opaque request is dynamic, requires exact-batch
approval, and is staged; it is never represented as a fixed empty request.
This is another explicit test-only over-rejection pending the production
whole-input instance model.
