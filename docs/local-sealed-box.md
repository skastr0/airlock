# Local sealed box (same user)

This opt-in macOS recipe builds the production sealed entrypoint, embeds the
operator public-key digest, signs one grant, and publishes a fresh same-user
generation. It does not use `sudo`, `chown`, `launchctl`, or the root tenant
installer.

## Build one observe box

Use fresh output and key paths, and keep the private key outside both the
workspace and generation:

```sh
mkdir -p /tmp/demo-ws
echo hi > /tmp/demo-ws/ok.txt

bun scripts/seal-box.ts keygen \
  --private-key /tmp/airlock-operator.key \
  --public-key /tmp/airlock-operator.pub

bun scripts/seal-box.ts local \
  --workspace /tmp/demo-ws \
  --out /tmp/demo-box \
  --private-key /tmp/airlock-operator.key \
  --public-key /tmp/airlock-operator.pub \
  > /tmp/demo-box-result.json

/usr/bin/python3 -c \
  'import json,sys; print(json.load(sys.stdin)["recipe"])' \
  < /tmp/demo-box-result.json
```

`local` keeps stdout as one JSON document for automation. It also prints the
literal, headed copy-paste recipe to stderr; the same text is retained in the
JSON `recipe` field. Paths are physical paths (on macOS, `/tmp` normally
resolves to `/private/tmp`). `SEALED` is created with exclusive create only
after the binary, signed seal, state roots, and complete bundle
verification succeed. It is the final publication mutation for a default box.
A partial failure before that point has no `SEALED` marker; the fresh path is
preserved for inspection and a retry refuses to replace it.

The default signed grant exposes only these commands:

```text
capabilities describe doctor eval inspect pending review run
```

and its policy lets a program read the workspace and nothing else:

```text
file.glob file.inspect file.list file.read file.stat
```

A program that calls any other tool fails with `invalid_code` before anything
runs. For example:

```sh
/tmp/demo-box/bin/airlock eval --workspace /tmp/demo-ws \
  --source 'return file.stat({ path: "ok.txt" })'

/tmp/demo-box/bin/airlock describe --workspace /tmp/demo-ws
```

`--policy ABSOLUTE_JSON` signs a different strict `airlock/tool-policy/v1`
document instead; see [usage.md](usage.md#2-the-policy).

## A person decides outside the box

Every command of a sealed install is the agent's to run, so no seal can grant
one that decides: `approve-plan`, `commit`, `cancel`, `undo` and `reap` are
refused in a grant and are absent subcommands of the box. A call the policy
holds for approval waits in the box's home. A person decides on it with the
unsealed `airlock`, over the same home and the same policy:

```sh
AIRLOCK_HOME=/tmp/demo-box/home AIRLOCK_POLICY_FILE=/path/to/policy.json \
  airlock pending
AIRLOCK_HOME=/tmp/demo-box/home AIRLOCK_POLICY_FILE=/path/to/policy.json \
  airlock commit <id>
```

Nothing a sealed box starts outlives the command that started it.

## Tamper and lifecycle boundary

Startup rechecks the compiled binary digest, embedded operator-key anchor,
signature, and compile-bound local readiness marker. A changed
grant, wrong binary, root-tenant readiness marker,
or missing readiness marker exits 78 before Airlock state is constructed.
Running `bun run src/cli.ts` with `AIRLOCK_SEAL` set remains rejected as
`source-mode`; source loading is not a sealed identity.

`Hold.reap` remains the only unlink authority, and only a person's unsealed
`airlock reap` calls it. To change a box, create a **fresh `--out`
generation** rather than replacing one in place.

## Threat boundary

“Same user” is a packaging and signed-language boundary, not a second macOS
principal. A process that already has arbitrary ambient authority as the same
UID can edit user-owned generation bytes or read a user-owned signing key. The
claim applies when the harness gives the agent only the grant-filtered compiled
binary and withholds an ambient shell or equivalent host API. Keep the private
key outside every agent-readable workspace and never copy it into the
generation. Use the separate root/two-principal tenant install when an OS user
boundary is required.
