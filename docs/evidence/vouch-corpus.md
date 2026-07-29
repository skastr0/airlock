# Vouch-derived shell replacement corpus

This is a workload corpus, not an Airlock extension. It is derived from the
state-preserving replacement path in Vouch's `box-runtime-v1.py`, but no Vouch
term is a Plan node, native verb, resource kind, or runtime authority.

The source workload has three stages:

1. snapshot state, including a safe SQLite backup, and download a durable
   archive;
2. upload and restore that archive into a newly created machine, validating a
   machine-readable receipt; and
3. only after a durable local backup exists, request a remote replacement and
   restore/validate the new machine.

The source's cleanup and service-specific registration are intentionally out
of this first corpus. They are ordinary later `run` calls or separate managed
local `Apply` operations; neither creates a new physics category.

## Lowering contract

| source concern | Airlock operation | executable / authority | timeout | success claim |
| --- | --- | --- | --- | --- |
| create a SQLite-consistent archive | `Invoke` through `run` | `/usr/bin/python3 -I -S helper` in a private Cell; state-root read and archive write grants | 150s | exit code is zero; helper emits a captured receipt |
| move archive into downloadable location | `Invoke` through `run` | existing controller executable plus its structured args | 45s | exit code is zero |
| download archive | `Invoke` through `run`, then `Capture` | existing controller executable; local artifact destination grant | 180s | exit code is zero and captured artifact has bytes |
| retain durable backup | `Apply(write)` | Hold-managed local path; no direct overwrite | n/a | Apply receipt says recovery material exists |
| upload archive | `Invoke` through `run` | existing controller executable plus args | 120s | exit code is zero |
| restore state | `Invoke` through `run`, then `Capture` | existing controller executable plus an isolated helper | 210s | process receipt says `phase = state_restored`, `ok = true`, and `extracted > 0` |
| replace or create remote machine | `RequestExternal` | brokered remote-realm endpoint; intent is staged in Outbox | 30s hold before dispatch | only `staged` before commit; after commit result may be succeeded, failed, or uncertain |

`tar`, `sqlite3`, the controller executable, and Python helpers remain existing
tools. Airlock neither parses archives nor adopts controller/sandbox concepts.
The scripts therefore use `run({ executable, args, stdin, stdout, stderr,
timeout, cellProfile })`: no command string, shell interpolation, or project-native
verb appears.

## Required generic contracts

The corpus requires these contracts from the runtime, rather than a bespoke
implementation:

- `run` accepts an executable handle or absolute executable identity, a list
  of args atoms, optional working directory and environment overlay, explicit
  stdin/stdout/stderr policy, timeout, output limit, and Cell
  profile. It returns exit status and captured streams as artifacts.
- `capture` admits local/process-output observations with provenance; a later
  assertion is over captured receipt data, not shell text.
- `apply(write)` installs an artifact only through Hold and reports whether
  recovery material was retained.
- `request_external` stages a generic request in Outbox. Dispatch is separate,
  cancellable while staged, and `uncertain` if a crash occurs after dispatch
  might have started.
- A tool definition may make the controller executable ergonomic, but it may
  only lower to these existing Plan constructors. It cannot add `upload`,
  `restore`, `snapshot`, or `replace` physics.

## Current evidence and remaining runtime work

The corpus is parser-backed now and the companion test constructs a canonical
Plan DAG using only `Capture`, `Invoke`, `Apply`, and `RequestExternal`. It
does **not** claim that an external machine has been replaced: execution,
tool-definition admission, process-output artifact decoding, endpoint
brokerage, and the remote-realm adapter must be wired before this becomes an
end-to-end proof.

Source evidence: `../vouch/assets/box-runtime-v1.py`,
`snapshot_hermes_state` (around line 5853), `restore_hermes_state` (around
line 5956), and `replace_sandbox_preserving_state` (around line 6041), read on
2026-07-29.
