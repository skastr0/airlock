# airlock — Agent Guide

The design evolves. Code and tests are the source of truth; documents describe
them afterwards and never freeze them. If a document disagrees with the best
design, change the document.

## Rules

- No backward compatibility: one current shape per contract, no shims, no
  migration code.
- Enforce invariants in types and tests, not in prose.
- Components are pristine: Schema-typed contracts, tagged errors, invariants
  tested. CLI wiring is glue — keep it plain.

## Validation

`bun run verify` (typecheck + tests) must pass before any done-claim.
