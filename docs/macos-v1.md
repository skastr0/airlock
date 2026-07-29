# macOS v1 runtime contract

> Status: current implementation envelope plus release acceptance conditions.
> Compatibility and native-contained are implemented. VM enclosure is a future
> stronger backend, not a v1 claim gate.

## What macOS v1 is

macOS v1 exposes one Unix-shaped CLI and Airlock program surface over the same
Plan, Admission, Runtime, Hold, Outbox, and receipt contracts.

The two available profiles serve different jobs:

- `compatibility` keeps zero-config host capability and makes no containment
  claim.
- `native-contained` provides an explicitly selected, fail-closed subset using
  a private workspace and macOS Seatbelt enforcement.

The runtime never silently changes profiles. The agent program cannot widen
the supervisor-selected profile or policy.

## Install and probe

The standalone builder emits paired supervisor and agent binaries for
`bun-darwin-arm64` or `bun-darwin-x64`. Build support is not test evidence;
release reports must name the architecture and macOS build that actually ran.

```sh
bun install
bun run verify
bun run build:macos
sh scripts/install-macos.sh
airlock doctor
airlock-agent actions
```

The builder ad-hoc signs both local artifacts, verifies their signatures, and
writes SHA-256 and JSON manifests. The installer verifies both source and
copied artifacts and probes both entrypoints before displacing either live
binary; replacement and uninstall preserve prior binaries through a unique
Trash transaction. Developer ID signing, notarization, and public provenance
remain release-owner gates.

`airlock` is the supervisor surface. `airlock-agent` omits raw exec, direct
mutation, dispatch/cancel, undo/reap, and flush while retaining program,
schema/capability, and read-only state commands.

`airlock doctor` and `airlock capabilities` return the same machine-readable
report. It distinguishes an enforced mechanism from something merely present
or allowed. Relevant fields include:

- APFS inspection and clone/copy support;
- Seatbelt availability;
- private writable view;
- live-workspace write fence;
- denied-network fence;
- ambient host read posture;
- confidentiality posture;
- process cancellation limits; and
- VM backend availability.

## Compatibility: implemented

Compatibility is the default:

```sh
airlock exec \
  --executable /bin/echo \
  --arg "hello world" \
  --cwd /tmp
```

The executable and argument atoms remain separate, streams and timeout are
explicit, and the process emits a receipt. The child otherwise runs under the
user's existing host authority. Unknown tools remain runnable. Compatibility
does not claim filesystem, process, network, secret, or configuration
containment.

An Airlock program in compatibility receives a generated broad policy unless
`AIRLOCK_POLICY_FILE` is supplied. If a supplied policy names another profile,
execution is refused rather than reinterpreted.

## Native-contained: implemented subset

Native-contained program execution requires:

1. `--profile native-contained`;
2. a Schema-valid policy in `AIRLOCK_POLICY_FILE`;
3. a matching `profile` field in that policy; and
4. available native enforcement reported by `airlock doctor`.

Minimal policy shape:

```json
{
  "schemaVersion": "airlock/admission-policy/v1",
  "profile": "native-contained",
  "principal": "agent:example",
  "realm": "local",
  "admittedBy": "operator:example",
  "pathAllowlist": ["/absolute/workspace/**"],
  "executableAllowlist": ["/usr/bin/touch"],
  "endpointAllowlist": []
}
```

Minimal effectful program:

```text
return process.run({ executable: "/usr/bin/touch", args: ["created.txt"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })
```

Run it with:

```sh
AIRLOCK_POLICY_FILE=/absolute/policy.json \
  airlock run /absolute/create.air \
  --workspace /absolute/workspace \
  --profile native-contained \
  --bindings '{"workspace":"/absolute/workspace"}'
```

The program lowers to an admitted `Invoke` followed by `Apply`. The Apply is
part of the effectful program path; it is not a direct post-process copy.

### Native mechanism

For each contained Invoke, the current runtime:

1. fingerprints the live workspace;
2. creates a fresh same-volume private workspace by APFS clone or copy;
3. generates a Seatbelt profile using JSON-escaped path literals;
4. permits process execution and ambient file reads;
5. permits writes in the private workspace, declared temp paths, and
   `/dev/null`;
6. denies network;
7. runs the requested executable in the private workspace;
8. fingerprints the live and private views;
9. emits a delta plus drift evidence; and
10. applies an admitted delta only through Hold.

Before Apply, the runtime fingerprints the live workspace again. It refuses
drift, unsupported types, overlapping paths, stale private output, or a target
whose current identity no longer matches the baseline.

### Advertised native envelope

Established by implementation and tests:

- private workspace preparation;
- live source-workspace write denial during Invoke;
- network denial during Invoke;
- separate executable and argv atoms;
- output capture and limits;
- same-process-group descendant ownership until exit, timeout, or cancellation;
- top-level regular-file/directory delta detection;
- preflight drift and source checks;
- live merge through recoverable Hold transitions; and
- explicit refusal when VM or native requirements are unavailable.

Not established:

- confidentiality or secret isolation, because `file-read*` is ambient;
- complete loader/helper/hook/plugin/config execution closure;
- daemonization/session-escape-proof descendant ownership;
- endpoint leases or contained network access;
- symlink, special-file, hardlink, ACL, xattr, sparse-file, device, mount, or
  remote-filesystem Apply;
- live SQLite/WAL, foreign writers, or other active protocol state;
- atomic all-or-nothing multi-entry merge;
- retained private-workspace lifecycle across every transition; or
- resource-exhaustion resistance beyond current process/output bounds.

Unsupported work returns a typed error. It does not fall back to compatibility.

## VM-enclosed: future backend

The capability report currently marks the VM backend `not-provided`. Both
`airlock exec --profile vm-enclosed` and `airlock run --profile vm-enclosed`
fail explicitly.

A future VM backend may offer a stronger realm:

- no ambient host reads;
- broader execution of unknown guest tools;
- brokered host files, secrets, sockets, and endpoints;
- stronger descendant and descriptor mediation; and
- guest-private loopback and filesystem state.

Those are design goals. No current documentation or acceptance result may
attribute them to macOS v1.

## Failure posture

- Missing enforcement is refusal, never downgrade.
- A compatibility result carries no containment claim.
- A native result applies only to the capability report and resource envelope
  exercised by that run.
- A live-workspace drift blocks Apply.
- Each accepted merge transition is recoverable through Hold; multi-entry
  atomicity is not claimed.
- HTTP intent remains staged until Outbox commit.
- A recovered `committing` Outbox entry is `uncertain`.
- Hold and Outbox serialize cross-process recovery transitions with a bounded
  recoverable Airlock-home lease; Hold can promote a valid staged-only journal.
- Reaping retained recovery material remains a separate terminal authority.

## v1 evidence boundary

The release may describe the implemented compatibility and native-contained
profiles only after the [acceptance contract](acceptance.md) clears for their
published envelopes. Today the accurate judgment is:

> usable developer preview — broad claim not yet earned

The current Vouch evidence includes a restore/apply/stage/undo fixture and a
12-action host-operation program. The repository also contains four
shell-parity fixtures. These do not replace the missing representative corpus,
repeated macOS runs, exhaustive fault/overlap matrix, or hostile containment
tests.
