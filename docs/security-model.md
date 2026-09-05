# Security model

> Status: current guarantee boundary plus candidate stronger contracts.
> Airlock is a reference-monitor design for agent-originated effects, not an
> intent oracle. The current native backend is a write/network fence around a
> private workspace; it is not a confidentiality sandbox.
>
> Only the reaper and ratchet laws in [`DESIGN.md`](../DESIGN.md) are frozen.
> The execution-closure, information-flow, two-phase, endpoint, and persistent-
> authority material below is implemented only where explicitly stated; the
> rest is candidate design or acceptance work.

## Trust boundary

Untrusted inputs include:

- agent program source and bindings;
- project files and instructions;
- paths, arguments, URLs, downloaded artifacts, and process output;
- tool-definition documents before decoding and admission; and
- existing executables and every loader/helper/configuration path not bound by
  the current contract.

Trusted for a particular result:

- the Bun and host-native mechanisms named by the active macOS or Linux
  capability report;
- Airlock's Admission, Runtime, Hold, Outbox, and storage implementation;
- the supervisor that selects the profile and supplies policy;
- admitted executable and resource identities at the precision the current
  resolver actually records; and
- the harness claim that no alternate machine-effect tool was exposed.

The harness is outside this repository. If it exposes a shell, filesystem,
network, Docker, SSH, or equivalent bypass beside Airlock, a shell-free
reference-monitor claim is invalid.

Airlock is agent-only in this threat model. It is not trying to make a human
terminal safe. A valid harness removes direct shell and peer effect tools,
exposes the reduced `airlock-agent` surface, and retains supervisor control of
profile, policy, commit, undo, and reap authority.

Security gates are profile- and claim-specific. A native profile that advertises
no contained network must deny it and need not pretend an EndpointBroker exists;
if a later profile advertises contained endpoints, confidentiality, persistent
authority safety, or complete execution closure, the corresponding broker,
label, cross-plan, or closure gates become mandatory for that claim.

## Current enforceable properties

### Structured process input

The agent-facing process seam separates the executable from argument atoms.
There is no command-string execution form in the Airlock language or Plan.
This removes shell interpolation, word splitting, and command-substitution
semantics from the orchestration boundary.

This does not make an invoked interpreter harmless. A deliberately admitted
shell, Python program, build system, package script, Git hook, or plugin may
interpret its own arguments and configuration.

### Single-use Plan execution

Before any node adapter or world operation, Runtime requires a persistent run
journal and acquires a SHA-256-derived per-Plan claim file under `.claims`. The
kernel-backed exclusive-file lease is held through the full run lifecycle.
Runtime durably publishes `running` before node execution and records
`finalizing` before Cell retention.

Concurrent contenders serialize on the claim. Once any durable snapshot
exists—including a recovered nonterminal snapshot—concurrent or sequential
reuse fails closed as `RuntimeExecutionClaimRejected`; the operation identifies
`persistent-journal-required`, `acquire`, or `replay`. Airlock does not infer
that a stranded run is safe to resume or repeat.

### Agent requests versus trusted transitions

The agent can author only the four Plan nodes:

```text
Capture | Invoke | Apply | RequestExternal
```

Admission, grant/handle binding, Plan claiming, live Hold transitions, Outbox
dispatch, pre-claim cancellation, reconciliation, undo, and reap are trusted
runtime or supervisor transitions. `RequestExternal` creates inert durable
state; `Outbox.commit` claims it before dispatch, while cancellation is legal
only before that claim. `Apply` describes a managed mutation; it is not raw
filesystem authority. Keeping these algebras distinct prevents “commit,”
“cancel,” or “reap” from becoming an accidental fifth agent primitive.

### Modeled execution authority

The integrated program path carries a Schema-validated `ExecutionAuthority`
rather than erasing admission to a bare Plan. It retains the closed Plan,
Grants, handles, exact requirement resolutions, per-node bindings,
policy/profile identity, and a closure digest.

For the fields present in Plan v1, Admission requires:

- file Capture locator `read`;
- Invoke root executable `invoke`, each declared descendant executable
  `execute`, and explicit cwd `read`;
- Apply target `write`, copy source `read`, and move source `read + write`; and
- external endpoint `connect + emit`.

The endpoint Grant admits and binds one `RequestExternal` intent. It is not a
socket or wire capability exposed to the agent. A later supervisor-authorized
commit owns the separate claim and dispatch authority.

Unused requirements, duplicate authority identities/rights, unbound modeled
operands, mutated closure data, and expired Grants are rejected with typed
errors. Runtime accepts only `ExecutionAuthority`, verifies one retained
per-node binding against the admitted handle closure, and refreshes the closure,
Grant lifetime, and handles immediately before each dependency-ready node.
Tampering or expiry becomes a failed `RuntimeAuthorityInvalid` node receipt and
no effect adapter is called. Definitions may request requirements but cannot
issue a Grant.

For native-contained work, policy binds each declared descendant to one
separately admitted root. The descendant's `execute` Grant cannot be reused to
select it as a later root Invoke. Compatibility does not enforce these edges,
because that profile deliberately preserves ambient host capability.

This is operand-complete only relative to the current Plan schema. Exact
executable edges model new exec transitions, not dynamic libraries, code
interpreted in-process, inherited configuration, plugins, descriptors,
credentials, or the semantic behavior of an admitted executable.

### Recoverable managed changes

Supported Airlock-owned local mutation passes through Hold. The live binding
is displaced by rename, undo checks the current binding before restoration,
and `Hold.reap` owns the only irreversible removal site in the runtime.
Compatibility children retain ambient host writes, so syscalls they perform
internally are not mediated as Apply and receive no Hold recovery guarantee.

Installing or restoring live managed bytes uses an Effect capability over
`renamex_np(RENAME_EXCL)` on macOS or `renameat2(RENAME_NOREPLACE)` on Linux. A
target that appears after preflight is preserved and reported as a typed
conflict; there is no fallback to an overwriting rename. Replacing rename
remains limited to publishing journal replicas, where old and new names
represent the same state record.

Native adapters reserve a journaled runtime-private Hold act before populating
candidate bytes for write/copy/move/mkdir. If population fails or is
interrupted, the stage remains enumerable and Reaper-owned rather than becoming
untracked adapter state.

Hold and Outbox serialize their recovery transitions through a bounded,
cancellable Airlock-home exclusive-file lease. The owner record is durably
published, stale/dead owners can be reclaimed by rename, and tests exercise
competing processes, interruption without stealing the live owner, and bounded
lock-directory growth. Hold also stages and syncs journal candidates before
promotion and recovers a valid staged-only candidate.

The current envelope covers modeled files/directories and supported
same-volume transitions. It does not establish safety for symlinks, hardlink
topology, special files, mounts, devices, ACL/xattr fidelity, foreign writers,
live protocol state, every crash point, or every overlapping operation
schedule.

### External staging

`RequestExternal` and `http.stage` create durable local Outbox intent. For that
Airlock-owned intent, the single runtime wire-capable call is inside
`Outbox.commit`. Commit claims the staged entry before dispatch. Startup
recovery converts a stranded `committing` entry to `uncertain` rather than
inventing an outcome. Cancel is meaningful only before the claim. Completed,
failed, and uncertain are dispatch outcomes; enqueue/stage is not itself the
external effect.

A v2 supervisor policy may pre-authorize the commit for endpoint grants it
classed `read` (`commit: "auto"`). That auto-commit is a caller of the same
`Outbox.commit` after durable staging — no second wire site, and no program or
definition can select a class. It is implemented with local fixture evidence
([`evidence/external-read-slice.md`](evidence/external-read-slice.md)), which
is not vendor or brokerage evidence.

Current dispatch is direct HTTP with manual redirects. It is not a contained
EndpointBroker and does not prove DNS, proxy, loopback, Unix-socket,
descriptor-passing, credential, or protocol-idempotency policy.
Compatibility children may use ambient host network directly; those sends are
not Outbox dispatches and receive no staging, cancellation, or uncertainty
guarantee.

### Native-contained write and network fences

The native Cell:

- receives a workspace canonicalized before admission by the trusted CLI;
- runs against a fresh private workspace;
- denies writes outside that workspace and declared temporary locations;
- denies network;
- fingerprints source/private state and reports a delta; and
- requires a separate, revalidated Hold-backed Apply; and
- transfers the exact private workspace into runtime-private Hold lifecycle on
  normal completion, typed failure, or cancellation.

For native program execution, existing absolute policy scopes are
canonicalized and the conventional `workspace` binding is replaced with the
supervisor-selected canonical directory. A symlink-ancestor alias cannot make
a lexically allowed directory grant a different physical workspace. Runtime
also checks the registered private workspace and Cell-reported directory refer
to the same device/inode before retention.

These checks close the demonstrated top-level workspace alias/substitution
paths. They do not establish general identity-safe resolution for every
resource under symlink, rename, hardlink, or mount races.

Both native backends permit ambient host reads. macOS Seatbelt grants
`process-exec` only to resolved admitted paths. Linux pins selected executable
objects and required ELF loaders into Bubblewrap, then grants Landlock EXECUTE
only to those objects; its launcher also installs seccomp before target
environment variables become active and closes descriptors above stderr.

The Cell records each executable binding's root/descendant role, requested
path, launch path, allowed paths, and whether a workspace-local executable was
rebased into the private view. Runtime carries that evidence in its process
receipt. A private per-Invoke temp directory is exported through `TMPDIR`,
`TMP`, and `TEMP`, excluded from the proposed delta, and retained with the
private workspace lifecycle.

This is a **direct executable-edge/object fence**, not complete execution
closure. Dynamic libraries load through file reads. An admitted interpreter can
execute agent-owned data in-process. Configuration and plugins can affect
behavior without a new exec. On Linux, hardlink aliases share Landlock object
authority, and an admitted ELF loader can interpret another ELF passed as data
without a second mediated exec. Linux setup objects are descriptor-pinned;
macOS external paths do not establish immutable code bytes across every
replacement race.

Therefore the implemented native profile supports a local-state integrity
claim only within its advertised delta envelope. It does **not** support a
confidentiality claim, complete execution-closure claim, or proof against all
daemonization and descendant-escape techniques.

Adversarial tests make the distinction observable. On macOS, an admitted
`/bin/bash` sources agent-owned `BASH_ENV` in-process while Seatbelt still
confines writes and loopback. On Linux, an admitted ELF loader interprets an
unlisted ELF while the resulting mutation remains in the private view. These
are successful boundary proofs, not hidden failures.

The process runner waits for its owned process group; Linux additionally uses
Bubblewrap as PID-namespace init with parent-death teardown, and the adversarial
suite covers a double-forked session on timeout. Output limits retain bounded
partial receipts. No backend proves every daemonization technique, and neither
installs CPU, memory, process-count, disk, or I/O quotas.

Runtime-private Hold acts are excluded from ordinary undo and can be discarded
only by Reaper. The normal finalizer never prefix-sweeps neighboring paths.
Retention failure is surfaced in the run result. A process crash before
registration/finalization can still leave a private tree outside this lifecycle
and requires future startup reconciliation. Held trees also consume storage
until the supervisor reaps them.

### Fail-closed profile selection

Native-contained program execution requires a supervisor policy whose profile
matches the CLI profile. Missing policy or mismatched profile is refused.
VM-enclosed is refused because no backend is installed. Neither path falls
back to compatibility.

The installed `airlock-agent` binary narrows the command surface by omitting
raw exec, direct mutation, dispatch/cancel, undo/reap, and flush. This is a
useful defense-in-depth boundary. It also removes the agent-controlled profile
option: the supervisor pins `AIRLOCK_AGENT_PROFILE`, and a structured node
that asks for a weaker profile receives a failed `RuntimeCapabilityDenied`
receipt without performing the effect. It does not prove the external harness
withheld every alternate machine-effect tool.

### Inert tool definitions

Tool definitions are decoded from JSON into a finite Schema:

- no code executes while loading;
- v1 accepts exactly one absolute executable and only `invoke` lowering;
- v2 adds `enqueue` actions that lower onto the staged
  `RequestExternal`/`http.stage` seam, must declare an `emissionEffect` that
  can only narrow a grant's supervisor-side dispatch class, and are refused
  with a typed `ToolGrantAssertionRejected` if any definition text names
  grant-side class or commit vocabulary;
- argument/environment/resource templates and result decoders are
  declarative;
- unsupported artifact/secret template forms are rejected rather than
  partially interpreted;
- executable constraints match explicit absolute identities;
- definitions request requirements but do not grant them; and
- every accepted action lowers totally to the existing Plan constructors — a
  structured Invoke action for v1 `invoke`, a staged `http.stage` intent for
  v2 `enqueue` — or returns a typed error.

Accepted definitions execute end to end through the same program, Admission,
ExecutionAuthority, Runtime, and output Schema validation as native actions.
Their digests are bound into the request and Plan. They cannot add an effect
class, dispatch, or mint authority.

Definition signing, provenance strength, distribution locking, richer
execution-closure contracts, and whether future versions need compositions of
the existing Plan nodes remain open.

## Candidate execution-closure contract

The stronger design admits a transitive closure rather than one executable:

```text
root/image identity
+ executable + loader/shebang chain
+ dynamic libraries + environment + configuration
+ descendants + helpers + hooks + plugins
+ pagers/editors/credential helpers/lifecycle scripts
+ filesystem/endpoint/stream/artifact/credential grants
+ limits + lifetime + cancellation + receipt obligations
```

That is an acceptance condition, not a current native guarantee. The present
Seatbelt and Landlock mechanisms fence declared root/descendant direct execs and
permit ambient reads. They do not mediate dynamic-library or config reads, code
interpreted within an admitted process, every plugin callback, mutable
executable bytes, hardlink aliases on Linux, or every descendant-lifetime
escape.

Airlock intentionally does not replace or semantically verify the program:
`tar`, `git`, compilers, package managers, and interpreters retain their
algorithms. A complete execution closure constrains what the opaque program can
observe and affect; it does not prove that its application-level result matches
the agent's intent.

A future VM backend may contain unknown guest execution behind stronger host
seams. No VM backend exists today.

## Information labels

Airlock contains a pure, Schema-first candidate label component:

```text
Confidentiality = public < project < private < secret
Integrity       = untrusted < project < operator < runtime
```

Implemented module properties:

- combining inputs raises confidentiality to the maximum;
- combining inputs lowers integrity to the minimum;
- ordinary derivation preserves those conservative directions;
- sink checks enforce a confidentiality ceiling and integrity floor;
- declassification requires a scoped, unexpired supervisor capability for one
  exact lower target; and
- endorsement requires a distinct capability for one exact higher target.

The component produces typed transition receipts. It does not issue, sign,
revoke, persist, or authenticate capabilities, and the current Plan/Runtime/
Outbox path does not propagate or enforce labels end to end. It therefore
cannot yet prevent secret exfiltration or cross-plan integrity laundering.

The two combinations the stronger admission model must make explicit are:

```text
confidential read + external write
untrusted write    + later trusted execution/config/policy use
```

A conservative node/artifact label is a plausible first implementation; the
design does not presume complete per-byte taint tracking. Declassification
(lowering confidentiality) and endorsement (raising integrity) remain separate
supervisor acts.

Giving raw secret bytes to an executable would be disclosure, not
declassification. Non-extractable credential capabilities are design
direction, not current behavior.

## Persistent authority laundering

The design must account for time-separated authority:

```text
low-authority work writes hook/config/executable
  → later stronger work consumes those bytes
  → persisted untrusted bytes exercise new authority
```

Relevant resources include executable/search paths, definitions, policies,
hooks, plugins, build/package scripts, SCM/tool configuration, credential
helpers, launch agents, trust stores, and grant sources.

Admission of one Plan cannot discover this time-separated flow merely by
checking that Plan's requirements. Candidate controls include execution-
adjacent resource classes, config-neutralizing tool contracts, persistent
provenance/integrity, explicit endorsement before later trusted use, and
immutable execution roots. These are design directions to test against hostile
workloads, not frozen invariants.

The current repository has label types and admission provenance, but it does
not yet classify and enforce all of these resources across runs. Prevention
of persistent authority laundering is an acceptance gate, not an implemented
claim.

## Endpoint brokerage

The stronger candidate contract gives contained code no ambient host network
or host Unix socket. An Outbox commit would create a bounded lease containing:

```text
intent and Plan identity
destination and protocol class
DNS/redirect/proxy/loopback policy
connection, byte, and time budgets
confidentiality release ceiling
expiry and revocation
```

The broker would receipt actual destinations and reject authority import such
as unmodeled file descriptors over Unix sockets.

For high-value credentials, the preferred companion is a non-extractable
credential capability: authorize a specific signature, request, destination,
or single-use exchange without projecting the underlying secret bytes into the
Cell. Raw projection cannot provide a non-leakage guarantee after an opaque
executable receives the bytes.

No such broker is installed. Native Cells deny network; compatibility
processes retain ambient host network; Outbox itself can dispatch HTTP. The
implemented dispatch-class slice — supervisor-classed endpoint grants whose
`read`-class `commit: "auto"` entries auto-commit staged intents through the
existing `Outbox.commit`, with local fixture evidence — preserves the single
dispatch site and is not a broker: DNS, redirect, proxy, loopback, budget, and
credential authority remain unowned. A future VM may route guest egress
through a broker, but endpoint and credential brokerage are design direction
only.

## Two-phase local and external work

The architecture separates:

```text
private process work → proposed delta → Hold-backed Apply
staged external intent → privileged Outbox commit → external outcome
```

A native process never receives both live-workspace write authority and
network authority in the current path because it receives neither live writes
nor network. This is narrower than the general “two doors” candidate, which
would allow brokered network while still withholding live mutation.

The phases are not atomic together. If an eventual external action succeeds
and a later local Apply fails, the honest result must say both.

## Honest limits

Airlock does not currently protect against:

- kernel, administrator, physical, or supply-chain compromise;
- a harness bypass;
- deliberate broad authority in compatibility;
- confidential host reads by native-contained code;
- malicious semantics inside an admitted executable;
- dynamic libraries, in-process interpretation, config/plugin behavior, and
  every descendant-lifetime escape beyond the exact executable-edge fence;
- general resource identity races beyond the canonical native workspace
  binding, including mutable external executable bytes;
- native Cell trees stranded by an uncatchable crash before lifecycle
  finalization;
- resource exhaustion beyond the published limits;
- unsupported filesystems, metadata, devices, or live state;
- external consequences after dispatch;
- duplicate effects in protocols without idempotency;
- cross-plan authority laundering; or
- label-policy gaps outside the pure candidate module.

If dispatch may have occurred, the result is `uncertain`. If a managed
resource falls outside Hold's established envelope, the runtime must refuse it
or publish an explicitly weaker contract. Neither case may be rounded into a
strong security claim.

## Evidence required for stronger claims

Before claiming more than the current narrow envelope, the project needs:

- complete shell-free harness mediation evidence;
- hostile interpreter/descendant/config/descriptor tests, including cases
  that succeed in-process but must remain inside the published resource fence;
- path, symlink, hardlink, mount, liveness, and metadata race tests;
- exhaustive crash and concurrency tests across Hold, Apply, Outbox, and
  Journal beyond the bounded lease/journal evidence already present;
- end-to-end labels and persistent-authority fixtures;
- endpoint-broker tests if network is advertised;
- repeated results on each published platform/architecture combination; and
- a representative model/harness corpus rather than the current local
  Vouch/parity fixtures.

The checked-in 72-case Unix contract corpus is useful schema/lowering/
admission coverage, not security evidence: it executes no task and measures no
model or harness. The ten executed parity workloads and Vouch-derived proofs
exercise real paths, but they are still short of the frozen 50-task corpus,
direct-shell baseline, and hostile campaigns required by the acceptance
contract.

These are defined in the [acceptance contract](acceptance.md).
