# airlock — Agent Guide

Read `DESIGN.md` first — the four effect classes and the two laws (only the
reaper unlinks; the ratchet law) govern every change here.

## Rules

- Every mutation verb is a rename. Never add an unlink outside `Hold.reap`;
  a test counts the unlink sites and fails on a second one.
- Emissions touch the wire only inside `Outbox.commit`. Never add a second
  network site.
- Zero-config behavior is bash parity. New restrictions must be opt-in flags
  (the ratchet), never defaults.
- Components (`Hold`, `Outbox`, `Ledger`) are pristine: Schema-typed
  contracts, tagged errors, invariants tested. CLI wiring is glue — keep it
  plain.

## Validation

`bun run verify` (typecheck + tests) must pass before any done-claim.
