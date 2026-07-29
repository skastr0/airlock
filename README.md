# Airlock

Airlock is the chamber between agents and the world: local mutations are held
for recovery, external intent is staged before dispatch, and machine effects
produce structured receipts.

**Current maturity: usable physics prototype; macOS v1 is under active
implementation.** The repository contains implemented Hold, Outbox, Ledger, Plan,
process, and language slices, but the integrated checkout must pass
`bun run verify` before any build is treated as usable. The macOS
shell-replacement claim is a published acceptance target and remains unearned
until the complete Plan/Cell/broker/profile corpus passes.

## Run the prototype

Requirements: Bun 1.3.x and a repository checkout.

```sh
bun install
bun run verify
```

All CLI output is JSON. `AIRLOCK_HOME` overrides the state directory; the
default is `~/.airlock`.

## Recover a local mutation

```sh
bun run src/cli.ts write ./example.txt 'first'
bun run src/cli.ts write ./example.txt 'second'
bun run src/cli.ts held
bun run src/cli.ts undo
```

The previous binding enters Hold before replacement. Undo restores it without
blindly destroying a newer value. `reap` is the only operation that
irreversibly discards retained recovery material:

```sh
bun run src/cli.ts reap --older-than 7d
```

## Stage an external request

```sh
bun run src/cli.ts send https://api.example.com/hook \
  --body '{"x":1}' \
  --hold 30s
bun run src/cli.ts pending
bun run src/cli.ts cancel emi_...
# or:
bun run src/cli.ts commit emi_...
```

`send` stages local data; nothing reaches the wire until `commit` or an
explicitly configured expiry flush. Cancellation before dispatch does not need
to pretend it can reverse a send.

## What macOS v1 means

The first release keeps one contract across three profiles:

- `compatibility` — zero-config capability parity; no containment claim.
- `vm-enclosed` — broad existing-tool support inside an Airlock-owned macOS VM
  with brokered host files and endpoints.
- `native-contained` — a faster, narrower subset backed by enforceable native
  macOS capabilities.

All profiles lower to the same four Plan nodes—Capture, Invoke, Apply, and
RequestExternal—and the same terminal laws: only Hold changes managed live
bindings, only Outbox commit dispatches external intent, and only Reaper
irreversibly discards recovery material.

Airlock will claim that v1 “replaces most shell usage for agents” only after an
agent with no shell or alternate machine-effect tool completes at least 90% of
the fixed representative corpus and every construction, containment, recovery,
endpoint, label, and persistent-authority gate passes three clean repetitions
on each published macOS/backend combination.

## Documentation

- [Design and the two laws](DESIGN.md)
- [macOS-first architecture](ARCHITECTURE.md)
- [macOS runtime profiles](docs/macos-v1.md)
- [Plan/runtime contract](docs/contracts/plan-runtime.md)
- [Security model](docs/security-model.md)
- [v1 acceptance contract](docs/acceptance.md)
- [Vouch-first adoption](docs/vouch-first.md)
- [Feedback disposition](docs/feedback-disposition.md)

## Known gaps

The checked-in prototype does not yet prove complete harness mediation,
production crash/concurrency durability, full execution closure, endpoint
brokerage, persistent-authority prevention, information-flow enforcement, or
the published VM/native shell-free corpus. See the acceptance contract for the
exact line between a developer preview and a release claim.
