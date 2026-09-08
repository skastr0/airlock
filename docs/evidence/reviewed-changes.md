# Reviewed local changes — executed evidence

Developer-preview integration evidence, exercised on 2026-09-07 in an Amp
Debian 12 Linux x86-64 orb, kernel 6.1.158+, Bun 1.3.11. This is not a
production certification, power-loss proof, or macOS execution claim.

This records the initial slice. See [repeated-use evidence](repeated-use.md)
for the later inbox, approval, content paging, and explicit snapshot collection;
the initial no-GC boundary below is historical, not the current contract.

## Integrated gate

```sh
AIRLOCK_BWRAP=/usr/local/bin/bwrap bun run verify
```

Exit 0. Typecheck passed; 73 test files passed / 5 skipped, with 470 tests
passed / 27 skipped. The subsequent required Bun gates reported:

```json
{"gate":"bun-process-runner","status":"passed","tests":11}
{"gate":"linux-native-contained","status":"passed","tests":13}
```

The full gate uses audited Bubblewrap 0.12.0 and libseccomp. The direct change
journey does not: its CLI test explicitly supplies nonexistent containment
helper paths and still stages, applies, and undoes successfully.

## What the tests actually exercise

- [CLI integration](../../test/change-cli.test.ts): seven cases covering external
  preparation, independent snapshots, full-digest approval, agent command
  exclusion, drift refusal, whole-directory replacement and undo, cancellation,
  three simultaneous supervisor processes producing one installation, and
  supervisor recovery after an actual child process exit.
- [Process-exit boundaries](../../test/change-crash.test.ts): 16 cases that
  terminate real child processes with exit 86 around claims, retention,
  installation, outcome/receipt publication, acknowledgement, undo, and
  restoration. Restarts reconcile evidence without repeating installation;
  unresolved recovery material remains protected from the reaper.
- [Workflow cases](../../test/change-workflow.test.ts): 19 cases including
  target/parent drift, exact proposals, private snapshots, checked undo,
  recovery publication failures, bounded repeated recovery metadata, and
  explicit restoration refusing a foreign target occupant.
- [Tree contracts](../../test/change-tree.test.ts): five cases covering canonical
  digest/snapshot behavior, admission limits and unsupported kinds, symlink
  traversal, and Linux mount-topology rejection.
- Existing Hold and authority-site construction tests remain in the full gate.
  No fifth Plan node, second managed unlink authority, or new network site.

## Runnable adoption proof

```sh
bash examples/changes/demo.sh
```

The interactive demo creates its own scratch target, shows review including
bounded text previews, and requires `APPLY`. It checks the replacement, undoes
by receipt, and checks restored bytes and directory membership. Any other
answer cancels. Both approval and cancellation paths passed using Bun checkout
entrypoints and a freshly built standalone Linux pair from
`bun scripts/build-linux.ts --out "$OUT"`. The successful path ended with
`PASS: scratch replacement and checked undo.` No real target was used.

## Boundaries

This is an optional tool alongside Bash/Python, not an ambient access monitor.
The tested envelope is quiescent local regular files/trees, bytes and ordinary
POSIX modes, with same-filesystem Hold transitions. Replacement uses two
renames, not an atomic swap or filesystem compare-and-swap. Process exits do
not establish arbitrary hardware power-loss durability. There is no live
database/deployment safety, confidentiality, malicious same-UID defense, or
snapshot GC. Storage reservations are application limits, not a filesystem
quota. Receipts are historical; undo additionally needs retained payloads.
See [the operational contract](../changes.md) for limits and recovery usage.
