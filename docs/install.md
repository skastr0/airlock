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
| operating system | macOS or Linux for the sandboxed CLI. The `@skastr0/airlock/core` and `@skastr0/airlock/cloudflare` libraries install anywhere. |
| runtime | Bun 1.4.0 or newer (`engines.bun`). |
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

```sh
npm install --global @skastr0/airlock
airlock --version
airlock-agent describe
```

The npm-installed commands are Bun scripts, not self-contained binaries: they
need Bun 1.4.0 or newer on `PATH`. For the compiled pair — which embeds its own
runtime and needs nothing on `PATH` — build and install from a checkout as
shown below.

## Install from a checkout

```sh
bun install
bun run verify
```

`bun run verify` is the repository gate: `tsc --noEmit`, the complete
platform-selected Vitest suite, explicit Bun/host-native boundary evidence,
and the core and Cloudflare portability proofs. A current run on this
repository (macOS 26.5.2 arm64, Bun 1.4.3):

```text
$ tsc --noEmit
$ bun scripts/run-tests.ts

 Test Files  105 passed | 5 skipped (110)
      Tests  916 passed | 42 skipped (958)
   Duration  171.81s

$ bun run scripts/verify-bun-integrations.ts
{"gate":"bun-process-runner","status":"passed","tests":11}
{"gate":"process-run-tool","status":"passed","tests":8}
{"gate":"macos-native-cell","status":"passed","assertions":8}
{"gate":"macos-executable-edges","status":"passed","assertions":7}
{"gate":"macos-inprocess-boundary","status":"passed","assertions":9}
$ bun scripts/prove-core-portable.ts
{"proof":"airlock-core-portable-v1","ok":true,"bundleBytes":1097437,
 "hostGuardsInBundle":false,"emission":{"id":"emi_7e7b41…","state":"committed","status":204}}
$ bun scripts/prove-cloudflare-portable.ts
{"proof":"airlock-cloudflare-portable-v1","ok":true,
 "bundleBytes":{"src/cloudflare/index.ts":1054814,
                "test/cloudflare/worker.ts":1191565,
                "examples/cloudflare/src/worker.ts":1060913}}
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
airlock-agent describe
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

`airlock-agent describe` lists the tools the current policy grants and how to
write a program. Both commands emit JSON only.

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
bun run src/agent-cli.ts describe
```

Everywhere the docs write `airlock`, `bun run src/cli.ts` is the equivalent; for
`airlock-agent`, `bun run src/agent-cli.ts`. `bun run dev` is a shorthand for
the person's entrypoint.

## The paired-binary model

Airlock ships **two** executables from one codebase because the authority split
is the product, not a packaging detail.

`src/agent-cli.ts` sets `AIRLOCK_AGENT_SURFACE=1` before importing the CLI, so
the agent's command graph is *constructed* without the commands that decide. It
is not a flag an agent can turn off.

| | `airlock` (person) | `airlock-agent` (agent) |
| --- | --- | --- |
| run programs | `run`, `eval`, `review`, `describe` | same |
| read state | `pending`, `inspect`, `ledger`, `doctor`, `capabilities` | same |
| decide | `approve-plan`, `commit`, `cancel`, `undo`, `reap` | **absent** |
| reviewed local changes | `change` | `change`, without the deciding subcommands |

The omissions are structural. Asking for one is a command-graph mismatch, not a
permission error:

```sh
airlock-agent undo emi_0
```

exits non-zero with an "invalid subcommand" message and prints nothing on
stdout.

### Harness wiring

Two environment variables are the whole person-side configuration.

**`AIRLOCK_HOME`** — the state directory: Hold store, recorded calls, the
ledger and locks. Defaults to `~/.airlock`. Give each isolated realm its own
home.

**`AIRLOCK_POLICY_FILE`** — the person's tool policy. Without it, a program may
read and change files in its workspace and nothing else. It is the only way
grants enter the system; a program cannot select its own. See
[The policy](usage.md#2-the-policy) for the document shape.

```sh
export AIRLOCK_HOME="$PREFIX/home"
export AIRLOCK_POLICY_FILE="$PREFIX/policy.json"
```

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
airlock-agent describe
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
gate on Bun 1.4.0 and 1.4.2.

## What actually ran

The macOS command transcripts earlier in this document were recorded on macOS
26.5.2 arm64 with Bun 1.4.3 on 2026-10-13. The Linux implementation was
executed directly on 2026-09-04 in a Debian 12 x86-64 orb (Linux 6.1.158+,
glibc 2.36, Bun 1.3.11, Bubblewrap 0.12.0, Landlock ABI 2). Its native,
distribution, shared workload, and Vouch evidence is recorded in
[`evidence/linux-beachhead.md`](evidence/linux-beachhead.md).

The npm package publishes from the `v*` tag release workflow on GitHub
Actions, with provenance attestations through npm trusted publishing.
Developer ID/notarized macOS artifacts and public Linux artifacts are not
claimed here.

## Next

[`usage.md`](usage.md) — the `.air` language, the action vocabulary, profiles and
policy, dispatch classes, Hold/Outbox operations, harness integration, the
corpus harness, and the failure taxonomy, each section proof-run.
