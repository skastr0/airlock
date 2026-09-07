# Scratch change example

**Implementation-target walkthrough; CLI integration is not yet validated.**
Requires Bash and Python 3 to generate the fixture, plus installed Airlock
binaries for the [stage → review → apply → undo journey](../../docs/changes.md).
No `.air` program, native containment, production paths, or running service.

For the full scripted journey, run from the repository root:

```sh
bash examples/changes/demo.sh
```

It prepares a fresh fixture, stages and reviews it (including opt-in diff),
and waits for you to type `APPLY` before applying the exact staged digest.
It then checks the installed files, undoes by receipt, and checks restoration.
Any other answer cancels. The script accepts no target arguments and must never
be adapted by substituting a real target. This scratch-only demo uses the
supervisor binary for approval and undo; it does not grant those verbs to agents.

To prepare a fixture for the manual walkthrough instead:

```sh
DEMO="$(bash examples/changes/prepare.sh)"
export AIRLOCK_HOME="$DEMO/airlock-home"
```

`prepare.sh` creates a new private temporary directory and invokes `generate.py`
to write candidate data before staging. It never invokes Airlock or applies a
change. `live/obsolete.txt` demonstrates whole-directory removal through Hold;
the candidate intentionally omits it. Use the linked walkthrough to review and
approve manually. The scripted demo reads the confirmed `id`, `proposalDigest`,
and `receiptId` JSON fields and checks `installed` / `undone` response states.

The fixture and its isolated Airlock home remain available for inspection and
recovery. No automatic cleanup or snapshot GC is implied. Keep demo storage
bounded. Running both roles under your account demonstrates recovery semantics,
not enforced separation of agent and supervisor authority.
