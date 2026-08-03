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
| operating system | macOS. `package.json` declares `os: ["darwin"]`. |
| runtime | Bun 1.3.11 or newer (`engines.bun`). |
| architecture | Apple silicon or Intel; the builder targets `bun-darwin-arm64` or `bun-darwin-x64` and the published evidence must name which one ran. |
| shell tools used by examples | `/usr/bin/grep`, `/usr/bin/tr`, `/usr/bin/touch`, `/usr/bin/printf`, `/bin/sleep` — all base macOS. |

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

Linux is a **design direction, not a supported release platform**. The two host
primitives Hold, Outbox, and Ledger depend on — an atomic no-replace rename and
a recoverable exclusive lease — exist on Linux and behave as the contracts
require, and the portable suites pass in a container. That is the whole claim.

There is **no native containment on Linux**: no Seatbelt equivalent ships
in-tree, and `native-contained` refuses with `CellUnavailable` rather than
falling back to compatibility. On Linux the enclosure is the operator's
container or VM, not Airlock. No Linux release artifact is built or published.

See [`evidence/linux-beachhead.md`](evidence/linux-beachhead.md) for the exact
executed boundary and its non-claims, and
[Linux (experimental)](#linux-experimental) below for how to reproduce it.

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

`bun run verify` is the repository gate: `tsc --noEmit`, then the vitest suite,
then the four Bun/macOS boundary suites. Executed here:

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

## Linux (experimental)

Reproduce the portable-core evidence from a macOS workstation with Docker, or
run the suites directly on a Linux host:

```sh
sh scripts/prove-linux-boundary.sh     # container: proof + portable suites
sh scripts/run-linux-suites.sh         # on a Linux host: the same commands
bun scripts/prove-linux-boundary.ts    # on a Linux host: the boundary proof alone
```

`prove-linux-boundary.sh` bind-mounts the repository into `oven/bun:1.3.13` and
masks `node_modules` with a named volume, so macOS-native packages never enter
the container and the container never rewrites the host tree.
`.github/workflows/linux.yml` runs `run-linux-suites.sh` unmodified on
`ubuntu-latest`, so container and CI execute byte-identical commands. **The CI
job itself was not executed in this environment.**

Executed here (container, Apple-silicon host):

```text
airlock: linux evidence in oven/bun:1.3.13

== renameat2 + flock boundary, 16-process contention, lease recovery ==
{
  "proof": "airlock-linux-beachhead-v1",
  "ok": true,
  "assertions": {
    "renameIntoAbsentTargetSucceeded": true,
    "renameOntoLiveTargetReportedTargetExists": true,
    "liveTargetBytesPreserved": true,
    "refusedSourceBytesPreserved": true,
    "everyContenderCompleted": true,
    "contendersWereDistinctProcesses": true,
    "noIndependentOverlapObserved": true,
    "atMostOneHolderInside": true,
    "everyContenderEnteredAndExited": true,
    "leaseReclaimedAfterHolderKilled": true
  },
  "host": {
    "distribution": "Debian GNU/Linux 13 (trixie)",
    "kernelRelease": "7.0.11-orbstack-…",
    "architecture": "arm64",
    "cLibrary": "glibc 2.41",
    "bunVersion": "1.3.13",
    "proofFilesystem": "overlayfs"
  }
}

== portable suites ==
 Test Files  7 passed (7)
      Tests  54 passed | 4 skipped (58)

== partially portable suites (two fixture-limited tests excluded) ==
 Test Files  2 passed (2)
      Tests  13 passed | 2 skipped (15)
```

**What this proves.** `renameat2(RENAME_NOREPLACE)` supplies the atomic
no-replace rename and `flock(2)` supplies the recoverable exclusive lease;
sixteen independent processes contend for the lease with at most one holder
inside at any time, verified by an independent `O_EXCL` sentinel; a `SIGKILL`ed
holder's lease is reclaimed by the kernel with no release path running. The
portable suites — Hold semantics, the rename boundary and its post-rename
directory-sync recovery, cross-instance Hold serialization, Outbox hardening,
Outbox↔Ledger recovery, cancellation durability — pass on that platform.

**What this does not prove.** No containment: `native-contained` refuses on
Linux. No release: no artifact is built or published, and `os: ["darwin"]`
stands. One filesystem only (`overlayfs`); a filesystem lacking
`RENAME_NOREPLACE` gets a typed `ExclusiveRenameUnavailable`, and that path has
not been exercised against a real such filesystem. Cross-process *Runtime claim*
racing is macOS-gated and has no Linux evidence. No parity, corpus, latency, or
task-completion claim. Four tests are skipped by platform gate and two are
excluded by name — both exclusions are fixture limits documented in
[`evidence/linux-beachhead.md`](evidence/linux-beachhead.md), not Airlock
behaviour.

## What actually ran

| | |
| --- | --- |
| date | 2026-08-03 |
| host | macOS 26.5.2 (build 25F84), arm64 |
| Bun | 1.3.14 |
| binaries under test | `airlock` / `airlock-agent` 0.1.0, built and installed during this session |
| container image | `oven/bun:1.3.13` |
| not executed | `npm install --global @skastr0/airlock` (no such release), `scripts/uninstall-macos.sh`, the `ubuntu-latest` CI job |

## Next

[`usage.md`](usage.md) — the `.air` language, the action vocabulary, profiles and
policy, dispatch classes, Hold/Outbox operations, harness integration, the
corpus harness, and the failure taxonomy, each section proof-run.
