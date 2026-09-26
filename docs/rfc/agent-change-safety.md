# RFC: Airlock as the change-safety layer for agents

> Status: **candidate design, not implemented.** Authored at `2189a67`; every
> `src/`/`test/` citation is pinned to that tree. Nothing here is an invariant
> or a v1 contract until it cites source and a named test. The two laws in
> [`DESIGN.md`](../../DESIGN.md) are untouched: `Hold.reap` stays the sole
> unlink site and every new surface only narrows or reports (the ratchet).
> Produced by four collaborating agents (framing, adoption, mechanics,
> coordination) from one field session; claims marked *verified* were re-run
> by the coordinator.

## 1. Why: the field session

A Claude session reclaiming disk on this Mac found 94 stale
Chrome-for-Testing copies (211 GB). Its first move was `rm -rf`; the operator
interrupted: "use a safer way of doing this — maybe use ../airlock". With
Airlock it held all 94 by same-volume rename in seconds, trial-undid one copy
(restored intact), and left the only irreversible step — reap — to the
operator. Its summary: "It turned one scary decision into two small ones."

It also hit four frictions, each a gap in this document:

| friction | gap |
|---|---|
| `reap` is all-or-nothing; a throwaway `AIRLOCK_HOME` was needed to avoid unrelated acts | reap selects only by age (`src/cli.ts:806`, `src/Hold.ts:1617`) |
| 93 separate `airlock rm` calls | `rm` takes one target (`src/cli.ts:732`) |
| nothing says how many bytes are held back or freed | `ReapReport` carries ids only |
| ran from `dist/`, not installed | adoption, not mechanics |

Two more gaps surfaced during the review:

- **Two-phase stops at the most dangerous verb.** DESIGN.md says "Two-phase
  everywhere", but reap, the one irreversible verb, has no preview, and `held`
  hides `restored` journals that reap still collects (`src/Hold.ts:1602`).
- **The field agent used the supervisor binary.** `rm`, `undo`, and `reap` are
  supervisor verbs (`src/cli.ts:1624-1628`), absent from the `airlock-agent`
  list (`src/cli.ts:1648-1661`). "Operator approves reap" was etiquette, not a
  boundary.

## 2. Positioning: identity versus binding strength

The current docs call Airlock "an optional tool" (README.md:9, DESIGN.md:3/7,
package.json:6, docs/security-model.md:4/45). That conflates two things:

- **What it is:** the change-safety layer for agents doing system work.
  Mutations are recoverable by construction, external effects are staged, and
  every irreversible step is a separate, operator-visible decision.
- **How strongly it binds:** a harness choice. Adopted by an agent that keeps
  its shell, Airlock makes that agent's own changes recoverable. With the
  agent given only `airlock-agent` and terminal verbs kept by the operator, it
  becomes the approval boundary for those targets.

The ratchet law is the bridge: one substrate, and only the operator turns it
tighter. "Optional is not enforced" (README.md:71) stays true as a fact about
binding strength; it stops being the product's name.

**Thesis.** Airlock is the change-safety layer for agents doing system work:
every mutation is recoverable by construction, and every irreversible step is
a separate decision the operator can see and approve.

**README opener (replaces README.md:7-13).**

> **Recoverable system changes for agents. Keep Bash and Python.**
>
> Airlock is the change-safety layer for agents that touch real systems.
> Removals and replacements are renames into Hold, undoable until someone
> deliberately reaps them. External requests wait in an Outbox until a
> supervisor commits them. Reviewed replacements apply exactly the digest that
> was approved. Every step leaves a receipt. Adopted by an agent, Airlock
> makes its changes recoverable; when a harness gives the agent only
> `airlock-agent` and keeps apply, commit, undo, and reap for the operator,
> Airlock becomes the approval boundary. Same substrate — only the operator
> tightens it.

**package.json description (143 chars).** `Change-safety layer for agents
doing system work: recoverable mutations, staged external effects,
digest-bound approval, and durable receipts.`

**Binding-strength bullet (replaces README.md:71-73).**

> - **Binding strength is set outside Airlock.** An agent that keeps direct
>   shell or write access can route around Airlock; for that agent it is a
>   recovery layer, not a barrier. It becomes a boundary only when production
>   authority is externally owned: the harness withholds direct access, exposes
>   `airlock-agent`, and the operator keeps apply, commit, undo, and reap.

**Heading (replaces README.md:87 "Existing tools, still optional").** `The
substrate: Hold, Outbox, and four effect classes`, opening with: the `change`
journey is built on the same parts that make everyday agent work recoverable.

Matching edits: DESIGN.md:296 "This optional tool becomes…" → "Airlock
becomes…"; DESIGN.md:301 → "Adoption evidence"; docs/security-model.md:45 →
"a recovery layer for its own changes, not a barrier".

Add the everyday journey the README never shows, and that the field used:
hold → verify → trial undo → operator reap. `change` cannot serve it: trees cap
at 64 MiB / 4,096 entries (`src/change/Tree.ts:36`), there is no remove
proposal, and `change` refuses sealed installs (`src/cli.ts:646`).

## 3. What Airlock gives agent safety today

| property | mechanism | receipt | status |
|---|---|---|---|
| Changes stay correctable, so the operator keeps oversight | managed mutations rename into Hold; one physical delete | `src/Hold.ts:1657`; `test/authority-sites.test.ts:23-33` | invariant |
| One door to the outside world | sole `fetch` inside `Outbox.commit` | `src/Outbox.ts:561`; `test/authority-sites.test.ts:15-21` | test-enforced rule (see §7) |
| An agent cannot widen its own authority | `airlock-agent` rejects `--profile`; supervisor pins the profile | `src/agent-cli.ts:7-14`; `src/cli.ts:360` | invariant (ratchet) |
| The agent proposes, the operator decides | agent `change` surface is stage/inbox/review only | `src/cli.ts:680`, `:727` | implemented |
| Irreversible acts become approvable decisions | apply requires the reviewed digest; interactive approve binds what was shown | `src/change/Change.ts:205`; `src/cli.ts:682` | implemented for `change`; direction for reap (§4.1) |
| Honest uncertainty, no silent retry | stranded send becomes `uncertain`; a Plan cannot replay | `src/Outbox.ts:469`; `src/runtime/Runtime.ts:370-377` | implemented |
| Recovery never clobbers something newer | undo refuses drift; no-replace renames | `src/Hold.ts:1550`; `src/platform/macos/MacosExclusiveRename.ts:155` | implemented |
| Auditability | schema-valid JSONL ledger; apply/undo receipts | `src/Ledger.ts:17-25`; `src/change/Checked.ts:18-25` | implemented, not tamper-evident |
| A class of accidents removed (word splitting, interpolation) | executable + argv atoms, no command-string form | `src/plan/Plan.ts:115` | implemented, Airlock language only |

**Never claim** that Airlock aligns agents or checks intent (DESIGN.md
non-goals); that it contains an agent with ambient shell; that
compatibility-mode children are mediated; that the audit trail is tamper-proof
under the same UID; that approval proves a human read every byte; or that an
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

One `select` function feeds both `Hold.reap` and a new, write-free
`Hold.previewReap`, so what the operator approves is exactly what is unlinked.

- **Candidates.** `Age` and `Label` filter by age (and exact label); `Acts`
  names ids. Selection narrows *before* today's eligibility loop
  (`src/Hold.ts:1623-1640`), which stays the gate.
- **Do not generalize the `Retirement` path.** It skips the gate (safe only
  because `collectChangeSnapshots` pre-checked correlation, `:2029-2050`) and
  deletes `payloadFile`, not `actDir`. A user id routed there could reap an act
  pinned by an in-flight `change`.
- **Excluded acts** carry a reason: `snapshot-retirement`, `checked-pinned`,
  `checked-unsettled`, `retirement-pinned`, `undo-unsettled`. `Age`/`Label`
  skip and report them. `Acts` fails the whole call before the first unlink:

```ts
export class ReapSelectionRejected extends Schema.TaggedError<ReapSelectionRejected>()(
  "ReapSelectionRejected",
  { unknown: Schema.Array(ActId),
    ineligible: Schema.Array(Schema.Struct({ id: ActId, reason: ReapIneligibleReason })) }
) {}
```

- **Defaults.** Bare `reap` keeps its meaning (age, 7d). `--label` defaults age
  to 0; `--id` ignores age. Otherwise `reap --id` on a fresh act, the field
  case, would silently do nothing.
- **Daemon.** One call site, `src/daemon/Daemon.ts:285`, becomes
  `reap({ _tag: "Age", olderThanMillis })`. A label does not protect a batch
  from daemon age-reap; document that a label selects, it does not pin.

### 4.2 Labels and batch remove (priority 2)

- `HeldManifest.label: Schema.optional(HoldLabel)`, pattern
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, branded. Optional in the same schema
  the legacy decode uses (`src/Hold.ts:313`), like `purpose`. Only
  `Hold.remove(target, { label? })` sets it, so labels never reach
  overwrite, displaced, runtime-private, or change acts. Every later manifest
  write spreads `...manifest`, so it survives undo and recovery.
- `rm <path...> [--label L]`: **one act per target** (a multi-target act would
  make `HeldManifest.target` a list, share one prepared→held journal, and turn
  undo all-or-nothing). Each target is admitted separately through the
  existing chain. **Continue and report**, exit 1 if any failed — bash `rm a b
  c` parity; stop-on-first would be a new restriction. Two or more targets
  without `--label` get `batch-<hex>`, printed. One target, no label: output
  byte-identical to today's `RemoveReceipt`.
- `undo --label L`: undoes `held` acts with that label newest-first (so
  `rm a/b; rm a` restores `a` first); continues on `UndoConflict`. If the
  operator had rejected the Chrome cleanup, this is one command instead of 94.

### 4.3 Bytes (priority 3)

`RetainedMetadata.bytes` is an install-identity check (`src/Hold.ts:745`), not
a size, so it is not reused. On APFS logical size is not space freed (clones,
local snapshots). Report both, and keep `rm` O(1):

- `logicalBytes`: `lstat` walk of the delete target, no symlink follow,
  hardlinks once by `(dev, ino)`. It runs per act *before* the
  `uninterruptibleMask`, so interrupting the walk never half-reaps.
- `observedFreedBytes`: `statfs(holdDir)` delta across the reap, labelled
  observed; absent (never fatal) if statfs is unavailable. Unverified: whether
  Bun exposes `fs.statfs`.
- `held --sizes` runs the same walk on demand; `rm` prints "held; nothing
  freed until reap".

### 4.4 CLI surface

| command | behavior |
|---|---|
| `rm <path...> [--label L]` | §4.2 |
| `held [--label L] [--sizes]` | filter; no flags → today's output |
| `held --reapable [--id…\|--label L] [--older-than D]` | agent-visible preview, same `select` |
| `reap [--id…\|--label L] [--older-than D] [--dry-run]` | `--id`/`--label` exclusive; `--dry-run` = preview |
| `undo --label L` | §4.2 |

Output shapes: `RemoveBatch { label, results: Held | Failed }`,
`UndoBatch`, `ReapPlan { selection, acts, skipped, logicalBytes }`,
`ReapReport` gains `skipped`, `logicalBytes`, `observedFreedBytes?`.
`HoldReapRecoveryRequired` keeps its shape.

### 4.5 Agent surface

- **Unsealed `airlock-agent` gets preview, not reap.** `held --reapable` lets
  the agent hand the operator an exact proposal (`airlock reap --id … = N
  bytes`); the operator runs the irreversible step.
- **Add `airlock-agent rm <paths…> [--label]` as sugar.** It lowers to the
  `file.remove` program path, not a direct Hold call, so it adds no authority:
  `eval` already admits `file.remove`. *Verified:*
  `airlock-agent eval --workspace W --bindings '{"targets":[…]}' --source 'for t in targets { file.remove({ path: t }) }'`
  held two directories as two acts. docs/install.md's "direct mutation:
  absent" row becomes "direct Hold calls absent; admitted `file.*` present".
- **Sealed:** unchanged; `--id`/`--label` only narrow a granted `reap`.

### 4.6 Failure reasons (friction bug)

*Verified:* `file.remove` on a path outside `--workspace` fails with
`causeTag: RuntimeNodeFailure`, reason `runtime node … finished failed`, and
no cause. An agent that sees that goes back to `rm -rf`. Carry the tagged
cause (outside workspace, `CrossVolumeHold`, admission denial) into the
`failure` record. Visibility is compatibility-free safety, allowed by default.

## 5. Adoption: making the safe path the default path

The layer only matters if agents take it. Measured by the adoption agent (not
re-run): on a 20k-file tree, `rm -rf` took 3.25 s and `airlock-agent eval
file.remove` 1.23 s, 0.89 s of it CLI startup from source. Held removal is a
rename, so it is safer *and* faster on the same volume. Cross-volume fails as
`CrossVolumeHold` (`src/Hold.ts:771-785`) and never falls back to deletion.

Ranked:

1. **Agent skill + AGENTS.md block** (S). When: deleting, overwriting, or
   moving existing data outside temp roots. Rhythm: **hold** (one call, all
   targets, a label), **verify** (`held`, check the system still works),
   **ask** (show `held --reapable`; the operator runs `reap`/`undo`).
   Cross-volume: stop and ask, never fall back to `rm`.
2. **Failure reasons** (§4.6, S–M).
3. **`airlock hook claude-code`** (M). Reads PreToolUse JSON on stdin, runs a
   pure, table-tested classifier, and denies destructive shapes with the
   airlock command to use instead. It only reads and stats — no unlink, no
   emission. Not installed by default: installing it is the operator turning
   the ratchet. Levels `nudge|strict` only tighten; there is no agent-settable
   bypass. Escapes are operator-owned: approve an `ask`, run with `!`, add a
   disposable root, lower the level.
4. **`airlock-agent rm` sugar** (§4.5, M).
5. **`doctor` hints** (S): `install { path, installed, fromSource }` and
   `hold { dir, device }` so skill and hook can predict `CrossVolumeHold`.
6. **Install story** (S): README quickstart ends with `install:macos` and how
   to enable skill and hook; `--with-claude-hook` writes harness settings only
   when passed.

### Hook decision table (draft)

Commands are split on `; && || |` and newlines; `env`, `command`, `nohup`,
`time` prefixes stripped; targets resolved against `cwd` and stat'ed.
Always allowed: nonexistent targets, disposable roots (`$TMPDIR`, `/tmp`,
`/private/tmp`, `/private/var/folders`, operator globs), `>>`, `2>&1`,
`>/dev/*`.

| pattern | condition | nudge | strict | redirect |
|---|---|---|---|---|
| `rm -r`/`-R` | existing target | deny | deny | `airlock-agent rm <targets…> --label <task>`, then ask the operator to reap |
| `rm`, `unlink` | existing file | allow | deny | same, one target |
| `find -delete`, `-exec rm`, `xargs rm` | root outside disposable | deny | deny | `file.glob` then `file.remove` in one `eval` |
| `>`, `: >`, `truncate`, `cp /dev/null` | existing regular file | deny | deny | `file.write` (previous bytes held) |
| `mv` without `-n`/`-i` | destination exists | deny | deny | `file.move` holds the displaced destination |
| `cp` without `-n` | destination exists | allow | deny | `file.copy` |
| `git clean -f`, `reset --hard`, `checkout --`/`restore <p>` | always | deny | deny | `git stash push -u -m <why>` (not an Airlock verb; say so) |
| `rsync --delete`, `dd of=`, `shred`, `srm` | — | deny | deny | irreversible: stage elsewhere, ask |
| `airlock reap/undo/commit/flush/cancel`, `change approve/apply/recover/collect` | from the agent | ask | ask | terminal authority: the operator approves |
| `sudo` + any row | — | ask | ask | outside Hold's envelope |
| opaque (`sh -c`, `eval`, `$(…)`, `python -c` with `rmtree`) | contains a row | allow | ask | the operator decides |
| parse failure | — | allow | ask | — |

Docs wording: "The hook redirects common destructive shell shapes. It is not a
boundary: an agent with Bash can route around it through interpreters, and a
hook that crashes fails open."

## 6. Sequence

1. `ReapSelection` + preview + label field (§4.1, §4.2 label).
2. Variadic `rm` and `airlock-agent rm` sugar.
3. Failure reasons; skill + AGENTS.md block; positioning edits (§2).
4. `undo --label`; bytes.
5. Hook classifier; doctor hints; install story.

Required tests: `test/authority-sites.test.ts` unchanged and green (one
`fs.remove(`); `Acts` all-or-nothing (unknown + valid id → rejected, zero
unlinks, ledger byte-identical); `Acts` respects every gate reason (property
test); `Acts` ignores age; `Label` exact; preview ids equal reaped ids and
preview writes nothing; label schema bounds and legacy-journal decode; variadic
rm continue-and-report and single-target byte parity; sealed per-target
admission; `undo --label` newest-first, never unlinks; bytes exact over a
hardlink/symlink fixture, statfs failure non-fatal; `Retirement` unreachable
from the public tag (`@ts-expect-error`); daemon age-reap unchanged; unsealed
agent verb set has no `reap`; hook classifier table tests.

## 7. Open decisions

- **Agent `undo`.** Trial undo is what built trust in the field, and `undo`
  is supervisor-only. Recommended: keep it there; the skill has the agent
  request it and the hook turns a direct call into an operator prompt.
  Alternative: add it to `airlock-agent` (undo is itself Hold-recoverable, but
  it changes the paired-binary split).
- **Hook `ask` under auto permission mode.** Unverified whether `ask` reaches
  a human when the harness runs in auto mode. If not, terminal-authority rows
  use `deny` with "ask the operator" wording.
- **Single-wire rule.** The one-`fetch`-in-`Outbox.commit` rule is
  test-enforced and in AGENTS.md, but DESIGN.md names only two frozen laws.
  Promote it, or write down why it is a rule and not a law.
- **"Two-phase everywhere" (DESIGN.md).** Overclaims until §4.1 lands; reword
  to "two-phase for replace and emit; reap preview is direction" until then.
