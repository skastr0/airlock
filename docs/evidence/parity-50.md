# Fifty agent-surface executions

> Status: bounded repeatability and contract-coverage evidence. This is not a
> claim that Airlock completed fifty unique tasks or replaced most agent shell
> usage.

Run:

```sh
bun scripts/prove-parity-50.ts
bun x vitest run test/parity-50.test.ts \
  --testTimeout 300000 --hookTimeout 300000
```

The proof launches the real `src/agent-cli.ts` entrypoint as a new Bun
subprocess for every execution. The supervisor pins `AIRLOCK_AGENT_PROFILE`;
the program cannot select its own profile. Every CLI response is decoded
through an Effect Schema before any success is counted. The final JSON evidence
is also Schema-encoded and decoded before publication.

## What “50” means

The matrix contains ten deterministic, scripted cases. Each case runs five
times from a fresh temporary workspace and Airlock home:

```text
10 scripted cases × 5 fresh repetitions = 50 agent CLI executions
```

There are forty compatibility executions and ten native-contained executions.
A successful proof requires all 50 subprocesses to exit successfully, all 50
program reports to decode, and every case-specific host assertion to pass.

This is deliberately not described as:

- fifty unique tasks;
- fifty model-generated programs;
- a model task-completion benchmark;
- a direct-shell A/B comparison; or
- a held-out or independently selected corpus.

## Matrix

| Case | Profile | Contract exercised |
| --- | --- | --- |
| `capture-observe` | compatibility | `file.inspect`, `file.read`, `file.stat`, `file.list`, and `file.glob` Capture |
| `managed-files` | compatibility | managed mkdir/write/copy/move/remove through Apply and Hold |
| `structured-argv` | compatibility | executable plus literal argv atoms and captured stdout |
| `environment` | compatibility | explicit environment projection |
| `text-stdin` | compatibility | explicit text stdin and captured stdout |
| `artifact-pipeline` | compatibility | captured stdout artifact supplied as a second process's stdin |
| `failure-branch` | compatibility | nonzero process evidence and bounded fallback branching |
| `bounded-control` | compatibility | finite range, conditional control, managed writes, and Capture |
| `native-rewrite` | native-contained | private Cell rewrite followed by Apply through Hold |
| `native-create` | native-contained | private Cell creation followed by Apply through Hold |

The native-contained cases require macOS, `/usr/bin/sandbox-exec`, the declared
executable allowlist, a fresh supervisor policy, and the currently published
regular-file capability envelope. There is no fallback to compatibility.

## Evidence record

`scripts/prove-parity-50.ts` emits
`airlock/parity-50-proof/v1`, including:

- the exact repository `HEAD` observed before the run and whether the worktree
  was dirty;
- macOS version and build, architecture, Bun version, and agent entrypoint;
- all fifty invocation outcomes and their case, repetition, profile, counts,
  latency, and assertions;
- minimum, median, p95, maximum, mean, total invocation, and wall-clock
  latency;
- the exercised capability summary; and
- the explicit limitations below.

The test invokes the proof once and independently Schema-decodes its JSON. It
requires exactly ten case IDs, repetitions one through five for each case,
50/50 successes, forty compatibility results, ten native-contained results,
and a wall-clock duration below five minutes.

## Claim boundary

This artifact strengthens repeatability evidence for the current contracts. It
does not satisfy the representative-corpus contract required to say Airlock
“replaces most shell usage for agents.” In particular, it supplies no:

- model-generation measurement;
- direct-shell task, quality, or latency baseline;
- held-out task set;
- independent task selection;
- network-dispatch, PTY/job-control, daemon, live-database, special-file, or
  remote-filesystem coverage; or
- containment claim for the forty compatibility executions.

The two native-contained cases support only their tested macOS capability
envelope. Broader acceptance remains governed by
[`docs/acceptance.md`](../acceptance.md).
