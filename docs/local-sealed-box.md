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
after the binary, signed seal, exact catalog, state roots, and complete bundle
verification succeed. It is the final publication mutation for a default box.
A partial failure before that point has no `SEALED` marker; the fresh path is
preserved for inspection and a retry refuses to replace it.

The default signed grant is `native-contained` and exposes only these verbs:

```text
actions doctor eval held pending run schema serve
```

Its native actions are:

```text
file.glob file.inspect file.list file.read file.stat http.stage
```

It has no `process.run`, managed write action, endpoint grant, or daemon
operation. Therefore no daemon is started or required by default. Direct
`commit`, `undo`, `exec`, `write`, and `rm` are absent subcommands. For example:

```sh
/tmp/demo-box/bin/airlock eval --workspace /tmp/demo-ws \
  --source 'return file.stat({ path: "ok.txt" })'

/tmp/demo-box/bin/airlock schema file.stat
# resultSchema describes `bytes`; it does not invent a `size` alias.
```

A custom `--admission ABSOLUTE_JSON` and repeated `--definition ABSOLUTE_JSON`
inputs may be supplied. A compatibility admission is refused unless the same
command also spells `--allow-sealed-compatibility`.

## Same-user commit daemon

To grant the existing supervisor loop `commit` authority, opt in explicitly:

```sh
bun scripts/seal-box.ts local \
  --workspace /tmp/demo-ws \
  --out /tmp/demo-box-with-daemon \
  --private-key /tmp/airlock-operator.key \
  --public-key /tmp/airlock-operator.pub \
  --with-daemon-commit
```

This adds exactly `daemonOps: ["commit"]`, starts `bin/airlock serve`, and does
not return success until the health-only Unix socket reports the same signed
grant digest. The JSON result includes `daemonPid`, `daemonReady: true`, and a
ready-to-copy recipe. The daemon dispatches only already staged evidence that
the signed admission grant classed `read` and `auto`; it still calls the sole
`Outbox.commit` network authority.

When any daemon operation is present, `run` and `eval` require the same-digest
daemon. Killing it makes the next program fail closed with `field: "daemon"`;
there is no local commit fallback.

## Tamper and lifecycle boundary

Startup rechecks the compiled binary digest, embedded operator-key anchor,
signature, exact catalog, and compile-bound local readiness marker. A changed
grant, extra `*.airlock-tool.json`, wrong binary, root-tenant readiness marker,
or missing readiness marker exits 78 before Airlock state is constructed.
Running `bun run src/cli.ts` with `AIRLOCK_SEAL` set remains rejected as
`source-mode`; source loading is not a sealed identity.

`Hold.reap` remains the only unlink authority. In particular, local deployment
does not remove a stale Unix socket. An ungracefully killed daemon may leave
that pathname behind, so create a **fresh `--out` generation** rather than
promising restart or replacement in place.

## Threat boundary

“Same user” is a packaging and signed-language boundary, not a second macOS
principal. A process that already has arbitrary ambient authority as the same
UID can edit user-owned generation bytes or read a user-owned signing key. The
claim applies when the harness gives the agent only the grant-filtered compiled
binary and withholds an ambient shell or equivalent host API. Keep the private
key outside every agent-readable workspace and never copy it into the
generation. Use the separate root/two-principal tenant install when an OS user
boundary is required.
