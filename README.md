# airlock

The chamber between agents and the world: every mutation recoverable, every
emission cancellable, everything ledgered.

**Status: v0 physics prototype.** The two core effect classes (undoable
mutations, cancellable emissions) work end-to-end with a ledger. Cells,
provenance tags, plan mode, and the DSL surface are roadmap — see
`DESIGN.md`.

```sh
# mutations — staged, recoverable; only `reap` ever unlinks
airlock rm ./build              # gone from the tree, bytes held
airlock undo                    # back, byte-for-byte
airlock write config.json '{}'  # previous version held
airlock held                    # what is recoverable right now
airlock reap --older-than 7d    # the second phase: reclaim held bytes

# emissions — staged as data, nothing on the wire until commit
airlock send https://api.example.com/hook --body '{"x":1}' --hold 30s
airlock pending
airlock cancel emi_...          # it was never sent
airlock commit emi_...          # affirmative gate: send now
airlock flush                   # send everything whose hold expired

# the record
airlock ledger
```

All output is JSON receipts (agent-native). `AIRLOCK_HOME` overrides the
state directory (default `~/.airlock`).

```sh
bun install
bun run verify   # typecheck + tests
```
