# airlock — design

The chamber between agents and the world. Nothing passes directly: local
mutations sit in the chamber (recoverable), external effects sit in the
chamber (cancellable until commit), arbitrary code runs inside a sealed cell.
Both doors never open at once.

The founding incident: an agent's installer test derived a write path from the
wrong root and truncated a real database through bash `>` — one character,
zero preview, zero recovery. Airlock exists so that class of event is a
non-event: recoverable by default, on the first day, with zero configuration.

## The metaphysics — four effect classes

Everything a shell command does decomposes into exactly four classes. Each
class gets its own physics:

| class | what it is | physics | verb status |
|---|---|---|---|
| **observation** | reads: files, env, responses | provenance-tagged at entry; screens (PII, injection) are opt-in filters on top of the tags | planned |
| **mutation** | local state change: write, delete, move | **undoable** — two-phase: every verb is a rename into the hold; only the reaper unlinks | `Hold` (v0) |
| **emission** | external effect: send, publish, push | **cancellable** — staged as data in the outbox; nothing on the wire until hold expiry or affirmative commit | `Outbox` (v0) |
| **computation** | running arbitrary code (ruby, python, npm) | **fenceable** — sealed cell: CoW clone of writable scope + OS fence; merge-back is the gated phase | planned |

## The two laws

**1. Only the reaper unlinks.** Every mutation verb is a rename into the hold
(`~/.airlock/hold/<act>/payload` + manifest). Rename is atomic on the same
volume and content-preserving, so the recovery floor is guaranteed by
construction, not by review. This holds recursively: undo itself never
destroys bytes (an undo that must clear the target *displaces* it into the
hold). The single unlink site in the codebase is `Hold.reap` — the second
phase, held by the reaper, never by the acting agent. A test enforces the
single-site invariant.

Damage is defined structurally: **damage = irreversible loss of the last copy
of unique bytes.** Deletion that is reversible for a window is not damage —
worst case it is disk pressure, which quotas and the reaper absorb.

**2. The ratchet law.** Zero-config behavior is bash parity, always. Safety
accrues only where it is free (staging, ledger, plan display — the
compatibility cost is zero). Restriction (scopes, net denial, gated merges,
hold windows) exists only where the user turned the ratchet — per project,
per path, per effect class, as deep as they care to go. Never-break outranks
every security property. Correctness-first tools (Nix, SELinux) die of
upfront cost; recovery-first tools (git, Time Machine) get adopted. Undo is
the product.

Corollary: **curation never gates capability.** Unknown tools run in the
loosest applicable tier with everything ledgered; curated profiles only ever
remove friction, and the profile registry has no completeness obligation.

## Two-phase everywhere

Every dangerous operation splits into the phase the agent may hold and the
point of no return the runner holds:

| operation | agent-held phase | runner-held phase |
|---|---|---|
| `rm -rf` | rename into hold | reap |
| overwrite | previous version into hold, write new | reap |
| send / publish | stage in outbox | commit (hold expiry or gate) |
| arbitrary code | run in cell against CoW clone | merge diff back |
| `git push --force` | push to quarantine ref | promote |

Emissions are the one class with no undo after commit — you cannot unsend.
The 30-second undo everyone wants is *delayed dispatch*: cancellation of a
queued value, not reversal of a sent one. All design effort lives before the
send.

## v0 scope (this prototype)

- `Hold` — undoable mutations: `rm`, `write`, `undo`, `held`, `reap`
- `Outbox` — cancellable emissions: `send`, `pending`, `commit`, `cancel`, `flush`
- `Ledger` — append-only JSONL record of every act
- CLI with JSON receipts on stdout (agent-native)
- `--scope` as the first ratchet (default `/` = parity)

## Roadmap (in dependency order)

1. **Cells** — computation class: CoW clone (APFS `clonefile`) of the
   declared writable scope, OS fence (Seatbelt/Landlock, srt-style), diff on
   exit, gated merge. Registry-scoped tier for package managers (lockfile
   diff as the manifest).
2. **Provenance tags** — observation class: origin tag on every byte entering
   through the runner; PII/injection screens as opt-in filters; "tainted
   bytes may not enter a URL" as a plan-time policy.
3. **Plan mode** — every verb dry-runs to a concrete manifest; execution
   binds to the manifest and halts on drift (kills TOCTOU/glob-drift).
4. **DSL concrete syntax** — a bash-like surface that parses to these verbs;
   interpret, never transpile; no shell-escape verb, ever.
5. **Flush daemon + quotas** — hold-expiry pump; disk-pressure handling.
6. **Prism integration** — airlock as the leaf altitude of prism workflows:
   typed graph at the top, capability-scoped verbs at the bottom.

## Non-goals

- Modeling tool semantics (curation is a friction cache, not a requirement)
- Supply-chain product features (registry-scoped cells make them *possible*;
  building them is someone else's product)
- Protection against kernel exploits (the fence is OS-boundary strong, not
  mathematical)
