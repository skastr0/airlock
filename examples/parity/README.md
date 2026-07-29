# Agent shell-parity corpus

These programs are executable acceptance fixtures for common, noninteractive
agent work. They exercise Airlock actions and existing Unix executables; they
do not add project-specific nouns or reimplement tool behavior.

| fixture | representative shell work | Airlock path |
|---|---|---|
| `filesystem.air` | inspect, read, list, glob, stat, mkdir, write, copy, move, remove | native actions admitted as `Capture` and `Apply`; mutations pass through Hold |
| `process-pipeline.air` | `grep ... | tr ...`, structured argv, captured stdout | separate `Invoke` plans with an explicit stdout artifact passed as stdin |
| `bounded-control.air` | guarded and repeated work | pure `if`, `assert`, and a statically bounded loop around admitted actions |
| `native-rewrite.air` | a tool rewrites a workspace file | native macOS Cell produces a private delta, then `Apply` merges it through Hold |
| `native-destructive.air` | `rm -rf protected` | `/bin/rm` runs only in the private Cell; its deletion delta passes through Hold and remains supervisor-undoable |

The Vitest files named `test/parity-*.test.ts` create isolated fixtures, run
these programs through the public CLI, and verify the resulting filesystem,
Plan nodes, receipts, and undo behavior.

The corpus is intentionally scoped. It demonstrates ordinary repository
scripting, not interactive PTYs, background daemons, host-confidentiality
containment, live databases, special files, remote machines, or endpoint
dispatch.
