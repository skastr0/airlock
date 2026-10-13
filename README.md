<p align="center">
  <img src="https://raw.githubusercontent.com/skastr0/airlock/main/docs/assets/airlock-icon.png" width="128" alt="Airlock icon">
</p>

# Airlock

**A small typed language for agent code mode. Every program is reviewed before
it runs, and nothing leaves without a person's approval.**

An agent writes a short `.air` program. It cannot touch anything directly:
each thing it wants done is a call to a granted tool — files, processes,
HTTP — and each call either runs at once, waits for a person, or is refused.
The whole program is checked and reviewed before anything runs, every call
returns a receipt, and a person can undo what a completed call changed.

The same kernel runs the same way as a local CLI and as a Cloudflare Durable
Object, so agent code mode has one design on every host.

**Developer preview · macOS + Linux · MIT.** Requires
[Bun](https://bun.sh) 1.4 or newer.

## A first program

Ask what a workspace allows and how to write a program:

```sh
airlock-agent describe --workspace .
```

`actions` lists each tool a program may call, the one record it takes, what it
returns, and whether a call runs at once. `description` is the agent's
briefing, generated from the policy, so it is always current.

```text
let note = file.read({ path: "notes.md", format: "text" })
assert note.state == "done", "could not read notes.md"
let w = file.write({ path: "notes.bak", content: "backed up" })
return { wrote: w.state }
```

```sh
airlock-agent run backup.air --workspace .
```

Every call returns one receipt:

| `state` | Meaning |
| --- | --- |
| `done` | It ran. `result` is what it returned; `id` names the call. |
| `staged` | It was recorded and waits for a person. `id` names it. |
| `refused` | Nothing happened. `refusal.code` and `refusal.message` say why. |

A program may read `receipt.result` only where the state is known to be
`done`. The full language, the run report and every stop reason are in
[docs/usage.md](docs/usage.md).

## What a person decides

With no policy file, a program may read and change files in its workspace and
nothing else. A policy grants more: which tools, with which resource ceilings
and budget, and which calls run at once.

`now` is accepted only where the machine can put things back: reads, file
changes through Hold, and a `process.run` confined in a private workspace.
A request that leaves the machine — `http.stage` — **never** runs without a
person. A person commits, cancels or undoes:

```sh
airlock pending                 # calls waiting for a decision
airlock commit <id>             # approve it and carry it out now
airlock undo <id>               # put back what a completed call changed
```

A person can also approve a program's plan before it runs, so reads and fully
fixed requests never wait again; anything whose content is not known until the
run is approved as an exact batch, after it exists. See
[docs/usage.md](docs/usage.md#3-the-persons-commands).

## Reviewed local changes

For work without a program, `airlock change` stages a candidate directory
against a target, reviews it as a full diff, and applies exactly the approved
digest — with checked undo and durable recovery. The agent can only stage and
review. See [docs/changes.md](docs/changes.md).

## Where the guarantee stops

- **Enforcement needs ownership.** An agent with ambient direct access can
  bypass Airlock; enforcement requires external ownership of production
  authority.
- **Local replacement, not deployment.** Reviewed changes cover ordinary
  user-owned files and directory trees: bytes and POSIX modes, not ACLs,
  xattrs, ownership or timestamps. No live-database safety or service restart.
- **Containment is not confidentiality.** `native-contained` fences live
  writes and network and is platform-dependent (`airlock doctor` reports what
  a machine enforces); it does not claim VM isolation.
- **Honest uncertainty.** A dispatch that may have reached the wire is never
  retried; it ends `uncertain`.

[docs/security-model.md](docs/security-model.md) states the full model.

## For a host or a cloud

Airlock is a storage-agnostic kernel (`@skastr0/airlock/core`) plus a host
that supplies files, processes and the network. A new host writes the store,
ledger, dispatcher and tool-host layers and runs the kernel's conformance
suites. `@skastr0/airlock/cloudflare` runs the same programs inside a Durable
Object, and `@skastr0/airlock/alchemy` deploys it. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Documentation

- [docs/usage.md](docs/usage.md) — writing and running `.air`, the policy, the person's commands
- [docs/language.md](docs/language.md) — the type system and its roadmap
- [docs/decisions.md](docs/decisions.md) — the decision log
- [docs/install.md](docs/install.md) — install, build and platform requirements
- [ARCHITECTURE.md](ARCHITECTURE.md) — the design as built
- [docs/security-model.md](docs/security-model.md) — what is and is not defended
- [docs/macos-v1.md](docs/macos-v1.md) · [docs/linux-v1.md](docs/linux-v1.md) — the platform sandboxes

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` runs the typecheck, the test suite, the Bun and platform
integration gates, and the portability proofs.

## License

MIT
