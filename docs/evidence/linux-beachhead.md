# Linux beachhead

> Status: bounded platform-primitive evidence. Linux is a **design direction**
> for Airlock, not a supported release target. This document records that the
> two host primitives Hold, Outbox, and Ledger depend on exist on Linux and
> behave as the contracts require, and that the portable suites pass there. It
> is not a containment claim, not a release claim, and not a parity corpus.

## What Linux needed

macOS v1 rests on two host primitives:

| capability | macOS | Linux |
| --- | --- | --- |
| atomic no-replace rename | `renamex_np(RENAME_EXCL)` | `renameat2(RENAME_NOREPLACE)` |
| recoverable exclusive lease | `open(2)` with `O_EXLOCK` | `flock(2)` with `LOCK_EX \| LOCK_NB` |

`O_EXLOCK` is a BSD extension Linux does not implement, so the Linux lease is
taken with `flock(2)` immediately after the descriptor is opened rather than
atomically with the open. Both ends hold the same contract: authority is the
open file description, the kernel releases it on close or process death, and
stale owner JSON is an inert diagnostic rather than a lock to reclaim.

Selection is by host platform only, in `src/HoldLive.ts` and inside
`src/platform/ExclusiveFileLock.ts`. No program, profile, or tool definition
reaches it. Each adapter independently refuses when it is not on its own
platform, and a filesystem whose rename does not implement `RENAME_NOREPLACE`
gets a typed `ExclusiveRenameUnavailable` — never a replacing rename.

## Run it

```sh
sh scripts/prove-linux-boundary.sh     # container: proof + portable suites
bun scripts/prove-linux-boundary.ts    # on a Linux host: the proof alone
sh scripts/run-linux-suites.sh         # on a Linux host: proof + suites
```

`scripts/prove-linux-boundary.sh` bind-mounts the repository into the official
Bun image and masks `node_modules` with a named volume, so the host's
macOS-native packages never enter the container and the container never
rewrites the host tree. `.github/workflows/linux.yml` runs
`scripts/run-linux-suites.sh` unmodified on `ubuntu-latest`, so the container
and CI execute byte-identical commands.

Vitest must run on the Bun runtime (`bun --bun x vitest`): the Linux lease and
rename are Bun FFI calls that a Node worker cannot make.

## What actually ran

Container executed on 2026-08-02 from an Apple-silicon workstation:

| | |
| --- | --- |
| image | `oven/bun:1.3.13` |
| distribution | Debian GNU/Linux 13 (trixie) |
| kernel | `7.0.11-orbstack-00360-gc9bc4d96ac70` |
| architecture | `arm64` |
| C library | glibc 2.41 |
| Bun | 1.3.13 |
| proof filesystem | `overlayfs` (container `/tmp`) |

### Boundary proof — `airlock-linux-beachhead-v1`

`bun scripts/prove-linux-boundary.ts` emitted `ok: true` with every assertion
true:

```text
renameIntoAbsentTargetSucceeded          true
renameOntoLiveTargetReportedTargetExists true    collisionTag ExclusiveRenameTargetExists
liveTargetBytesPreserved                 true    "first bytes"
refusedSourceBytesPreserved              true    "second bytes"
everyContenderCompleted                  true    16 of 16
contendersWereDistinctProcesses          true    16 distinct pids
noIndependentOverlapObserved             true    0 overlap reports
atMostOneHolderInside                    true    maximum 1, 32 events, balanced
everyContenderEnteredAndExited           true
leaseReclaimedAfterHolderKilled          true    SIGKILL, reclaimed in 12ms
```

The sixteen contenders are the same `test/fixtures/exclusive-file-lock-contender.ts`
process fixture the macOS cross-process test drives, so both platforms are held
to one mechanism. Its `O_EXCL` sentinel is an independent overlap detector that
does not depend on the lock under test. The lease-recovery case kills a holder
with `SIGKILL`, so no release path ever runs; the reclaim is the kernel's.

### Portable suites — 7 files, 54 passed, 4 skipped

```text
test/exclusive-rename.test.ts          7 tests
test/exclusive-file-lock.test.ts       4 tests
test/hold.test.ts                     26 tests
test/outbox-hardening.test.ts          8 tests
test/outbox-ledger-recovery.test.ts    3 tests
test/runtime-execution-claim.test.ts   5 tests (4 skipped, macOS-gated)
test/cancellation-durability.test.ts   5 tests
```

That covers Hold remove/overwrite/undo semantics, the atomic no-replace rename
boundary including the post-rename directory-sync recovery path, cross-instance
Hold serialization, Outbox stage/claim/recovery hardening, Outbox↔Ledger
recovery, and the Runtime execution claim.

The four skipped tests are the `Runtime execution claims on macOS` describe,
gated on `process.platform !== "darwin"`. Cross-process Runtime claim racing
therefore has no Linux evidence yet; cross-process lease serialization does,
through the boundary proof.

### Partially portable suites — 13 passed, 2 excluded by name

```text
test/outbox.test.ts    5 tests (1 skipped)   stage, cancel, commit, flush
test/ledger.test.ts   10 tests (1 skipped)   append, recovery, quarantine
```

Two tests are excluded by an explicit name filter in
`scripts/run-linux-suites.sh`. Both are fixture limits, not Airlock behaviour:

- **`Outbox … does not recover a live commit from another Airlock process as
  uncertain`** hangs in its own HTTP fixture teardown under the Bun runtime:
  instrumented, the emission stages, commits, and is observed as `committed` in
  226 ms, and then the fixture's `server.close()` never calls back. It
  reproduces identically on macOS under `bun --bun x vitest`, where no Linux
  code runs at all, so it is a runtime-of-the-harness artifact.
- **`Ledger … waits for a kernel lease held by another process before
  appending`** spawns a blocker process that hardcodes Darwin's `O_EXLOCK`
  (`0x20`), which Linux does not implement. The Linux equivalent of that claim
  is the 16-process contention section of the boundary proof.

## Non-claims

- **No native containment profile exists on Linux.** There is no Seatbelt
  equivalent in-tree, no private-view preparation, and no network fence. The
  `native-contained` profile refuses on Linux — `Cell` fails with
  `CellUnavailable` — and never falls back to compatibility. On Linux the
  enclosure is the operator's container or VM, not Airlock.
- **This is not a supported platform.** `package.json` still declares
  `os: ["darwin"]`, the distribution scripts remain macOS-only, and no Linux
  release artifact is built or published.
- **The evidence covers one filesystem.** `overlayfs` on the kernel above. A
  filesystem whose rename does not implement `RENAME_NOREPLACE` is refused with
  a typed `ExclusiveRenameUnavailable`; that refusal path has not been exercised
  against a real such filesystem.
- **No parity or corpus claim.** Nothing here measures shell replacement, task
  completion, or latency. See [`docs/evidence/parity-50.md`](parity-50.md) and
  [`docs/acceptance.md`](../acceptance.md), both of which remain macOS-scoped.
- **The two laws are untouched.** `Hold.reap` remains the only unlink site,
  `Outbox.commit` remains the only wire-dispatch site, and neither adapter adds
  a Plan constructor, a profile, or an agent-visible verb.

## Known Linux failures outside this scope

A full `vitest run` in the container reports 37 files passing and these
failures, none of them caused by the platform adapters:

- **`test/distribution.test.ts`** — exercises the macOS install/uninstall
  scripts and Trash displacement. macOS-only by construction.
- **`test/agent-cli.test.ts`, `test/cli.test.ts`** — these fixtures pass one
  temporary directory as both `AIRLOCK_HOME` and `--workspace`, and the native
  filesystem correctly refuses to mutate inside the Airlock home
  (`ProtectedPath: airlock home`). They pass on macOS only because `mktemp -d`
  there returns a symlinked `/var/folders/...` path that does not match the
  resolved workspace. Reproduced on macOS with a resolved home:

  ```sh
  H=$(cd "$(mktemp -d)" && pwd -P)
  AIRLOCK_HOME=$H bun src/agent-cli.ts eval --workspace "$H" \
    --source 'let receipt = file.write({ path: "a.txt", content: "x" })
  return receipt'    # exit 1, same protection
  ```

  This is a fixture path-normalization artifact that predates Linux support and
  is platform-independent. It is recorded here, not fixed here.
