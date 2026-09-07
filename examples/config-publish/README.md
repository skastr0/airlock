# Repeated configuration publishing: agent handoff only

**Implementation-target integration.** The glue tests use a fake agent; they
do not prove real Airlock staging, approval, retirement, or collection. The
parent integration must execute the real workflow before claiming it works.

This small Bash/Python example prepares a JSON configuration for a fictional
`scratch-api`, validates its environment and worker count (1–16), and submits
it with `airlock-agent change stage --source PATH --target PATH`. It emits a
versioned JSON handoff with proposal ID, full digest, target, Airlock home, and
operator instructions. **It never invokes the supervisor or approves anything.**

Requires Bash and Python 3. Uses installed `airlock-agent` from PATH, or falls
back to `bun src/agent-cli.ts` from this checkout. No command-string evaluation,
production paths, network call, or secret-bearing config is involved.

## Initialize once, submit repeatedly

Run from the repository root:

```sh
FIXTURE="$(bash examples/config-publish/publish.sh init)"
export AIRLOCK_HOME="$FIXTURE/airlock-home"
bash examples/config-publish/publish.sh stage "$FIXTURE" --workers 2
# Later, keep exactly the same fixture, target, and home:
bash examples/config-publish/publish.sh stage "$FIXTURE" --workers 4 --environment staging
```

Keep `FIXTURE` for subsequent sessions. `init` always creates a fresh scratch
fixture; **do not rerun it to evade proposal/storage capacity**. Stage requires
the existing home and target and will not recreate missing state. There is no
external target or home override. The home passed to the child is always the
fixture's home, even if the caller sets a different `AIRLOCK_HOME`.

Each submission regenerates `candidate/config.json`, leaving the live config
untouched. The candidate has an exact four-field schema: `version: 1`, fixed
`service: "scratch-api"`, `environment: "development" | "staging"`, and integer
`workers` between 1 and 16. Validation completes before invoking the agent.
New candidate bytes do not change an already staged immutable proposal.

Run submissions sequentially; this example does not coordinate concurrent
candidate writers. Multiple proposals can share a baseline: after one is
applied, another may be stale and must not be forced through. Regenerate and
stage against the new live baseline instead. Failed submission never means
approval; if communication or JSON decoding fails, a proposal may still have
been staged—inspect the existing inbox before retrying.

## Operator-owned follow-up (not run by these scripts)

Use the same `AIRLOCK_HOME`. Read the handoff's `proposalId` and
`proposalDigest`; review in the operator inbox or use the forthcoming approval
flow. These are **parent integration contracts**, not independently executed
evidence here:

```sh
ID='PASTE_PROPOSAL_ID'
airlock change inbox --human
airlock change approve "$ID"
# Instead of approval, cancel an unwanted staged proposal:
airlock change cancel "$ID"
# Inspect fresh inventory after cancellation; take this row's retirementDigest:
airlock change inbox
RETIREMENT_DIGEST='sha256:PASTE_RETIREMENT_DIGEST_FROM_INVENTORY'
airlock change retire "$ID" --expect-digest "$RETIREMENT_DIGEST"
airlock change collect "$ID"
```

These are alternative lifecycle actions, not a script to run blindly in order.
`approve` is interactive: the operator reviews and enters the exact reviewed
digest in a terminal. The agent submission never invokes it. Retirement uses
the inventory's `rows[].retirementDigest` (also shown by `inbox --human`), **not
the proposal digest in this handoff**. It binds the currently eligible snapshots
and workflow; cancel a staged proposal before retiring it. `collect` explicitly
reaps only retired snapshots while preserving apply undo payloads. Cancel alone
does not imply reclaimed capacity. When full, the operator manages retained
state through this lifecycle, not by deleting or resetting the home.

## Boundaries and tests

Scratch only: one ordinary user-owned regular file, bytes and ordinary POSIX
modes. No live database or service restart, remote deployment, confidentiality,
or same-UID malicious-tamper protection. Path/link checks prevent accidental
redirection, not hostile races. An agent with ambient target access can bypass
Airlock; external ownership of production authority is required for enforcement.
The demo's same-account roles do not supply that boundary.

```sh
python3 -B -m unittest discover -s examples/config-publish -p 'test_*.py' -v
```

Tests isolate a **fake agent on PATH** to check repeated staging, stable target
and home, validation-before-submission, refusal of target overrides/missing
homes, and handoff shape. They never execute supervisor commands and do not
substitute for the parent's real CLI integration checks.
