<p align="center">
  <img src="docs/assets/airlock-icon.png" width="128" alt="Airlock icon">
</p>

# Airlock

**Review, apply, and undo consequential local changes. Keep Bash and Python.**

Airlock is an optional tool for work where replacing the wrong file or directory
would be expensive. Generate a candidate with the tools you already use; stage
it against one target; review it; let a supervisor apply exactly the approved
digest. Keep a receipt for checked undo and durable recovery.

**Developer preview · macOS + Linux · MIT.** The `change` workflow is implemented
with [executed Linux integration and recovery evidence](docs/evidence/reviewed-changes.md).
This is not production certification or macOS execution evidence. Existing
compatibility, `.air`, Cell, Hold, and Outbox features remain available; they
are not prerequisites for this first journey.

## First journey: a reviewed directory replacement

With `airlock` and `airlock-agent` installed and on PATH, prepare a disposable
fixture from this checkout (Bash and Python 3 required):

```sh
DEMO="$(bash examples/changes/prepare.sh)"
export AIRLOCK_HOME="$DEMO/airlock-home"
airlock-agent change stage --source "$DEMO/candidate" --target "$DEMO/live"
```

Copy the proposal ID from the JSON response into `ID`. Review the target,
baseline, candidate, and full digest before approval:

```sh
airlock-agent change review "$ID"
airlock-agent change review "$ID" --diff
```

As the supervisor, set `DIGEST` to the reviewed `sha256:` value with all 64 hex
digits, then apply it. Set `RECEIPT_ID` from the successful apply response:

```sh
airlock change apply "$ID" --expect-digest "$DIGEST"
airlock change status "$ID"
airlock change undo "$RECEIPT_ID"
```

Apply runs no arbitrary command: it installs the immutable staged candidate
only if the target still matches its recorded baseline. Editing the original
source after staging cannot alter the approved proposal. Undo refuses drift;
it is not an unconditional restore. Output is JSON; bounded per-path text
previews are opt-in with `--diff`. No `.air` program or native-contained setup
is needed. Try the scratch-only interactive demo directly from this checkout:

```sh
bash examples/changes/demo.sh
```

Read the [complete walkthrough and command contract](docs/changes.md), including
cancel, recovery, and deliberate drift checks.

## Where the guarantee stops

- **Optional is not enforced.** An agent with ambient direct access can bypass
  Airlock. Enforcement requires external ownership of production authority;
  the reduced CLI alone is not a security boundary.
- **Local replacement, not deployment.** Use quiescent, ordinary user-owned
  regular files or directory trees: no symlinks, hardlinks, or special files.
  Only bytes and ordinary POSIX modes are covered—not ACLs, xattrs, ownership,
  or timestamps. No live database safety or service restart is provided.
- **A directory is replaced whole.** Entries absent from the candidate leave
  the live target through Hold. Moving the old target aside and installing the
  candidate takes two renames, not an atomic swap or zero-downtime update.
- **Recovery has limits.** No confidentiality or same-UID malicious-tamper
  defense; no force or replay. Undo refuses changes made since apply. Initial
  snapshots have no garbage collection: retained storage must be bounded
  operationally. Do not treat this as an unlimited backup system.

## Existing tools, still optional

Airlock also supports structured `.air` programs and four effect classes:
`Capture`, `Invoke`, `Apply`, and `RequestExternal`. Hold retains displaced local
state; Outbox stages external requests for separate supervisor dispatch.
These features complement ordinary shell work rather than require replacing it.

The zero-config **compatibility** profile keeps broad Bash-like host authority;
child writes and network sends do not acquire Hold or Outbox guarantees.
**Native-contained** is an explicit, platform-dependent restriction for private
workspace computation. Its Linux prerequisites belong to that feature, not to
the new direct `change` journey. **VM-enclosed** remains future direction.

Two laws remain unchanged: **only the reaper unlinks managed retained bytes**,
and **restrictions are opt-in ratchet turns**. See [DESIGN.md](DESIGN.md).

## Documentation and development

- [Changes: walkthrough and boundaries](docs/changes.md)
- [Example fixture](examples/changes/README.md)
- [Existing installation and build guide](docs/install.md)
- [Existing language and harness usage](docs/usage.md)
- [Security model](docs/security-model.md)
- [Architecture](ARCHITECTURE.md)
- [macOS profiles](docs/macos-v1.md) · [Linux profiles](docs/linux-v1.md)
- [Executed evidence](docs/evidence/) — bounded claims, distinct from targets

For checkout development:

```sh
bun install --frozen-lockfile
bun run verify
```

## License

MIT
