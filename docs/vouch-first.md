# Vouch-first adoption and evidence

> Status: first adoption workload, two runnable local native-contained proofs,
> and parser-backed full-workflow examples.
> Vouch supplies workload evidence; it does not define Airlock's ontology.

## Why Vouch goes first

Vouch's state-preserving replacement flow combines the four kinds of work
Airlock is meant to express:

- observe local state;
- run existing archive, SQLite, Python, and controller programs;
- install recovered local state; and
- request a consequential remote replacement.

That makes Vouch a useful vertical slice. It does not justify `Vouch*`,
`sandbox.*`, `archive.*`, `sqlite.*`, or replacement-specific Plan nodes.

## Generic lowering

```text
snapshot → upload → restore → validate → replace
```

| Workload step | Generic Airlock composition |
| --- | --- |
| inspect state/archive | `Capture` through an admitted path |
| create or extract archive | structured `Invoke` of an existing tool in a private view |
| SQLite-consistent snapshot | structured `Invoke` of the existing helper or SQLite tool |
| upload/download/controller work | structured invocation or a staged remote-realm request, depending on the actual authority boundary |
| validate output | captured process artifacts plus pure program checks |
| retain/replace local state | `Apply` through Hold |
| request remote replacement | `RequestExternal`, followed by separately authorized commit |
| recover local failure | typed reconciliation or Hold undo; never guessed success |

Application semantics stay in tar, Python, SQLite, OpenShell, or the remote
service. Airlock owns admission, structured argv, execution bounds, private
state, local finality, external staging, and receipts.

## What runs today

`scripts/prove-vouch.ts` executes one fixed, safe, local proof on supported
macOS hosts. The test is `test/vouch-e2e.test.ts`; the operation inventory is
`examples/vouch/OPERATIONS.md`.

The admitted Plan contains five generic nodes:

1. `Capture` reads a fixed state archive through an explicit path grant.
2. `Invoke` runs `/usr/bin/tar -xzf - -C hermes` with the archive as stdin in
   a native-contained Cell.
3. A second `Capture` reads live `SOUL.md` after Invoke and before Apply.
4. `Apply.merge` installs the private `hermes` directory delta through Hold.
5. `RequestExternal` stages a body-bearing HTTPS replacement request.

The proof then invokes Hold undo as an administrative transition.

### Receipts established by the fixture

The proof asserts:

- six admitted grants and six handles, including separate executable and
  working-directory authority for the `tar` invocation;
- five succeeded Plan-node receipts in sequence;
- one admitted resource identity per node except the invocation, which carries
  its distinct executable and working-directory identities;
- the archive digest is attached to the Invoke input;
- the actual executable and args are recorded;
- network is denied;
- the Cell reports `ambient-host-read`, making the confidentiality limitation
  explicit;
- the process proposes one top-level modified directory;
- live state remains unchanged before Apply;
- restored content and the introduced session appear after Apply;
- the HTTP request remains `staged`;
- no `fetch` call occurs;
- private dispatch data preserves body/headers and is mode `0600`;
- Hold undo restores the prior content and removes the introduced session; and
- Ledger contains mutation, staging, and undo entries.

This is concrete evidence for the current native Plan/Runtime/Hold/Outbox path.
It is candidate-level evidence because it is one controlled fixture.

### Expanded host-operation proof

`scripts/prove-vouch-operations.ts` runs
`examples/vouch/host-workflow.air`; its test is
`test/vouch-operations-e2e.test.ts`. The program executes 12 actions / 16 Plan
nodes covering list/glob/capture, native mkdir, tar snapshot and list, artifact
stdin, OpenShell-shaped argv atoms, managed copy/move/remove, and staged HTTP.

The surrounding proof also establishes targeted Hold undo, process timeout,
`AbortSignal` cancellation, and a 128-byte output-limit partial process
receipt. The Outbox remains pending with no commit; public endpoint data is
redacted while the owner-only body remains staged. The CLI Plan receipt is
versioned.

This expands the operation surface beyond the restore fixture. It is still a
controlled local proof rather than a representative corpus.

Separate agent-only parity workloads now cover repository search/pipelines,
native editing, archives, local Git, build descendants, and recoverable
recursive removal. They broaden the generic evidence without turning the
Vouch-derived proofs into a representative corpus.

## What the proof does not do

It does not:

- run Vouch itself;
- invoke OpenShell or a real remote sandbox;
- perform an online SQLite backup;
- test image-owned permission collisions;
- use a contained endpoint broker;
- dispatch the replacement request;
- validate remote health or replacement completion;
- run the whole Vouch/OpenShell lifecycle through the checked-in `.air`
  examples;
- prove complete execution closure for tar or Python;
- prove confidentiality;
- exercise crash injection or concurrent merges/commits;
- prove ACL, xattr, hardlink, symlink, special-file, or live-writer semantics;
  or
- measure a representative shell-free corpus.

The `.invalid` endpoint and fetch guard make the local proof safe. They also
mean it cannot be cited as external replacement evidence.

## Program corpus

`examples/vouch/host-workflow.air` is executed. `snapshot.air`, `restore.air`,
and `replace.air` remain parser-backed full-workflow examples. Their companion
contract test verifies:

- no shell escape or Vouch-specific runtime action;
- structured `run` calls with executable, args, streams, timeout, and profile;
- staged external requests; and
- lowering to the four generic Plan nodes.

Some example calls describe the intended full controller workflow and exceed
today's integrated native capability. Parser-backed is not the same as
executed end to end.

## Next evidence steps

1. Run a disposable OpenShell fixture with an admitted executable/config/
   helper closure.
2. Exercise the real SQLite-safe snapshot and collision-skipping restore
   semantics in the existing helpers.
3. Keep the replacement request staged until its endpoint/credential authority
   has an honest broker or remote-realm contract.
4. Run snapshot, upload, restore, receipt decoding, validation, replacement,
   and post-replacement health as one shell-free Airlock program.
5. Inject crashes and concurrent conflicts at every Hold/Apply/Outbox boundary.
6. Publish latency, retention, escape, and recovery evidence against the
   direct-shell workflow.
7. Freeze vocabulary and run an unrelated held-out repository workload.

Direct shell permission should be removed from a Vouch agent harness only
after the applicable [macOS acceptance gates](acceptance.md) pass. A future VM
may widen or strengthen the backend, but it is not required to evaluate the
current native-contained v1 envelope.

## Overfitting tripwire

If a Vouch step appears to require a new primitive, classify it first as:

1. pure composition missing from the language;
2. a resource/endpoint classification missing from Admission;
3. a trusted lifecycle transition;
4. an adapter or inert tool definition; or
5. genuinely new machine physics.

Only the fifth can contest the four-node algebra, and it requires an unrelated
Unix counterexample plus contract review.
