# External-read slice

> Status: **implemented candidate seam**, with the boundary stated below. It is
> evidence that one vertical slice — `RequestExternal` → staged Outbox intent →
> supervisor-policy auto-commit through the existing `Outbox.commit` → receipt
> and bounded response artifact — runs end to end against a local fixture
> provider. It is not a claim about any real provider, any vendor API, or any
> realm other than the macOS host that ran it. The two laws in
> [`DESIGN.md`](../../DESIGN.md) are untouched: this slice adds no unlink site
> and no second wire-capable call.

Design source: [`docs/rfc/dispatch-classes-and-provider-contract.md`](../rfc/dispatch-classes-and-provider-contract.md).

## Run

```sh
bun run scripts/prove-external-read.ts
```

The proof starts the fixture provider — a local HTTP server on an ephemeral
`127.0.0.1` port ([`test/support/FixtureEndpointProvider.ts`](../../test/support/FixtureEndpointProvider.ts)) —
composes the real `Program` → `Admission` → `Runtime` → `Outbox` stack against a
fresh temporary Airlock home per case, and runs Airlock programs through
`ProgramRunner`. Nothing is stubbed: every positive case is confirmed by the
fixture provider actually receiving the request, and every negative case by the
fixture provider recording that it never did.

## What ran, and what it showed

Executed on macOS (Darwin 25.5.0), Bun 1.3.14, on 2026-08-02.

```text
26 passed, 0 failed
```

| Proof | What the run observed |
| --- | --- |
| `positive/committed` | a `read`-class `commit: "auto"` grant turns a staged GET into `committed` inside the run |
| `positive/reached the provider` | the fixture provider received exactly `GET /v1/status` |
| `positive/receipt names the committing authority` | `committed_by = policy-auto` |
| `positive/receipt names the dispatch class` | `dispatch_class = read` |
| `positive/receipt names the grant identity` | `grant_id` is the admitted grant id; `grant_selector` is the policy selector verbatim |
| `positive/receipt names the actual endpoint` | canonical `scheme://host/path` actually dispatched to |
| `positive/receipt carries redacted response metadata` | `status`, `response_bytes`, `response_truncated`, `response_limit_bytes` — no body bytes |
| `positive/response body is a bounded artifact` | the program read the JSON body from the node's second artifact |
| `positive/ledger records the authority and grant` | the `commit` Ledger line carries `by=policy-auto class=read grant=…` |
| `unclassified/*` (3) | a grant with neither class nor commit leaves the intent `staged`, durably retained, with zero provider requests |
| `ungranted/*` (2) | an endpoint fitting no grant is `AdmissionDenied` before staging; zero provider requests |
| `program-class/typed refusal` | a program naming `class` in `http.stage` is a `ProgramActionDecodeFailed` |
| `definition-class/typed refusal` | a v2 definition naming `commit` is a `ToolGrantAssertionRejected` |
| `mutate-grant/*` (2) | a `mutate`-classed grant leaves a POST `staged`; zero provider requests |
| `declared-mutate/*` (2) | a definition declaring `emissionEffect: "mutate"` stays `staged` under a `read`/`commit: "auto"` grant on the same endpoint |
| `declared-read/*` (2) | the same definition's `read` action auto-commits through that same grant — so the row above is a narrowing, not a dead path |
| `auto-on-mutate/policy refused` | a policy declaring `commit: "auto"` on `class: "mutate"` is `AdmissionContractInvalid` |
| `oversized/*` (3) | a 200,000-byte response commits, retains exactly 65,536 bytes, and reports `truncated: true` |

## The claim boundary

Stated exactly, so nothing here is read wider than it ran.

- **One host, one realm.** Everything above ran on macOS against `127.0.0.1`.
  Per the RFC's realm section, a Linux Airlock is a peer supervisor with its own
  policy, Hold, Outbox, and wire site; no receipt here speaks for it.
- **One counterparty, and it is a fixture.** The provider is a local test HTTP
  server that exists so a proof has something behind an endpoint. It is not a
  provider adapter and not a vendor integration, and its behavior is not
  evidence about any real API's semantics, latency, or failure modes.
- **`read` is a supervisor judgment, never a discovery.** Airlock does not
  verify that a granted endpoint is idempotent. The proof shows that the class
  the supervisor wrote is the class that governed the dispatch — not that the
  class was correct about the endpoint.
- **No retry semantics.** `uncertain` is preserved exactly as before. A
  `read`-class grant does not license automatic retry, and none was added.
- **The bound is a construction constant.** `DISPATCH_RESPONSE_LIMIT_BYTES`
  (65,536) is not a policy knob: an endpoint cannot enlarge it and a program
  cannot request more. The oversized proof observes the bound holding; it is
  not evidence about behavior above it.
- **Redaction is unchanged, not re-proved.** This slice adds response metadata
  to the outcome and response bytes to the owner-only emission directory. The
  existing secret-redaction guarantees are the ones already covered by
  `test/outbox-hardening.test.ts`; this document does not re-claim them.

## Construction properties this slice preserves

- **Single wire site.** The only `fetch(` in `src/Outbox.ts` remains lexically
  inside `Outbox.commit`; the policy auto-commit is a *caller* of that method,
  not a second dispatcher. Guarded by `test/outbox-hardening.test.ts` ("keeps
  the single wire-capable site lexically inside `Outbox.commit`"), which passed
  in the run below.
- **Staged before dispatched, always.** The runtime reaches the commit path
  only after `Outbox.stage` has durably returned for that node. There is no
  branch in which dispatch occurs without a prior durable `staged` state.
- **Fail-closed by absence.** The runtime is handed a list of authorizations,
  never a policy. An empty list — the default, and everything a v1 policy can
  produce — means every staged intent waits for an explicit supervisor commit.
- **The class vocabulary stays in `src/admission/`.** The auto-commit decision
  lives in `src/admission/SupervisorDispatch.ts`; the value it hands out fixes
  `effectiveClass` to the literal `read`, so no consumer can construct an
  authorization for a wider class. Guarded by
  `test/admission-dispatch-classes.test.ts` ("keeps the class vocabulary out of
  every program-side module").
- **Single unlink site.** Unchanged. The response capture is written into the
  emission directory the reaper already owns; no removal path was added.

## Contract changes this slice made

Discharged against the checklist in
[`docs/contracts/plan-runtime.md`](../contracts/plan-runtime.md) (lines 224–234).

**1. `Outbox.commit` gains an optional `provenance`, and `Outbox` gains `response`.**

- *Counterexample*: a committed dispatch left no record of which authority
  committed it or under which grant, so an unattended commit and a human commit
  were indistinguishable in the receipt trail.
- *Narrow or version*: narrowed. `provenance` is optional and defaults to a
  bare `supervisor` commit, so every existing call site keeps its exact
  behavior; `response` is additive.
- *Consumers and migration*: `src/runtime/Runtime.ts` (the auto-commit caller),
  `src/cli.ts` (`airlock commit`, unchanged — records `supervisor`),
  `Outbox.flush` (unchanged), and the `Outbox` stub in
  `test/runtime-contract.test.ts`.
- *Tests*: `test/outbox.test.ts`, `test/outbox-hardening.test.ts`,
  `test/outbox-ledger-recovery.test.ts`, and this proof.
- *Superseded surface*: none. The unconditional `response.body?.cancel()` in
  `Outbox.commit` is replaced by a bounded read followed by a cancel.

**2. `OutboxOutcome` gains optional `response` and `provenance`.**

- *Counterexample*: the outcome recorded only an HTTP status, so a receipt
  could not state what was captured or under what bound.
- *Narrow or version*: narrowed, under the same
  `airlock/outbox-outcome/v1` literal. Both fields are optional, so outcome
  documents written before this change still decode.
- *Consumers and migration*: `src/Outbox.ts`, `src/program/Program.ts`
  (the `http.stage` result record), the persisted `outcome.json`.
- *Tests*: as above.
- *Superseded surface*: none.

**3. `RequestExternal` may declare a second produced artifact.**

- *Counterexample*: a committed read had nowhere to put its response, so the
  program that requested the read could not consume it.
- *Narrow or version*: narrowed. The runtime bound moved from "at most one" to
  "at most two"; slot 0 is unchanged, slot 1 is materialized only when a
  supervisor pre-authorized the commit. No new Plan node kind, no new field on
  `RequestExternalNode`.
- *Consumers and migration*: `src/runtime/Runtime.ts` (`produces` validation
  and `materializeNodeArtifact`), `src/program/Program.ts` (lowering declares
  the slot; `externalArtifactSlot` reads it and treats an absent slot 1 as the
  legal staged outcome).
- *Tests*: `test/runtime-contract.test.ts`, `test/program-live.test.ts`,
  and this proof.
- *Superseded surface*: the "at most one staged-intent artifact" message.

**4. `Runtime.execute` gains an optional third argument.**

- *Counterexample*: the runtime had no way to be told that a commit was already
  authorized, and no honest way to learn it — handing the runtime a policy would
  have made the class readable in a second place.
- *Narrow or version*: narrowed. The argument defaults to an empty list, which
  is exactly the previous behavior; a v1 policy can never produce a non-empty
  one. `RuntimeDispatchAuthorization` fixes `dispatchClass` to the literal
  `read`, so a wider authorization has no representation.
- *Consumers and migration*: `src/program/Program.ts`
  (`ProgramPlanRuntimeWithPolicyLive`; `ProgramPlanRuntimeLive` stays
  staged-only), `src/admission/SupervisorDispatch.ts` (the decision),
  runtime stubs in tests.
- *Tests*: `test/runtime-contract.test.ts`, `test/program-live.test.ts`,
  `test/admission-dispatch-classes.test.ts`, and this proof.
- *Superseded surface*: none.

## Supporting suite

```sh
bunx vitest run --testTimeout 30000 --hookTimeout 30000
```

```text
Test Files  54 passed | 1 skipped (55)
     Tests  283 passed | 16 skipped (299)
```

The repository gate (`bun run verify`: typecheck + vitest + Bun integrations)
is not reported here; this document records only the two commands above.
