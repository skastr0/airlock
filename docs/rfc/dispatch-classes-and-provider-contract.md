# RFC: Dispatch classes and the EndpointProvider contract

> Status: **candidate design, partially implemented**. This RFC was authored at
> commit `ffd3733`, and all `src/`/`test/` line citations below are pinned to
> that commit's tree unless a citation says otherwise. Since then, three of its
> candidate seams have been implemented in this tree: admission-policy v2 with
> dispatch-class endpoint grants (§1.3; `src/admission/Admission.ts`,
> `AdmissionPolicyV2`), tool-definition v2 (§2.2, §2.4;
> `src/tools/Definitions.ts`), and the `RequestExternal` read slice with
> supervisor-policy auto-commit through `Outbox.commit`
> (`SupervisorDispatch`/`DispatchPolicy`) — see
> [`docs/evidence/external-read-slice.md`](../evidence/external-read-slice.md)
> for exactly what ran and its claim boundary. Everything else remains
> unimplemented design direction: nothing here is an invariant or a v1
> contract unless it explicitly cites source or a named test.
> The two laws in [`DESIGN.md`](../../DESIGN.md) (Hold.reap sole unlink; the
> ratchet) are untouched. Every schema change proposed here is a contract
> change under the checklist in
> [`docs/contracts/plan-runtime.md`](../contracts/plan-runtime.md) (lines
> 224–234) and names its counterexample, versioning decision, consumers,
> tests, and superseded surface inline.

## Scope and the two fixed points

This RFC proposes the external-effect growth path for Airlock: how a
supervisor grants classes of dispatch authority, how tool definitions describe
external requests without gaining authority, and where a provider ecosystem
attaches without entering the trust base.

Two implemented construction properties anchor everything below:

- **Single wire site.** The only runtime wire-capable call is the `fetch` at
  `src/Outbox.ts:415`, lexically inside `Outbox.commit`
  (`src/Outbox.ts:396`), guarded by the construction test
  `test/outbox-hardening.test.ts:269–279`, which counts exactly one `fetch(`
  in the module and asserts it sits between `commit` and `cancel`.
- **Single unlink site.** `Hold.reap` (`src/Hold.ts:1592`) is the only
  irreversible removal site in `src/`, guarded by
  `test/hold.test.ts:726` ("only the reaper unlinks: exactly one fs.remove in
  src").

Every mechanism in this RFC composes onto these fixed points. None replaces,
duplicates, or bypasses them. In particular, an "immediate dispatch"
experience is defined as *staged `ExternalIntent` plus a supervisor-policy
auto-commit routed through the existing `Outbox.commit` path* — never a second
wire-capable call site.

---

## 1. Dispatch classes and admission policy v2

### 1.1 The problem

At authoring time, the v1 `AdmissionPolicy` (`src/admission/Admission.ts:47–71`
at `ffd3733`) admitted `RequestExternal` endpoints through a flat
`endpointAllowlist` (`src/admission/Admission.ts:69` at `ffd3733`), and every
admitted intent then waited for a manual supervisor `Outbox.commit`. That is
correct for irreversible sends, but
it made a plain external *read* (a `GET` against an idempotent endpoint) pay
the same interactive latency as an irreversible mutation. The counterexample
required by the contract-change checklist: an agent program that polls a
read-only status endpoint could not complete unattended even when the
supervisor would grant that read unconditionally — the v1 policy schema has
no vocabulary to say so. This is the counterexample the implemented
`AdmissionPolicyV2` (§1.3) discharges.

### 1.2 Design direction: classes are grant-side facts

A **dispatch class** is a supervisor judgment about the consequence envelope
of dispatching an admitted intent:

```text
DispatchClass = read | mutate | irreversible-send
```

- `read` — the supervisor asserts the endpoint treats the declared
  method/route as an idempotent observation. Wrongness costs information
  disclosure, not remote state.
- `mutate` — remote state may change, but the provider documents an
  application-level compensation (delete-the-created-thing). Compensation is a
  provider claim, not an Airlock guarantee; Airlock's own finality model
  (staging, cancellation before claim, `uncertain` on ambiguity —
  `src/Outbox.ts:262–316`) is unchanged.
- `irreversible-send` — the default and the floor. An external effect has no
  undo after the recipient observes it (DESIGN.md, "Two-phase everywhere").

**Classes live only in the supervisor policy file.** A program, tool
definition, or MCP annotation can never select, assert, or widen a class.
This is the ratchet law applied to dispatch: policy may narrow (or, per class,
pre-authorize commit for intents it already narrowed to); agent-side text can
only describe. An agent-side attempt to name a class is a typed refusal at
lowering time (see §2.4), mirroring how definitions today "cannot mint grants,
add Plan constructors, dispatch, or bypass runtime result validation"
(ARCHITECTURE.md, tool-definition paragraph; enforced at
`src/tools/Definitions.ts:481–485` for lowering kinds).

### 1.3 Admission policy v2 schema (implemented candidate seam)

> Implemented since authoring as `AdmissionPolicyV2`
> (`src/admission/Admission.ts`); evidence:
> [`docs/evidence/external-read-slice.md`](../evidence/external-read-slice.md).
> The text below is the design as proposed.

Versioned, not aliased: `schemaVersion: "airlock/admission-policy/v2"`
supersedes `"airlock/admission-policy/v1"`
(`src/admission/Admission.ts:48`). The v1 flat `endpointAllowlist` string
array is replaced by structured endpoint grants; the other v1 fields
(`profile`, `principal`, `realm`, `admittedBy`, `grantTtlMillis`,
`pathAllowlist`, `executableAllowlist`, `executableEdges`) carry over
unchanged.

```jsonc
{
  "schemaVersion": "airlock/admission-policy/v2",
  "profile": "compatibility",
  "principal": "agent:vouch-worker",
  "realm": "local",
  "admittedBy": "guilherme",
  "pathAllowlist": [],
  "executableAllowlist": [],
  "endpointGrants": [
    {
      // read-class grant: staged intent is auto-committed through
      // Outbox.commit by the supervisor policy engine, not by the agent.
      "selector": "https://status.internal.example/v1/*",
      "methods": ["GET"],
      "class": "read",
      "commit": "auto",
      "budget": { "maxDispatchesPerRun": 20, "maxBodyBytes": 0 }
    },
    {
      // mutate-class grant: staged, then committed only by an explicit
      // supervisor act; the class records the consequence judgment.
      "selector": "https://api.example/v2/tasks/*",
      "methods": ["POST", "PATCH"],
      "class": "mutate",
      "commit": "supervisor"
    },
    {
      // irreversible-send: the v1-equivalent floor.
      "selector": "https://hooks.example/notify",
      "methods": ["POST"],
      "class": "irreversible-send",
      "commit": "supervisor"
    }
  ]
}
```

Semantics:

- Admission still binds each `RequestExternal` requirement to
  `connect + emit` rights on one declared endpoint
  (`src/admission/Admission.ts:270–271`); the endpoint rights remain "not a
  socket or wire capability held by agent code" (ARCHITECTURE.md, authority
  table). The class annotates the *grant*, and the grant travels inside
  `ExecutionAuthority` exactly as today.
- `commit: "auto"` is legal **only** on `class: "read"`, and only when the
  intent's method is in the grant's `methods`. The auto-commit is performed by
  the trusted runtime after `StageExternal` durably completes
  (`src/Outbox.ts:322–391`), by calling the ordinary
  `Outbox.commit` (`src/Outbox.ts:396`): `ClaimExternal → DispatchExternal →
  AppendReceipt`, the same administrative lowering as
  `docs/contracts/plan-runtime.md:156`. Staging is never skipped; the receipt
  trail is identical to a manual commit plus a `committedBy: policy-auto`
  provenance field.
- **Class fit requires URL canonicalization.** The v1 selector match is a raw
  string prefix (`endpointAllows` `startsWith` for trailing-`*` selectors,
  `src/admission/Admission.ts:178–179, 200–204`) and `Outbox.commit` passes
  `dispatch.url` to `fetch` verbatim (`src/Outbox.ts:415`); under v1 a human
  commit mitigates the gap, but auto-commit removes that human, so the string
  match cannot be the sole load-bearing check for unattended dispatch.
  Counterexample: `https://status.internal.example/v1/../admin` (or
  query/fragment tricks) passes the prefix while fetch normalizes to a
  different resource. Before any grant fit is evaluated — and mandatorily
  before `commit: "auto"` fires — the intent URL is **canonicalized**: parsed
  as a URL, scheme and host matched exactly (lowercased; no userinfo
  permitted at all), dot-segments resolved out of the path, and the fit
  computed on the normalized path; query and fragment never participate in
  a prefix match. A URL that fails to parse or changes identity under
  canonicalization does not fit any grant. **Test obligation:** admission
  tests that `../`-, userinfo-, query-, and fragment-bearing URLs which
  string-prefix-match a `read` grant are refused auto-commit.
- Class mismatch (an intent whose method or selector does not fit any grant of
  a permitting class) is not a downgrade-and-proceed: it stays staged awaiting
  supervisor commit, or is refused at admission if no grant matches at all —
  matching today's fail-closed posture at
  `src/admission/Admission.ts:200–204` where the explicit endpoint allowlist,
  not a realm check, is the boundary.

Contract-change checklist discharge: **counterexample** — unattended
read-only polling (above); **narrow or version** — versioned (`v2` literal;
v1 documents keep decoding, no alias field); **consumers** — the policy
decoder in `src/admission/Admission.ts`, the CLI policy loader
(`AIRLOCK_POLICY_FILE` path), policy fixtures under `test/` and
`examples/`; **tests** — extend `test/admission.test.ts` with class-fit,
auto-commit-eligibility, and refusal cases, plus a construction test that
`commit: "auto"` is unreachable for `mutate`/`irreversible-send`;
**superseded surface** — `endpointAllowlist` string entries are removed from
v2 (not aliased into it).

### 1.4 What auto-commit does not change

- `Outbox.cancel` remains legal only while staged
  (`src/Outbox.ts:526–529`); an auto-committed read has the same
  no-cancellation-after-claim physics as any commit.
- A crash between claim and outcome still recovers as `uncertain`
  (`src/Outbox.ts:262–316`); a `read` class does not license automatic retry.
  Retry-on-uncertain even for reads would need separate idempotency evidence
  and is out of scope here (DESIGN.md: `uncertain` is "never collapsed …
  or automatically retried without idempotency evidence" — obligation 6,
  `docs/contracts/plan-runtime.md:194–196`).

---

## 2. Tool definition v2: external requests as inert data

### 2.1 The pre-cut seam already in the schema

The v1 schema already reserved the vocabulary for this cut:

- `ToolLoweringKind = "invoke" | "enqueue"`
  (`src/tools/Definitions.ts:83`);
- `ToolEffect = "capture" | "invoke" | "apply" | "enqueue"`
  (`src/tools/Definitions.ts:86`);
- `ArtifactTemplate` and `SecretTemplate` template values
  (`src/tools/Definitions.ts:56–64`), with the Secret comment already
  stating "resolved only during admission";
- the v1 validation gate that keeps all of it dormant:
  `"v1 definitions support only invoke lowering"`
  (`src/tools/Definitions.ts:481–485`).

Tool-definition v2 is therefore a **gate flip, not a vocabulary invention**:
the external-request lowering kind is the schema's own **`enqueue`**, and this
RFC's earlier working placeholder "request-external" is dropped in its favor.
`enqueue` says precisely what the lowering does — it produces a
`RequestExternal` Plan node whose only runtime lowering is
`StageExternal → AppendReceipt` (`docs/contracts/plan-runtime.md:151`), i.e.
it enqueues durable Outbox state and nothing else.

### 2.2 v2 action shape (implemented candidate seam)

> Implemented since authoring (`src/tools/Definitions.ts`, `v2` schema
> literal); evidence:
> [`docs/evidence/external-read-slice.md`](../evidence/external-read-slice.md).
> The text below is the design as proposed.

`schemaVersion: "airlock/tool-definition/v2"` (supersedes the `v1` literal at
`src/tools/Definitions.ts:149`). An `enqueue`-lowered action maps
Schema-validated input onto the fields of the existing `RequestExternalNode`
(`src/plan/Plan.ts:180–194`: `method`, `endpoint`, `headers`, `body` /
`bodyArtifact`, `holdMillis`) through the same finite template language used
for argv today (`Literal | Input | Artifact | Secret`,
`src/tools/Definitions.ts:66–71`):

```jsonc
{
  "schemaVersion": "airlock/tool-definition/v2",
  "id": "example.tasks",
  "version": "1.0.0",
  "executables": [],
  "actions": [
    {
      "name": "tasks.create",
      "inputSchema": { "type": "object", "properties": { "title": { "type": "string" } } },
      "lowering": "enqueue",
      "effectFootprint": ["enqueue"],
      "emissionEffect": "mutate",
      "request": {
        "method": "POST",
        "endpoint": { "_tag": "Literal", "value": "https://api.example/v2/tasks" },
        "headers": {
          "authorization": { "_tag": "Secret", "path": ["credentials", "example"] },
          "content-type": { "_tag": "Literal", "value": "application/json" }
        },
        "body": { "_tag": "Input", "path": ["title"] }
      },
      "resultDecoder": "none"
    }
  ]
}
```

Rules, in the same spirit as v1's total lowering:

- **Total or refused.** For every accepted v2 action, lowering produces an
  existing `http.stage`-shaped action (`src/actions/Catalog.ts:22`) and
  `PlanDraft`, or returns a typed rejection — exactly the v1 property
  ARCHITECTURE.md states for invoke lowering. `RequestExternal` contract
  validation stays where it is (`src/plan/Plan.ts:585` and the
  body/bodyArtifact exclusivity at `src/plan/Plan.ts:190–192`).
- **`emissionEffect` never widens — and its narrowing has a mechanism.** Its
  values `read | mutate | irreversible-send` describe what the definition
  author believes the endpoint does. Widening is impossible by construction:
  a definition claiming `read` against a grant the supervisor classed
  `mutate` fits the *grant's* class, and a definition field attempting to
  set `commit`, a dispatch class, or any grant property is a typed decode
  failure, the same posture as the v1 gate at
  `src/tools/Definitions.ts:481–485`. Narrowing is enforced at the
  auto-commit decision, not merely asserted: the policy engine computes the
  intent's **effective class** as the stricter of the grant's class and the
  originating definition's declared `emissionEffect` (ordering
  `read < mutate < irreversible-send`), and `commit: "auto"` fires only when
  the effective class is `read`. So an action honestly declaring
  `emissionEffect: "mutate"` (as in the example above) whose staged intent
  lands under a `read`-class `commit: "auto"` grant is **not**
  auto-committed — it stays staged awaiting an explicit supervisor commit.
  This is the seam T3's "definitions can restrict" clause relies on.
  **Test obligation:** a policy-engine test that a `mutate`-declaring
  action under a matching `read`/`commit: "auto"` grant remains staged, and
  that no `emissionEffect` value ever converts a `supervisor` commit into an
  auto-commit.
- **Templates never see secret bytes — the carrier is a reference, resolved
  only inside trusted staging.** The `RequestExternalNode` field a `Secret`
  template maps onto (`headers` values are plain strings,
  `src/plan/Plan.ts:186–190`) never carries credential bytes. Lowering
  emits an **opaque secret-reference placeholder** (a typed
  `airlock-secret-ref` value naming the `Secret` template's path, carrying
  no bytes) into the node field; admission validates that the reference
  names a credential the policy actually holds but performs **no
  resolution**. Resolution happens exactly once, inside the trusted
  `StageExternal` path that constructs the owner-only private dispatch
  document (`src/Outbox.ts:210–236`): the staging code substitutes the
  bytes into the private document only, so the agent-visible Plan node, the
  redacted public manifest (`src/Outbox.ts:213–231`; `src/Outbox.ts:153` is
  the redaction primitive), receipts, logs, and errors all see only the
  placeholder — discharging the existing Schema-first seam obligation
  (`docs/contracts/plan-runtime.md:204–214`, "no secret bytes in Plans,
  receipts, logs, or errors"). The current lowering already refuses to
  resolve `Artifact`/`Secret` templates in-line
  (`src/tools/Lowering.ts:264–265`); v2 keeps that refusal for any position
  where resolution would place bytes into agent-visible text, and adds a
  refusal (`ToolSecretPlacementRejected`, §2.4) for a `Secret` template in
  any field that is not carried into the private dispatch document
  (e.g. `endpoint`). **Test obligation:** a construction/behavior test that
  a staged intent lowered from a `Secret`-bearing v2 action contains no
  credential bytes in the Plan node, public manifest, or receipts, and
  that the bytes appear only in the private dispatch document.

### 2.3 MCP annotations are untrusted hints

MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
are third-party, unauthenticated descriptions. A converter that imports MCP
tool catalogs into v2 definitions may copy them into `emissionEffect` as a
*starting suggestion for the supervisor*, and nothing else. They never select
a dispatch class, never satisfy the `read`-class judgment, and never appear
in admission decisions. This is the existing doctrine — "treat an installed
binary or definition as trustworthy by existence" is a DESIGN.md non-goal —
applied to annotation metadata.

### 2.4 Typed refusals

New tagged errors, following the house pattern
(`Schema.TaggedError`, e.g. `src/tools/Definitions.ts:186–199`):

```text
ToolGrantAssertionRejected           // definition/program text tried to name or widen a class or commit mode (implemented: src/tools/Definitions.ts, `ToolGrantAssertionRejected`)
ToolSecretPlacementRejected          // Secret template targeted an agent-visible position
ToolEnqueueContractRejected          // request template cannot map totally onto RequestExternalNode
```

Contract-change checklist discharge: **counterexample** — no inert way today
to give a model a typed name for "stage this HTTP request with these bound
fields"; authors either hand-write `http.stage` calls or wrap curl via
`invoke`, losing structure; **narrow or version** — versioned (`v2` literal;
v1 documents keep decoding under the v1 gate); **consumers** — the
definition loader/validator (`src/tools/Definitions.ts`), lowering
(`src/tools/Lowering.ts`), discovery schema generation, definition fixtures;
**tests** — extend `test/tools.test.ts`, `test/tool-lowering.test.ts`,
`test/tool-definition-authority.test.ts` with enqueue-total-lowering,
secret-placement-refusal, and class-assertion-refusal cases; **superseded
surface** — the v1 "invoke-only" refusal message becomes version-scoped; no
parallel names ("request-external" never ships).

---

## 3. The EndpointProvider contract

### 3.1 The division of ownership

Airlock stays provider-neutral. No vendor tool definitions and no provider
adapters live in-tree; Airlock ships contracts, dispatch classes,
tool-definition v2, and one **fixture provider** — a local test HTTP server
used by proofs and examples only (the same posture as today's staged-HTTP
fixtures; Outbox tests exercise stage/cancel/commit without any vendor
surface). Composio, or any aggregator, appears in this document **only as an
example out-of-tree adopter** that could publish v2 definition packs and run
its own provider service; it has no privileged position.

```text
EndpointProvider owns:                Airlock owns:
  transport to the vendor API           admission and dispatch classes
  credential custody and refresh        staging (Outbox) and the single wire site
  vendor catalog -> v2 definitions      commit / cancel / uncertain physics
  vendor-side semantics and errors      receipts and redaction
```

The provider is a **counterparty behind the endpoint**, not a component
inside the trust base. From Airlock's side the entire provider surface is:
the endpoint selectors the supervisor chooses to grant
(`endpointGrants`, §1.3), the v2 definition documents the supervisor chooses
to install (inert JSON, §2), and the HTTP dispatches `Outbox.commit` performs
against it (`src/Outbox.ts:415`, `redirect: "manual"` at
`src/Outbox.ts:418`, response body cancelled rather than buffered at
`src/Outbox.ts:427`).

### 3.2 Credential boundary (candidate contract)

- Credentials never appear in program text, agent context, Plan nodes,
  receipts, logs, or errors. The mechanical basis exists today: the Outbox
  public manifest redacts URL query values, header values, and body bytes
  (`src/Outbox.ts:213–231`), the private dispatch document is owner-only, and
  the Schema seam forbids secret bytes in contract values
  (`docs/contracts/plan-runtime.md:204–214`).
- The `Secret` template (`src/tools/Definitions.ts:61–64`) is the only place
  a definition may *name* a credential, and it names a reference: admission
  validates the reference, and the bytes are substituted only inside the
  trusted staging path when the owner-only private dispatch document is
  constructed (the carrier mechanism of §2.2) — the definition, the Plan
  node, and every agent-visible artifact carry only the placeholder, never
  the bytes.
- The stronger direction remains what ARCHITECTURE.md's brokerage section
  already states: a non-extractable capability ("attach this credential only
  to this admitted destination") in preference to raw projection. That is
  design direction, not part of this RFC's candidate surface.

### 3.3 Relation to the EndpointBroker gate

DESIGN.md's endpoint-brokerage security gate applies only when contained
networking is advertised; today native Cells deny network and
`Outbox.commit` dispatches bounded HTTP itself (DESIGN.md, "Security gates";
ARCHITECTURE.md, "External intent: Outbox"). The EndpointProvider contract
does not advertise contained networking and therefore does not trigger that
gate: providers are reached by the same single supervisor-side dispatcher.
If a future EndpointBroker ships, provider endpoints become broker
destinations; the grant/class vocabulary of §1 is designed to survive that
move unchanged.

---

## 4. Linux realm claim boundary

Airlock is macOS-first; every containment, Hold, Outbox, and receipt claim in
ARCHITECTURE.md is scoped to the tested macOS envelope
(ARCHITECTURE.md, "Why macOS first"). A Linux deployment (e.g. the Docker
server available beside this host) is, in current vocabulary, a **separate
realm**, and the claim boundary is:

- **Realm is already a modeled field**, not a new concept: policies carry
  `realm` (`src/admission/Admission.ts:51`), requirements and grants carry
  realm (`src/plan/Plan.ts:63,74,85`), and admission matches requirement
  realm to policy realm for path/executable kinds
  (`src/admission/Admission.ts:185–188`) while endpoint realms deliberately
  name the remote system (`src/admission/Admission.ts:201–204`).
- **Design direction (unchanged from DESIGN.md, "Two-phase everywhere"):**
  remote machine work is a realm-scoped Plan request that the remote
  Airlock independently admits and executes. A Linux Airlock is a peer
  supervisor with its own policy file, its own Hold, its own Outbox, its own
  single wire site — not a remote adapter driven by the macOS instance's
  authority.
- **No borrowed claims.** Nothing in this RFC lets a macOS receipt speak for
  Linux execution or vice versa. Seatbelt-specific properties
  (executable-edge fencing, private APFS views) are macOS mechanisms; a Linux
  profile would need its own enforcement evidence before advertising any
  contained profile, and until then only `compatibility`-grade claims are
  honest there. Remote-realm authentication and ambiguous-result
  reconciliation remain open questions (DESIGN.md, "Open questions"), and
  this RFC does not resolve them — it only fixes that dispatch classes and
  endpoint grants are per-realm policy facts, never cross-realm defaults.

---

## 5. Theorem statements (candidate design constraints)

Each statement below is a **candidate** — a target for construction tests and
adversarial evidence, phrased so it is falsifiable. None is asserted as
currently proven beyond the cited evidence; none is a third law.

- **T1 — Complete mediation (candidate).** In the intended harness, every
  agent-originated world effect passes through an admitted Plan node or an
  authorized administrative transition; there is no alternate effect path.
  Current evidence boundary: the agent-only binary omits terminal-authority
  verbs (ARCHITECTURE.md, agent-only entrypoint), but "the external harness
  must still prove that it exposed no alternate effect tool" — mediation is
  a harness acceptance condition, not a repository theorem.

- **T2 — Admission soundness (candidate).** Every authority operand of every
  admitted node is bound to a grant the policy permits: if admission accepts
  a Plan under policy P, then each requirement matched a P selector of the
  right kind, realm, and rights (`src/admission/Admission.ts:178–204,
  270–271`), and runtime later rejects any drift between handle and retained
  grant (`src/plan/Plan.ts:727`, `src/admission/Admission.ts:688`). Under
  v2, additionally: no auto-commit occurs except under a `read`-class grant
  whose selector and method match the staged intent **after URL
  canonicalization** (normalized path with dot-segments resolved, no
  userinfo, exact scheme+host — §1.3, "Class fit requires URL
  canonicalization"), and whose effective class is not narrowed by the
  definition's declared `emissionEffect` (§2.2).

- **T3 — Ratchet monotonicity (candidate; corollary of Law 2).** Across the
  chain policy → admission → lowering → runtime, authority only narrows.
  A definition, program, or annotation can restrict how its own request is
  shaped but can never cause admission to accept what policy alone would
  refuse — including dispatch classes: for all definitions d and policies P,
  grants(P with d installed) ⊆ grants(P). The v2 typed refusals (§2.4) are
  the enforcement seam for widening attempts; the effective-class
  computation (§2.2) is the enforcement seam for the "can restrict" half.

- **T4 — Single unlink (Law 1, implemented).** `Hold.reap`
  (`src/Hold.ts:1592`) is the only irreversible unlink site in `src/`.
  Evidence: `test/hold.test.ts:726`. This RFC adds no removal path.

- **T5 — Single wire (implemented construction property).** Exactly one
  wire-capable call exists in the runtime, lexically inside `Outbox.commit`
  (`src/Outbox.ts:415`; `test/outbox-hardening.test.ts:269–279`). Under this
  RFC it must remain true verbatim: policy auto-commit is a caller of
  `Outbox.commit`, and any provider integration that would require a second
  dispatcher is thereby rejected by construction.

- **T6 — Staged-before-dispatch, always (candidate; implemented for the
  current path).** Every dispatch is preceded by a durable staged intent and
  a claim: `RequestExternal` lowers only to `StageExternal → AppendReceipt`,
  and dispatch is reachable only as `ClaimExternal → DispatchExternal`
  inside commit (`docs/contracts/plan-runtime.md:151–157`;
  `src/Outbox.ts:396–427`; stage durability at `src/Outbox.ts:322–391`).
  Auto-commit (§1.3) preserves this unconditionally: `commit: "auto"` runs
  after staging completes, never instead of it. Falsifier: any code path in
  which `DispatchExternal` executes without a durable prior `staged` state
  for the same emission id.

The compatibility carve-out stated in DESIGN.md applies to T1, T5, and T6
exactly as it does today: a compatibility child's ambient network activity is
outside the Outbox guarantee by design and is not a counterexample to these
statements, which govern Airlock-owned effects.

---

## Superseded and out of scope

- The placeholder lowering name "request-external" is superseded by the
  schema's own `enqueue` (`src/tools/Definitions.ts:83`) before ever
  shipping.
- No new Plan node kinds; extension is admission classification + tool
  definitions + out-of-tree adapters (DESIGN.md forbids informal Plan
  constructors; a fifth constructor requires the evidence bar in
  `docs/contracts/plan-runtime.md:230–234`).
- EndpointBroker, non-extractable credentials, label enforcement, and
  remote-realm transport remain the design directions and open questions
  already recorded in DESIGN.md and ARCHITECTURE.md; this RFC neither
  implements nor advertises them.
