# Installing Airlock

> Every command block below was executed on the host recorded in
> [What actually ran](#what-actually-ran), except the two blocks explicitly
> marked **not executed in this environment**. Trimmed real output is shown
> wherever the output teaches something. Scratch absolute paths are written as
> `$AIRLOCK_HOME`, `$PREFIX`, and `$WORKSPACE`; those variables were bound to
> real directories in the runs.

## Requirements

| | |
| --- | --- |
| operating system | macOS or Linux. `package.json` declares both. |
| runtime | Bun 1.3.11 or newer (`engines.bun`). |
| architecture | macOS arm64/x64, or glibc Linux arm64/x64; Linux bundles are host builds. |
| native runtime | macOS Seatbelt, or the probed Bubblewrap/Landlock/seccomp prerequisites in [`linux-v1.md`](linux-v1.md). |

```sh
bun --version
sw_vers
uname -m
```

```text
1.3.14
ProductName:		macOS
ProductVersion:		26.5.2
BuildVersion:		25F84
arm64
```

### Linux status

Linux native containment and local distribution are implemented. The backend
uses Bubblewrap 0.12+, unprivileged namespaces, descriptor-pinned mounts,
Landlock ABI 2+, and libseccomp. It fails closed when any mechanism is missing
or blocked and never changes AppArmor/sysctl policy or installs privileged
helpers.

The profile is a live-write/network/direct-exec fence, not a confidentiality or
VM boundary. It permits broad read-only host access, follows Landlock object
semantics (including hardlink aliases), does not close admitted-loader or
in-process interpretation gaps, supports deny-only native network, and installs
no resource quotas. See [`linux-v1.md`](linux-v1.md) for prerequisites and
[`evidence/linux-beachhead.md`](evidence/linux-beachhead.md) for executed Debian
evidence.

## Install from npm

**Not executed in this environment** — there is nothing to install. The
registry has no `@skastr0/airlock` package:

```sh
npm view @skastr0/airlock version
```

```text
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@skastr0%2fairlock - Not found
```

When a release exists, the paired command surface installs with:

```sh
npm install --global @skastr0/airlock
airlock --version
airlock-agent actions
```

Until then, **a checkout is the only way to get Airlock**, and the only way to
get the surfaces documented in [`usage.md`](usage.md): admission-policy v2 with
dispatch-class endpoint grants, tool-definition v2, the external-read slice, and
the corpus harness. Do not read the npm block above as an available path.

## Install from a checkout

```sh
bun install
bun run verify
```

> **`bun install` rewrites `bun.lock` on a clean checkout.** The committed
> lockfile's workspace-manifest section lists all seven packages under
> `devDependencies`, while `package.json` splits four of them (`effect`,
> `@effect/cli`, `@effect/platform`, `@effect/platform-bun`) into
> `dependencies`. A plain `bun install` reconciles the lockfile to
> `package.json` and reports `Saved lockfile`; resolution is otherwise identical
> (`Checked 83 installs across 130 packages (no changes)`). Both were executed
> here. If you must not touch a tracked file, use:
>
> ```sh
> bun install --frozen-lockfile
> ```
>
> which succeeds against the committed lockfile and leaves it byte-identical.

`bun run verify` is the repository gate: `tsc --noEmit`, the complete
platform-selected Vitest suite, and explicit Bun/host-native boundary evidence.
The historical macOS run recorded below predates the Linux backend:

```text
$ tsc --noEmit
$ vitest run --testTimeout 30000 --hookTimeout 30000

 Test Files  54 passed | 1 skipped (55)
      Tests  283 passed | 16 skipped (299)
   Duration  61.33s

$ bun run scripts/verify-bun-integrations.ts
{"gate":"bun-process-runner","status":"passed","tests":11}
{"gate":"macos-native-cell","status":"passed","assertions":8}
{"gate":"macos-executable-edges","status":"passed","assertions":7}
{"gate":"macos-inprocess-boundary","status":"passed","assertions":9}
```

### Build the paired binaries

`build:macos` compiles two standalone executables, ad-hoc code-signs and
verifies each one, then writes detached SHA-256 and JSON manifests. It **never
replaces an existing artifact** — it refuses instead:

```sh
bun run build:macos
```

```text
error: refusing to replace existing artifact: /Users/…/airlock/dist/airlock
```

So either remove `dist/` first, or point the builder at a fresh directory. The
second form is what ran here:

```sh
bun scripts/build-macos.ts --out "$PREFIX/dist"
```

```text
{
  "schema_version": 1,
  "product": "airlock",
  "version": "0.1.0",
  "target": "bun-darwin-arm64",
  "executables": [
    { "name": "airlock",       "sha256": "a8fc7adc65277bb…3484ca", "bytes": 65229488 },
    { "name": "airlock-agent", "sha256": "dea572a9670ef0…b196978", "bytes": 65360816 }
  ]
}
```

Elapsed: 1 second on this host. `--target bun-darwin-x64` cross-builds, but a
release report must say which architecture actually executed the evidence.
Developer ID signing and notarization remain release-owner work; the builder
only does local ad-hoc signing.

### Install them

The installer verifies both source and copied artifacts against the checksum
manifest, probes `--version` and `doctor` on the copies, and only then displaces
a live binary. Replacement preserves prior binaries in a unique Trash
transaction directory.

```sh
AIRLOCK_TRASH_DIR="$PREFIX/trash" sh scripts/install-macos.sh \
  --source "$PREFIX/dist/airlock" \
  --prefix "$PREFIX"
```

```text
installed $PREFIX/bin/airlock
installed $PREFIX/bin/airlock-agent
sha256 a8fc7adc65277bb…3484ca  airlock
sha256 dea572a9670ef0…b196978  airlock-agent
0.1.0
0.1.0
{ …doctor report… }
```

Defaults, when you pass no flags: `--source ./dist/airlock`, sibling
`airlock-agent` and `airlock.sha256`, `--prefix $HOME/.local`, Trash at
`$HOME/.Trash`. Useful flags:

| flag | effect |
| --- | --- |
| `--prefix PATH` | absolute, non-root install prefix; installs into `PATH/bin` |
| `--replace` | preserve an existing pair in a Trash transaction, then install |
| `--skip-doctor` | do not run `airlock doctor` after installation |
| `--agent-source`, `--checksum` | override the sibling defaults |

Without `--replace`, an existing destination is a hard stop
(`destination exists; rerun with --replace`, exit 73). The prefix is validated
before any filesystem write: root, `//`, and `..`-traversal spellings are
rejected.

Then put the prefix on `PATH` and probe:

```sh
export PATH="$PREFIX/bin:$PATH"
airlock doctor
airlock-agent actions
```

`doctor` (alias: `capabilities`) reports the enforcement envelope, and
distinguishes *enforced* from merely *available*:

```json
{
  "version": "0.1.0",
  "platform": "darwin",
  "profiles": {
    "compatibility":    { "available": true,  "guarantee": "bash-parity; no containment claim" },
    "native-contained": { "available": true,  "guarantee": "native Cell: private workspace, live-workspace write denial, and opt-in network denial; not VM-equivalent" },
    "vm-enclosed":      { "available": false, "reason": "no VM backend is bundled in this runtime; a selected vm-enclosed profile must fail closed" }
  },
  "macos": {
    "schemaVersion": "airlock/macos-capabilities/v2",
    "nativeContainment": {
      "seatbelt": { "posture": "enforced", "mechanism": "/usr/bin/sandbox-exec", … },
      "privateWritableView": { "posture": "enforced", "mechanism": "APFS clone or recursive copy prepared before execution", … },
      "liveWorkspaceWriteFence": { "posture": "enforced", "mechanism": "Seatbelt deny-default + file-write grants only for private workspace and explicit temp paths", … }
    }
  }
}
```

`airlock-agent actions` returns the twelve built-in actions plus any discovered
tool definitions (`"definitions": []` on a clean install). Both commands emit
JSON only.

### Uninstall

```sh
sh scripts/uninstall-macos.sh
```

**Not executed in this environment.** It is the mirror of the installer and
preserves the removed pair in a Trash transaction rather than unlinking it.

## Dev mode

No build step. Run the entrypoints directly from the checkout:

```sh
bun run src/cli.ts doctor
bun run src/agent-cli.ts actions
bun run src/agent-cli.ts schema process.run
```

Everywhere the docs write `airlock`, `bun run src/cli.ts` is the equivalent; for
`airlock-agent`, `bun run src/agent-cli.ts`. Both forms were exercised for this
document. `bun run dev` is a shorthand for the supervisor entrypoint.

## The paired-binary model

Airlock ships **two** executables from one codebase because the authority split
is the product, not a packaging detail.

`src/agent-cli.ts` sets `AIRLOCK_AGENT_SURFACE=1` before importing the CLI, so
the reduced command graph is *constructed*, not filtered at call time. It is not
a flag an agent can turn off.

| | `airlock` (supervisor) | `airlock-agent` (harness-facing) |
| --- | --- | --- |
| run programs | `run`, `eval` | `run`, `eval` |
| pick the profile | `--profile` | **absent** — pinned by the supervisor |
| discovery | `doctor`, `capabilities`, `actions`, `schema` | same |
| read state | `held`, `pending`, `ledger`, `runs`, `run-receipt` | same |
| raw process execution | `exec` | **absent** |
| direct mutation | `write`, `rm` | **absent** |
| recovery | `undo`, `reap` | **absent** |
| dispatch | `send`, `commit`, `cancel`, `flush` | **absent** |

The omissions are structural. Asking for one is a command-graph mismatch, not a
permission error:

```sh
airlock-agent undo
```

```text
Invalid subcommand for airlock-agent - use one of 'doctor', 'capabilities', 'actions',
'schema', 'run', 'eval', 'held', 'pending', 'ledger', 'runs', 'run-receipt'
```

And `--profile` is refused before the CLI is even loaded, with exit 64:

```sh
airlock-agent run "$WORKSPACE/first.air" --profile native-contained
```

```text
airlock-agent rejects --profile; the supervisor pins the execution profile
```

### Harness wiring

Three environment variables are the whole supervisor-side configuration
surface.

**`AIRLOCK_HOME`** — the state directory: Hold store, Outbox, run journals,
locks, and installed tool definitions. Defaults to `~/.airlock`. Give each
isolated realm its own home; every command in these docs ran with an explicit
`AIRLOCK_HOME` under a scratch root.

```sh
export AIRLOCK_HOME="$PREFIX/home"
airlock-agent runs --limit 3
```

**`AIRLOCK_AGENT_PROFILE`** — pins the execution profile for
`airlock-agent run`/`eval`. Unset, compatibility remains the ratchet default.
Pinned to `native-contained`, a program that asks for a weaker Cell is refused
and performs no effect:

```sh
AIRLOCK_AGENT_PROFILE=native-contained AIRLOCK_POLICY_FILE="$WORKSPACE/policy.json" \
  airlock-agent run "$WORKSPACE/weaken.air" \
  --workspace "$WORKSPACE" --bindings "{\"workspace\":\"$WORKSPACE\"}" --compact
```

```json
"failure": {
  "action": "process.run",
  "phase": "runtime",
  "causeTag": "RuntimePlanInvalid",
  "reason": "{ \"planId\": \"program/c46df37d…/0\", \"reason\": \"Invoke program/c46df37d…/0/node/0 cannot widen native-contained runtime authority\" }"
}
```

> The refusal observed here is `RuntimePlanInvalid` from Plan validation, which
> fires before the node-level `RuntimeCapabilityDenied` check in
> `src/runtime/Runtime.ts`. [`README.md`](../README.md) and
> [`macos-v1.md`](macos-v1.md) describe this refusal as
> `RuntimeCapabilityDenied`; treat the executed tag above as the observed one.

**`AIRLOCK_POLICY_FILE`** — the supervisor-owned admission policy. It is
**required** for `native-contained` program execution and is the only way grants
enter the system; a program cannot select its own. See
[Profiles and policy](usage.md#3-profiles-and-policy) for the document shape and
the typed refusals for a missing or mismatched policy.

```sh
export AIRLOCK_POLICY_FILE="$WORKSPACE/policy.json"
```

> Today the CLI decodes **v1 policy documents only**
> (`Schema.parseJson(AdmissionPolicy)` at `src/cli.ts:392`). A
> `airlock/admission-policy/v2` document with `endpointGrants` is rejected as a
> `CliInputError` even though `Admission`, `SupervisorDispatch`, and the CLI's
> own program layer all accept the union. Dispatch-class grants are therefore
> reachable in-process only — see
> [Dispatch classes](usage.md#4-dispatch-classes-and-tool-definitions-v2).

## Linux native-contained installation

Linux requires a glibc x64/arm64 host, Landlock ABI 2+, working unprivileged user
namespaces, Bubblewrap 0.12+ without setid bits or file capabilities,
`libseccomp.so.2`, libcap's `getcap`, and GNU `cp`. Build dependencies include a
C compiler, `libseccomp-dev`, and `pkg-config`. See
[`linux-v1.md`](linux-v1.md) for the audited Bubblewrap source-build recipe and
Ubuntu AppArmor caveat.

The installer never downloads Bubblewrap, invokes privilege elevation, grants
capabilities, installs a setuid helper, or changes AppArmor/sysctl policy. A
blocked user namespace is an unavailable capability, not permission to weaken
the host.

Build a host-architecture release unit into a fresh directory:

```sh
OUT="$(mktemp -d)"
bun scripts/build-linux.ts --out "$OUT"
```

The result contains:

```text
airlock
airlock-agent
airlock-linux-launcher
airlock.sha256
airlock.manifest.json
```

Install all three executable artifacts transactionally:

```sh
sh scripts/install-linux.sh \
  --source "$OUT/airlock" \
  --agent-source "$OUT/airlock-agent" \
  --launcher-source "$OUT/airlock-linux-launcher" \
  --checksum "$OUT/airlock.sha256" \
  --bwrap /usr/local/bin/bwrap \
  --prefix "$HOME/.local"
```

Before displacement, the installer verifies SHA-256s, regular/non-setid/no-cap
metadata, Bubblewrap version, launcher Landlock/seccomp linkage, and a
production-shaped candidate `doctor`. It takes an install `flock`, requires
`bin` and `libexec` on one filesystem, and publishes the unit by rename. With
`--replace`, prior artifacts move into
`$PREFIX/libexec/airlock/replaced/install.*`; every tested rename-boundary
failure rolls the unit back.

The installed layout is:

```text
$PREFIX/bin/airlock
$PREFIX/bin/airlock-agent
$PREFIX/libexec/airlock/airlock-linux-launcher
```

The CLIs discover the launcher relative to their own installed path. Name a
nonstandard Bubblewrap with `AIRLOCK_BWRAP` or `--bwrap` during install.

```sh
export PATH="$HOME/.local/bin:$PATH"
AIRLOCK_BWRAP=/usr/local/bin/bwrap airlock doctor
airlock-agent actions
```

Uninstall preserves rather than deletes the installed unit and does not touch
Airlock state or retained Holds:

```sh
sh scripts/uninstall-linux.sh --prefix "$HOME/.local"
```

Run the complete Linux gate directly on Linux:

```sh
AIRLOCK_BWRAP=/usr/local/bin/bwrap sh scripts/run-linux-suites.sh
```

`scripts/prove-linux-boundary.sh` is only the portable rename/flock proof in an
ordinary Docker container. It deliberately does not request `--privileged` or
weaken outer AppArmor/seccomp policy for nested containment. The required
Ubuntu 22.04 CI matrix builds exact Bubblewrap 0.12.0 and runs the complete host
gate on Bun 1.3.11 and 1.3.13.

## What actually ran

The macOS command transcripts earlier in this document were recorded on macOS
26.5.2 arm64 with Bun 1.3.14 on 2026-08-03. The Linux implementation was
executed directly on 2026-09-04 in a Debian 12 x86-64 orb (Linux 6.1.158+,
glibc 2.36, Bun 1.3.11, Bubblewrap 0.12.0, Landlock ABI 2). Its native,
distribution, shared workload, and Vouch evidence is recorded in
[`evidence/linux-beachhead.md`](evidence/linux-beachhead.md).

No npm package, hosted GitHub Actions result, Developer ID/notarized macOS
artifact, or public Linux artifact is claimed here.

## Next

[`usage.md`](usage.md) — the `.air` language, the action vocabulary, profiles and
policy, dispatch classes, Hold/Outbox operations, harness integration, the
corpus harness, and the failure taxonomy, each section proof-run.
