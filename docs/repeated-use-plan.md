# From a successful transition to repeated use

## Outcome

An operator can repeatedly publish a generated configuration directory using
one Airlock home: discover a proposal, understand the exact frozen change,
approve it without copying hashes, revisit its apply and undo outcomes, and
reclaim review snapshots without losing receipts or selected undo payloads.
Agents keep Bash/Python for preparation and validation. Airlock owns only the
consequential filesystem transition. Easy installation is assumed, not a
workstream in this plan.

The first workload is a small user-owned configuration tree outside Git,
consumed by a stopped batch job. The target's readers and writers remain
quiescent through replacement. This fits whole-directory replacement without
promising a service restart, live database safety, or a deployment transaction.

## Product decisions

1. Keep the existing Change/Hold transition machinery. Extend its source of
   truth; do not introduce another workflow engine or Plan node.
2. Lifecycle is a prerequisite; the product bet is review and approval.
   Raising quotas or rotating homes is not a cleanup strategy.
3. Keep JSON as the integration contract. Human views are explicit, safe text
   renderings of the same service results.
4. Approval captures the ID and full digest actually displayed. The controller
   must not recompute or substitute a digest when the operator confirms.
5. Agent-visible tools remain preparatory/read-only. Approval and irreversible
   collection remain supervisor actions. This is role separation by convention
   unless authority is externally separated; it does not prevent ambient bypass.
6. Preserve the two DESIGN laws byte-for-byte. No new unlink or wire site,
   arbitrary protected-path bypass, automatic cleanup, or restriction on Bash.

## Phase 1 — durable lifecycle and truthful state

### Discovery and inventory

Expose proposals in an existing home without needing their IDs in advance.
Report the target, digest, workflow state, separate apply/undo outcomes,
snapshot lifecycle, reserved storage, and incomplete/corrupt entries. One bad
entry must be visible, not silently omitted or allowed to hide the whole inbox.
An empty inventory must not allocate a change store. The existing CLI home
Layer still initializes its base Hold/Outbox directories; this tranche does
not rewrite initialization of all other commands.

Do not collapse these distinct facts:

- Historical apply installed or rejected.
- Historical undo undone, rejected, or interrupted.
- Recovery material retained, retired, or collected.
- Current target contents: not checked by status or inventory.

A drift-rejected undo consumes its attempt today. Document and test that
repeated undo returns the same rejection even if bytes later match again.
Never probe undo eligibility by actually invoking undo.

### Explicit retirement and collection

Separate digest-bound retirement from irreversible collection. Retirement
removes eligible review snapshots from active use through correlated Hold
renames; collection invokes the existing reaper on those specific objects.
Neither action may sweep unrelated Hold entries or discard apply/undo payloads.

Eligibility requires a consumed/cancelled proposal and no unresolved apply,
undo, receipt-publication, or restoration transition. A staged proposal must
be cancelled first. Receipts, proposal identity/digest, and consumed-operation
evidence survive retirement. Old IDs never become executable again.

Release reservation only after durable evidence establishes collection. Moving
bytes into Hold is not reclamation. Recover interrupted allocations and
retirement conservatively; do not grant budget based on a mutable auxiliary
flag alone. Reclaim active-proposal capacity too, while retaining history.
Keep selected undo payloads available under the existing Hold retention policy.
Name the reclaimed bucket explicitly: snapshot/private-stage reservation, not
total disk consumption. Original-world recovery payloads and historical
metadata remain outside that bucket; they still consume disk space. The result
is not a filesystem quota against outside writes.

### Evidence required

- 200 mixed stage/apply/cancel/undo/retire/collect cycles in one home, with no
  reset or raised quota, while preserving receipts and selected undo payloads.
- Real process exits around retirement renames, reaping, and accounting
  publication: no lost unresolved bytes and no premature capacity release.
- Concurrent review/apply/retirement/collection: no resurrection, substitution,
  snapshot disappearance under an active read, or unrelated payload collection.
- Failed/incomplete staging remains visible and has a safe cleanup path.
- Existing Hold and authority-site construction tests pass unchanged in intent.

## Phase 2 — supervisor review and exact approval

### Terminal inbox and review

Provide a human inbox and readable proposal view alongside machine JSON. Show
absolute target, whole-tree replacement warning, path additions/deletions,
permission changes, binary markers, digest, and omitted-content warnings.
Escape terminal control characters in filenames, errors, and file content;
never let candidate bytes become terminal instructions.

Keep bounded previews by default. Add strict per-path, per-side access to
frozen snapshot content, with bounded pages and byte offsets. A consequential
edit beyond byte 8,192 must be inspectable without opening the mutable source.
Reject traversal and paths not present in the stored tree. Binary content must
have an explicit encoding, not lossy decoding. A retired snapshot reports
unavailable rather than silently falling back to another file.

### Interactive approval

A supervisor command displays one frozen review and asks for an explicit
confirmation on a terminal. It applies the captured ID/digest, not a freshly
looked-up value. Nonterminal callers use the existing exact-digest apply API;
there is no implicit yes flag on the human approval interaction.

Declining does not mutate or consume the proposal. Target drift between review
and confirmation refuses installation. Source edits do not change the frozen
proposal. No validator, hook, shell command, or service restart runs on apply.

### Evidence required

- Render actual CLI output for empty, staged, failed-undo, corrupt, truncated,
  binary, and retired states; inspect what the operator sees.
- Exercise the real terminal confirmation path, refusal, EOF/nonterminal
  behavior, target drift, and captured-digest binding.
- Test a late-file edit and adversarial control characters/path names.
- Agent and sealed command graphs exclude approval, retirement, and collection.

## Phase 3 — one thin agent handoff

Use subprocess/JSON integration with the existing agent CLI, not a privileged
RPC server. Supply a concrete configuration-publishing example that prepares
and validates a candidate, submits it, and hands the proposal reference to the
operator. It must not approve, invoke supervisor binaries, auto-copy a digest
into apply, or advertise protection from an agent that has ambient target access.

The operator follows the same inbox/review/approval journey, checks the receipt,
and can undo or retire snapshots explicitly. Keep production paths out of
automated examples. Exercise repeat submissions in the same home rather than
resetting it to make a demo green.

## Integration and delivery

Core ownership: Change lifecycle/read APIs, correlated Hold retirement/reaping,
schemas, crash/accounting tests. Parent integration ownership: CLI presentation,
interactive approval, harness example, end-to-end tests, docs, and final gate.
Commit isolated checkpoints locally; do not push, publish, deploy, or change
real production data. Integrate core by patches, then verify the combined tree.

Release gates: `bun run verify`, standalone Linux build, executed scratch
journey, repeated-use and crash evidence, local documentation links, and
unchanged two-laws text. Report platform skips and limitations honestly.
Record actual results rather than treating the plan as proof.

## Adoption experiment — requires real users, not synthetic proof

After the local slice works, recruit operators already doing this workflow.
Observe multiple sessions. The success signal is voluntary second use, not
completion of a prompted demo. Record bypass reasons: preparation burden,
review burden, storage, unsupported filesystem shape, or authority requirements.
Recruitment and external sharing are not authorized by this local implementation
task; these remain an explicit operator-owned follow-up.

Change priority if an adopter cannot accept ambient agent access: external
ownership of the target and store becomes the next prerequisite. If preparation
is the burden, improve one candidate-generation workflow. If Git already solves
the user's problem, choose a different operational artifact rather than adding
more UI.

## Non-goals

No shell replacement, arbitrary-command approval, autonomous production agent,
live database handling, remote deployment, service orchestration, automatic
rollback, secret-store/confidentiality promise, same-UID hostile-process defense,
or general authority broker. Two renames remain non-atomic. Local diagnostic
UID/time fields are not authenticated human signatures. Process-exit evidence
does not establish arbitrary hardware power-loss durability.
