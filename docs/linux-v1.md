# Linux native-contained runtime contract

> Status: implemented developer-preview envelope. Compatibility and
> native-contained run on supported Linux hosts. VM enclosure is not
> implemented. This document describes the mechanisms the current code probes
> and the narrower guarantees they support.

## Profiles

Airlock uses the same Plan, Admission, Runtime, Hold, Outbox, and receipt
contracts on Linux and macOS:

- `compatibility` is the zero-configuration default. It runs a structured
  executable-plus-argv request with the invoking user's ambient authority and
  makes no containment claim.
- `native-contained` is opt-in and requires a matching supervisor policy. It
  runs in a private workspace, denies writes to the live host view, denies
  network, fences direct executable objects, reports a delta, and leaves live
  mutation to a separate Hold-backed Apply.
- `vm-enclosed` is unavailable and fails closed.

A missing or blocked Linux mechanism returns an unavailable capability. Airlock
never downgrades a selected native-contained run to compatibility.

## Supported build and runtime envelope

The Linux bundle is built on and for one glibc host architecture:

- x86-64: `bun-linux-x64`;
- arm64: `bun-linux-arm64`;
- Bun 1.3.11 or newer; and
- an unprivileged Linux host with Landlock ABI 2 or newer.

The native launcher is compiled for the build host, so `build:linux` rejects a
mixed-architecture cross-build. Build once on each architecture. Musl builds,
32-bit architectures, privileged/root operation, and non-Linux kernels are
outside this envelope.

Native-contained additionally requires:

- Bubblewrap 0.12.0 or newer as a regular executable with no setuid/setgid bits
  and no file capabilities;
- enabled unprivileged user namespaces;
- `libseccomp.so.2` at launcher runtime;
- libcap's `getcap` utility so Airlock can fail closed on helper file
  capabilities; and
- `/bin/cp` with GNU `--archive --reflink=auto` for private workspace creation.

Bubblewrap is an audited external prerequisite, not bundled into the Airlock
release unit. Version 0.12.0 is the minimum because it contains the relevant
setup-race fixes and intentionally no longer supports setuid installation.
Never pass `--not-a-security-boundary`, install a setuid helper, or add file
capabilities for Airlock.

Ubuntu 24.04 and other AppArmor configurations may deny unprivileged user
namespace creation. `airlock doctor` reports that as unavailable. Do not
silently disable AppArmor, change a global sysctl, or privilege Bubblewrap to
make the probe pass; use an approved host policy or a host where the required
primitive is available.

## Build and install

Install build/runtime packages using the host's package policy. On Debian or
Ubuntu the required package set is:

```sh
sudo apt-get install --no-install-recommends \
  build-essential libseccomp-dev libseccomp2 pkg-config \
  libcap2-bin meson ninja-build git
```

Debian 12's packaged Bubblewrap is older than Airlock's minimum. One
reproducible 0.12.0 source build is:

```sh
git clone --depth 1 --branch v0.12.0 \
  https://github.com/containers/bubblewrap.git /tmp/bubblewrap

test "$(git -C /tmp/bubblewrap rev-parse HEAD)" = \
  2a76602a8c71f36c1527cf9fc3417d9149822e0c

meson setup /tmp/bubblewrap/_build /tmp/bubblewrap \
  -Dselinux=disabled -Dman=disabled -Dtests=false
meson compile -C /tmp/bubblewrap/_build
sudo install -m 0755 /tmp/bubblewrap/_build/bwrap /usr/local/bin/bwrap

test ! -u /usr/local/bin/bwrap
test ! -g /usr/local/bin/bwrap
test -z "$(/sbin/getcap /usr/local/bin/bwrap)"
test "$(/usr/local/bin/bwrap --version)" = "bubblewrap 0.12.0"
```

Airlock's installer never performs those privileged steps itself. Build into a
fresh output directory, then install the three verified artifacts:

```sh
bun install --frozen-lockfile
OUT="$(mktemp -d)"
bun scripts/build-linux.ts --out "$OUT"

sh scripts/install-linux.sh \
  --source "$OUT/airlock" \
  --agent-source "$OUT/airlock-agent" \
  --launcher-source "$OUT/airlock-linux-launcher" \
  --checksum "$OUT/airlock.sha256" \
  --bwrap /usr/local/bin/bwrap \
  --prefix "$HOME/.local"

export PATH="$HOME/.local/bin:$PATH"
AIRLOCK_BWRAP=/usr/local/bin/bwrap airlock doctor
```

The build emits `airlock`, `airlock-agent`,
`airlock-linux-launcher`, `airlock.sha256`, and
`airlock.manifest.json`. The installer verifies checksums and metadata, probes
the launcher and Bubblewrap, runs the candidate `doctor`, and then publishes
all three executables by rename under one install lock. Replacement preserves
prior artifacts in `$PREFIX/libexec/airlock/replaced/install.*`; a failed
boundary rolls the complete unit back.

Uninstall is reversible and does not touch Airlock state or Holds:

```sh
sh scripts/uninstall-linux.sh --prefix "$HOME/.local"
```

It moves the installed unit into a preserved `replaced/uninstall.*`
transaction.

## Native mechanism

For each native-contained Invoke, Airlock:

1. canonicalizes and fingerprints the source workspace;
2. creates a fresh private clone-or-copy with GNU `cp`;
3. opens the source, private tree, temp paths, launcher, admitted executables,
   and required ELF loaders with `O_PATH | O_NOFOLLOW` and pins those objects
   into Bubblewrap with `--bind-fd`/`--ro-bind-fd`;
4. starts Bubblewrap with empty environment and unshared user, mount, PID,
   network, IPC, UTS, and cgroup namespaces, a new session, parent-death
   teardown, all capabilities dropped, a read-only host root, and fresh `/proc`
   and `/dev` mounts;
5. starts Airlock's small native launcher with no target environment;
6. validates stdio, installs a Landlock EXECUTE+REFER ruleset for the admitted
   executable objects, installs a libseccomp filter, closes every descriptor
   above stderr, materializes the target environment, and calls `execve`;
7. waits for the Bubblewrap-owned PID namespace/process group to disappear;
8. fingerprints live and private trees and returns delta and drift evidence;
   and
9. applies an admitted supported delta only through Hold.

Explicit text or artifact stdin is runtime-owned authority. Bun 1.3 materializes
those bytes in an anonymous memfd, so the backend emits a narrow launcher flag
and the launcher requires `F_GET_SEALS` to identify that fd. A regular
filesystem file on stdin is rejected even with the flag; inherited stdin,
stdout, and stderr are rejected by Cell before launch. Captured stdout/stderr
use runtime-owned socketpairs. Bubblewrap closes every consumed bind source
before it forks the namespace's PID 1, and the launcher closes any descriptor
remaining above stderr before the target starts.

The seccomp filter denies socket creation and use, `memfd_create`, `execveat`,
namespace/mount mutation, ptrace and cross-process memory calls, key/BPF/module
control, `io_uring`, and namespace-bearing `clone` flags. `clone3` returns
`ENOSYS` so ordinary libraries can take their legacy clone fallback, whose
namespace flags are argument-filtered.

## Exact guarantee boundary

### Writes and Apply

The host root is mounted read-only and only the private workspace and declared
temporary paths are writable. A target process cannot write the source
workspace or another ordinary host path through normal filesystem operations.
Foreign host writers remain possible; Airlock detects source drift before
Apply. The current merge envelope is top-level regular files and directories,
installed or displaced through Hold. Multi-entry Apply is individually
recoverable, not one atomic transaction.

### Reads and confidentiality

The read-only host root remains broadly readable to preserve ordinary loader
and Unix-tool behavior. Native-contained is therefore **not a confidentiality
boundary**. It does not hide home-directory secrets, configuration, repository
content outside the workspace, or other files readable by the Airlock user.
Use a separate VM or machine boundary when confidential host reads matter.

### Executable objects, not complete code closure

Landlock mediates filesystem objects reached by direct `execve`; it does not
turn path strings into immutable source-code identities. Consequences:

- hardlinks to an admitted inode share that object's execute authority;
- a pinned executable mount prevents replacement of the selected object during
  setup, but the policy is still object-oriented rather than a universal
  pathname theorem;
- every ELF interpreter required by an admitted ELF is admitted too;
- an admitted ELF loader can interpret another ELF passed as data without a
  second mediated exec;
- admitted shells, language interpreters, dynamic loaders, plugins, hooks,
  configuration, and libraries can execute or interpret code in-process; and
- `LD_PRELOAD` and related target variables become active only after Landlock
  and seccomp are installed, but their in-process behavior is not an executable
  edge.

Accordingly, the advertised property is a **direct executable-object fence**,
not complete execution closure or proof that an admitted executable is benign.
Policies must list known descendant execs and matching root-scoped
`executableEdges`; complex tools such as GNU tar may require `/bin/sh` and
`/usr/bin/gzip` descendants.

### Network and resources

Linux native-contained supports `network: deny` only. It has no contained
endpoint broker. The network namespace plus syscall filter covers TCP, UDP,
loopback, Unix sockets, netlink, and new socketpairs; inherited descriptors are
not an escape because Cell rejects inherited stdio and the launcher closes
other fds. Outbox remains the separate trusted HTTP staging/commit path.

The cgroup namespace changes visibility but installs no cgroup limits. Airlock
does not currently bound CPU, memory, process count, disk space, or general I/O
consumption. Process timeout, cancellation, and captured-output limits are the
only relevant bounds; resource-exhaustion resistance is not claimed.

## Probe and verification

`airlock doctor` and `airlock capabilities` emit
`airlock/linux-capabilities/v1`. A usable report includes a `runtime` object
naming the exact Bubblewrap and launcher paths, Bubblewrap version, and Landlock
ABI. Absence of that object means native-contained is unavailable; the report's
caveats explain why.

Run the complete Linux gate on a Linux host:

```sh
AIRLOCK_BWRAP=/usr/local/bin/bwrap sh scripts/run-linux-suites.sh
```

That runs the rename/flock boundary proof and `bun run verify`, including a
fresh launcher build, adversarial native tests, shared native workloads,
standalone build/install/discovery/execution/uninstall, and Bun subprocess
evidence. `.github/workflows/linux.yml` repeats the gate on Ubuntu 22.04 with
Bun 1.3.11 and 1.3.13 and builds the exact Bubblewrap 0.12.0 commit above.

`scripts/prove-linux-boundary.sh` is intentionally narrower: it proves only the
portable rename/flock primitives in an ordinary Docker container. It does not
request a privileged container or weaken outer Docker/AppArmor/seccomp policy
to manufacture nested native-containment evidence.
