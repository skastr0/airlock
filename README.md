# Airlock

Airlock is a macOS-first, Unix-shaped runtime for agent-authored machine work.
It runs structured programs, routes managed local changes through recoverable
Hold transitions, stages HTTP intent in Outbox, and records receipts.

**Current maturity: usable developer preview.** Compatibility execution and
the native-contained macOS path are implemented. The native path uses a private
workspace, denies writes to the live workspace while the process runs, denies
network, derives a delta, and applies supported top-level changes through Hold.
It is not a confidentiality boundary: the current Seatbelt profile permits
ambient host reads. A VM backend is a future, stronger enclosure and is not a
macOS v1 release prerequisite.

The repository has two runnable Vouch-derived local proofs, eleven checked-in
and executed shell-parity workloads, a 50-execution agent-surface repeatability
campaign, a direct 16-process macOS proof of the shared `O_EXLOCK` lease, an
executed external-read slice against a local fixture provider, a containerized
Linux proof of the two host primitives Hold and Outbox depend on, an eight-row
model-authored corpus campaign, bounded Hold/Outbox recovery tests, and
construction checks for the mutation and wire gateways. The final integrated
gate passes 54 test files plus one skipped file, 283 tests plus 16 skipped
tests, and all four Bun/macOS boundary suites. It does not yet have the
representative corpus, exhaustive crash/overlap matrix, or red-team evidence
needed for a strong shell-replacement claim.

## Install from npm

Published releases support macOS only and require Bun 1.3.11 or newer. Once a
release is available on npm, install the paired command surface with:

```sh
npm install --global @skastr0/airlock
airlock --version
airlock-agent actions
```

No such release exists yet: the registry returns no `@skastr0/airlock` package,
so nothing published carries the dispatch-class admission policy,
tool-definition v2, or the Linux beachhead described below. A checkout is
currently the only source of those surfaces.

`airlock` is the supervisor CLI. `airlock-agent` is the reduced command
surface intended for an agent harness; use the latter when the harness is
removing direct shell authority from the agent.

## Install from a checkout

Requirements: macOS and Bun 1.3.11.

```sh
bun install
bun run verify
bun run build:macos
sh scripts/install-macos.sh
export PATH="$HOME/.local/bin:$PATH"
airlock doctor
airlock-agent actions
```

`build:macos` creates paired standalone binaries plus SHA-256 and JSON
manifests in a fresh `dist/` directory. The installer verifies, probes, and
installs the paired
`airlock` and `airlock-agent` binaries before displacing either existing
binary; `--replace` preserves prior binaries in a unique Trash transaction.
The builder applies and verifies local ad-hoc code signatures before hashing;
Developer ID signing and notarization remain release-owner work. It accepts
`--target bun-darwin-x64`, but the published evidence must say which
architecture actually ran.

For development, replace `airlock` below with `bun run src/cli.ts`.

## Run an effectful program

This example is the same native-contained shape exercised by the CLI
integration test. It requires a supervisor-owned policy file; the program
cannot select its own grants.

```sh
WORKSPACE="$(pwd)/airlock-demo"
mkdir -p "$WORKSPACE"

cat > "$WORKSPACE/create.air" <<'AIR'
return process.run({ executable: "/usr/bin/touch", args: ["created.txt"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })
AIR

cat > "$WORKSPACE/policy.json" <<EOF
{
  "schemaVersion": "airlock/admission-policy/v1",
  "profile": "native-contained",
  "principal": "agent:demo",
  "realm": "local",
  "admittedBy": "operator:demo",
  "pathAllowlist": ["$WORKSPACE/**"],
  "executableAllowlist": ["/usr/bin/touch"],
  "endpointAllowlist": []
}
EOF

AIRLOCK_POLICY_FILE="$WORKSPACE/policy.json" \
  airlock run "$WORKSPACE/create.air" \
  --workspace "$WORKSPACE" \
  --profile native-contained \
  --bindings "{\"workspace\":\"$WORKSPACE\"}"

test -f "$WORKSPACE/created.txt"
airlock held
airlock undo
test ! -e "$WORKSPACE/created.txt"
```

`airlock run` parses the program, lowers the action to `Invoke` plus
`Apply`, admits the executable and path requirements, runs the executable in a
native Cell, and merges the resulting delta through Hold. A missing policy,
profile mismatch, unavailable native mechanism, unsupported delta, or live
workspace drift is a typed refusal; it does not fall back to compatibility.

A later action or language failure returns a versioned `failed` or `partial`
program report and a nonzero exit. A partial report retains completed action
records, Plan drafts, and artifact metadata alongside the typed failure; it
does not imply rollback of earlier actions.

Compatibility is the zero-configuration profile:

```sh
airlock exec \
  --executable /bin/echo \
  --arg "hello world" \
  --cwd /tmp
```

It preserves broad Bash-like host capability and makes no containment claim.
The child process retains the invoking user's ambient filesystem, network,
configuration, descendant, and descriptor authority. Writes and sends it
performs internally are not converted into `Apply` or `RequestExternal` and
receive no Hold, Outbox, recovery, cancellation, or dispatch-uncertainty
guarantee.

## Inspect the surface

```sh
airlock doctor
airlock actions
airlock schema plan
airlock ledger
```

All CLI output is JSON. `AIRLOCK_HOME` overrides the state directory; the
default is `~/.airlock`.

`airlock` is the supervisor surface. `airlock-agent` is intentionally
narrower: it exposes program execution, schemas/capabilities, and read-only
state inspection, but omits raw exec, direct mutation, dispatch/cancel,
undo/reap, and flush. Agent `run`/`eval` has no `--profile` option; the
supervisor may pin it with `AIRLOCK_AGENT_PROFILE` (otherwise compatibility
remains the ratchet default). A program can still request structured Invoke or
Apply work, but a node that attempts to weaken the selected profile returns a
failed `RuntimePlanInvalid` receipt ("cannot widen native-contained runtime
authority") and does not perform the effect; Plan validation fires before the
node-level `RuntimeCapabilityDenied` check.

Action discovery is generated from the same Effect Schemas used to decode
native actions, so `airlock-agent schema process.run` reports the executable
contract rather than a parallel handwritten approximation. `run` and `eval`
accept `--compact` for a compact, deduplicated projection of action, Plan,
node, artifact, and failure evidence. Process output and the returned program
value remain subject to their configured limits; compact mode is not a
separate byte ceiling. `airlock-agent runs` returns ten recent run snapshots by
default; `--limit` accepts values from 1 through 100.

The current program action vocabulary is generic:

- observations: `file.inspect`, `file.read`, `file.list`, `file.glob`,
  `file.stat`;
- managed mutations: `file.write`, `file.remove`, `file.move`, `file.copy`,
  `file.mkdir`;
- computation: `process.run`; and
- external intent: `http.stage`.

There are no Vouch-, archive-, SQLite-, Git-, or OpenShell-specific runtime
verbs. Existing Unix programs keep those application semantics.

Inert JSON tool definitions execute end to end through ordinary action
lowering, Admission, Plans, Runtime, and Schema-decoded results. They improve
typed ergonomics; they do not grant authority or add Plan constructors.
`airlock/tool-definition/v1` documents are unchanged and still support only
invoke lowering. `airlock/tool-definition/v2` flips the seam the v1 schema had
already reserved: a v2 action may declare the schema's own `enqueue` lowering,
which produces a staged `RequestExternal` and nothing else. Such an action
declares an emission effect class of `read` or `mutate`; that field can only
narrow the supervisor's floor, and a definition omitting it accepts the floor.
A definition that names a commit mode is a typed `ToolGrantAssertionRejected`.

Dispatch authority is grant-side, in the supervisor's policy.
`airlock/admission-policy/v2` replaces the v1 flat `endpointAllowlist` with
structured endpoint grants; v1 documents still decode unchanged. A grant may
carry a `class` of `read`, `mutate`, or `irreversible-send` and a `commit` mode
of `auto` or `supervisor`. Both default to the strict end —
`irreversible-send` and `supervisor` — so an unclassified endpoint stays staged
exactly as under v1, and `commit: "auto"` is legal only on a `read`-class grant
with an explicit method list. No program text, Plan node, tool definition, or
third-party annotation carries this vocabulary or can select a class; agent-side
text that tries receives a typed refusal.

## Hold and Outbox

Direct maintenance commands remain available:

```sh
airlock write ./example.txt first
airlock write ./example.txt second
airlock held
airlock undo
airlock reap --older-than 7d
```

Every Airlock-owned managed replacement displaces the prior binding by rename.
`Hold.reap` contains the repository's only irreversible removal site. Hold and
Outbox serialize recovery transitions across processes with a bounded
recoverable exclusive-file lease. Hold journal publication stages and syncs a
candidate before promotion; startup can promote a valid staged-only journal.
Those are tested properties. The lock proof launches 16 independent Bun
processes, requires every contender to complete, and uses a separate kernel
`O_EXCL` sentinel plus Schema-decoded enter/exit evidence to establish maximum
simultaneous holders of exactly one. This does not claim that every Hold or
Outbox crash point and overlapping operation schedule has been exhausted.

Reap waiting remains cancellable before terminal removal authority is taken,
leaving the held act intact. Once removal begins, removal and directory sync
run as one uninterruptible terminal section. If cancellation interrupts later
Ledger publication, Hold returns typed `HoldReapRecoveryRequired` evidence
with the confirmed removal set instead of reporting a false ordinary failure.
This is bounded cancellation evidence, not proof of every Reaper crash point.

```sh
airlock send https://api.example.com/hook \
  --body '{"x":1}' \
  --hold 30s
airlock pending
airlock cancel emi_...
# or:
airlock commit emi_...
```

`send` and `http.stage` create durable local intent. For Airlock-owned
`RequestExternal` work, the only runtime wire-capable call is inside
`Outbox.commit`. Compatibility children retain ambient network and their sends
are not Outbox dispatches. The current Outbox dispatch is bounded HTTP with
manual redirects; it is not the proposed general endpoint broker.

Staged remains the default and the only outcome a program can produce. When —
and only when — a supervisor grant classes an endpoint `read` and sets
`commit: "auto"`, the trusted runtime may commit that intent inside the run by
calling the same `Outbox.commit`. Staging is never skipped, and no second
wire-capable call site is added: the auto-commit is a caller of that method, not
a second dispatcher. The receipt trail is a manual commit's plus a
`policy-auto` committing authority, the dispatch class, and the admitted grant
identity. A committed read's response body becomes a bounded artifact under a
construction constant of 65,536 bytes that no policy, endpoint, or program can
enlarge. `uncertain` physics are unchanged: a `read` class licenses no
automatic retry.

## What is proved today

On a supported macOS host, `scripts/prove-vouch.ts` executes a fixed
Vouch-derived restore plan:

- an archive is captured through an admitted path;
- `/usr/bin/tar` receives it as stdin in a native-contained Cell;
- a pre-Apply capture shows the live state was unchanged;
- the private directory delta is applied through Hold;
- a body-bearing HTTP replacement request is staged without dispatch;
- the dispatch document is owner-only (`0600`); and
- undo restores the prior directory and removes the newly introduced entry.

`scripts/prove-vouch-operations.ts` executes a second checked-in program with
12 actions and 16 Plan nodes. It covers file capture/list/glob, native mkdir,
tar snapshot/list, an artifact pipe, literal OpenShell-shaped argv, managed
copy/move/remove, staged HTTP, targeted undo, timeout, cancellation, and a
bounded-output partial process receipt.

These are local host-operation fixtures, not a real Vouch/OpenShell replacement
run. They do not prove endpoint brokerage, confidentiality, complete execution
closure, exhaustive crash recovery, concurrent multi-entry atomicity, metadata
fidelity, or broad task coverage. Both proof tests pass in the final integrated
automated gate. No repeated-run report is checked in, so the repository claims
two executed local fixtures, not campaign-level repeatability or real remote
Vouch/OpenShell replacement.

Five foundational top-level workloads exercise generic filesystem actions,
explicit process pipelines, bounded range and captured-list control, and
native-contained rewriting. Five further agent-only corpus workloads exercise
repository observation/search and an artifact pipeline, native `sed` editing,
tar round-trip, local Git, and `make` with descendant processes. An eleventh
destructive native workload proves recursive removal remains Hold-backed and
exactly undoable by the supervisor.

The repeatability proof launches the real `airlock-agent` entrypoint in 50
fresh Bun subprocesses: exactly ten deterministic scripted cases, repeated
five times each. It records 40 compatibility and 10 native-contained
successes, and the automated gate requires the cold campaign to finish within
five minutes. This is not 50 unique or model-generated tasks, a direct-shell
A/B, or a held-out corpus. See
[the exact parity evidence and claim boundary](docs/evidence/parity-50.md).

`scripts/prove-external-read.ts` composes the real Program, Admission, Runtime,
and Outbox stack against a local fixture provider on an ephemeral `127.0.0.1`
port and reports 26 passed, 0 failed on macOS. Every positive case is confirmed
by the fixture provider actually receiving the request, and every negative case
by its recording that it never did: an unclassified grant leaves the intent
staged with zero provider requests, an endpoint fitting no grant is denied
before staging, a `mutate`-classed grant leaves a POST staged, a policy
declaring `commit: "auto"` on `class: "mutate"` is `AdmissionContractInvalid`,
and a 200,000-byte response commits while retaining exactly 65,536 bytes and
reporting truncation.

That counterparty is a fixture, not a provider adapter and not a vendor
integration. Airlock ships the contracts and one fixture provider; no vendor
tool definitions and no provider adapters live in-tree. `read` is a supervisor
judgment recorded in a grant, never a discovered property of an endpoint: the
proof shows the class the supervisor wrote is the class that governed the
dispatch, not that the class was correct about the endpoint. See
[the external-read slice and its claim boundary](docs/evidence/external-read-slice.md).

`scripts/prove-linux-boundary.sh` runs an atomic no-replace rename proof and the
same 16-process contender fixture inside the official Bun container. On
`oven/bun:1.3.13` (Debian 13, arm64, glibc 2.41, container `overlayfs`) every
assertion held: 16 of 16 distinct contender processes completed, maximum
simultaneous holders was exactly one across 32 balanced events, an independent
`O_EXCL` sentinel observed zero overlaps, and the kernel reclaimed the lease
12 ms after a holder was killed with `SIGKILL`. The portable suites pass there —
7 files, 54 passed, 4 skipped — alongside 13 tests from two partially portable
suites with two cases excluded by name as documented fixture limits. Linux uses
`renameat2(RENAME_NOREPLACE)` and a `flock(2)` lease beside the BSD `O_EXLOCK`
path; selection is by host platform only, and no program, profile, or tool
definition reaches it.

Linux is not a supported release platform. No native containment profile exists
there: no Seatbelt equivalent, no private-view preparation, and no network
fence. `native-contained` refuses on Linux with `CellUnavailable` and never
falls back to compatibility, `package.json` still declares `os: ["darwin"]`, and
no Linux artifact is built or published. On Linux the enclosure is the
operator's container or VM, not Airlock. `.github/workflows/linux.yml` runs
byte-identical commands on `ubuntu-latest` and is checked in, but no hosted
runner execution is claimed: the executed evidence is the local container run.
See [the Linux beachhead evidence](docs/evidence/linux-beachhead.md).

`scripts/corpus-harness.ts` runs one candidate program against one task spec in
an isolated realm — a fresh temporary workspace and private `AIRLOCK_HOME` per
attempt — and classifies the outcome from decoded receipts and bytes on disk. A
first campaign had cold, sidechannel-only agents author programs with no
repository access: 11 attempts across eight rows, 7 of 8 rows succeeded, 6 of 8
on the first attempt. `claude-opus-5[1m]` took 4 of 4 rows first-try;
`claude-fable-5` took 3 of 4 across 7 attempts. All four failed attempts trace
to the harness result seam rather than authoring judgment: three were schema
decode of tool results, twice a missing `size` record field, and one a numeric
predicate against a string from `wc` stdout. The eight rows cover seven distinct
specs — one spec ran once per model, and `03-snapshot-stage-webhook.json` never
ran — so this is a scripted eight-task campaign, not the acceptance corpus, and
it supports no acceptance-rate, cross-machine, or other-model claim. Raw
programs are checked in under `campaign/`. See
[the campaign evidence and claim boundary](docs/evidence/model-generated-corpus-v0.md).

Every Plan Runtime execution also requires persistent run-journal storage and
claims a SHA-256-derived Plan identity with a kernel-backed `O_EXLOCK` lease
before adapter or world work. The claim remains held through the full
`running` → `finalizing` → terminal lifecycle. Concurrent acquisition,
sequential replay, or an existing recovered snapshot returns typed
`RuntimeExecutionClaimRejected`; it does not execute the Plan again.

## Documentation

- [Installation guide](docs/install.md)
- [Usage guide](docs/usage.md)
- [Design and the two laws](DESIGN.md)
- [Implemented architecture and design direction](ARCHITECTURE.md)
- [macOS runtime profiles](docs/macos-v1.md)
- [Plan/runtime contract](docs/contracts/plan-runtime.md)
- [Security model](docs/security-model.md)
- [Dispatch classes and the EndpointProvider contract](docs/rfc/dispatch-classes-and-provider-contract.md)
- [v1 acceptance contract](docs/acceptance.md)
- [Vouch-first evidence](docs/vouch-first.md)
- [Airlock Programs field guide](docs/programs/README.md)
- [50-execution agent proof](docs/evidence/parity-50.md)
- [External-read slice evidence](docs/evidence/external-read-slice.md)
- [Linux beachhead evidence](docs/evidence/linux-beachhead.md)
- [Model-generated corpus campaign v0](docs/evidence/model-generated-corpus-v0.md)
- [Feedback disposition](docs/feedback-disposition.md)

## Known gaps

Strong confidence remains unearned. Fifty repeated executions of ten scripted
cases are not the required 50 unique real tasks, and the eight-row
model-authored campaign is a scripted-task campaign rather than the acceptance
corpus. The project has not yet published that shell-free corpus, repeated runs
across supported macOS builds, fault-injection at every durable transition, an
exhaustive overlapping Apply/undo/reap/commit campaign, hostile
execution-closure tests, or cross-plan information-flow and
authority-laundering tests.

Linux has the two host primitives and the portable suites and nothing more: no
containment profile exists there, so it stays a design direction rather than a
release target. The Linux workflow is checked in but has not been exercised on
hosted GitHub runners, so the only executed Linux evidence is the local
container run. The general endpoint broker also remains a candidate rather than
an implementation: the shipped surface is bounded HTTP with manual redirects
inside `Outbox.commit` plus one fixture provider, and it owns no DNS pinning,
redirect brokering, or credential custody. Endpoint-broker tests become required
if contained networking is advertised. Developer ID signing, notarization, and
public artifact provenance also remain release-owner gates. See the
[acceptance contract](docs/acceptance.md) for the claim boundary.
