# Reviewed local changes

**Status: implemented developer preview.** See the [executed Linux evidence](evidence/reviewed-changes.md)
for the tested integration and crash boundaries. This is not a production
release or evidence of execution on macOS.

Use Bash or Python to prepare a replacement. Use Airlock for the consequential
step: bind that candidate to one target, review it, apply exactly what was
approved, and retain a receipt for checked undo. No `.air` program, Cell, or
native-contained setup is required. This is local filesystem work, not a remote
deployment service, command runner, or service manager.

## Command contract

JSON is the default; `review --diff` adds per-path changes and bounded text
previews with binary/truncation markers. `--human` on inbox, review, or content
prints escaped terminal text instead. `ID` is a proposal ID; `RECEIPT_ID` is
an apply receipt ID. `sha256:FULL` means the entire reviewed digest (64 hex
digits after the prefix), not a prefix match or the hash of a source file
calculated separately.

```text
airlock change stage --source PATH --target PATH
airlock-agent change stage --source PATH --target PATH
airlock change inbox [--human]
airlock-agent change inbox [--human]
airlock change review ID [--diff] [--human]
airlock-agent change review ID [--diff] [--human]
airlock change content ID --side before|after --path PATH [--offset N] [--limit N] [--human]
airlock-agent change content ID --side before|after --path PATH [--offset N] [--limit N] [--human]
airlock change approve ID
airlock change apply ID --expect-digest sha256:FULL
airlock change status ID
airlock-agent change status ID
airlock change undo RECEIPT_ID
airlock change cancel ID
airlock change recover ID [--restore]
airlock change retire ID --expect-digest sha256:RETIREMENT_DIGEST
airlock change collect ID
```

Within this command group, the agent surface is **stage, inbox, review, content,
status only**. The supervisor owns approve, apply, undo, cancel, recover, retire,
and collect. A reduced command surface
does not remove ambient access: if the agent can write the target directly or
invoke the supervisor binary with equivalent authority, using Airlock is a
convention, not enforcement. Enforced deployments need an external boundary
that gives production authority to the supervisor, not the agent.

## First journey

The manual commands assume the installed binaries are on PATH. From the
repository root, `bash examples/changes/demo.sh` also works with Bun alone:
it uses this checkout if the paired commands are absent. It runs the full
scratch-only sequence with an explicit `APPLY` prompt, checks replacement,
and undoes it by receipt. It accepts no target arguments. For the equivalent
manual journey, generate a small scratch fixture:

```sh
DEMO="$(bash examples/changes/prepare.sh)"
export AIRLOCK_HOME="$DEMO/airlock-home"
printf 'Scratch fixture: %s\n' "$DEMO"
airlock-agent change stage --source "$DEMO/candidate" --target "$DEMO/live"
```

The preparation script creates only a fresh temporary directory. Python
generates `candidate/config.json` and `candidate/README.txt`; the live tree
contains the old configuration and an obsolete file. No production paths or
database are involved. The local demo uses one account for both roles and is
**not** an authority-separation demonstration.

Copy `id` from the stage JSON response (which also includes `version`,
`proposalDigest`, and `proposal`):

```sh
ID='PASTE_PROPOSAL_ID'
airlock-agent change review "$ID"
airlock-agent change review "$ID" --diff
```

Review the target path, baseline, candidate bytes and modes, and proposal
digest. The obsolete file is intentionally absent from the candidate: this is
a **whole directory replacement**, not an overlay or recursive merge. Missing
entries leave the live tree with the displaced directory through Hold.

The proposal binds an immutable candidate snapshot and target-specific
baseline. Editing `candidate` after stage does not edit the proposal. A changed
candidate requires a new stage and a new review. Do not automatically pipe a
freshly computed digest into apply and call that approval.

As the supervisor, copy the full digest from the reviewed proposal:

```sh
DIGEST='sha256:PASTE_ALL_64_HEX_DIGITS'
airlock change apply "$ID" --expect-digest "$DIGEST"
airlock change status "$ID"
cat "$DEMO/live/config.json"
test ! -e "$DEMO/live/obsolete.txt"
```

Apply refuses a mismatched digest or baseline drift. It installs the staged
candidate; it never reruns Python, Bash, hooks, or any arbitrary command. The
old target goes into Hold before the candidate takes its place. These are two
renames, **not an atomic swap**: observers can see an absent target between
them, so this is not zero-downtime publishing. Keep readers and writers stopped
through the managed transition.

Copy `receiptId` from the successful apply response (`state: "installed"`),
then undo (success reports `state: "undone"`):

```sh
RECEIPT_ID='PASTE_APPLY_RECEIPT_ID'
airlock change undo "$RECEIPT_ID"
cat "$DEMO/live/config.json"
test -f "$DEMO/live/obsolete.txt"
airlock change status "$ID"
```

Undo first checks that the target still matches the applied result. It retains
the displaced current state through Hold rather than deleting it in place.
If someone edited the live target after apply, undo refuses instead of
overwriting their work. There is no force flag or replay path.

A rejected undo also consumes its attempt: restoring matching bytes later does
not make that same undo retryable. The inbox shows historical apply and undo
outcomes separately; `workflow=rejected` can mean apply succeeded but undo did
not. Status and inventory never probe undo by trying it.

Receipts describe historical transitions, not the current filesystem. Repeating
apply returns its original receipt without reinstalling—even after undo.
Use status to inspect workflow state; it too is not a live filesystem check.
Undo requires the retained Hold payload: an authorized reaper can eventually
discard it after durable receipt publication. Independent baseline snapshots
are not an alternative force-restore path.

For a **single file**, start a fresh fixture and use the same sequence with:

```sh
airlock-agent change stage \
  --source "$DEMO/candidate/config.json" --target "$DEMO/live/config.json"
```

Only that file is replaced; its siblings are outside the proposal.

## Cancellation, drift, and recovery

- **Not approved:** `airlock change cancel "$ID"` cancels a staged proposal
  without applying it. Cancel is not undo and does not promise snapshot GC.
- **Target edited since stage:** apply must refuse. Inspect the new target,
  generate a candidate appropriate to it, and stage/review a new proposal;
  never override the baseline check.
- **Target edited since apply:** undo must refuse. Preserve and reconcile that
  work separately; a receipt is not permission to overwrite drift.
- **Interrupted transition:** inspect `airlock change status "$ID"`, then let
  the supervisor run `airlock change recover "$ID"` and inspect status again.
  Recovery reconciles durable transition evidence; it is not permission to
  replay an apply or run a command again. Do not manually move Hold entries or
  guess success from the presence of the target alone.
- **Interrupted with the live target absent:** after inspecting recovery
  evidence, `airlock change recover "$ID" --restore` explicitly restores the
  verified prior binding, never the candidate installation. It refuses to
  overwrite a foreign occupant. A completed restoration reports `rolled-back`;
  applying that consumed proposal again does not execute it.

For deliberate drift tests, use a fresh scratch fixture per case. After stage,
append a line to `"$DEMO/live/config.json"` and check that apply refuses. In a
separate successful apply, append a line afterward and check that undo refuses.
For source isolation, edit only `"$DEMO/candidate/config.json"` after stage and
confirm apply still installs the reviewed snapshot, not that later edit.

## Repeated use: inbox, approval, and storage lifecycle

Use [the configuration handoff example](../examples/config-publish/README.md)
to prepare and validate multiple submissions against the same scratch target
and home. The agent submits JSON, not approval. Operators discover the proposals:

```sh
airlock change inbox --human
airlock change review "$ID" --human
airlock change approve "$ID"
```

`approve` displays the frozen review and asks you to type `APPLY` on an
interactive terminal. It passes exactly that displayed ID/digest to apply;
it does not refresh the digest at confirmation. Any other answer, EOF, or
Ctrl-C leaves the proposal unapproved. Automation must use the existing explicit
`apply --expect-digest`; piping an answer into `approve` is refused.

Previews are **not complete review** when marked truncated. Inspect later bytes
of the immutable file, not the mutable preparation directory:

```sh
airlock change content "$ID" --side after --path config.json --offset 8192 --human
```

For a root single-file proposal use `--path ''`. Offsets are bytes; the default
page is 8,192 bytes, maximum 65,536. JSON returns exact base64 bytes, full file
digest, total size, and `nextOffset`; human output escapes control characters
and renders binary or split UTF-8 pages as base64. Follow `nextOffset` until
EOF. Paths must identify an exact stored regular-file entry. Retired snapshots
are unavailable; there is never a source-file fallback.

When review snapshots are no longer needed, cancel an unwanted staged proposal
first (do not cancel one already applied). Inspect fresh inventory, then copy
its **retirementDigest**, which binds eligible private snapshots and workflow:

```sh
airlock change inbox
airlock change retire "$ID" --expect-digest "$RETIREMENT_DIGEST"
airlock change collect "$ID"
```

The retirement digest is **not the approval/proposal digest**. Retirement moves
eligible snapshots into correlated Hold retention. Collection explicitly and
irreversibly reaps those retired snapshot bytes only. It preserves proposal
history, receipts, and original-world apply/undo payloads. Unresolved transitions
block cleanup. Retirement alone does not free budget; successful collection
does. Interrupted cleanup keeps conservative accounting and can be reconciled
by repeating the lifecycle operation. Do not delete/reset the home to regain
capacity, and do not use global `reap` as a substitute for targeted collection.

Inventory exposes incomplete/corrupt rows rather than hiding them. An eligible
incomplete allocation can have a retirement digest without a published proposal.
An empty inbox does not allocate the change store; the existing CLI home Layer
can still initialize the base Hold/Outbox directories.

## Supported envelope and storage

Use **quiescent ordinary user-owned regular files or directory trees**, with
no symlinks, hardlinks, or special files. The contract covers bytes and ordinary
POSIX modes only; it does not promise ACLs, extended attributes, ownership, or
timestamps. Do not use this to replace a live database, socket, device, or
actively written tree. Airlock neither makes databases safe nor restarts
services. There is no confidentiality or defense against malicious tampering
by another process with the same UID.

Snapshots are retained until **explicit retirement and collection**. Each tree
is limited to 64 MiB, 4,096 entries, depth 64, and 256 KiB of entry paths.
The store allows at most 128 active proposals and a 512 MiB snapshot/private-stage reservation budget,
whichever is reached first. Each stage reserves twice the candidate-plus-baseline
bytes plus 32 MiB overhead, so even tiny proposals exhaust the budget before
the count limit. Interrupted allocations remain conservatively charged.
Collection releases the snapshot reservation and active slot, not historical
metadata or separately retained world recovery payloads. Those continue to
consume disk under existing Hold retention policy. These application limits
are not a total-home disk cap or filesystem quota; budget actual free space
too. Cancellation and undo alone do not reclaim the reservation. Preserve the Airlock
home for receipts and recovery; the demo does not auto-delete it. Source
immutability means later edits to the original source are irrelevant, not that
same-UID attackers cannot modify private state.

The implementation composes Hold directly with **supervisor-managed Apply
semantics**. It does not claim Plan lowering or add a fifth Plan node. The
[two laws](../DESIGN.md#the-two-laws) continue to govern managed mutations and
optional restrictions. Compatibility mode, `.air`, Cell, and Outbox remain
separate optional features with their existing, narrower guarantees.
