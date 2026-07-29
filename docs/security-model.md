# Security model

> Status: current guarantee boundary plus candidate stronger contracts.
> Airlock is a reference-monitor design for agent-originated effects, not an
> intent oracle. The current native backend is a write/network fence around a
> private workspace; it is not a confidentiality sandbox.

## Trust boundary

Untrusted inputs include:

- agent program source and bindings;
- project files and instructions;
- paths, arguments, URLs, downloaded artifacts, and process output;
- tool-definition documents before decoding and admission; and
- existing executables beyond the authority deliberately granted to them.

Trusted for a particular result:

- the macOS/Bun/Seatbelt mechanisms named by the capability report;
- Airlock's Admission, Runtime, Hold, Outbox, and storage implementation;
- the supervisor that selects the profile and supplies policy;
- admitted executable and resource identities at the precision the current
  resolver actually records; and
- the harness claim that no alternate machine-effect tool was exposed.

The harness is outside this repository. If it exposes a shell, filesystem,
network, Docker, SSH, or equivalent bypass beside Airlock, a shell-free
reference-monitor claim is invalid.

## Current enforceable properties

### Structured process input

The agent-facing process seam separates the executable from argument atoms.
There is no command-string execution form in the Airlock language or Plan.
This removes shell interpolation, word splitting, and command-substitution
semantics from the orchestration boundary.

This does not make an invoked interpreter harmless. A deliberately admitted
shell, Python program, build system, package script, Git hook, or plugin may
interpret its own arguments and configuration.

### Recoverable managed changes

Supported local mutation passes through Hold. The live binding is displaced
by rename, undo checks the current binding before restoration, and
`Hold.reap` owns the only irreversible removal site.

Hold and Outbox serialize their recovery transitions through a bounded
Airlock-home exclusive-file lease. The owner record is durably published,
stale/dead owners can be reclaimed by rename, and tests exercise competing
processes and bounded lock-directory growth. Hold also stages and syncs journal
candidates before promotion and recovers a valid staged-only candidate.

The current envelope covers modeled files/directories and supported
same-volume transitions. It does not establish safety for symlinks, hardlink
topology, special files, mounts, devices, ACL/xattr fidelity, foreign writers,
live protocol state, every crash point, or every overlapping operation
schedule.

### External staging

`RequestExternal` and `http.stage` create durable local Outbox intent. The
single wire-capable call is inside `Outbox.commit`. Startup recovery converts
a stranded `committing` entry to `uncertain` rather than inventing an outcome.

Current dispatch is direct HTTP with manual redirects. It is not a contained
EndpointBroker and does not prove DNS, proxy, loopback, Unix-socket,
descriptor-passing, credential, or protocol-idempotency policy.

### Native-contained write and network fences

The native Cell:

- runs against a fresh private workspace;
- denies writes outside that workspace and declared temporary locations;
- denies network;
- fingerprints source/private state and reports a delta; and
- requires a separate, revalidated Hold-backed Apply.

The Seatbelt profile also permits:

- ambient `file-read*`; and
- `process*`, so loaders and descendant programs can run.

Therefore the implemented native profile supports a local-state integrity
claim only within its advertised delta envelope. It does **not** support a
confidentiality claim, complete execution-closure claim, or proof against all
daemonization and descendant-escape techniques.

The process runner owns a process group and now waits for same-group
descendants before reporting completion; timeout and cancellation terminate
the owned group, and output limits retain a bounded partial process receipt.
PTY, double-fork/session escape, and every daemonization technique remain
outside the proof.

### Fail-closed profile selection

Native-contained program execution requires a supervisor policy whose profile
matches the CLI profile. Missing policy or mismatched profile is refused.
VM-enclosed is refused because no backend is installed. Neither path falls
back to compatibility.

The installed `airlock-agent` binary narrows the command surface by omitting
raw exec, direct mutation, dispatch/cancel, undo/reap, and flush. This is a
useful defense-in-depth boundary. It does not prove the external harness
withheld every alternate machine-effect tool.

### Inert tool definitions

Tool definitions are decoded from JSON into a finite Schema:

- no code executes while loading;
- argument/environment/resource templates are declarative;
- artifact and secret templates cannot be resolved by pure lowering;
- executable constraints must match explicit absolute identities;
- definitions request requirements but do not grant them; and
- lowering produces existing native actions and Plan constructors.

Definition signing, provenance strength, distribution, locking, and
end-to-end program invocation remain open.

## Candidate execution-closure contract

The stronger design admits a transitive closure rather than one executable:

```text
executable + loader/shebang chain
+ dynamic libraries + environment + configuration
+ descendants + helpers + hooks + plugins
+ pagers/editors/credential helpers/lifecycle scripts
+ filesystem/endpoint/secret grants + limits + lifetime
```

That is an acceptance condition, not a current native guarantee. The present
Seatbelt profile allows process execution and ambient reads, while admission
binds the requested executable rather than mediating every later `exec` or
config lookup.

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

No such broker is installed. Native Cells deny network; compatibility
processes retain ambient host network; Outbox itself can dispatch HTTP. A
future VM may route guest egress through a broker, but that is design
direction only.

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
- every descendant, loader, config, hook, plugin, or helper path;
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
- hostile interpreter/descendant/config/descriptor tests;
- path, symlink, hardlink, mount, liveness, and metadata race tests;
- exhaustive crash and concurrency tests across Hold, Apply, Outbox, and
  Journal beyond the bounded lease/journal evidence already present;
- end-to-end labels and persistent-authority fixtures;
- endpoint-broker tests if network is advertised;
- repeated results on each published macOS/architecture combination; and
- a representative corpus rather than the current local Vouch/parity fixtures.

These are defined in the [acceptance contract](acceptance.md).
