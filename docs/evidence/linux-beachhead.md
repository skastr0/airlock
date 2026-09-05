# Linux native-contained evidence

> Status: executed developer-preview evidence for the Linux implementation.
> The original portable “beachhead” has been superseded: Linux now has a native
> Cell backend, distribution unit, shared workload coverage, and a required CI
> gate. The filename is retained so older links do not break.

## Tested host

The implementation was exercised directly in an Amp Debian orb on 2026-09-04:

| | |
| --- | --- |
| distribution | Debian GNU/Linux 12 (bookworm) |
| kernel | Linux 6.1.158+, x86-64 |
| C library | glibc 2.36 |
| Bun | 1.3.11 |
| Bubblewrap | upstream 0.12.0, regular mode 0755, no file capabilities |
| Bubblewrap source | tag `v0.12.0`, commit `2a76602a8c71f36c1527cf9fc3417d9149822e0c` |
| Landlock | ABI 2 |
| launcher | `airlock-linux-launcher-v1`, libseccomp filter loaded |
| proof filesystem | ext-family filesystem for `/tmp` |

Debian's packaged Bubblewrap 0.8.0 was installed but rejected as below the
runtime minimum. Upstream 0.12.0 was built without setuid mode or file
capabilities and installed at `/usr/local/bin/bwrap`. The orb also installed the
C compiler, libseccomp development/runtime files, pkg-config, Meson, Ninja,
libcap tools, and strace.

## Executed evidence

### Native adversarial suite

```sh
bun scripts/run-tests.ts test/linux-native.test.ts
```

The 13 cases passed. They establish, within this host envelope:

- rejection of Bubblewrap below 0.12.0 and of a missing launcher;
- fresh private workspace preparation;
- private `openat2` writes plus denial of source/outside `O_TRUNC` writes;
- denial of TCP and Unix sockets, socketpairs, `memfd_create`, `clone3`
  namespace creation, and `unshare`;
- acceptance of runtime-owned byte stdin while ordinary regular-file stdin is
  refused, even if the launcher's memfd flag is supplied;
- denial of an undeclared direct exec and acceptance of a declared descendant;
- required shebang-interpreter admission;
- target loader variables taking effect only after Landlock and seccomp;
- closure of backend mount descriptors before target execution, including
  absence from Bubblewrap PID 1's `/proc/1/fd` table;
- timeout teardown of a double-forked/session-changing descendant;
- fail-closed refusal of `network: allow`;
- the admitted ELF loader's ability to interpret an unlisted ELF as data,
  recorded as a limitation rather than hidden; and
- strict ELF interpreter parsing.

### Shared and Vouch-derived native workloads

The previously macOS-only Cell, CLI, Runtime, workspace-identity, execution
claim, destructive action, parity, and agent corpus tests now select the native
backend by host. GNU-specific fixture arguments and executable descendants are
explicit data rather than platform guesses.

Both Vouch-derived proofs run on Linux:

```sh
bun scripts/run-tests.ts test/vouch-e2e.test.ts \
  test/vouch-operations-e2e.test.ts
```

They execute real GNU tar restore/snapshot paths with root-scoped `/bin/sh` and
`/usr/bin/gzip` descendant authority, artifact stdin, private deltas,
Hold-backed Apply, staged Outbox intent, undo, timeout, cancellation, output
bounds, and literal argv. They do not run Vouch, OpenShell, or a remote
replacement service.

### Distribution proof

```sh
bun scripts/run-tests.ts test/linux-distribution.test.ts
```

All five distribution cases passed. The suite verifies:

- checksum- and metadata-checked three-artifact install and reversible
  uninstall;
- refusal of corrupt, old, setid, and root-aliased inputs before displacement;
- rollback after every one of the six install rename boundaries;
- rollback during uninstall displacement; and
- a real standalone glibc build, install, relative launcher discovery,
  production-shaped `doctor`, native-contained Invoke→Apply run, and uninstall.

The actual local release build produced standalone `airlock` and
`airlock-agent` executables plus the native launcher, SHA-256 list, and JSON
manifest. The installer placed the launcher under
`$PREFIX/libexec/airlock/airlock-linux-launcher`; the installed CLI discovered
it relative to itself without an override.

### Portable durability primitives

```sh
bun scripts/prove-linux-boundary.ts
```

The existing 16-process proof still exercises
`renameat2(RENAME_NOREPLACE)` and `flock(LOCK_EX | LOCK_NB)`: target collisions
preserve both byte sets, at most one independent process holds the lease, and a
lease held by a process killed with `SIGKILL` is reclaimed by the kernel.
Linux platform selection is host-owned; no program or policy can select a
weaker rename or lease adapter.

## CI gate

`.github/workflows/linux.yml` defines a required Ubuntu 22.04 matrix for Bun
1.3.11 and 1.3.13. Each job builds the exact upstream Bubblewrap 0.12.0 commit,
verifies regular non-setid/no-capability metadata, builds the Linux release
unit, requires a production-shaped candidate `doctor`, and runs
`scripts/run-linux-suites.sh`. The script runs the native boundary proof followed
by the complete `bun run verify` gate; there are no Linux behavior exclusions.

Host-policy diagnostics are reported, but the workflow does not disable
AppArmor or user-namespace policy. A denial is a failed native-containment gate,
not a skip.

## Claim boundary

The tests support the narrower contract in [`../linux-v1.md`](../linux-v1.md):
private writes, live-write denial, denied network, direct executable-object
fencing, bounded process teardown, delta/Apply separation, and the shared
Hold/Outbox/receipt physics.

They do **not** establish:

- confidentiality—the read-only host root is intentionally broadly readable;
- complete execution closure—hardlink aliases, admitted ELF loaders,
  interpreters, dynamic libraries, plugins, hooks, configuration, and
  in-process code remain meaningful;
- pathname exclusivity beyond pinned setup objects—Landlock execute authority
  follows filesystem objects;
- contained endpoint access—the Linux native profile supports deny-only
  network and has no endpoint broker;
- CPU, memory, process, disk, or I/O quotas—the cgroup namespace is not a
  resource controller;
- VM equivalence, kernel defense, administrator defense, or supply-chain
  integrity;
- all filesystems, kernel versions, Linux distributions, architectures, or
  AppArmor policies; or
- a representative model/harness shell-replacement corpus.

The two repository laws are unchanged: `Hold.reap` remains the only irreversible
managed-byte removal site, and `Outbox.commit` remains the only Airlock-owned
wire-dispatch site.
