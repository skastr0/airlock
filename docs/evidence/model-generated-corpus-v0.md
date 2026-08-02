# Model-generated corpus campaign v0

> Status: executed local evidence from one live authoring campaign. This is
> NOT the acceptance corpus and supports no acceptance-rate claim. Boundary:
> 8 tasks from `examples/corpus/tasks/`, cold sidechannel-only agents (each
> attempt authored from the regenerated cold-start brief with no repository
> access), two models (`claude-fable-5`, `claude-opus-5[1m]`) inside one
> orchestration run, single macOS machine (Bun 1.3.14), one program per
> attempt scored by `scripts/corpus-harness.ts`.

## What ran

Each attempt: a cold model authored one `.air` program from the sidechannel
brief; the harness ran it against the task spec in an isolated realm (fresh
temp workspace + private `AIRLOCK_HOME`) and classified the outcome from
decoded receipts and bytes on disk. Raw programs are checked in under
`campaign/task-<n>/attempt-<k>.air` (11 files across 8 task directories;
verified present on this machine, 2026-08-02).

## Per-task results

| # | task | model | attempts | success | wall ms (total) | failure taxonomy |
|---|------|-------|----------|---------|-----------------|------------------|
| 1 | collate-documents | claude-fable-5 | 3 | no | 1475 | parse: MissingRecordField `size` on `file.stat` result; parse: MissingRecordField `size` on `file.inspect` result; predicate: `result.minimum bytes >= 40` failed with value=67 (string from `wc` stdout, strict number check) |
| 2 | 02-heading-report | claude-opus-5[1m] | 1 | yes | 417 | — |
| 3 | pipe-through-parser (04-pipe-through-parser.json) | claude-fable-5 | 1 | yes | 447 | — |
| 4 | 04-pipe-through-parser | claude-opus-5[1m] | 1 | yes | 428 | — |
| 5 | inventory-manifest (05-inventory-manifest.json) | claude-fable-5 | 1 | yes | 1658 | — |
| 6 | promote-staged-build (06-promote-staged-build.json) | claude-opus-5[1m] | 1 | yes | 474 | — |
| 7 | wordcount-summary | claude-fable-5 | 2 | yes | 835 | parse (attempt 1) |
| 8 | 08-sorted-index | claude-opus-5[1m] | 1 | yes | 477 | — |

Note: tasks 3 and 4 exercised the same task spec
(`04-pipe-through-parser.json`) once per model; no attempt in this campaign
ran `03-snapshot-stage-webhook.json`.

## Aggregates

- Tasks succeeded: 7 of 8 rows (the single failure is collate-documents,
  claude-fable-5, exhausted at 3 attempts).
- Total attempts: 11.
- First-attempt success: 6 of 8 rows.
- Turns-to-success over the 7 successful rows: mean 1.14 (six at 1, one at
  2); the failed row contributes 3 attempts with no success.
- By model: claude-fable-5 3/4 rows succeeded (7 attempts);
  claude-opus-5[1m] 4/4 rows succeeded (4 attempts, all first-try).
- Failure taxonomy across all failed attempts (4): 3 parse-class (schema
  decode of tool results — twice a missing `size` record field), 1
  predicate-class (numeric expectation against a string value from `wc`
  stdout under strict number checking).

## Cross-check re-run

One recorded success was independently re-run on this machine (2026-08-02):

```
bun run scripts/corpus-harness.ts \
  --task examples/corpus/tasks/04-pipe-through-parser.json \
  --program campaign/task-4/attempt-1.air --json
```

Harness verdict: `"outcome": "passed"`, CLI exit code 0, all file and result
expectations passed (including `result.contains selected :: ERROR disk full`
and `result.contains transformed :: ERROR SOCKET CLOSED`). This matches the
recorded campaign outcome for that row.

## Claim boundary (what this does and does not establish)

- Establishes (executed, this machine): the checked-in campaign programs
  exist; the harness reproduces at least one recorded success from its raw
  artifact; two cold models can author passing programs for 7 of these 8
  task rows within ≤3 attempts.
- Does NOT establish: acceptance-corpus performance, cross-machine
  reproducibility, other models, warm/contexted agents, or any rate on tasks
  outside this 8-row set (`03-snapshot-stage-webhook.json` untested here).
- Wall-clock figures are per-row totals reported by the orchestration and
  were not independently re-measured.
