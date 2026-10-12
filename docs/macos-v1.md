# macOS v1 runtime contract

> Status: current implementation envelope plus release acceptance conditions.
> Compatibility and native-contained are implemented. VM enclosure is a future
> stronger backend, not a v1 claim gate.

## What macOS v1 is

macOS v1 exposes one Unix-shaped CLI and Airlock program surface over the same
tool contracts, policy, Hold, Outbox, and receipts.

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
airlock-agent describe
```

The builder ad-hoc signs both local artifacts, verifies their signatures, and
writes SHA-256 and JSON manifests. The installer verifies both source and
copied artifacts and probes both entrypoints before displacing either live
binary; replacement and uninstall preserve prior binaries through a unique
Trash transaction. Developer ID signing, notarization, and public provenance
remain release-owner gates.

`airlock` is the person's surface. `airlock-agent` has the same commands
except the ones that decide: `approve-plan`, `commit`, `cancel` and `undo`.
How a process is confined is the policy's choice, never the program's: a
`process.run` call has no profile field, and a grant runs it at once only under
`host.profile` `native-contained`.

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

## Without containment

Without a confining profile, a `process.run` grant may only stage the call: it
waits for a person, and when committed the process runs with the user's own
authority. Nothing it writes passes through Hold. Airlock makes no
containment claim for it.

## Native-contained: implemented subset

A program runs a process at once and contained when:

1. the policy in `AIRLOCK_POLICY_FILE` grants `process.run` with
   `"when": "now"` and `"host": { "profile": "native-contained" }`;
2. the executable is one of the policy's `resources.executable.roots`, and the
   working directory is inside `resources.path`; and
3. `airlock doctor` reports every native fence enforced. Otherwise the grant is
   refused when the policy loads.

Minimal policy:

```json
{
  "schemaVersion": "airlock/tool-policy/v1",
  "toolGrants": [
    { "id": "touch", "tool": "process.run", "when": "now", "host": { "profile": "native-contained" } }
  ],
  "resources": {
    "path": ["/absolute/workspace"],
    "executable": { "roots": ["/usr/bin/touch"], "edges": [] }
  },
  "budget": { "maxCalls": 8, "maxInputBytes": 100000 }
}
```

Minimal program:

```text
let ran = process.run({ executable: "/usr/bin/touch", args: ["created.txt"], cwd: "." })
assert ran.state == "done", "touch did not run"
return ran.result.merged
```

Run it with:

```sh
AIRLOCK_POLICY_FILE=/absolute/policy.json \
  airlock-agent run /absolute/create.air --workspace /absolute/workspace
```

The result lists what the process changed and was merged back through Hold;
`airlock undo <receipt id>` puts it back. A process that does not exit cleanly
has its changes discarded. The root executable receives `invoke`; any
executable the root may spawn must be listed in the call's
`descendantExecutables` and allowed for that root by a matching
`resources.executable.edges` entry. A descendant cannot be started as a root.

### Native mechanism

For each contained Invoke, the current runtime:

1. fingerprints the live workspace;
2. creates a fresh same-volume private workspace by APFS clone or copy;
3. generates a Seatbelt profile using JSON-escaped path literals;
4. permits process fork and exact `process-exec` paths for the admitted root
   and its root-scoped declared descendants;
5. permits ambient file reads;
6. provisions a private temp workspace for the Invoke, exports `TMPDIR`,
   `TMP`, and `TEMP` into it, and permits writes in the private workspace,
   declared temp paths, and `/dev/null`;
7. denies network;
8. runs the requested executable in the private workspace;
9. fingerprints the live and private views;
10. emits a delta plus drift and executable-binding evidence; and
11. applies an admitted delta only through Hold.

Before Apply, the runtime fingerprints the live workspace again. It refuses
drift, unsupported types, overlapping paths, stale private output, or a target
whose current identity no longer matches the baseline.

### Advertised native envelope

Established by implementation and tests:

- private workspace preparation;
- live source-workspace write denial during Invoke;
- network denial during Invoke;
- private Invoke temp isolation with temp-path exclusion from the merge delta;
- separate root `invoke` and root-scoped descendant `execute` authority;
- exact Seatbelt executable-path fencing for declared roots, descendants, and
  demonstrated shebang chains;
- Cell evidence for requested, launch, allowed executable paths,
  root/descendant role, and workspace rebasing;
- separate executable and argv atoms;
- output capture and limits;
- same-process-group descendant ownership until exit, timeout, or cancellation;
- top-level regular-file/directory delta detection;
- preflight drift and source checks;
- live merge through recoverable Hold transitions; and
- explicit refusal when VM or native requirements are unavailable.

Not established:

- confidentiality or secret isolation, because `file-read*` is ambient;
- complete loader/dynamic-library/helper/hook/plugin/config execution closure;
- prevention of code interpreted in-process by an admitted interpreter;
- immutable external executable-byte identity across path replacement races;
- daemonization/session-escape-proof descendant ownership;
- endpoint leases or contained network access;
- symlink, special-file, hardlink, ACL, xattr, sparse-file, device, mount, or
  remote-filesystem Apply;
- live SQLite/WAL, foreign writers, or other active protocol state;
- atomic all-or-nothing multi-entry merge;
- startup reconciliation for private workspaces left behind by a crash before
  they were moved into Hold; or
- resource-exhaustion resistance beyond current process/output bounds.

Each contained process run creates one private workspace tree. When the run
ends, however it ends, the tree moves into Hold with `purpose: runtime-private`;
it is never selected by `undo`, and only `airlock reap` discards it. Nothing
sweeps neighbouring paths. Retention is not free: the tree stays until reaped,
and a crash before it is moved still needs future startup reconciliation.

The measured pre-retirement repository no-op baseline was about 6.1 seconds
and about 212 MiB of logical tree data per Invoke. Same-volume retirement is an
O(1) rename, but full-tree fingerprinting and private-view construction remain
material performance costs; changed clone pages or copy fallback consume real
storage until reap.

Unsupported work returns a typed error. It does not fall back to compatibility.

### Executable-edge boundary

The implemented executable edge set is deliberately narrower than the
architecture's candidate full execution closure:

```text
root executable (`invoke`)
  → exact descendant executable paths for that root (`execute`)
```

Seatbelt checks a new exec against those resolved paths. It does not treat
dynamic-library loading or interpreter input as another exec. The required
Bun proof runs `/bin/bash` with no declared descendants and shows it sourcing
an agent-owned `BASH_ENV` in-process. The sourced code can write the private
view, but its live-workspace write and loopback connection receive
`Operation not permitted`; the private write is the sole delta.

This is the intended documented boundary: executable-edge fencing plus
resource confinement succeeded. It does not establish loader/config/plugin
semantics, immutable code identity, or persistent-authority safety.

## VM-enclosed: future backend

The capability report currently marks the VM backend `not-provided`. A grant that
asks for `vm-enclosed` is refused when the policy loads.

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
- A recorded call is replayed under its run id only if what it named is
  unchanged; otherwise it is a `conflict` and nothing is redone.
- A compatibility result carries no containment claim.
- A native result applies only to the capability report and resource envelope
  exercised by that run.
- A live-workspace drift blocks Apply.
- Each accepted merge transition is recoverable through Hold; multi-entry
  atomicity is not claimed.
- HTTP intent remains staged until Outbox commit; a v2 policy may
  pre-authorize that commit for grants it classed `read` (fixture-proven), and
  the auto-commit routes through the same `Outbox.commit`.
- Outbox commit claims staged intent before dispatch; supervisor cancellation
  is legal only before that claim.
- A recovered `committing` Outbox entry is `uncertain`.
- Hold and Outbox serialize cross-process recovery transitions with a bounded
  recoverable Airlock-home lease; a direct 16-process Bun campaign proves
  one-holder mutual exclusion for the shared `O_EXLOCK` mechanism, and Hold
  can promote a valid staged-only journal.
- Reaping retained recovery material remains a separate terminal authority.

## v1 evidence boundary

The release may describe the implemented compatibility and native-contained
profiles only after the [acceptance contract](acceptance.md) clears for their
published envelopes. Today the accurate judgment is:

> usable developer preview — broad claim not yet earned

The current Vouch evidence includes a restore/apply/stage/undo fixture and a
12-action host-operation program. Ten parity workloads additionally cover
common control/file/process shapes, repository search/pipelines, native edit,
tar, local Git, and build descendants. Required Bun integration proofs cover
the Cell write/network/temp fence, exact executable descendants and shebang
chains, and the admitted interpreter/in-process boundary. These do not replace
the missing representative corpus, repeated macOS runs, exhaustive
fault/overlap matrix, or hostile containment tests.
