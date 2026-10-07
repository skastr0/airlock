# Recent-capability security review — 2026-10-07

The reproduced findings below are fixed on local `main`. This pass covers the
storage-independent kernel, sessions/contracts/grants, file and Durable Object
adapters, the HTTP dispatcher and credential refusal, and the new Worker Loader
runner and Cloudflare example. Tests use synthetic canaries and local HTTP or
workerd; no production credentials, accounts or external writes were used.

Code was read starting at `99b5c8f`; the runner, facade and recovery alarm landed
during the review. The older native containment and sealed-box profiles were
not independently audited in this pass. Full verification for the final code
at `b829b8f` completed successfully; receipts are recorded below.

## Reproduced findings and fixes

| Finding | Severity | Fix |
| --- | --- | --- |
| Caller mutation changes session authority or admitted input | Critical: authority bypass | `f578aea` |
| A live permit authorizes substituted or duplicate sends; a built tool Effect runs after revocation | Critical: wire/authority bypass | `426aaf0` |
| Unexpected host exception text reaches the guest bridge | Critical: possible data exposure | `b2fe441` |
| Revocation leaves pending calls and pre-aborted bridges usable | High | `b2fe441`, runner interruption wiring `152b820` |
| Host does not independently enforce JSON depth/node limits | High | `b2fe441` |
| HTTP credential-name refusal misses SAS and other short aliases | Critical: credential persistence | `d8f73b3`, `ada5a01`, final policy `b829b8f` |

Severity describes the broken boundary. A canary reaching an error or a sealed
record demonstrates the route; it does not demonstrate a real credential leak.

### Session mutation

Claim: a session's captured policy and argument-level admission cannot be widened
through a caller-owned object. Before `f578aea`,
`src/core/session/ToolSession.ts:145-150` used Schema encode/decode as a copy;
nested `Schema.Json` objects remained shared. At `:172-211`, the decoded input
was checked against the grant before a suspension during hashing.

`bun run test test/security-tool-session.test.ts` initially gave **2 failed,
1 passed**. Mutating a nested grant `equals` value after opening the session
allowed a previously denied resource. Mutating a nested argument during hashing
staged `{resource:{bucket:"denied"}}` under the original allowed-resource grant.
That second case demonstrated incorrect staging, not an automatic send.
The private validation-error canary already passed.

The fix owns one JSON policy and input snapshot before admission and captures
run identity/hold configuration before awaits. The final suite also checks that
mutating the original run options cannot alter replay identity. Current fix:
`src/core/session/ToolSession.ts:147,176`.

Airlock-cloud separately fixed the kernel's equivalent stage snapshot in
`d6ad80b`. The conformance regression reads a changing getter once and verifies
that the later stored/sent input matches the original snapshot. Its code was
read and its memory and workerd suites were run here; the claimed pre-fix getter
failure was reported by the owner, not reproduced independently by this seat.

### Permit substitution, reuse and delayed execution

Claim: a permit authorizes one exact staged dispatch and cannot be replayed.
Before `426aaf0`, `src/host/HttpDispatcher.ts:68` checked only liveness, and
`src/core/airlock/Implement.ts:80` checked at Effect construction time.

`bun run test test/security-dispatch-permit.test.ts` initially gave **3 failed**:

- A dispatcher wrapper holding a genuine permit sent `/never-staged` and then
  `/staged` through the same HTTP handler.
- Concurrent uses of the same live HTTP permit delivered two local requests.
- A tool handler Effect built while the permit was live executed again after
  the original commit had revoked it.

The wrapper is trusted host code. Guest access to a permit was **not**
demonstrated. The permit itself nevertheless failed its stated binding and
single-use invariant.

The fix binds a private permit entry to the exact sealed canonical dispatch and
kind, atomically consumes it, and checks inside the executing Effect. The HTTP
and tool handlers own their inputs before consumption. A synchronous handler
construction throw now enters the kernel's uncertain/finalizer path. Two added
regressions check that throw and cross-kind substitution; those were added
after the fix rather than run as pre-fix attacks. Current sites:
`src/core/outbox/Outbox.ts:97,783`, `src/host/HttpDispatcher.ts:82`,
`src/core/airlock/Implement.ts:90`.

### Guest host bridge

Claim: only bounded JSON and intentional Airlock refusal sentences cross the
host boundary; revocation prevents waiting calls from continuing into staging.
Before `b2fe441`, `src/core/runner/GuestHost.ts:85` ran the host Effect without
a cancellation signal or defect redaction, `:127` returned from pre-abort before
cleanup, and parsed input lacked host depth/node checks.

`bun run test test/security-guest-bridge.test.ts` initially gave **5 failed**:

- A synthetic host defect exposed `host-canary-secret` as bridge Error.message.
- Closing the bridge while an admitted Effect waited still allowed its next
  emission step (`emissions: 1`, expected `0`).
- A pre-aborted settlement returned `aborted` but the bridge accepted another
  call (`accepted: true`, `calls: 1`).
- Input over `maxDepth: 1` or `maxNodes: 2` was accepted by the host.

The fixes pass the bridge AbortSignal into tool execution, make violations
sticky, redact unexpected defects and synchronous throws, and close on every
settlement path. A bounded own-data-property serializer checks host input,
tool replies and final guest results without invoking getters or `toJSON`.
Intentional typed tool refusals remain catchable. Current sites:
`src/core/runner/GuestHost.ts:24,116,150,154,203,229`.

Airlock-cloud supplied the companion Effect interruption wiring in `152b820`;
its code and interruption conformance were independently checked here. Tests
prove interruption before a waiting effect's next step, not recall of a request
already sent or interruption of deliberately uninterruptible host code.

`test/security-isolated-runner.test.ts`, committed as `df08c14`, additionally
checks the actual Worker Loader RPC path. A caught host defect still ends with
the fixed `execution_failed` outcome. Cache API access is blocked, and console
and unhandled-rejection canaries are absent from captured workerd stdout/stderr;
a trusted console message is the capture's positive control. These are local
workerd results, not a production logging or CPU-limit proof.

Cloudflare documents that RPC Error messages cross the boundary, so relying on
RPC to hide a host exception would not be sufficient.
[Official RPC error handling](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/).

### HTTP credential aliases

Claim: literal credentials in well-known HTTP URL/header positions are refused
before persistence. Before `d8f73b3`, the matcher at
`src/core/outbox/HttpIntent.ts:50` omitted the SAS query name `sig`.

`bun run test test/security-http-credentials.test.ts` initially gave **4 failed,
1 passed**. `sig`, `SIG` and `%73ig` were accepted; a synthetic SAS URL staged
successfully with this observed state:

```text
{state: "Success", records: 1, entries: 1, dispatches: 1, storesSignature: true}
```

The canary signature was inside the sealed canonical dispatch. No dispatch was
attempted. Azure defines `sig` as the SAS request authorization signature.
[Microsoft service SAS reference](https://learn.microsoft.com/en-us/rest/api/storageservices/create-service-sas).

Follow-up tests after the first fix gave **8 failed, 18 passed** for the remaining
whole-name aliases `pwd`, `pass`, `jwt`, `bearer`, `sas`, `code`, `assertion` and
`client_assertion`. That run reproduced matcher acceptance, not a separate
persistence experiment for each name. OAuth defines `code` in redirect queries
and JWT assertion credentials as `assertion`/`client_assertion`.
[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html),
[RFC 7523](https://www.rfc-editor.org/rfc/rfc7523.html).

The final policy in `b829b8f` refuses whole `sig`, `pwd`, `jwt`, `bearer`,
`assertion` and `client_assertion`, and query `code` alongside `state` (the OAuth
callback shape). Bare `code`, `pass` and `sas` deliberately remain usable as
ordinary data names: a generic name alone does not reliably identify a
credential, and refusing common data fields prevents legitimate staging. This
also means a credential under one of those ambiguous names can still pass.
The SAS URL signature itself remains refused as `sig`.

Matching ignores case and sees query names after the URL parser's single
percent decode. Mixed-case/percent-encoded AWS, GCP, signature, key, token and
other listed names are explicitly tested. Unrelated `design`, `signal`, `assign`,
`codepage` and `client_assertion_type` remain allowed. Tests retain all the
alias cases, distinguish ordinary data from the credential shape, and include
encoded/mixed-case OAuth callback names. Current sites:
`src/core/outbox/HttpIntent.ts:52,59`.

## Checked controls and limits

The reviewed conformance and focused tests exercise durable compare-and-set,
one winner under races, committing-before-handler ordering, cancellation,
uncertain dispatch never retried, refusing before send, recovery, replay,
compensation, corrupt records/digests, receipt recovery, response bounds and
private-input redaction. File and workerd adapters use those same kernel suites.
The Cloudflare example and crash/restart recovery alarm were read and tested;
the example explicitly gives its HTTP caller supervisor authority and requires
the owner's authentication around those routes.

The following are outside the passing local evidence:

- Production CPU enforcement, isolate termination, tail/observability settings
  and every platform built-in. `globalOutbound: null` and absent guest bindings
  were read; fetch/socket/binding/host isolation was exercised in workerd.
  [Worker Loader reference](https://developers.cloudflare.com/dynamic-workers/api-reference/).
- A storage owner rewriting all records and unkeyed digests consistently.
  Digest checks detect mismatch; they do not authenticate hostile storage.
- Generic credential discovery: HTTP matching inspects names/userinfo, not body
  content or generic tool inputs. Sealed material is plaintext. Credentials
  stay the owner's business in the outbound implementation; no secret manager
  or resolver was introduced.
- An Alchemy deployment recipe. None existed when this pass ran; its owner
  reported an outstanding package dependency decision. No deployment was run.

No security test was deleted or newly skipped in this pass. The credential
alias expectations were deliberately refined as described above; no credential
shape assertion was disabled. Two owner fixes
changed quoted guest source to avoid structural source-scan false positives;
the underlying isolation tests remain enabled.

## Validation receipts

Every implementation/test commit was preceded by a successful whole-tree
`bunx tsc --noEmit`. Focused receipts after fixes:

```text
security-tool-session + contracts + memory + facade: 61 passed, then 4/4 session regressions
permit + HTTP + core permit + memory + facade: 79 passed, then 5/5 permit regressions
guest bridge + memory + authority/core boundary: 81 passed
cloud durable + example + cloud boundary: 74 passed
all five initial security files: 32 passed
credential alias expansion + core HTTP: 29 passed
final credential policy + core HTTP: 32 passed
final security regressions across five files: 56 passed in the full run
isolated sealed-box proof after the first full-run failure: 3 passed
```

The first full verification reported a sealed-box proof failure at 10.337s,
matching its child-command timeout guard. It was interrupted before the final
failure stack, while the 200-cycle lifecycle test was still within its ten-minute
bound. A timeout due to load is an inference from that timing and the isolated
pass, not a separately captured error. This is not a passing receipt or a
deadlock finding. The second run, `VITEST_MAX_WORKERS=2 bun run verify`, finished
with exit 0: 747 tests passed, 48 existing platform skips, Bun process/native
gates passed, and core/cloud/example portability proofs passed. Its test phase
took 312.33s. The final matcher refinement landed while it was finishing, so a
third run of the same full command completed for the final code at `b829b8f`:

```text
exit 0
Test Files: 90 passed, 8 existing platform skips (98)
Tests: 750 passed, 48 existing platform skips (798)
Test duration: 283.28s
bun-process-runner: passed, 11 tests
macos-native-cell: passed, 8 assertions
macos-executable-edges: passed, 7 assertions
macos-inprocess-boundary: passed, 9 assertions
airlock-core-portable-v1: ok, hostGuardsInBundle false, staged emission committed (204)
airlock-cloud-portable-v1: ok, cloud entry + conformance Worker + example Worker bundled
```

## Next three targeted passes

1. Production Worker Loader CPU/termination and log/tail boundaries, including
   late unhandled failures and platform APIs beyond the exercised channels.
2. Cross-principal replay and supervisor routing in an authenticated host:
   namespace/session/run identifiers and how a host assigns policy to them.
3. File Ledger marker/crash combinations and settled response corruption, plus
   alarm retry behavior when storage or receipt recording is temporarily down.

These are coverage targets, not additional vulnerability findings.
