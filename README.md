<p align="center">
  <img src="docs/assets/airlock-icon.png" width="128" alt="Airlock icon">
</p>

<h1 align="center">Airlock</h1>

<p align="center">
  <strong>The chamber between AI agents and your machine.</strong><br>
  A language and runtime that lets agents do real Unix work —<br>
  without the one-character disasters.
</p>

<p align="center">
  <code>macOS + Linux</code> · <code>Bun 1.3.11+</code> · <code>MIT</code> · <code>developer preview</code>
</p>

---

## The problem

Agents run shell commands on real machines. Real machines keep the only copy
of your database, your dotfiles, your half-finished novel.

Shell gives that arrangement exactly one protection layer: **nothing**.
No preview. No staging. No undo. No receipt. One mistyped redirect —
one `>` where a `>>` belonged — and the last copy of unique bytes is gone.
Not "an error occurred." Gone.

Airlock was founded on a real incident: an installer test derived a write path
from the wrong root and truncated a production database through Bash `>`.
One character. No recovery.

The natural fixes all fail:

- **"Be more careful"** — the incident rate scales with autonomy, and agents
  are getting more autonomous, not less.
- **"Approve every command"** — you become the bottleneck, and approval
  fatigue means you stop reading after the fifth one.
- **"Sandbox everything in a VM"** — heavy, slow, and it answers the wrong
  question. The agent usually *should* touch your files. That's the job.
  The question is whether its changes are **recoverable, staged, and
  receipted** — not whether they happen at all.

## The idea

Airlock decomposes everything an agent can do into **four effect classes**,
and gives each one a physics that makes it safe by construction:

| What the agent wants | Airlock class | What happens |
|---|---|---|
| Read the world | **observation** | `Capture` — information enters with provenance attached |
| Run existing programs | **computation** | `Invoke` — uses the selected execution profile, never a raw shell string |
| Change local files | **mutation** | `Apply` — the old state is renamed into **Hold** before the new one lands. Undo is a first-class verb |
| Call the network | **emission** | `RequestExternal` — the request is **staged** in the **Outbox**, not sent. Dispatch is a separate, supervisor-gated act |

Two laws govern the whole system:

1. **Only the reaper unlinks.** Every managed mutation is a rename through
   Hold. Nothing is ever deleted in place — so "undo" is not a feature, it's
   the architecture. A construction test fails the build if a second unlink
   site ever appears.
2. **The ratchet law.** Zero-config behavior is full bash parity — safety
   never comes at the cost of lock-in. Restrictions are opt-in turns of a
   ratchet: a profile may narrow authority, but an agent program can never
   widen it. No silent fallbacks, ever.

The result: an agent can `rm -rf` inside a native-contained private workspace,
apply its supported delta through Hold, and the supervisor can restore the
prior bytes. An agent can prepare an HTTP POST through Outbox, and nothing
touches the wire until someone — or an explicit policy — says so. Every run
returns a versioned JSON receipt of exactly what happened, what was planned,
and what failed.

```text
before:  agent ──bash──▶ your machine          (hope)

after:   agent ──.air──▶ plan ──▶ admit ──▶ run ──▶ receipt
                            │        │        │
                            ▼        ▼        ▼
                          typed    policy   Hold / Outbox
                          plans    gates    receipts
```

## A program in 30 seconds

Agents write `.air` programs — a small, total language with no shell strings,
no functions, no recursion, and no way to invent new effects:

```js
// create.air
return process.run({
  executable: "/usr/bin/touch",
  args: ["created.txt"],
  cwd: workspace,
  cellProfile: "native-contained",
  stdout: "capture",
  stderr: "capture"
})
```

Run it under a supervisor-owned policy (the program cannot pick its own
grants; see the [policy setup](docs/install.md)), then undo the whole thing:

```sh
AIRLOCK_POLICY_FILE="$PWD/policy.json" \
  airlock run create.air --workspace . --profile native-contained

airlock held     # what's recoverable right now
airlock undo     # put it back
```

Every step — admission, execution, the Hold transition — produces typed,
Schema-validated receipts. All CLI output is JSON, built to be consumed by
harnesses, not grepped by humans.

`airlock-agent` is the reduced command surface for harnesses: it exposes
program execution and read-only inspection, and omits raw `exec`, direct
mutation, dispatch, undo, and flush. When you give an agent `airlock-agent`
instead of a shell, the dangerous verbs simply aren't on the menu.

## The `.air` language

Total by construction. If it parses, it terminates.

```text
let <name> = <expression>          bind a value; no assignment, ever
if <expr> { … } else { … }         else optional
for <name> in <from>..<to> { … }   finite integer range
for <name> in <list> { … }         iterate a captured list
assert <expr>, "message"           fail the run on a false test
return <expression>                the program result
```

Values: strings, numbers, booleans, `null`, durations (`250ms`, `30s`, `5m`,
`2h`, `1d`), lists, records. Field access `a.b`, index `a[0]`. Operators
`|| && == != < <= > >= + - * / !`.

The entire action vocabulary — twelve verbs, no more:

| group | verbs |
|---|---|
| observations | `file.inspect` `file.read` `file.list` `file.glob` `file.stat` |
| managed mutations | `file.write` `file.remove` `file.move` `file.copy` `file.mkdir` |
| computation | `process.run` |
| external intent | `http.stage` |

No Git-specific verbs, no SQLite verbs, no tool-specific special cases.
Existing Unix programs keep their semantics — Airlock wraps *effects*, not
applications.

Inert JSON **tool definitions** can declare typed call shapes on top of this
vocabulary for better ergonomics. They never grant authority: a tool
definition that tries to assert a grant or pick a dispatch class gets a typed
refusal. Dispatch authority lives exactly one place — the supervisor's
policy.

## Profiles

- **`compatibility`** — zero-config, broad bash-like capability with receipts
  where compatible. No containment claim. The ratchet's starting position.
  Child writes and network sends retain ambient host authority and are not
  converted into Hold mutations or Outbox dispatches.
- **`native-contained`** (macOS and Linux) — private clone/copy workspace,
  live-host write denial, network denial, and declared direct-exec fencing;
  supported deltas are applied separately through Hold. macOS uses Seatbelt;
  Linux uses Bubblewrap 0.12+, Landlock ABI 2+, and a libseccomp launcher.
  Unsupported capabilities fail explicitly — they never degrade to
  compatibility. Both permit ambient host reads: neither is confidential or
  VM-equivalent. Linux supports deny-only networking and provides no resource
  quotas; executable-object fencing is not complete execution closure because
  hardlink aliases, ELF loaders, and in-process interpretation remain relevant.
- **`vm-enclosed`** — design direction. The CLI refuses it today rather than
  pretend.

## Status

**Usable developer preview.** macOS and Linux, Bun 1.3.11+. Compatibility and
native-contained profiles are implemented and exercised end to end. Direct
[Debian 12 x86-64 evidence](docs/evidence/linux-beachhead.md) covers adversarial
containment, shared native and Vouch workloads, and a real standalone
build/install/execution/uninstall cycle. This is a bounded host envelope, not
evidence for every Linux distribution or architecture. The claim
"replaces most shell usage for agents" is a written acceptance contract with
explicit gates — deliberately not yet claimed. See
[docs/acceptance.md](docs/acceptance.md) for the bar, and
[DESIGN.md](DESIGN.md) for the two laws and what would have to be true to
change them.

## Install

From a checkout; no npm release yet. On Linux, install the
[runtime and build prerequisites](docs/linux-v1.md#build-and-install) first:
glibc, working unprivileged user namespaces, Bubblewrap 0.12+ without setid bits
or file capabilities, Landlock ABI 2+, libseccomp, libcap tools, and GNU `cp`.
Blocked namespace/AppArmor policy is reported as unavailable, never bypassed.

```sh
bun install --frozen-lockfile
bun run verify
```

On macOS:

```sh
bun run build:macos
sh scripts/install-macos.sh
```

On Linux, build into a fresh directory and name the external Bubblewrap:

```sh
OUT="$(mktemp -d)"
bun scripts/build-linux.ts --out "$OUT"
sh scripts/install-linux.sh \
  --source "$OUT/airlock" \
  --agent-source "$OUT/airlock-agent" \
  --launcher-source "$OUT/airlock-linux-launcher" \
  --checksum "$OUT/airlock.sha256" \
  --bwrap /usr/local/bin/bwrap
```

The Linux installer verifies and probes all three artifacts before replacing
anything, and preserves prior bytes for rollback. Bundles are host-architecture
glibc builds; Bubblewrap remains an external prerequisite.

```sh
export PATH="$HOME/.local/bin:$PATH"
airlock doctor
airlock-agent actions
```

## Documentation

- [DESIGN.md](DESIGN.md) — the four effect classes and the two laws
- [Usage guide](docs/usage.md) — the language in 10 minutes, failure taxonomy, harness integration
- [Installation guide](docs/install.md)
- [Security model](docs/security-model.md)
- [Architecture](ARCHITECTURE.md) — implemented seams and design direction
- [macOS runtime profiles](docs/macos-v1.md)
- [Linux runtime contract](docs/linux-v1.md)
- [Executed Linux evidence](docs/evidence/linux-beachhead.md)
- [Airlock Programs field guide](docs/programs/README.md)
- [Evidence](docs/evidence/) — what has actually been executed, and the claim boundaries

## License

MIT
