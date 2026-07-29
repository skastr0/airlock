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

The repository has two runnable Vouch-derived local proofs, ten checked-in
shell-parity workloads, bounded Hold/Outbox cross-process recovery tests, and
construction checks for the mutation and wire gateways. It does not yet have
the representative corpus, exhaustive crash/overlap matrix, or red-team
evidence needed for a strong shell-replacement claim.

## Install from npm

Published releases support macOS only and require Bun 1.3.11 or newer. Once a
release is available on npm, install the paired command surface with:

```sh
npm install --global @skastr0/airlock
airlock --version
airlock-agent actions
```

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

It preserves broad host capability and makes no containment claim.

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
failed `RuntimeCapabilityDenied` receipt and does not perform the effect.

The current program action vocabulary is generic:

- observations: `file.inspect`, `file.read`, `file.list`, `file.glob`,
  `file.stat`;
- managed mutations: `file.write`, `file.remove`, `file.move`, `file.copy`,
  `file.mkdir`;
- computation: `process.run`; and
- external intent: `http.stage`.

There are no Vouch-, archive-, SQLite-, Git-, or OpenShell-specific runtime
verbs. Existing Unix programs keep those application semantics.

Inert JSON tool definitions now execute end to end through ordinary action
lowering, Admission, Plans, Runtime, and Schema-decoded results. They improve
typed ergonomics; they do not grant authority or add Plan constructors.

## Hold and Outbox

Direct maintenance commands remain available:

```sh
airlock write ./example.txt first
airlock write ./example.txt second
airlock held
airlock undo
airlock reap --older-than 7d
```

Every managed replacement displaces the prior binding by rename. `Hold.reap`
contains the repository's only irreversible removal site. Hold and Outbox
serialize recovery transitions across processes with a bounded recoverable
exclusive-file lease. Hold journal publication stages and syncs a candidate
before promotion; startup can promote a valid staged-only journal. Those are
tested properties, not a claim that every crash point and overlapping
operation schedule has been exhausted.

```sh
airlock send https://api.example.com/hook \
  --body '{"x":1}' \
  --hold 30s
airlock pending
airlock cancel emi_...
# or:
airlock commit emi_...
```

`send` and `http.stage` create durable local intent. The only wire-capable
call is inside `Outbox.commit`. The current Outbox dispatch is bounded HTTP
with manual redirects; it is not the proposed general endpoint broker.

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
fidelity, or broad task coverage.

Five additional agent-only workloads exercise repository observation/search
and an artifact pipeline, native `sed` editing, tar round-trip, local Git,
and `make` with descendant processes. A destructive native fixture also proves
recursive removal remains Hold-backed and exactly undoable by the supervisor.

## Documentation

- [Design and the two laws](DESIGN.md)
- [Implemented architecture and design direction](ARCHITECTURE.md)
- [macOS runtime profiles](docs/macos-v1.md)
- [Plan/runtime contract](docs/contracts/plan-runtime.md)
- [Security model](docs/security-model.md)
- [v1 acceptance contract](docs/acceptance.md)
- [Vouch-first evidence](docs/vouch-first.md)
- [Feedback disposition](docs/feedback-disposition.md)

## Known gaps

Strong confidence remains unearned. The project has not yet published a
50-task shell-free corpus, repeated runs across supported macOS builds,
fault-injection at every durable transition, an exhaustive overlapping
Apply/undo/reap/commit campaign, hostile execution-closure tests, or cross-plan
information-flow and authority-laundering tests. Endpoint-broker tests become
required if contained networking is advertised. Developer ID signing,
notarization, and public artifact provenance also remain release-owner gates.
See the
[acceptance contract](docs/acceptance.md) for the claim boundary.
