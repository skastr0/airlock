# Vouch-derived shell-replacement evidence

> Status: two local proofs executed on macOS and Linux plus parser-backed
> full-workflow examples. This is workload evidence, not a representative corpus
> and not a real Vouch/OpenShell replacement.

Vouch's state-preserving replacement path motivates three stages:

1. snapshot state, including a safe SQLite backup, and retain an archive;
2. upload and restore the archive into a new machine, validating a
   machine-readable result; and
3. only after a durable local backup exists, request replacement and verify
   the new machine.

No Vouch term is a Plan node, native verb, resource kind, or runtime authority.
Tar, SQLite, Python, and OpenShell retain their own application semantics.

## Executed restore proof

`scripts/prove-vouch.ts` and `test/vouch-e2e.test.ts` execute this admitted
native-contained path:

```text
Capture archive
  → Invoke /usr/bin/tar with artifact stdin
  → Capture live state before Apply
  → Apply directory delta through Hold
  → RequestExternal staged in Outbox
  → targeted Hold undo
```

The fixture establishes that live state is unchanged before Apply, the
restored directory is installed and recoverable, the HTTP request remains
staged with no fetch, owner-only private dispatch data retains the request,
and node/resource receipts correlate the work.

## Executed host-operation proof

`examples/vouch/host-workflow.air`,
`scripts/prove-vouch-operations.ts`, and
`test/vouch-operations-e2e.test.ts` execute 12 generic actions / 16 Plan
nodes:

| Shape | Executed evidence |
| --- | --- |
| observe host state | file list, glob, and capture |
| create private state | native `file.mkdir` |
| snapshot | `/usr/bin/tar` writes a private archive, followed by Apply |
| inspect an archive | `/usr/bin/tar` listing captured as an artifact |
| explicit pipe | listing artifact becomes `wc` stdin |
| controller-shaped argv | OpenShell-looking atoms round-trip through `printf`; no command string |
| managed local transitions | copy, move, and remove lower through Hold |
| external intent | body-bearing HTTP request remains staged; endpoint query is redacted |
| recovery | targeted undo restores the exact prior archive bytes |
| process bounds | timeout, `AbortSignal` cancellation, and a 128-byte output-limit partial process receipt |

The CLI Plan receipt schema is versioned. The proof reports the node-kind
sequence and keeps Outbox pending with no commit.

## Parser-backed full workflow

`examples/vouch/snapshot.air`, `restore.air`, and `replace.air` preserve the
broader workflow as structured examples. Their contract test verifies
shell-free syntax and lowering to `Capture`, `Invoke`, `Apply`, and
`RequestExternal`. Some calls exceed the integrated native envelope; parsing
and lowering are not execution evidence.

## Generic contract

The workload is expected to compose:

- structured `process.run` with separate executable and argv, explicit
  cwd/environment/streams, timeout, output limit, and profile;
- captured file and process-output artifacts with provenance;
- `Apply` through Hold for managed live state;
- `RequestExternal` into Outbox, with dispatch separately authorized; and
- ordinary tools or inert definitions, never Vouch-specific physics.

## Exact evidence boundary

The two proofs provide useful candidate-level evidence for local file,
process, artifact, Hold, Outbox, and receipt paths. They do **not**:

- run the Vouch executable or a real OpenShell Unix-socket/config/credential
  closure;
- create or replace a disposable remote realm;
- execute the live SQLite-safe backup or unwritable-collision cases;
- provide a native endpoint broker or dispatch the staged request;
- prove PTY, daemon/session escape, complete loader/helper/config closure, or
  confidentiality;
- establish hardlink, ACL, xattr, special-file, live-writer, multi-entry
  atomicity, or exhaustive crash behavior; or
- supply a frozen representative corpus or direct-shell baseline.

The separate parity suite adds agent-only repository search/pipeline, native
edit, tar, local Git, build-descendant, and recoverable recursive-removal
workloads. Those are corroborating generic evidence, not Vouch execution and
not a representative corpus.

The source-operation inventory and provenance notes live in
[`examples/vouch/OPERATIONS.md`](../../examples/vouch/OPERATIONS.md).
