# RFC: Airlock as the change-safety layer for agents

> Status: **candidate design, not implemented.** Authored at `2189a67`; every
> `src/`/`test/` citation is pinned to that tree. Nothing here is an invariant
> or a v1 contract until it cites source and a named test. The two laws in
> [`DESIGN.md`](../../DESIGN.md) are untouched: `Hold.reap` stays the sole
> unlink site and every new surface only narrows or reports (the ratchet).
> Evidence comes from real sessions retrieved through Quasar (ids cited as
> `session:seq`) and read by four collaborating agents; claims marked
> *verified* were re-run by the coordinator.

## 1. Evidence: what happens when agents delete things

Airlock is already the operator's go-to unblock: when an agent is stopped on
an unsafe removal, "use ../airlock" gets it moving again. Four such redirects
are on record, plus the pattern they sit inside.

### 1.1 Operator redirects

| session | blocked command | what the agent did next |
|---|---|---|
| `claude:7ba6326f` (mac-tuning) | `… \| while read -r n; do rm -rf "$C/$n"; done` | used airlock end to end (§1.2) |
| `claude:b6973bcc` (junto) | `rm -f $SP/*.png` in a scratchpad (:1243) | found `airlock rm` only after grepping `docs/usage.md` (:1258); held the whole directory and recreated it |
| `claude:ad6a5584` (junto) | `rm -f $S/*` in a scratchpad (:2560) | read the README head, concluded airlock means `change`, avoided deleting altogether (:2571) |
| `claude:5f513f17` (junto) | `rm -rf *` in a scratchpad (:1628) | read the README head, avoided deleting altogether (:1637) |

Three findings:

- **What the operator blocks is shape, not location.** Across the three junto
  sessions agents ran 37 plain `rm`s; the operator rejected exactly the three
  with an unexpanded glob, all inside `/tmp` scratchpads. None of the 33
  named-path deletions, including `rm -rf` in the repo, was rejected. The
  danger is the founding-incident class: a derived path (`$SP` empty →
  `rm -f /*.png`) nobody sees expanded.
- **Discovery decides adoption.** Every redirected agent's first read was the
  README head. The mac-tuning agent read the pre-`2189a67` README, which led
  with `rm`, and succeeded. Two junto agents read today's `change`-first,
  "optional tool" README and never found `rm`. `change` cannot delete a path
  and caps trees at 64 MiB (`src/change/Tree.ts:36`).
- **The instruction sticks.** "Use `…/dist/airlock rm <path>` instead of
  `rm`" survived context compaction (`b6973bcc:1356`). One sentence changes
  behavior; the tool has to meet it on the first screen.

### 1.2 The field session, corrected

`claude:7ba6326f`, disk at 99%. Before its first call the agent chose a
private `AIRLOCK_HOME` and checked both paths were on one volume
(`stat -f %d` → `16777229`). It ran three batches: 94 stale Chrome-for-Testing
copies (one held, trial-undone, re-held, then 93 in a loop), 64 stale
`node_modules`/`target` directories, and 234 `prism-test-run-*` directories.
393 single-target `rm` calls, zero failures, nothing left held.

- **Reap was operator-gated once.** Batch 1 waited for "go ahead"; the agent
  reaped batch 2 on its own ("it contains nothing else. Clearing it now") and
  batch 3 inside the same call that held it, behind a home-made preview
  (`held | grep -vcE … || abort`). It ran the supervisor binary, where
  nothing stops `reap`; `dist/` ships no `airlock-agent` (*verified*).
- **Bytes misled everyone.** `du` said 211 GB; the reap freed about 3 GB
  (*verified*: "it freed only about 3 GB (38 → 41 GB free), not 211 GB … the
  copies were APFS clones"). The operator suspected airlock itself ("are you
  sure it's not airlock?") and the agent proved otherwise by hand from the
  ledger and `lsof +L1`.
- **Reclaim was the goal.** Airlock's founding note said physical reclaim is
  "needed by the agent never, synchronously never" (`claude:99dd7c94`). For
  disk-pressure tasks that is false: holding frees nothing, so the agent
  reaps immediately.
- **The alternative is worse.** An earlier mac-tuning run used
  `/usr/bin/trash`: 37 GB and 1,422 items sat in the Trash with no ledger
  until the operator found them ("how the hell are these in my trash?") and
  the agent needed six tool calls to trace them to a May change note.

### 1.3 When no human steps in

Groundwork's risk hook (operator-installed, several harnesses) blocks
`rm -rf` once: `[groundwork:risk] Recursive forced rm is blocked to prevent
destructive deletion (rule: rm.recursive-force). Blocked once for this exact
command … Recommended: ask the user before retrying`
(`groundwork/packages/core/src/risk/rules.ts:163-166`, `service.ts:206-208`).
It never names a recoverable alternative, and the rule needs both `-r` and
`-f`. What agents did next:

- **Improvised a hold:** `mv` to a quarantine directory (`codex:6a3d7659`,
  `codex:e670e38c`) or to the Trash, which "passed the gate with `allow`"
  (`claude:64fdc6fb`).
- **Reworded past it:** dropped `-f` (`grok:5c87d660`); retried the exact
  command after block-once (`codex:1ec69b46`, `codex:ba85ab6d`); split a
  blocked `git push --force` into an allowed `--force-with-lease`, then ran
  `filter-repo`, `branch -D` on its own backup branch, and
  `push origin --delete` of 21 tags, each checked "allow" by the classifier
  (`grok:1de7a7ec` seq 185–287).
- **Gave up:** left the cleanup undone (`codex:99d076b7`, `codex:72b09d74`)
  or handed `rm -rf` to the human (`opencode:81a7c898`).

A deny-only hook trains rewording. Agents already want a hold; they build a
worse one each time.

## 2. Positioning

The docs call Airlock "an optional tool" (README.md:9, DESIGN.md:3/7,
package.json:6, docs/security-model.md:4/45). The evidence says otherwise: it
is what the operator reaches for whenever an agent is stopped on a
destructive act. "Optional" conflates two things:

- **What it is:** the change-safety layer for agents doing system work — the
  hold agents already improvise with `mv` and the Trash, made real with a
  ledger, undo, and one reaper.
- **How strongly it binds:** a harness choice. Adopted by an agent that keeps
  its shell, Airlock makes that agent's changes recoverable. With the agent
  given only `airlock-agent` and terminal verbs kept by the operator, it
  becomes the approval boundary.

The ratchet law bridges the two: one substrate, only the operator tightens
it. "Optional is not enforced" (README.md:71) stays true as a statement about
binding strength and stops being the product's name.

**Thesis.** Airlock is the change-safety layer for agents doing system work:
every mutation is recoverable by construction, and every irreversible step is
a separate decision the operator can see and approve.

**README first screen (replaces README.md:7-13).** It must show `rm` in the
first twenty lines; that is what the redirected agents read.

> **Recoverable system changes for agents. Keep Bash and Python.**
>
> When an agent needs to delete or replace something, Airlock does it as a
> rename into Hold: instant on the same volume, undoable until someone
> deliberately reaps it.
>
> ```sh
> airlock rm build/ out/cache --label cleanup   # held, not deleted
> airlock undo act_…                             # exact act back
> airlock reap --label cleanup --dry-run         # what reaping would free
> ```
>
> External requests wait in an Outbox until a supervisor commits them.
> Reviewed directory replacements (`airlock change`) apply exactly the digest
> that was approved. Every step leaves a receipt. Adopted by an agent, Airlock
> makes its changes recoverable; when a harness gives the agent only
> `airlock-agent` and keeps apply, commit, undo, and reap for the operator,
> Airlock becomes the approval boundary. `change` is for reviewed
> replacements; to delete, use `rm`.

**package.json description.** `Change-safety layer for agents doing system
work: recoverable mutations, staged external effects, digest-bound approval,
and durable receipts.`

**Binding-strength bullet (replaces README.md:71-73).**

> - **Binding strength is set outside Airlock.** An agent that keeps direct
>   shell or write access can route around Airlock; for that agent it is a
>   recovery layer, not a barrier. It becomes a boundary only when production
>   authority is externally owned: the harness withholds direct access,
>   exposes `airlock-agent`, and the operator keeps apply, commit, undo, and
>   reap.

Matching edits: README.md:87 heading → "The substrate: Hold, Outbox, and four
effect classes"; DESIGN.md:296 "This optional tool becomes…" → "Airlock
becomes…"; DESIGN.md:301 → "Adoption evidence"; docs/security-model.md:45 →
"a recovery layer for its own changes, not a barrier".

## 3. What Airlock gives agent safety today

| property | mechanism | receipt | status |
|---|---|---|---|
| Changes stay correctable, so the operator keeps oversight | managed mutations rename into Hold; one physical delete | `src/Hold.ts:1657`; `test/authority-sites.test.ts:23-33` | invariant |
| One door to the outside world | sole `fetch` inside `Outbox.commit` | `src/Outbox.ts:561`; `test/authority-sites.test.ts:15-21` | test-enforced rule (§8) |
| An agent cannot widen its own authority | `airlock-agent` rejects `--profile`; supervisor pins the profile | `src/agent-cli.ts:7-14`; `src/cli.ts:360` | invariant (ratchet) |
| The agent proposes, the operator decides | agent `change` surface is stage/inbox/review only | `src/cli.ts:680`, `:727` | implemented for `change`; reap is ungated on the supervisor binary (§1.2) |
| Irreversible acts become approvable decisions | apply requires the reviewed digest | `src/change/Change.ts:205`; `src/cli.ts:682` | implemented for `change`; direction for reap (§4.1) |
| Honest uncertainty, no silent retry | stranded send becomes `uncertain`; a Plan cannot replay | `src/Outbox.ts:469`; `src/runtime/Runtime.ts:370-377` | implemented |
| Recovery never clobbers something newer | undo refuses drift; no-replace renames | `src/Hold.ts:1550`; `src/platform/macos/MacosExclusiveRename.ts:155` | implemented |
| Auditability | schema-valid JSONL ledger; apply/undo receipts | `src/Ledger.ts:17-25`; `src/change/Checked.ts:18-25` | implemented, not tamper-evident; answered "was it airlock?" in §1.2 |
| A class of accidents removed | executable + argv atoms, no command-string form | `src/plan/Plan.ts:115` | implemented, Airlock language only |

**Never claim** that Airlock aligns agents, checks intent, or "guarantees safe
execution" (a pitch-deck draft already said this, `antigravity:158c0fe6`);
that it contains an agent with ambient shell; that compatibility-mode
children are mediated; that the audit trail is tamper-proof under the same
UID; that approval proves a human read every byte; or that a push or other
external effect is undoable after dispatch.

## 4. Mechanics

### 4.1 Reap selection and preview (priority 1)

Replace the positional `reap(olderThanMillis, retirement?)` with one tagged
selection:

```ts
// domain.ts — public
export const ReapSelection = Schema.Union(
  Schema.TaggedStruct("Age",   { olderThanMillis: NonNegativeInt }),
  Schema.TaggedStruct("Acts",  { ids: Schema.NonEmptyArray(ActId) }),
  Schema.TaggedStruct("Label", { label: HoldLabel, olderThanMillis: NonNegativeInt })
)
// Hold.ts — internal, never on the service tag
type InternalReapSelection = ReapSelection | { _tag: "Retirement"; journal: HoldJournal }
```

One `select` function feeds `Hold.reap` and a write-free `Hold.previewReap`,
so what the operator approves is exactly what is unlinked. This replaces the
field agent's `held | grep -vcE … || abort`.

- **Candidates.** `Age`/`Label` filter by age (and exact label); `Acts` names
  ids. Selection narrows *before* today's eligibility loop
  (`src/Hold.ts:1623-1640`), which stays the gate.
- **Do not generalize `Retirement`.** It skips the gate (safe only because
  `collectChangeSnapshots` pre-checked correlation, `:2029-2050`) and deletes
  `payloadFile`, not `actDir`. A user id routed there could reap an act pinned
  by an in-flight `change`.
- **Excluded acts** carry a reason: `snapshot-retirement`, `checked-pinned`,
  `checked-unsettled`, `retirement-pinned`, `undo-unsettled`. `Age`/`Label`
  skip and report them; `Acts` fails whole before the first unlink:

```ts
export class ReapSelectionRejected extends Schema.TaggedError<ReapSelectionRejected>()(
  "ReapSelectionRejected",
  { unknown: Schema.Array(ActId),
    ineligible: Schema.Array(Schema.Struct({ id: ActId, reason: ReapIneligibleReason })) }
) {}
```

- **Defaults.** Bare `reap` keeps its meaning (age, 7d). `--label` defaults
  age to 0; `--id` ignores age. Otherwise `reap --id` on a fresh act, the
  field case, silently does nothing.
- **Daemon.** One call site, `src/daemon/Daemon.ts:285`, becomes
  `reap({ _tag: "Age", olderThanMillis })`. A label selects; it does not pin
  against daemon age-reap.

### 4.2 Labels, batch remove, exact undo (priority 2)

- `HeldManifest.label: Schema.optional(HoldLabel)`, pattern
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, branded, optional in the schema the
  legacy decode uses (`src/Hold.ts:313`), like `purpose`. Only
  `Hold.remove(target, { label? })` sets it; every later manifest write
  spreads `...manifest`, so it survives undo and recovery.
- `rm <path...> [--label L]`: **one act per target** (a multi-target act would
  make `HeldManifest.target` a list, share one prepared→held journal, and make
  undo all-or-nothing). Each target is admitted separately. **Continue and
  report**, exit 1 if any failed — bash `rm a b c` parity. Two or more targets
  without `--label` get `batch-<hex>`, printed. One target, no label: output
  byte-identical to today's `RemoveReceipt`. The field session's 393 calls
  become three.
- `rm --glob '<pattern>' --root <dir>`: Airlock expands the pattern itself,
  prints every match in the receipt, and holds each one. This is the shape the
  operator actually blocked (§1.1): the expansion becomes visible and
  receipted instead of trusted. An empty `--root` or zero matches fails; it
  never widens to `/`.
- **Every receipt prints its exact undo.** `rm` prints `airlock undo <act-id>`
  (and `undo --label L` for batches). Bare `undo` restores the newest act in
  the whole home; with several agents sharing `~/.airlock`, the junto agent's
  advice "`airlock undo` restores it" (`b6973bcc:1288`) would have undone
  another agent's act. The skill forbids recommending bare `undo`.
- `undo --label L`: undoes `held` acts with that label newest-first; continues
  on `UndoConflict`.

### 4.3 Bytes: observed first, logical demoted (priority 2)

The field reap would have reported 211 GB for a 3 GB reclaim. A number that
misleads the operator into distrusting Airlock is worse than none.

- **`observedFreedBytes`** leads every reap report: the `statfs(holdDir)`
  available-bytes delta across the reap, labelled observed (includes other
  writers). Absent, never fatal, if statfs is unavailable (unverified whether
  Bun exposes `fs.statfs`).
- **`logicalBytes`** (`lstat` walk before the `uninterruptibleMask`, no
  symlink follow, hardlinks once) is reported as "logical size; clones and
  snapshots share blocks, so reaping may free much less". Never labelled as
  space freed.
- **Preview cannot promise freed bytes.** Say so in the `--dry-run` output
  instead of estimating.
- `RetainedMetadata.bytes` is an install-identity check (`src/Hold.ts:745`),
  not a size; it is not reused. `rm` stays O(1) and prints "held; nothing
  freed until reap".

### 4.4 Disk-reclaim journey (priority 2)

When the task is freeing disk, holding is not the goal, and the agent will
reap at once unless the flow gives it a better rhythm:

1. Hold per batch with a label (`rm --label chrome-cft …`).
2. Verify the system still works; trial-undo one act.
3. `reap --label chrome-cft --dry-run`: acts, logical size with the clone
   caveat.
4. The operator approves one reap per label; the report shows observed freed
   bytes.

A separate `AIRLOCK_HOME` stops being necessary: the label is the batch.

### 4.5 Agent surface

- **Ship `airlock-agent` in `dist/`** and make it the documented agent entry.
  Agents run whatever binary `dist/` has; with only the supervisor binary,
  "operator approves reap" held for one batch of three.
- **Unsealed `airlock-agent` gets preview, not reap** (`held --reapable`).
- **Add `airlock-agent rm <paths…> [--label] [--glob]` as sugar** over the
  `file.remove` program path. It adds no authority: `eval` already admits
  `file.remove`. *Verified:* `airlock-agent eval --workspace W --bindings
  '{"targets":[…]}' --source 'for t in targets { file.remove({ path: t }) }'`
  held two directories as two acts.
- **Sealed:** unchanged; `--id`/`--label` only narrow a granted `reap`.

### 4.6 Visibility fixes

- **Failure reasons.** *Verified:* `file.remove` outside `--workspace` fails
  as `RuntimeNodeFailure: runtime node … finished failed` with no cause.
  Carry the tagged cause (outside workspace, `CrossVolumeHold`, admission).
- **Long-held acts.** A Hold nobody reaps becomes the 37 GB Trash. `held` and
  `doctor` report count, age, and logical size of held acts — reported, never
  auto-reaped. `~/.airlock` today holds 9 `held` acts back to July
  (*verified*), including two regenerable `feed-shots` directories from the
  "clear and recreate" pattern that dominates junto (30+ occurrences).
- **Live databases.** A junto agent held `junto.db-wal` and `junto.db-shm`.
  Renaming WAL/SHM files away from an open SQLite database corrupts it as
  surely as `rm`. `rm` warns on `*-wal`, `*-shm`, `*.sqlite*`, `*.db` targets
  (a warning is visibility, allowed by default).

### 4.7 Git history

The largest unguarded loss on record is git history and remotes
(`grok:1de7a7ec`). Airlock-shaped answers, stated honestly:

- **Local:** before `filter-repo`, `rebase`, or deleting branches, hold a
  same-volume `git clone --mirror` as an Airlock act; delete a backup branch
  through Hold, never `branch -D`. Agent-made backups are recovery material:
  only the reaper destroys them.
- **Remote:** a push is an emission. Airlock cannot undo it; staging pushes in
  Outbox is direction only (Outbox dispatches HTTP today).

### 4.8 CLI surface

| command | behavior |
|---|---|
| `rm <path...> [--label L] [--glob P --root D]` | §4.2; prints exact undo |
| `held [--label L] [--sizes]` | filter; no flags → today's output; summary of age/count |
| `held --reapable [--id…\|--label L] [--older-than D]` | agent-visible preview, same `select` |
| `reap [--id…\|--label L] [--older-than D] [--dry-run]` | `--id`/`--label` exclusive; `--dry-run` = preview |
| `undo --label L` | §4.2 |

Output shapes: `RemoveBatch { label, results: Held | Failed }`, `UndoBatch`,
`ReapPlan { selection, acts, skipped, logicalBytes, note }`, `ReapReport`
gains `skipped`, `observedFreedBytes?`, `logicalBytes`.
`HoldReapRecoveryRequired` keeps its shape.

## 5. Adoption: redirect, don't just deny

The operator has already installed the blocker; what is missing is the
redirect. Held removal is a rename, so it is safer *and* faster on the same
volume (measured by one reviewer, not re-run: 20k-file tree, `rm -rf` 3.25 s
vs `airlock-agent eval file.remove` 1.23 s, 0.89 s of it CLI startup).

Ranked:

1. **README first screen** (§2, S). The evidence ties adoption to it
   directly.
2. **Groundwork names Airlock** (S, in the Groundwork repo). Every rule with
   a recoverable equivalent carries it in the message, e.g. `…(rule:
   rm.recursive-force). Recoverable instead: airlock-agent rm <targets…>
   --label <task>; the operator reaps.` Treat `airlock rm` as allow and
   `airlock reap`/`undo` as gated. Close the gaps the sessions exposed: `rm -r`
   without `-f`, unexpanded globs in any location (including temp roots),
   `mv` to the Trash, `git filter-repo`, `branch -D`, `tag -d`,
   `push --delete`, `push --force-with-lease`. Rows with no Airlock
   equivalent say so instead of only blocking. This replaces the earlier idea
   of an `airlock hook claude-code`: Groundwork already runs in several
   harnesses, and the operator already opted in, so the ratchet is untouched.
3. **Agent skill + AGENTS.md block** (S). When: deleting, overwriting, or
   moving existing data — including scratchpads when a glob or variable
   derives the path. Rhythm: **hold** (one call, a label), **verify**,
   **ask** (`held --reapable`; the operator runs `reap`/`undo`). Keep the
   receipt: never discard `rm` output (`b6973bcc:1313` piped it to
   `/dev/null`), stop on a non-zero exit, report act ids. Never recommend
   bare `undo`. Cross-volume: stop and ask, never fall back to `rm`, `mv`, or
   the Trash.
4. **Ship `airlock-agent` in `dist/`; install story** (S). Quickstart ends
   with `install:macos`; `doctor` reports `installed`/`fromSource` and the
   Hold device so agents can predict `CrossVolumeHold`.
5. **Mechanics §4.1–4.6** in the sequence below.

Docs wording for any hook: "A hook redirects common destructive shapes. It
is not a boundary: an agent with Bash can route around it, and a hook that
crashes fails open."

## 6. Sequence

1. README first screen and positioning edits (§2); ship `airlock-agent` in
   `dist/`.
2. `ReapSelection` + preview + label (§4.1, §4.2 label).
3. Variadic and `--glob` `rm`, exact-undo receipts, `airlock-agent rm` sugar.
4. Bytes (observed first), disk-reclaim journey docs, failure reasons,
   long-held and live-database warnings.
5. `undo --label`; skill; Groundwork redirect messages (cross-repo).
6. Git-history recipe in the skill.

## 7. Required tests

`test/authority-sites.test.ts` unchanged and green (one `fs.remove(`);
`Acts` all-or-nothing (unknown + valid id → rejected, zero unlinks, ledger
byte-identical); `Acts` respects every gate reason (property test); `Acts`
ignores age; `Label` exact; preview ids equal reaped ids and preview writes
nothing; label schema bounds and legacy-journal decode; variadic `rm`
continue-and-report and single-target byte parity; `--glob` with empty root
or zero matches fails and never widens; every `rm` receipt carries its exact
undo; sealed per-target admission; `undo --label` newest-first and never
unlinks; `observedFreedBytes` absent-not-fatal on statfs failure, logical
bytes exact over a hardlink/symlink fixture; `Retirement` unreachable from
the public tag (`@ts-expect-error`); daemon age-reap unchanged; unsealed
agent verb set has no `reap`; `dist/` build emits both binaries.

## 8. Open decisions

- **Agent `undo`.** Trial undo built trust in the field, and `undo` is
  supervisor-only. Recommended: keep it there; the agent requests it with the
  exact act id. Alternative: add it to `airlock-agent` (undo is itself
  Hold-recoverable, but it changes the paired-binary split).
- **Single-wire rule.** One `fetch` in `Outbox.commit` is test-enforced and in
  AGENTS.md, but DESIGN.md names only two frozen laws. Promote it, or record
  why it is a rule and not a law.
- **"Two-phase everywhere" (DESIGN.md).** Overclaims until §4.1 lands; reword
  to "two-phase for replace and emit; reap preview is direction" until then.
- **Groundwork changes live in another repo.** This RFC specifies them; they
  ship there.
