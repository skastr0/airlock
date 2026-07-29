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

The repository has one runnable Vouch-derived proof, unit and integration
coverage, and construction checks for the two destructive gateways. It does
not yet have the representative corpus, crash matrix, or red-team evidence
needed for a strong shell-replacement claim.

## Install from a checkout

Requirements: macOS and Bun 1.3.11.

```sh
bun install
bun run verify
bun run build:macos
sh scripts/install-macos.sh
export PATH="$HOME/.local/bin:$PATH"
airlock doctor
```

`build:macos` creates a standalone binary plus a SHA-256 manifest in a fresh
`dist/` directory. The installer verifies the checksum and refuses to replace
an existing binary unless `--replace` is supplied. The builder accepts
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

The current program action vocabulary is generic:

- observations: `file.inspect`, `file.read`, `file.list`, `file.glob`,
  `file.stat`;
- managed mutations: `file.write`, `file.remove`, `file.move`, `file.copy`,
  `file.mkdir`;
- computation: `process.run`; and
- external intent: `http.stage`.

There are no Vouch-, archive-, SQLite-, Git-, or OpenShell-specific runtime
verbs. Existing Unix programs keep those application semantics.

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
contains the repository's only irreversible removal site.

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

This is one local fixture, not a real Vouch/OpenShell replacement run. It does
not prove endpoint brokerage, confidentiality, complete execution closure,
crash recovery, concurrent multi-entry atomicity, metadata fidelity, or broad
task coverage.

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
fault-injection at every durable transition, concurrent Apply/commit evidence,
hostile execution-closure tests, endpoint-broker tests, or cross-plan
information-flow and authority-laundering tests. See the
[acceptance contract](docs/acceptance.md) for the claim boundary.
