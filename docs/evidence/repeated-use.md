# Repeated-use configuration publishing — executed evidence

Executed on 2026-09-08 in a Debian 12 Linux x86-64 Amp orb, kernel 6.1.158+,
Bun 1.3.11, audited Bubblewrap 0.12.0. This extends the
[initial reviewed-change evidence](reviewed-changes.md); its former no-GC
limitation is superseded by explicit snapshot retirement and collection.

## Integrated gate

```sh
AIRLOCK_BWRAP=/usr/local/bin/bwrap bun run verify
```

Exit 0: typecheck passed; 76 test files passed / 5 skipped; **498 tests passed /
27 skipped**. This run includes the 200-cycle case after all integration fixes.
The subsequent required gates reported:

```json
{"gate":"bun-process-runner","status":"passed","tests":11}
{"gate":"linux-native-contained","status":"passed","tests":13}
```

Local documentation links and byte-identical DESIGN two-laws text also passed.

## Repeated-use and recovery proof

[The lifecycle suite](../../test/change-lifecycle.test.ts) executes **200 mixed
cycles in one home**, without resetting it or raising limits. Each proposal is
cancelled, applied, or applied and undone, then explicitly retired and collected.
The final inventory assertions are:

```json
{"rows":200,"active":0,"reservedBytes":0,"snapshotBytes":0,"collected":200,"errors":0}
```

Separate cases check undo after snapshot collection, consumed rejected undo,
legacy `held`/`undoLast` unaffected by retirement artifacts, stale retirement
digests, retained-content drift, concurrent reads/retirement/collection,
incomplete allocations, and reappeared private bytes remaining charged.

[Eight lifecycle process-exit cases](../../test/change-lifecycle-crash.test.ts)
terminate real children at retirement approval, bundle binding, rename before
sync, retired publication, collecting claim, partial deletion, complete deletion
before sync, and collected tombstone publication. Recovery does not release
capacity early or discard correlated unresolved private stages. The existing
[16 checked-operation process-exit cases](../../test/change-crash.test.ts) remain
in the gate. These are process-crash tests, not hardware power-loss certification.

## Review and approval proof

[Nine CLI cases](../../test/change-review-cli.test.ts) exercise JSON and human
inventory, frozen pagination past 8 KiB, binary content, path traversal refusal,
hostile terminal characters, distinct apply/undo outcomes, corrupt rows,
targeted collection preserving undo, and exclusion of terminal authority from
the agent surface. A real Unix PTY drives confirmation, decline, EOF, source
edits, and target drift during the approval prompt. Nonterminal approval refuses.

A regression first reproduced an inbox following a symlinked change-store
directory and overwriting an outside scratch lock file. Shared store validation
now rejects that redirected directory before acquiring the read lease; the
sentinel remains unchanged. This does not claim protection from malicious
same-UID races or redesign the repository-wide lease primitive.

Actual human inbox/review output was rendered and inspected. Binary and
truncated content are marked, control characters are escaped, and the inbox
labels historical outcomes and the snapshot-only budget rather than claiming
that the live target was checked.

## Agent handoff and standalone execution

[The configuration example](../../examples/config-publish/README.md) was run
against the real CLI in one scratch home: two submissions, frozen workers=2
installation despite the later candidate edit, stale proposal refusal, snapshot
retirement/collection, undo after collection, and a third submission followed
by cancellation and collection. Final snapshot reservation was zero without
resetting the home.

A fresh `bun scripts/build-linux.ts --out "$OUT"` standalone pair also passed
agent handoff → human review → exact-digest apply → retire → collect → checked
undo, retaining the same home and returning to zero snapshot reservation.
The original scratch directory replacement/undo demo still passed.

```sh
python3 -B -m unittest discover -s examples/config-publish -p 'test_*.py' -v
```

Six glue tests passed. These deliberately use a fake agent to test submission
validation, stable target/home, refusal of overrides and symlinks, Bun fallback,
and sanitized failure without retry. They do not substitute for the real CLI
execution above. The adapter never invokes supervisor authority.

## Remaining boundaries

Local quiescent regular files/trees and ordinary POSIX modes only. Two renames
are not an atomic swap. Snapshots are unencrypted; there is no same-UID hostile
process defense or ambient access interception. Collection preserves historical
metadata and original-world recovery payloads: the snapshot/private-stage
budget is **not a total disk cap**. Real-user second-use adoption remains an
unmeasured, operator-owned experiment in the [action plan](../repeated-use-plan.md).
