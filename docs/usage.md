# Using Airlock

> Every command block below was executed on macOS 26.5.2 (arm64), Bun 1.3.14,
> on 2026-08-03, against `airlock` / `airlock-agent` 0.1.0 built and installed
> from this checkout — except the blocks explicitly marked **not executed in
> this environment**. Output is real and trimmed with `…`. `$AIRLOCK_HOME` and
> `$WORKSPACE` were bound to scratch directories; `bun run src/cli.ts` and
> `bun run src/agent-cli.ts` are the equivalent dev forms.
>
> Install first: [`install.md`](install.md).

**Contents**

1. [First program: the `.air` language in 10 minutes](#1-first-program-the-air-language-in-10-minutes)
2. [The action vocabulary](#2-the-action-vocabulary)
3. [Profiles and policy](#3-profiles-and-policy)
4. [Dispatch classes and tool definitions v2](#4-dispatch-classes-and-tool-definitions-v2)
5. [Hold and Outbox operations](#5-hold-and-outbox-operations-supervisor)
6. [Agent-harness integration](#6-agent-harness-integration)
7. [Corpus harness](#7-corpus-harness-for-evaluating-agents)
8. [Troubleshooting: the failure taxonomy](#8-troubleshooting-the-failure-taxonomy)

---

## 1. First program: the `.air` language in 10 minutes

An Airlock program is a small, total script. It has no functions, no `while`, no
recursion, no imports, no shell strings, and no way to define a new action. Every
effect is one of twelve verbs called as an identifier applied to **one record
literal**.

### The whole grammar

```text
let <name> = <expression>            bind a value; there is no assignment
if <expression> { … } else { … }     the else arm is optional
for <name> in <from>..<to> { … }     finite integer range, upper bound exclusive
for <name> in <list> { … }           iterate a captured list
assert <expression>, "message"       fail the run on a false test
return <expression>                  the program result
<expression>                         an expression statement
```

Values: strings, numbers, booleans, `null`, durations (`250ms`, `30s`, `5m`,
`2h`, `1d`), lists (`[a, b]`), records (`{ key: value }`). Field access `a.b`,
index access `a[0]`. Operators `|| && == != < <= > >= + - * / ! -`.

Statements are separated by newlines or `;`. Confirmed live:

```sh
airlock-agent schema language
```

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "language": {
    "syntax": "airlock",
    "effects": "identifier ActionResolver calls only",
    "control": ["let", "if", "for finite range", "for captured list", "return", "assert"]
  }
}
```

### A real first program

```sh
cat > "$WORKSPACE/first.air" <<'AIR'
let greeting = file.write({
  path: "greeting.txt",
  content: "hello from Airlock\n"
})
assert greeting.state == "applied", "write did not apply"

let text = file.read({ path: "greeting.txt", format: "text" })

return {
  target: greeting.target,
  bytes: greeting.bytes,
  text: text
}
AIR

airlock-agent run "$WORKSPACE/first.air" --workspace "$WORKSPACE" --compact
```

```json
{
  "schemaVersion": "airlock/program-run/v1",
  "profile": "compatibility",
  "workspace": "$WORKSPACE",
  "result": {
    "state": "succeeded",
    "result": {
      "target": "$WORKSPACE/greeting.txt",
      "bytes": 19,
      "text": "hello from Airlock\n"
    },
    "plans": [
      { "id": "program/9eb8c466…/0", "actionReference": "file.write@sha256:bee82be5…", "nodeCount": 1 },
      { "id": "program/d64c3f83…/1", "actionReference": "file.read@sha256:69f9494e…",  "nodeCount": 1 }
    ],
    "counts": { "plans": 2, "actions": 2, "artifacts": 1 },
    "artifacts": [
      {
        "id": "program/9eb8c466…/0/input/content",
        "mediaType": "text/plain; charset=utf-8",
        "byteLength": 19,
        "provenance": "program:inline-content"
      }
    ]
  }
}
```

Exit code 0. Note what the report already tells you: two Plans, one node each,
each Plan carrying a content-addressed `actionReference`, and the inline write
content promoted to a tracked artifact.

### Reading the program-run JSON report

The envelope is always `airlock/program-run/v1` with three top-level fields
(`profile`, `workspace`, `result`) and these fields inside `result`:

| field | meaning |
| --- | --- |
| `state` | `succeeded`, `partial`, or `failed` |
| `result` | the program's returned value, or `null` when it did not return |
| `plans` | one Plan draft per action, with `id` and `actionReference` (`--compact` collapses nodes to `nodeCount`) |
| `actions` | full form only: the decoded call, its `callDigest`, the Plan draft, inline artifacts, and the result value |
| `artifacts` | artifact metadata — id, media type, byte length, `provenance` |
| `counts` | `--compact` only: plan/action/artifact totals |
| `failure` | present on `partial` and `failed` — see below |

`state` distinguishes two very different things:

- **`failed`** — nothing durable happened before the refusal, or the first action
  itself refused.
- **`partial`** — earlier actions *did* complete. Their records, Plan drafts, and
  artifact metadata are retained alongside the typed failure. **A partial report
  does not imply rollback.** Recovery is a supervisor act (`airlock undo`).

`failure` has four fields, and you repair from the leaves:

```json
"failure": {
  "action": "program",
  "phase": "language",
  "causeTag": "MissingRecordField",
  "reason": "{ \"field\": \"path\", \"span\": {\"start\":82,\"end\":95,\"line\":2,\"column\":17} }"
}
```

- **`causeTag`** — the typed error that fired. The single most specific fact
  available; read it first.
- **`reason`** — the leaf underneath that tag. Here: field `path`, at line 2
  column 17.
- **`phase`** — which seam refused: `language` (did not parse or evaluate),
  `contract` (the call did not match the action schema), `admission` (policy
  refused a resource), `runtime` / `native-filesystem` (the effect itself
  failed), `outbox` (staging failed).
- **`action`** — the call that failed, or `program` for a language-phase failure.

That exact failure came from a one-line mistake — `greeting.path` instead of
`greeting.target`:

```sh
cat > "$WORKSPACE/bad-field.air" <<'AIR'
let greeting = file.write({ path: "greeting.txt", content: "x" })
return { wrote: greeting.path }
AIR

airlock-agent run "$WORKSPACE/bad-field.air" --workspace "$WORKSPACE" --compact
```

`state: "partial"` and exit 1: the write *applied*, then the field access failed.
Input field names and result field names are different vocabularies — `file.write`
takes `path` and returns `target`.

### Control flow, records, lists, durations

```sh
cat > "$WORKSPACE/control.air" <<'AIR'
let plan = {
  label: "control-tour",
  hold: 30s,
  entries: [
    { name: "a.txt", body: "alpha" },
    { name: "b.txt", body: "beta" }
  ]
}

assert plan.hold >= 1s, "hold must be at least one second"
assert plan.entries[0].name == "a.txt", "first entry misnamed"

for entry in plan.entries {
  let written = file.write({ path: entry.name, content: entry.body })
  assert written.state == "applied", "write failed"
}

let slots = ["slot-0.txt", "slot-1.txt", "slot-2.txt"]
for index in 0..3 {
  let filled = file.write({ path: slots[index], content: "slot" })
  assert filled.state == "applied", "slot write failed"
}

if plan.label == "control-tour" {
  return { label: plan.label, hold: plan.hold, slots: slots }
} else {
  return { label: "unexpected" }
}
AIR

airlock-agent run "$WORKSPACE/control.air" --workspace "$WORKSPACE" --compact
```

```json
"state": "succeeded",
"result": {
  "label": "control-tour",
  "hold": { "kind": "Duration", "value": 30, "unit": "s" },
  "slots": ["slot-0.txt", "slot-1.txt", "slot-2.txt"]
},
"counts": { "plans": 5, "actions": 5, "artifacts": 5 }
```

Five sharp edges, each of which cost a run to find:

1. **There is no assignment.** `let` is the only binder and a `let` inside a loop
   body does not escape it. A loop cannot accumulate into an outer variable — it
   accumulates through *actions*, or you precompute a list.
2. **A duration is a value, not a number.** It survives into the result as
   `{ kind: "Duration", value, unit }`, and comparisons are duration-to-duration.
   `plan.hold >= 1s` works; `plan.hold > 0` does not.
3. **`+` does not coerce.** Both sides must be numbers, or both strings.
   `"slot-" + index` fails with
   `InvalidLanguageOperation … "requires numbers (or strings for +)"`.
4. **`for … in 0..3` is exclusive** at the upper bound: three iterations.
5. **Loops have one shared budget** — 10,000 visited items by default, and
   exceeding it is `LoopLimitExceeded`.

### Bindings: `workspace` is not automatic

Supervisor-supplied bindings appear as free identifiers. `process.run` needs an
absolute `cwd`, so nearly every real program wants `workspace` — and the CLI
does **not** bind it for you:

```sh
airlock-agent run "$WORKSPACE/pipeline.air" --workspace "$WORKSPACE" --compact
```

```json
"failure": {
  "action": "program",
  "phase": "language",
  "causeTag": "UnboundIdentifier",
  "reason": "{ \"name\": \"workspace\", \"span\": {\"start\":101,\"end\":110,\"line\":4,\"column\":8} }"
}
```

Pass it explicitly:

```sh
airlock-agent run "$WORKSPACE/pipeline.air" \
  --workspace "$WORKSPACE" \
  --bindings "{\"workspace\":\"$WORKSPACE\"}" \
  --compact
```

`--workspace` sets the *root* for relative `file.*` paths and for admission;
`--bindings` supplies *values the program can read*. They are independent. The
corpus harness always injects `workspace` into its bindings
(`scripts/corpus-harness.ts:636`), which is why programs authored against
[`examples/corpus/sidechannel.md`](../examples/corpus/sidechannel.md) can rely
on it.

More runnable programs: [`programs/snippets/`](programs/snippets/) and the
24-page field guide in [`programs/`](programs/).

---

## 2. The action vocabulary

Twelve generic verbs. There are no Vouch-, archive-, SQLite-, Git-, or
OpenShell-specific runtime verbs; existing Unix programs keep those semantics.

**The live source of truth is the CLI, not this page.** Discovery is generated
from the same Effect Schemas that decode the actions, so it cannot drift from
the decoder:

```sh
airlock-agent actions
airlock-agent schema process.run
airlock-agent schema file.write
airlock-agent schema plan
```

```json
{
  "schemaVersion": "airlock/actions/v1",
  "actions": [
    { "name": "file.inspect", "node": "Capture",         "summary": "Capture an identity-safe filesystem inspection." },
    { "name": "file.read",    "node": "Capture",         "summary": "Capture file bytes, text, or JSON." },
    { "name": "file.list",    "node": "Capture",         "summary": "Capture a directory listing." },
    { "name": "file.glob",    "node": "Capture",         "summary": "Capture a glob expansion rooted at an explicit path." },
    { "name": "file.stat",    "node": "Capture",         "summary": "Capture filesystem metadata without following symlinks by default." },
    { "name": "file.write",   "node": "Apply",           "summary": "Apply a held file write from content or an artifact." },
    { "name": "file.remove",  "node": "Apply",           "summary": "Apply a held removal." },
    { "name": "file.move",    "node": "Apply",           "summary": "Apply a managed move." },
    { "name": "file.copy",    "node": "Apply",           "summary": "Apply a managed copy." },
    { "name": "file.mkdir",   "node": "Apply",           "summary": "Apply managed directory creation." },
    { "name": "process.run",  "node": "Invoke",          "summary": "Invoke one structured executable + args contract inside a Cell." },
    { "name": "http.stage",   "node": "RequestExternal", "summary": "Stage an HTTP intent; it cannot dispatch from this lowering." }
  ],
  "definitions": []
}
```

Note that `schema <action>` returns the **input** contract. Result record shapes
are not in discovery — read them off a receipt, or off the tables below.

### Observations (`Capture`)

| action | required | optional | result |
| --- | --- | --- | --- |
| `file.inspect` | `path` | `realm` | `{ path, kind, bytes, mode, device, inode }` |
| `file.read` | `path` | `realm`, `format` (`text`\|`bytes`\|`json`) | with `format: "text"`, a **bare string** |
| `file.list` | `path` | `realm` | `[{ name, stat: { path, kind, bytes, mode, device, inode } }]` |
| `file.glob` | `root`, `pattern` | `realm` | a list of absolute paths |
| `file.stat` | `path` | `realm`, `followSymlinks` | `{ path, kind, bytes, mode, device, inode }` |

The metadata field is **`bytes`**, not `size` — the single most common
model-authored mistake in the
[v0 corpus campaign](evidence/model-generated-corpus-v0.md).

### Managed mutations (`Apply`) — all Hold-backed

Every one of these routes through Hold, so every one is recoverable by the
supervisor with `airlock undo` until `airlock reap` reclaims it.

```sh
cat > "$WORKSPACE/mutate.air" <<'AIR'
let made = file.mkdir({ path: "stage" })
let wrote = file.write({ path: "stage/one.txt", content: "one" })
let copied = file.copy({ source: "stage/one.txt", destination: "stage/two.txt" })
let moved = file.move({ source: "stage/two.txt", destination: "stage/three.txt" })
let removed = file.remove({ path: "stage/three.txt" })
let inspected = file.inspect({ path: "stage" })
let stated = file.stat({ path: "stage/one.txt" })
return {
  made: made, wrote: wrote, copied: copied, moved: moved,
  removed: removed, inspected: inspected, stated: stated
}
AIR

airlock-agent run "$WORKSPACE/mutate.air" --workspace "$WORKSPACE" --compact
```

```json
"state": "succeeded",
"result": {
  "made":    { "state": "applied", "action": "file.mkdir",  "path": "…/stage", "act_ids": ["act_63d723e9-19a5"] },
  "wrote":   { "state": "applied", "action": "file.write",  "act_id": "act_12a922af-fc97", "target": "…/stage/one.txt",   "previous_held": false, "bytes": 3 },
  "copied":  { "state": "applied", "action": "file.copy",   "act_id": "act_70d88707-aa49", "source": "stage/one.txt", "target": "…/stage/two.txt", "previous_held": false, "bytes": 3 },
  "moved":   { "state": "applied", "action": "file.move",   "install_act_id": "act_0e2cbf61-fa8f", "remove_act_id": "act_4ab7a0d5-6bbb", "source": "…/stage/two.txt", "target": "…/stage/three.txt" },
  "removed": { "state": "applied", "action": "file.remove", "act_id": "act_9ed531a7-82b4", "target": "…/stage/three.txt", "kind": "file" },
  "inspected": { "path": "…/stage",         "kind": "directory", "bytes": 96, "mode": 16877, … },
  "stated":    { "path": "…/stage/one.txt", "kind": "file",      "bytes": 3,  "mode": 33188, … }
}
```

| action | required | optional |
| --- | --- | --- |
| `file.write` | `path` | `realm`, `content`, `sourceArtifact` |
| `file.remove` | `path` | `realm` |
| `file.move` | `source`, `destination` | `realm` |
| `file.copy` | `source`, `destination` | `realm` |
| `file.mkdir` | `path` | `realm`, `parents` |

`file.move` and `file.copy` take **`source`/`destination`**, not `from`/`to`. Get
it wrong and the contract phase tells you the exact legal set — see
[section 8](#8-troubleshooting-the-failure-taxonomy).

### Computation: `process.run` (`Invoke`)

**There is no command-string form.** `airlock-agent schema plan` states it
outright: `"commandString": false`. Argv is structured atoms; nothing is parsed
by a shell, so `"literal; touch should-not-exist"` is one argument.

Required: `executable` (absolute path), `args` (array of strings), `cwd`.
Optional:

| field | values |
| --- | --- |
| `cellProfile` | `compatibility` \| `native-contained` \| `vm-enclosed` |
| `timeoutMs` | number |
| `stdin` | `"discard"` \| `"inherit"` \| `{ kind: "text", value }` \| `{ kind: "artifact", id }` |
| `stdout`, `stderr` | `"capture"` \| `"discard"` \| `"inherit"` |
| `outputLimitBytes` | number |
| `env` | string→string map |
| `descendantExecutables` | additional absolute executable paths |
| `readable`, `writable` | explicit `ResourceNeed` declarations |
| `realm` | string |

`capture` materializes the stream as an artifact whose id is returned in
`stdout_artifact` / `stderr_artifact` — and **that artifact id is how you build a
pipeline** without a shell pipe:

```sh
cat > "$WORKSPACE/pipeline.air" <<'AIR'
let selected = process.run({
  executable: "/usr/bin/grep",
  args: ["ERROR", "service.log"],
  cwd: workspace,
  stdin: "discard",
  stdout: "capture",
  stderr: "capture",
  timeoutMs: 5000,
  cellProfile: "compatibility"
})
assert selected.state == "succeeded", "grep failed"

let upper = process.run({
  executable: "/usr/bin/tr",
  args: ["a-z", "A-Z"],
  cwd: workspace,
  stdin: { kind: "artifact", id: selected.stdout_artifact.id },
  stdout: "capture",
  stderr: "capture",
  cellProfile: "compatibility"
})
assert upper.state == "succeeded", "tr failed"

let written = file.write({ path: "errors.txt", content: upper.stdout })
assert written.state == "applied", "write failed"

return { selected: selected.stdout, transformed: upper.stdout }
AIR

airlock-agent run "$WORKSPACE/pipeline.air" --workspace "$WORKSPACE" \
  --bindings "{\"workspace\":\"$WORKSPACE\"}" --compact
```

```json
"state": "succeeded",
"result": {
  "selected":    "ERROR disk full\nERROR socket closed\n",
  "transformed": "ERROR DISK FULL\nERROR SOCKET CLOSED\n"
}
```

The result record of an Invoke:

```json
{
  "state": "succeeded",
  "plan_id": "program/123fd9a8…/0",
  "process_outcome": "exited",
  "exit_code": 0,
  "signal": null,
  "stdout": "", "stderr": "",
  "stdout_artifact": { "id": "…/artifact/0", "digest": "sha256:e3b0c442…", "media_type": "application/octet-stream", "byte_length": 0, "provenance": "invoke:stdout:/usr/bin/touch" },
  "stderr_artifact": { … "provenance": "invoke:stderr:/usr/bin/touch" },
  "delta_artifact":  { … "media_type": "application/vnd.airlock.cell-delta+json", "provenance": "cell-delta:/usr/bin/touch" },
  "recovery": [],
  "receipts": [ { "node_id": "…/node/0", "sequence": 1, "state": "succeeded", "error_tag": null, "output_artifacts": [ … ] }, … ]
}
```

`delta_artifact` is the private workspace's derived delta, which Hold then
applies. Observed non-null under `native-contained` and `null` under
`compatibility` — consistent with the mechanism, since only `native-contained`
prepares a private view.

**`process_outcome` is data, not a program failure.** A timed-out or non-zero
process returns a record with `state: "failed"`; the *program* still succeeds
unless you assert on it. This is deliberate and it is a trap — always assert.
See [section 8](#8-troubleshooting-the-failure-taxonomy).

### External intent: `http.stage` (`RequestExternal`)

Required: `endpoint`, `method`. Optional: `headers`, `body`, `bodyArtifact`,
`holdMillis`, `realm`.

```sh
cat > "$WORKSPACE/stage.air" <<'AIR'
let staged = http.stage({
  endpoint: "https://api.example.com/hook",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{\"operation\":\"snapshot-ready\"}",
  holdMillis: 300000
})
assert staged.state == "staged", "intent must stage, never send"
return staged
AIR

airlock-agent run "$WORKSPACE/stage.air" --workspace "$WORKSPACE" --compact
```

```json
"state": "succeeded",
"result": {
  "state": "staged",
  "action": "http.stage",
  "emission_id": "emi_789312fb-110f",
  "method": "POST",
  "endpoint": "https://api.example.com/hook",
  "hold_millis": 300000
}
```

Nothing crossed the wire. The lowering *cannot* dispatch: the only runtime
wire-capable call for Airlock-owned `RequestExternal` work is lexically inside
`Outbox.commit`. What a program produces is durable local intent plus an
`emission_id` a supervisor can `commit` or `cancel` — see
[section 5](#5-hold-and-outbox-operations-supervisor).

---

## 3. Profiles and policy

Two profiles are implemented; a third fails closed. The runtime never silently
changes profiles, and a program cannot widen the one the supervisor selected.

### `compatibility` — zero configuration, no containment claim

The default. No policy file needed:

```sh
airlock exec --executable /bin/echo --arg "hello world" --cwd /tmp
```

It preserves broad Bash-like host capability and **makes no containment claim**:
the child keeps the invoking user's ambient filesystem, network, configuration,
descendant, and descriptor authority. Writes and sends the child performs
*internally* are not converted into `Apply` or `RequestExternal` and get no Hold,
Outbox, recovery, cancellation, or dispatch-uncertainty guarantee.

What compatibility does **not** give up: managed verbs are still mediated. A
`file.write` in a compatibility program is still an `Apply` through Hold, still
recoverable by `undo` — as the [first program](#a-real-first-program) shows,
running under `"profile": "compatibility"` and producing a held act. The
containment claim is about the *child process*, not about the action vocabulary.

### `native-contained` — a policy file is mandatory

`native-contained` prepares a private writable workspace (APFS clone, or
recursive copy), runs the executable under Seatbelt with a deny-default profile,
denies writes to the live workspace while the process runs, denies network,
derives a delta, and applies supported top-level changes through Hold.

It is **not a confidentiality boundary**: the current Seatbelt profile permits
ambient host reads. Check `airlock doctor` for the exact postures.

The policy is supervisor-owned. A program cannot select its own grants.

```sh
cat > "$WORKSPACE/create.air" <<'AIR'
return process.run({
  executable: "/usr/bin/touch",
  args: ["created.txt"],
  cwd: workspace,
  cellProfile: "native-contained",
  stdout: "capture",
  stderr: "capture"
})
AIR

cat > "$WORKSPACE/policy.json" <<EOF
{
  "schemaVersion": "airlock/admission-policy/v1",
  "profile": "native-contained",
  "principal": "agent:docs",
  "realm": "local",
  "admittedBy": "operator:docs",
  "pathAllowlist": ["$WORKSPACE/**"],
  "executableAllowlist": ["/usr/bin/touch"],
  "endpointAllowlist": []
}
EOF

AIRLOCK_POLICY_FILE="$WORKSPACE/policy.json" airlock run "$WORKSPACE/create.air" \
  --workspace "$WORKSPACE" \
  --profile native-contained \
  --bindings "{\"workspace\":\"$WORKSPACE\"}"

test -f "$WORKSPACE/created.txt" && echo present
airlock held
airlock undo
test ! -e "$WORKSPACE/created.txt" && echo absent
```

```text
{ "schemaVersion": "airlock/program-run/v1", "profile": "native-contained", …
  "result": { "state": "succeeded", "result": { "state": "succeeded",
    "process_outcome": "exited", "exit_code": 0, … } } }
present
[ { "id": "act_6fbbdb22-5963", "act": "overwrite", … "status": "held" }, … ]
{ "id": "act_b803c562-3a3e", "target": "$WORKSPACE/created.txt", "displaced": "act_641dc506-2f95", … }
absent
```

The program lowered to `Invoke` + `Apply`, the executable and paths were
admitted, `touch` ran in a native Cell against the private view, and the derived
delta merged through Hold — so the supervisor could take the whole thing back
with one `undo`.

### Policy document (v1)

| field | meaning |
| --- | --- |
| `schemaVersion` | `airlock/admission-policy/v1` |
| `profile` | must equal the selected `--profile` |
| `principal`, `realm`, `admittedBy` | who this policy is for, in which realm, granted by whom |
| `pathAllowlist` | explicit path selectors; exact or trailing `**` |
| `executableAllowlist` | absolute executable paths |
| `executableEdges` | executables admitted **only** as descendants of a named root, so a helper grant never becomes a new root Invoke authority |
| `endpointAllowlist` | endpoint selectors; exact or trailing `*` prefix |
| `grantTtlMillis` | optional; a positive value issues expiring grants |

### Typed refusals

There is no fallback to compatibility. Each of the following was executed.

**Missing policy** — a `CliInputError` before anything runs:

```sh
airlock run "$WORKSPACE/create.air" --workspace "$WORKSPACE" --profile native-contained \
  --bindings "{\"workspace\":\"$WORKSPACE\"}"
```

```json
{"field":"AIRLOCK_POLICY_FILE","reason":"is required for native-contained program execution","_tag":"CliInputError"}
```

**Profile mismatch** — the policy says `compatibility`, the run says
`native-contained`:

```json
{"field":"AIRLOCK_POLICY_FILE","reason":"policy profile compatibility does not match selected native-contained","_tag":"CliInputError"}
```

**Resource outside the allowlist** — refused at the `admission` phase, before any
Plan node executes:

```json
"failure": {
  "action": "process.run@sha256:0481739d…",
  "phase": "admission",
  "causeTag": "AdmissionDenied",
  "reason": "{ \"requirementId\": \"program/abd98cf0…/0/requirement/0\", \"reason\": \"selector /usr/bin/touch or realm local is outside the native-contained allowlist\" }"
}
```

An `admission` phase is a refusal, not a bug to route around: no rewrite of the
program can widen what the supervisor granted.

**Profile weakening** — with `AIRLOCK_AGENT_PROFILE=native-contained` pinned, a
program asking for a `compatibility` Cell is refused and performs no effect:

```json
"failure": {
  "action": "process.run",
  "phase": "runtime",
  "causeTag": "RuntimePlanInvalid",
  "reason": "{ \"planId\": \"program/c46df37d…/0\", \"reason\": \"Invoke program/c46df37d…/0/node/0 cannot widen native-contained runtime authority\" }"
}
```

> Observed tag: `RuntimePlanInvalid`, from Plan validation, which precedes the
> node-level `RuntimeCapabilityDenied` check. The node-level tag still exists
> for authority denials that reach a node; profile widening is caught earlier,
> at the Plan.

### `vm-enclosed` — fails closed

```json
"vm-enclosed": {
  "available": false,
  "reason": "no VM backend is bundled in this runtime; a selected vm-enclosed profile must fail closed"
}
```

Selecting it yields `RuntimeUnsupported`. It is a future, stronger enclosure —
not a macOS v1 release prerequisite.

Full envelope: [`macos-v1.md`](macos-v1.md) and
[`security-model.md`](security-model.md).

---

## 4. Dispatch classes and tool definitions v2

**Status: implemented candidate seam with a stated boundary.** Design source:
[`rfc/dispatch-classes-and-provider-contract.md`](rfc/dispatch-classes-and-provider-contract.md).
Executed evidence and claim boundary:
[`evidence/external-read-slice.md`](evidence/external-read-slice.md).

### The problem it solves

`http.stage` always stages. For an irreversible send that is exactly right — a
human should stand between intent and wire. But an idempotent *observation*
(fetch a status endpoint) also stages, and then a program cannot read what it
asked for without a supervisor round-trip. Dispatch classes let the supervisor
grant, per endpoint, that a staged read may be committed immediately.

### Classes are grant-side facts, and only grant-side

The vocabulary lives in `src/admission/DispatchPolicy.ts` and nowhere else. No
Plan node, program text, tool definition, or third-party annotation carries it
or can widen it.

| class | supervisor's assertion |
| --- | --- |
| `read` | the endpoint treats this method/route as an idempotent observation |
| `mutate` | remote state may change under a **provider-claimed** compensation — never an Airlock guarantee |
| `irreversible-send` | the default and the floor |

Ordering is `read < mutate < irreversible-send`, and the **stricter side always
wins** when a grant and a declaration disagree.

| commit mode | effect |
| --- | --- |
| `supervisor` | default: stays `staged` until an explicit `airlock commit` |
| `auto` | the trusted runtime may call the ordinary `Outbox.commit` once staging has durably completed |

`auto` never skips staging and never adds a second wire-capable call site. It
requires an explicit `methods` list, and it is only legal on `class: "read"`.

### Admission policy v2

`airlock/admission-policy/v2` carries every v1 field except the flat
`endpointAllowlist`, which is **superseded** by structured `endpointGrants`:

```json
{
  "schemaVersion": "airlock/admission-policy/v2",
  "profile": "native-contained",
  "principal": "agent:example",
  "realm": "local",
  "admittedBy": "operator:example",
  "pathAllowlist": [],
  "executableAllowlist": [],
  "endpointGrants": [
    { "selector": "http://127.0.0.1:PORT/v1/*", "methods": ["GET"], "class": "read", "commit": "auto" }
  ]
}
```

A grant entry: `selector` (exact, or a trailing `*` prefix, matched **after
canonicalization** — query and fragment never participate), optional `methods`,
`class` (default `irreversible-send`), `commit` (default `supervisor`), optional
`hold` bounds, optional `budget` (`maxBodyBytes` enforced by admission against
inline bodies; `maxDispatchesPerRun` owned by the dispatch engine). Omitting
`class` and `commit` reproduces the v1 posture exactly.

A v2 document loads through `AIRLOCK_POLICY_FILE` on both surfaces: the CLI
decodes the `AdmissionPolicyDocument` union (v1 or v2, discriminated on
`schemaVersion`), and a v1 file keeps decoding unchanged. Executed on both
`airlock` and `airlock-agent` with a v2 compatibility-profile policy:
the program ran and reported `succeeded`.

### Walking the proof end to end

```sh
bun run scripts/prove-external-read.ts
```

```text
ok    positive/committed — state=committed
ok    positive/reached the provider — provider saw ["GET /v1/status"]
ok    positive/receipt names the committing authority — committed_by=policy-auto
ok    positive/receipt names the dispatch class — dispatch_class=read
ok    positive/receipt names the grant identity — grant_id=grant/program/606caed8…/requirement/0/ef4d83ac54f06b41 selector=http://127.0.0.1:61137/v1/*
ok    positive/receipt names the actual endpoint — dispatched_endpoint=http://127.0.0.1:61137/v1/status
ok    positive/receipt carries redacted response metadata — status=200 bytes=27 truncated=false limit=65536
ok    positive/response body is a bounded artifact the program can read — artifact=program/606caed8…/0/artifact/1 body.state=green
ok    positive/ledger records the authority and grant — ledger lines=2
ok    unclassified/stays staged — state=staged committed_by=undefined
ok    unclassified/never reached the provider — provider saw 0 request(s)
ok    unclassified/intent is durably retained for a supervisor — outbox=["staged"]
ok    ungranted/refused before staging — …"causeTag":"AdmissionDenied"…
ok    ungranted/never reached the provider — provider saw 0 request(s)
ok    program-class/typed refusal — …"causeTag":"ProgramActionDecodeFailed"…
ok    definition-class/typed refusal — refusal=ToolGrantAssertionRejected
ok    mutate-grant/stays staged — state=staged
ok    mutate-grant/never reached the provider — provider saw 0 request(s)
ok    declared-mutate/narrows a read grant to staged — state=staged
ok    declared-mutate/never reached the provider — provider saw 0 request(s)
ok    declared-read/auto-commits through the same grant — state=committed
ok    declared-read/reached the provider — provider saw 1 request(s)
ok    auto-on-mutate/policy refused as an invalid contract — …"causeTag":"AdmissionContractInvalid"…
ok    oversized/committed and reached the provider — state=committed
ok    oversized/capture stops at the bound — bytes=65536 of 200000 truncated=true
ok    oversized/artifact carries only the bounded bytes — artifact bytes=65536

26 passed, 0 failed (fixture provider at http://127.0.0.1:61137)
```

The proof starts a local fixture provider on an ephemeral `127.0.0.1` port,
composes the real `Program` → `Admission` → `Runtime` → `Outbox` stack against a
fresh temporary Airlock home per case, and runs real Airlock programs. Nothing
is stubbed: every positive case is confirmed by the provider *receiving* the
request, and every negative case by the provider recording that it never did.

Read the rows as five things:

1. **Staged intent comes first, always.** The runtime reaches a commit path only
   after `Outbox.stage` has durably returned for that node. There is no branch
   in which dispatch happens without a prior durable `staged` state.
2. **Auto-commit is a caller of `Outbox.commit`, not a second dispatcher.** The
   only `fetch(` in `src/Outbox.ts` stays lexically inside `commit`, guarded by a
   construction test in `test/outbox-hardening.test.ts`.
3. **Receipts name the authority.** `committed_by = policy-auto` (versus
   `supervisor` for a human commit), plus `dispatch_class`, `grant_id`, the
   policy `grant_selector` verbatim, the endpoint actually dispatched to, and
   redacted response metadata (`status`, `response_bytes`,
   `response_truncated`, `response_limit_bytes` — never body bytes). The Ledger
   line carries `by=policy-auto class=read grant=…`.
4. **The response is a bounded artifact.** A committed read materializes a second
   artifact on the node (slot 1) that the program can read.
   `DISPATCH_RESPONSE_LIMIT_BYTES` is 65,536 and is a **construction constant**,
   not a policy knob: the oversized case commits a 200,000-byte response, retains
   exactly 65,536 bytes, and reports `truncated: true`.
5. **The negative proofs are the load-bearing ones.** A grant naming neither
   class nor commit leaves the intent `staged` and durably retained, with zero
   provider requests. An endpoint fitting no grant is `AdmissionDenied` *before*
   staging. A `mutate`-classed grant never auto-commits. A policy declaring
   `commit: "auto"` on `class: "mutate"` is `AdmissionContractInvalid`. A program
   naming `class` inside `http.stage` is a `ProgramActionDecodeFailed`. A v2
   definition naming `commit` is a `ToolGrantAssertionRejected`. **Fail-closed by
   absence**: the runtime is handed a list of authorizations, never a policy, and
   an empty list — the default, and everything a v1 policy can produce — means
   every staged intent waits for an explicit supervisor commit.

The narrowing row is worth naming: a definition declaring
`emissionEffect: "mutate"` stays `staged` under a `read`/`commit: "auto"` grant
on the same endpoint, while that same definition's `read` action auto-commits
through that same grant. So the stricter-side-wins rule is a real narrowing, not
a dead path.

**Boundary.** One host, one realm, and the counterparty is a **fixture** — a
local test HTTP server that exists so a proof has something behind an endpoint.
It is not a provider adapter and says nothing about any real API's semantics,
latency, or failure modes. `read` is a supervisor *judgment*, never a discovery:
Airlock does not verify that a granted endpoint is idempotent, only that the
class the supervisor wrote is the class that governed the dispatch. No retry
semantics were added; `uncertain` is preserved exactly as before.

### Tool definitions: typed ergonomics, never authority

A tool definition is **inert JSON** in a discovered directory. It executes
through ordinary action lowering, Admission, Plans, Runtime, and Schema-decoded
results. It adds no Plan constructor, no profile, no verb, and no authority.

Definitions are read from four fixed, immediate, optional directories — never
recursively, and only `*.airlock-tool.json` regular files:

| precedence | directory |
| --- | --- |
| builtin | `<install>/tool-definitions` |
| installed | `$AIRLOCK_HOME/tools` |
| user | `~/.config/airlock/tools` |
| project | `<workspace>/.airlock/tools` |

The reader opens each file with `O_NOFOLLOW` and caps it at 256 KiB, so a raced
symlink replacement fails rather than being read through.

**v1 — `invoke` lowering.**
[`examples/tools/printf-json.airlock-tool.json`](../examples/tools/printf-json.airlock-tool.json):

```json
{
  "schemaVersion": "airlock/tool-definition/v1",
  "id": "printf_json",
  "version": "1.0.0",
  "executables": [ { "realm": "local", "selector": "/usr/bin/printf" } ],
  "actions": [
    {
      "name": "decode",
      "inputSchema": { "type": "object", "properties": { "cwd": { "type": "string" }, "json": { "type": "string" } }, "required": ["cwd", "json"], "additionalProperties": false },
      "outputSchema": { "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"], "additionalProperties": false },
      "args": [ { "_tag": "Input", "path": ["json"] } ],
      "cwd": { "_tag": "Input", "path": ["cwd"] },
      "resources": [ { "kind": "path", "realm": "local", "selector": { "_tag": "Input", "path": ["cwd"] }, "rights": ["read"] } ],
      "lowering": "invoke",
      "effectFootprint": ["invoke"],
      "resultDecoder": "json-stdout"
    }
  ]
}
```

**v2 — `enqueue` lowering with a declared emission effect.**
[`examples/tools/fixture-status.airlock-tool.json`](../examples/tools/fixture-status.airlock-tool.json):

```json
{
  "schemaVersion": "airlock/tool-definition/v2",
  "id": "fixture_status",
  "version": "1.0.0",
  "executables": [],
  "actions": [
    {
      "name": "read",
      "inputSchema": { "type": "object", "properties": { "endpoint": { "type": "string" } }, "required": ["endpoint"], "additionalProperties": false },
      "lowering": "enqueue",
      "effectFootprint": ["enqueue"],
      "emissionEffect": "read",
      "request": {
        "method": "GET",
        "endpoint": { "_tag": "Input", "path": ["endpoint"] },
        "headers": { "accept": { "_tag": "Literal", "value": "application/json" } },
        "holdMillis": 0
      },
      "resultDecoder": "none"
    },
    { "name": "reconcile", "…": "identical request, emissionEffect: \"mutate\"" }
  ]
}
```

`emissionEffect` is the *definition author's declaration*, and it can only ever
**narrow**. It cannot select a class, cannot set a commit mode, and cannot widen
a grant. A definition that names `class` or `commit` is a
`ToolGrantAssertionRejected`. MCP annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`) are third-party unauthenticated hints; a
converter may copy them into `emissionEffect` as a *starting suggestion for the
supervisor* and nothing more.

Both definitions discovered and executed:

```sh
cp examples/tools/printf-json.airlock-tool.json \
   examples/tools/fixture-status.airlock-tool.json \
   "$WORKSPACE/.airlock/tools/"

airlock-agent actions --workspace "$WORKSPACE"
```

```json
"definitions": [
  { "name": "fixture_status.read",      "definitionId": "fixture_status", "version": "1.0.0", "executable": [],                  "resultDecoder": "none" },
  { "name": "fixture_status.reconcile", "definitionId": "fixture_status", "version": "1.0.0", "executable": [],                  "resultDecoder": "none" },
  { "name": "printf_json.decode",       "definitionId": "printf_json",    "version": "1.0.0", "executable": ["/usr/bin/printf"], "resultDecoder": "json-stdout" }
]
```

```sh
cat > "$WORKSPACE/tool.air" <<AIR
let decoded = printf_json.decode({ cwd: "$WORKSPACE", json: "{\\"ok\\":true}" })
assert decoded.ok, "decoder should report ok"
return decoded
AIR

airlock-agent run "$WORKSPACE/tool.air" --workspace "$WORKSPACE" --compact
```

```json
"state": "succeeded",
"result": { "ok": true },
"plans": [ { "actionReference": "printf_json.decode@sha256:…", "nodeCount": 1 } ]
```

And the authority point, executed: the v2 `read` action under the CLI's default
compatibility policy — which has **no** endpoint grants — lowers to `http.stage`
and stays `staged`. The fixture provider log shows it never received the request.

```sh
cat > "$WORKSPACE/read.air" <<'AIR'
return fixture_status.read({ endpoint: "http://127.0.0.1:PORT/v1/status" })
AIR

airlock-agent run "$WORKSPACE/read.air" --workspace "$WORKSPACE" --compact
```

```json
"state": "succeeded",
"result": {
  "state": "staged",
  "action": "http.stage",
  "emission_id": "emi_2f48bb44-95a7",
  "method": "GET",
  "endpoint": "http://127.0.0.1:PORT/v1/status",
  "hold_millis": 0
}
```

A definition changed the *ergonomics* — one typed call instead of a hand-written
`http.stage` record — and changed the authority by exactly nothing.

### No vendor tools ship in-tree

Airlock is provider-neutral. **No vendor tool definitions and no provider
adapters live in this repository**; the only provider in-tree is the local
fixture used by proofs. Adopters generate their own definition suites
out-of-tree.

```text
EndpointProvider owns:                Airlock owns:
  transport to the vendor API           admission and dispatch classes
  credential custody and refresh        staging (Outbox) and the single wire site
  vendor catalog -> v2 definitions      commit / cancel / uncertain physics
  vendor-side semantics and errors      receipts and redaction
```

The provider is a **counterparty behind the endpoint**, not a component inside
the trust base. Airlock's entire view of it: the endpoint selectors the
supervisor grants, the inert definitions the supervisor installs, and the HTTP
dispatches `Outbox.commit` performs. Aggregators appear in the RFC only as
example out-of-tree adopters with no privileged position.

---

## 5. Hold and Outbox operations (supervisor)

Two laws shape this section. **`Hold.reap` contains the repository's only
irreversible removal site.** **`Outbox.commit` contains the only runtime
wire-capable call.** Everything below is a consequence.

### Hold: write, held, undo

```sh
airlock write "$WORKSPACE/example.txt" first
airlock write "$WORKSPACE/example.txt" second
airlock held
airlock undo
```

```json
{ "id": "act_bd7389a4-5c98", "target": "$WORKSPACE/example.txt", "previousHeld": false, … }
{ "id": "act_098d2228-da70", "target": "$WORKSPACE/example.txt", "previousHeld": true,  … }
```

`airlock rm` is the recursive counterpart, and it is exactly as recoverable:

```sh
airlock rm "$WORKSPACE/tree"
airlock undo
```

```text
{ "id": "act_e6f15587-6138", "target": "$WORKSPACE/tree", "kind": "directory", … }
{ "id": "act_e6f15587-6138", "target": "$WORKSPACE/tree", … }
$WORKSPACE/tree/deep/leaf.txt        # the whole tree came back
```

`airlock undo` with no argument restores the most recent held act; pass an
`act-id` to target one. A restore that displaces a newer binding records it as
`displaced`, so the undo itself is held too.

### Rename, not copy

Every Airlock-owned managed replacement **displaces the prior binding by
rename**. Nothing is copied, so a large file costs the same as a small one and
the prior bytes are never duplicated. Executed with inode identity:

```sh
airlock write "$WORKSPACE/example.txt" first
stat -f '%i %N' "$WORKSPACE/example.txt"
airlock write "$WORKSPACE/example.txt" second
stat -f '%i %N' "$WORKSPACE/example.txt"
find "$AIRLOCK_HOME" -inum 265887383
```

```text
265887383 $WORKSPACE/example.txt
265887389 $WORKSPACE/example.txt
$AIRLOCK_HOME/hold/act_098d2228-da70/payload
```

Inode `265887383` — the file that *was* `example.txt` — is now the held payload
under a different name. Same inode, moved by rename.

**Precondition: same volume.** A rename cannot cross a filesystem boundary, so
the Hold store must live on the same volume as the paths it manages. On macOS
the mechanism is `renamex_np(RENAME_EXCL)`; a filesystem that cannot provide an
atomic no-replace rename gets a typed `ExclusiveRenameUnavailable` — never a
replacing rename. Hold journal publication stages and syncs a candidate before
promotion, and startup can promote a valid staged-only journal.

### Reap: the only unlink, and urgency is a parameter

```sh
airlock reap --older-than 7d
airlock held
airlock reap --older-than 0s
airlock held
```

```json
{ "reaped": [], "at": "2026-08-03T20:46:21.431Z" }
10
{ "reaped": 19, "at": "2026-08-03T20:46:21.767Z" }
[]
```

`--older-than 0s` means **delete now**. That is not a special code path: the
retention window is a parameter, and `0s` is the value that makes everything
eligible. There is one unlink site regardless of urgency, so "I need this gone
immediately" and "reclaim last week's bytes" traverse identical code.

> The count above is honest and worth explaining: `held` listed 10 acts while
> reap reclaimed 19. `held` shows acts with status `held`; reap also reclaims
> acts already superseded or restored. Reap ≥ held is normal.

Reap waiting stays **cancellable** until terminal removal authority is taken,
leaving the held act intact. Once removal begins, removal and directory sync run
as one uninterruptible terminal section. If cancellation interrupts later Ledger
publication, Hold returns typed `HoldReapRecoveryRequired` evidence naming the
confirmed removal set, rather than reporting a false ordinary failure. That is
bounded cancellation evidence — not proof that every Reaper crash point has been
exercised.

### Outbox: send, pending, cancel, commit, flush

```sh
airlock send https://api.example.com/hook --body '{"operation":"snapshot-ready"}' --hold 30s
airlock pending
airlock cancel emi_789312fb-110f
```

```json
{
  "id": "emi_789312fb-110f",
  "status": "staged",
  "intent":  { "kind": "http", "method": "POST", "endpoint": "https://api.example.com/hook", "headerNames": ["content-type"], "bodyBytes": 30 },
  "request": { "method": "POST", "url": "https://api.example.com/hook", "headers": { "content-type": "[redacted]" }, "body": "[redacted:30 bytes]" },
  "stagedAt": "…", "holdUntil": "…"
}
```

Headers and body are redacted in every public record. A cancelled emission
reports `"status": "cancelled"` — **it was never sent**.

`commit` is the wire. Executed against a local fixture server:

```sh
airlock send http://127.0.0.1:PORT/hook --body '{"operation":"snapshot-ready"}' --hold 0s
airlock commit emi_36203bbd-9f26
```

```json
{
  "id": "emi_36203bbd-9f26",
  "status": "committed",
  "outcome": {
    "status": 200,
    "responseBytes": 36,
    "response": { "status": 200, "contentType": "application/json", "retainedBytes": 36, "truncated": false, "limitBytes": 65536 },
    "provenance": { "committedBy": "supervisor" },
    "completedAt": "2026-08-03T20:46:15.700Z"
  }
}
```

The fixture server's own log confirmed receipt of exactly
`POST /hook {"operation":"snapshot-ready"}`. `committedBy: "supervisor"` is the
human path; `policy-auto` is the [dispatch-class](#4-dispatch-classes-and-tool-definitions-v2)
path.

`flush` sends every staged emission whose hold has expired, and reports what it
did not touch:

```sh
airlock flush
```

```json
{ "committed": [], "failed": [], "waiting": 0 }
```

Current dispatch is bounded HTTP with **manual** redirects — it is not the
proposed general endpoint broker, and it does not silently follow a redirect to
an unadmitted endpoint. Compatibility children retain ambient network; their
sends are not Outbox dispatches and get none of these guarantees.

### Ledger

```sh
airlock ledger
```

```json
[
  { "at": "…", "effect": "emission", "act": "stage",  "ref": "emi_36203bbd-9f26", "detail": "POST http://127.0.0.1:PORT/hook" },
  { "at": "…", "effect": "emission", "act": "commit", "ref": "emi_36203bbd-9f26", "detail": "POST http://127.0.0.1:PORT/hook -> 200 [by=supervisor]" }
]
```

Append-only, one line per act, with the committing authority named inline. Hold
and Outbox serialize recovery transitions across processes with a bounded,
recoverable exclusive-file lease (`O_EXLOCK` on macOS): authority is the open
file description, the kernel releases it on close or process death, and stale
owner JSON is an inert diagnostic rather than a lock to reclaim.

---

## 6. Agent-harness integration

The agent surface is deliberately small. See
[the paired-binary model](install.md#the-paired-binary-model) for what is absent
and why.

### `run` and `eval`

```sh
airlock-agent run "$WORKSPACE/program.air" --workspace "$WORKSPACE" \
  --bindings "{\"workspace\":\"$WORKSPACE\"}" --compact

airlock-agent eval --workspace "$WORKSPACE" --compact \
  --source 'let matched = file.glob({ root: ".", pattern: "*.txt" })
return { matched: matched }'
```

```json
{
  "schemaVersion": "airlock/program-run/v1",
  "profile": "compatibility",
  "workspace": "$WORKSPACE",
  "result": { "state": "succeeded", "result": { "matched": ["$WORKSPACE/input.txt"] }, … }
}
```

| option | meaning |
| --- | --- |
| `--workspace` | root for relative `file.*` paths and for admission |
| `--bindings` | JSON object of free identifiers the program may read |
| `--compact` | deduplicated projection of action, Plan, node, artifact, and failure evidence |
| `--source` | `eval` only: the program as one structured argument |

`eval` exists so a harness never has to write a temp file. Neither accepts
`--profile`.

`--compact` reduces *evidence volume*, not output limits. Process output and the
returned program value remain subject to their configured byte ceilings; compact
mode is not a separate ceiling.

### Reading state back

```sh
airlock-agent runs --limit 3
airlock-agent run-receipt --plan-id "program/68459570-6b49-4b31-9061-1454ef46cd7f/6"
airlock-agent held
airlock-agent pending
airlock-agent ledger
```

```json
{
  "schemaVersion": "airlock/runtime-run-snapshot/v1",
  "planId": "program/68459570…/6",
  "state": "succeeded",
  "startedAt": "…", "observedAt": "…", "sequence": 4,
  "receipts": [
    { "schemaVersion": "airlock/receipt/v1", "id": "receipt_3081c149…", "nodeId": "…/node/0",
      "sequence": 1, "state": "succeeded", "at": "…",
      "inputDigests": [], "outputArtifacts": ["…/artifact/0"],
      "resourceIdentities": ["lexical:endpoint:external:http://127.0.0.1:PORT/v1/status"] }
  ],
  "artifacts": [ { "id": "…/artifact/0", "digest": "sha256:37e9625c…", … } ]
}
```

`runs` returns the latest redacted durable receipt per Plan — ten by default,
`--limit` from 1 through 100. Every Plan Runtime execution requires persistent
run-journal storage and claims a SHA-256-derived Plan identity with a
kernel-backed lease before any adapter or world work; the claim is held through
`running` → `finalizing` → terminal. Concurrent acquisition, sequential replay,
or an existing recovered snapshot returns typed
`RuntimeExecutionClaimRejected` — it does not execute the Plan again.

### The repair loop

This is the whole reason the failure record is shaped the way it is. Two kinds of
failure, two kinds of repair:

**Contract-phase refusals name the expected fields.** Nothing to guess:

```sh
cat > "$WORKSPACE/copy-wrong.air" <<'AIR'
return file.copy({ from: "greeting.txt", to: "copy.txt" })
AIR

airlock-agent run "$WORKSPACE/copy-wrong.air" --workspace "$WORKSPACE" --compact
```

```json
{ "action": "file.copy", "phase": "contract", "causeTag": "ProgramActionDecodeFailed" }
```
```text
└─ is unexpected, expected: "action" | "source" | "destination" | "realm"
```

The leaf is the fix: rename `from`/`to` to `source`/`destination`.

**Runtime failures carry a `causeTag`.** `RuntimeNodeFailure` on a read of an
absent path, `RuntimeProcessFailure` with `process_outcome: "timed-out"`,
`AdmissionDenied` on an ungranted resource, `RuntimePlanInvalid` on a
profile-weakening attempt.

The loop:

1. Read `causeTag`. It is the most specific fact available.
2. Read `reason` for the leaf — a field name, a span, a selector, a node id.
3. Read `phase` to know *which seam* refused, and therefore whether a program
   change can even help. `language` and `contract` are yours to fix.
   `admission` is not: it is a refusal, and no rewrite widens a grant.
4. Change only what the tag and reason implicate. Resubmit the **whole** program.

### Recommended cold-start sidechannel

A cold agent with no repository access can author passing programs from a
sidechannel brief. The one this repository uses is regenerable:

```sh
bun run scripts/corpus-harness.ts --emit-sidechannel examples/corpus/sidechannel.md
```

**Not executed in this environment** — the checked-in
[`examples/corpus/sidechannel.md`](../examples/corpus/sidechannel.md) is the
generated artifact, and regenerating it would rewrite a tracked file. Its
structure is the recommendation:

1. **The complete action list** — `airlock-agent actions` verbatim, framed as
   "nothing else is callable."
2. **Input schemas for the actions the task needs** —
   `airlock-agent schema <action>` for each. Not all twelve; the brief ships
   `process.run`, `file.read`, `file.glob`, `file.write`, `http.stage`.
3. **The grammar in a dozen lines**, including the three properties an author
   cannot infer: no assignment, `+` does not coerce, `workspace` is a supervisor
   binding.
4. **Two or three worked programs** — take them from
   [`programs/snippets/`](programs/snippets/): `01-first.air` (a captured
   invoke), `02-control.air` (assert/for/if plus a managed write),
   `05-pipeline.air` (artifact-as-stdin, the one shape with no shell analogue).
   `03-capture.air` and `09-native-touch.air` if the task needs observation or
   containment.
5. **How to read a failure** — the four `failure` fields and the repair rule
   above.

The measured outcome of exactly this brief: two cold models, 8 task rows,
7 succeeded within ≤3 attempts, first-attempt success on 6 of 8, and every
failure in the campaign was `parse`-class (result-record decode — twice a
missing `size` field) or `predicate`-class. See
[`evidence/model-generated-corpus-v0.md`](evidence/model-generated-corpus-v0.md)
for the full boundary; it is **not** an acceptance-rate claim.

---

## 7. Corpus harness (for evaluating agents)

`scripts/corpus-harness.ts` scores one candidate program against one task spec
in an isolated realm, and aggregates recorded attempts into a report. It is how
you measure whether an agent can actually do work through Airlock.

```text
corpus-harness — run one candidate program against one corpus task spec

  single task:
    bun run scripts/corpus-harness.ts --task <spec.json> --program <program.air> --json
      [--profile compatibility|native-contained] [--policy <policy.json>]
      [--timeout-ms 60000] [--attempt-id <id>] [--out <attempt.json>]

  report over recorded attempts:
    bun run scripts/corpus-harness.ts --report --attempts <directory> [--json]

  regenerate the cold-start brief handed to a candidate model:
    bun run scripts/corpus-harness.ts --emit-sidechannel examples/corpus/sidechannel.md
```

### Single-task mode

```sh
bun run scripts/corpus-harness.ts \
  --task examples/corpus/tasks/04-pipe-through-parser.json \
  --program campaign/task-4/attempt-1.air \
  --json
```

```json
{
  "schemaVersion": "airlock/corpus-attempt/v1",
  "taskId": "pipe-through-parser",
  "attemptId": "264cda79-3fd9-4a8f-8366-b6ac40a1c978",
  "programPath": "…/campaign/task-4/attempt-1.air",
  "programBytes": 833,
  "profile": "compatibility",
  "wallMillis": 407,
  "isolation": {
    "root":         "/private/var/folders/…/airlock-corpus-pipe-through-parser-KeCOry",
    "workspace":    "…/airlock-corpus-pipe-through-parser-KeCOry/workspace",
    "airlockHome":  "…/airlock-corpus-pipe-through-parser-KeCOry/airlock-home"
  },
  "outcome": "passed",
  "taxonomy": "none",
  "receipts": {
    "programState": "succeeded",
    "plans": 3, "actions": 3, "artifacts": 5, "artifactBytes": 108,
    "runJournalEntries": 3, "outboxStaged": 0, "held": 1
  },
  "predicate": {
    "total": 8, "passed": 8,
    "checks": [
      { "check": "program.state == succeeded",                        "passed": true, "detail": "state=succeeded" },
      { "check": "file.exists out/errors.txt",                        "passed": true, "detail": "36 bytes" },
      { "check": "file.contains out/errors.txt :: ERROR DISK FULL",   "passed": true, "detail": "found" },
      { "check": "file.contains out/errors.txt :: ERROR SOCKET CLOSED","passed": true, "detail": "found" },
      { "check": "file.notContains out/errors.txt :: WARN",           "passed": true, "detail": "absent" },
      { "check": "file.notContains out/errors.txt :: INFO",           "passed": true, "detail": "absent" },
      { "check": "result.contains selected :: ERROR disk full",       "passed": true, "detail": "ERROR disk full\nERROR socket closed\n" },
      { "check": "result.contains transformed :: ERROR SOCKET CLOSED","passed": true, "detail": "ERROR DISK FULL\nERROR SOCKET CLOSED\n" }
    ]
  },
  "cli": { "exitCode": 0, "stdoutBytes": 2263, "stderrExcerpt": "" }
}
```

`outcome` is decided from **decoded receipts and bytes on disk**, not from the
program's self-report. `taxonomy` classifies a failure (`parse`, `predicate`, …)
so a campaign can be summarized without reading every attempt.

### Isolation

Every attempt gets a **fresh temporary root** holding both a clean `workspace`
built from the spec's `workspaceFixture` and a **private `AIRLOCK_HOME`**. Two
attempts therefore share no Hold store, no Outbox, no run journal, and no tool
definitions. The harness spawns the real `airlock-agent` entrypoint as a
subprocess with `--compact`, `--workspace`, and `--bindings` (always injecting
`workspace`), so what is measured is the shipped surface, not an in-process
shortcut.

### Task spec shape

[`examples/corpus/tasks/`](../examples/corpus/tasks/) holds eight specs. The one
run above:

```json
{
  "schemaVersion": "airlock/corpus-task/v1",
  "id": "pipe-through-parser",
  "goal": "Select every ERROR line from logs/service.log with /usr/bin/grep, pipe that captured stdout artifact into /usr/bin/tr as stdin to upper-case it, and write the transformed bytes to out/errors.txt. Return a record { selected: <grep stdout>, transformed: <tr stdout> }.",
  "workspaceFixture": {
    "directories": ["out"],
    "files": [ { "path": "logs/service.log", "content": "INFO boot ok\nERROR disk full\nWARN retrying\nERROR socket closed\nINFO shutdown\n" } ]
  },
  "notes": [
    "process.run stdin accepts { kind: \"artifact\", id: <previous>.stdout_artifact.id } to connect two processes without a shell pipe."
  ],
  "successPredicate": {
    "programState": "succeeded",
    "files":  [ { "path": "out/errors.txt", "contains": ["ERROR DISK FULL", "ERROR SOCKET CLOSED"], "notContains": ["WARN", "INFO"] } ],
    "result": [ { "path": "selected", "contains": "ERROR disk full" }, { "path": "transformed", "contains": "ERROR SOCKET CLOSED" } ]
  }
}
```

`goal` is the only thing the candidate agent sees besides the sidechannel;
`notes` are optional hints; `successPredicate` is what actually scores it, over
both files on disk and paths inside the returned value. `bindings` is optional
and merged with the injected `workspace`.

### Report mode

```sh
bun run scripts/corpus-harness.ts --task examples/corpus/tasks/04-pipe-through-parser.json \
  --program campaign/task-4/attempt-1.air --out "$ATTEMPTS/04.json" --json
bun run scripts/corpus-harness.ts --task examples/corpus/tasks/08-sorted-index.json \
  --program campaign/task-8/attempt-1.air --out "$ATTEMPTS/08.json" --json

bun run scripts/corpus-harness.ts --report --attempts "$ATTEMPTS"
```

```json
{
  "schemaVersion": "airlock/corpus-report/v1",
  "generatedAt": "2026-08-03T20:41:44.788Z",
  "attemptsDirectory": "$ATTEMPTS",
  "totals": { "attempts": 2, "passed": 2, "failed": 0, "uniqueTasks": 2, "tasksWithAtLeastOnePass": 2 },
  "taxonomy": [ { "taxonomy": "none", "attempts": 2 } ],
  "latency": { "minimumMillis": 405, "medianMillis": 405, "p95Millis": 409, "maximumMillis": 409, "meanMillis": 407 },
  "tasks": [
    { "taskId": "pipe-through-parser", "attempts": 1, "passed": 1, "firstPassAttempt": 1, "medianMillis": 409, … },
    { "taskId": "sorted-index",        "attempts": 1, "passed": 1, "firstPassAttempt": 1, … }
  ]
}
```

`firstPassAttempt` is the turns-to-success measure. `--out` is what makes report
mode possible: write one attempt file per run, then aggregate the directory.

Checked-in campaign programs live under `campaign/task-<n>/attempt-<k>.air`, and
the campaign they came from is
[`evidence/model-generated-corpus-v0.md`](evidence/model-generated-corpus-v0.md).
Read its boundary before quoting any rate: 8 rows, 2 models, one machine, and
explicitly **not** the acceptance corpus.

---

## 8. Troubleshooting: the failure taxonomy

Every entry below was reproduced in this session. Read `causeTag` first, then
`reason`, then `phase`.

### Language phase — the program did not parse or evaluate

`causeTag` is one of `UnboundIdentifier`, `InvalidLanguageOperation`,
`InvalidCallTarget`, `MissingRecordField`, `InvalidIndex`, `AssertionFailed`,
`DuplicateRecordField`, `LoopLimitExceeded`. A parse error is not a program-run
report at all — it is a bare `LanguageDiagnostic` on stderr with the offending
span and the source echoed back:

```json
{"detail":"expected a newline or ';' between statements","span":{"start":392,"end":393,"line":19,"column":9},"source":"…","_tag":"LanguageDiagnostic"}
```

That one was an attempted assignment (`names = names`). There is no assignment.

| observed | cause | fix |
| --- | --- | --- |
| `MissingRecordField` field `path` | read a field the result record does not have (`file.write` returns `target`) | use the real result field |
| `UnboundIdentifier` name `workspace` | no `--bindings` | pass `--bindings '{"workspace":"…"}'` |
| `InvalidLanguageOperation` `+` `requires numbers (or strings for +)` | `"slot-" + index` | precompute a list of strings |
| `LoopLimitExceeded` | more than 10,000 visited items across all loops | bound the work |

### Contract phase — `ProgramActionDecodeFailed`

The call did not match the action schema. **The leaf names the expected fields**,
which is the whole point:

```sh
airlock-agent run "$WORKSPACE/copy-wrong.air" --workspace "$WORKSPACE" --compact
```

```json
{ "action": "file.copy", "phase": "contract", "causeTag": "ProgramActionDecodeFailed" }
```
```text
└─ is unexpected, expected: "action" | "source" | "destination" | "realm"
```

Two more variants, both executed:

```text
["path"]  └─ is missing                                       # file.write with no path
["args"]  └─ Expected ReadonlyArray<string>, actual "not-a-list"   # process.run args as a string
```

The Effect union prelude is noisy; the last line is the fix. Extract it:

```sh
airlock-agent run … --compact | python3 -c \
  "import json,sys;print(json.load(sys.stdin)['result']['failure']['reason'].splitlines()[-1].strip())"
```

### Admission phase — `AdmissionDenied`, `AdmissionContractInvalid`

```json
"failure": {
  "action": "process.run@sha256:0481739d…",
  "phase": "admission",
  "causeTag": "AdmissionDenied",
  "reason": "{ \"requirementId\": \"program/abd98cf0…/0/requirement/0\", \"reason\": \"selector /usr/bin/touch or realm local is outside the native-contained allowlist\" }"
}
```

Refused before any Plan node executes — `"actions": []` in the report. This is
not a bug to work around: **no rewrite of the program widens a grant.** Either
the supervisor adds the selector to the policy, or the work does not happen.

`AdmissionContractInvalid` means the *policy itself* is illegal — e.g. declaring
`commit: "auto"` on `class: "mutate"`.

Before reaching admission, two policy problems surface as `CliInputError`:

```json
{"field":"AIRLOCK_POLICY_FILE","reason":"is required for native-contained program execution","_tag":"CliInputError"}
{"field":"AIRLOCK_POLICY_FILE","reason":"policy profile compatibility does not match selected native-contained","_tag":"CliInputError"}
```

And a v2 policy document is currently rejected by the CLI decoder — see
[the note in section 4](#admission-policy-v2).

### Runtime phase — `RuntimePlanInvalid`

Plan validation refused the Plan before executing it. Both observed cases are
authority-shaped:

```json
"reason": "{ \"planId\": \"program/c46df37d…/0\", \"reason\": \"Invoke program/c46df37d…/0/node/0 cannot widen native-contained runtime authority\" }"
"reason": "{ \"planId\": \"program/0a234a58…/0\", \"reason\": \"Apply program/0a234a58…/0/node/1 merge must target the admitted workspace root\" }"
```

The first is a profile-weakening attempt under `AIRLOCK_AGENT_PROFILE`. The
second is a `native-contained` `cwd` pointing at a subdirectory rather than the
admitted workspace root.

### Runtime phase — `RuntimeNodeFailure`

The effect itself failed. Reading an absent path:

```sh
cat > "$WORKSPACE/absent.air" <<'AIR'
return file.read({ path: "absent.txt", format: "text" })
AIR

airlock-agent run "$WORKSPACE/absent.air" --workspace "$WORKSPACE" --compact
```

```json
"failure": {
  "action": "file.read",
  "phase": "runtime",
  "causeTag": "RuntimeNodeFailure",
  "reason": "runtime node program/425070cb…/0/node/0 finished failed",
  "runtime": {
    "schemaVersion": "airlock/runtime-run/v1",
    "state": "failed",
    "receipts": [
      { "nodeId": "…/node/0", "sequence": 1, "state": "failed",
        "resourceIdentities": ["lexical:path:local:absent.txt"],
        "errorTag": "RuntimeNodeFailure" }
    ]
  }
}
```

`reason` is generic here, so read the embedded `runtime.receipts` —
`resourceIdentities` names the exact path the node touched. Exit 1.

### Timeouts — a returned outcome, not a program failure

This is the highest-value trap in the whole surface.

```sh
cat > "$WORKSPACE/timeout.air" <<'AIR'
let slow = process.run({
  executable: "/bin/sleep",
  args: ["5"],
  cwd: workspace,
  stdout: "capture",
  stderr: "capture",
  timeoutMs: 250,
  cellProfile: "compatibility"
})
return { state: slow.state, outcome: slow.process_outcome, signal: slow.signal, exit: slow.exit_code }
AIR

airlock-agent run "$WORKSPACE/timeout.air" --workspace "$WORKSPACE" \
  --bindings "{\"workspace\":\"$WORKSPACE\"}" --compact
```

```json
"result": {
  "state": "succeeded",
  "result": { "state": "failed", "outcome": "timed-out", "signal": "SIGTERM", "exit": null }
}
```

**Exit code 0.** The *program* succeeded — it ran and returned. The *process*
timed out. The node receipt carries `errorTag: "RuntimeProcessFailure"`, but
nothing propagates that into the program result unless you say so:

```text
assert slow.state == "succeeded", "sleep timed out"
```

`RuntimeProcessFailure` outcomes are `nonzero-exit`, `signal`, `timed-out`,
`output-limit`, `cancelled`. Assert on `state` after **every** `process.run` — or
your harness will read exit 0 and believe the work happened.

### The rest of the runtime taxonomy

Not reproduced here; from `src/runtime/Runtime.ts`:

| tag | meaning |
| --- | --- |
| `RuntimeUnsupported` | e.g. `vm-enclosed` selected with no VM backend installed |
| `RuntimeCapabilityDenied` | node-level authority refusal (`right` names what was denied) |
| `RuntimeMergeDrift` | the live workspace changed under a `native-contained` delta |
| `RuntimeDeltaUnsupported` | the private-workspace delta contains a change Hold cannot apply |
| `RuntimeExecutionClaimRejected` | concurrent acquisition, sequential replay, or an existing recovered snapshot for the same Plan id |
| `RuntimeArtifactClaimMismatch` | a node's claimed artifacts differ from what materialized |
| `RuntimeRecoveryRequired` | a durable transition needs supervisor recovery |
| `RuntimeLifecycleFailure` | private-workspace lifecycle failed; names the workspaces |
| `RuntimeAuthorityInvalid` | the supplied authority document did not validate |

### Fast checks when something is off

```sh
airlock doctor                      # is the mechanism you assumed actually "enforced"?
airlock-agent actions --workspace . # is the tool definition being discovered?
airlock-agent schema file.copy      # what are the real input field names?
airlock-agent runs --limit 5        # what did the last runs actually record?
airlock held                        # is there something to undo?
airlock pending                     # is an intent sitting staged?
```

---

## See also

- [`install.md`](install.md) — requirements, install paths, the paired-binary model, Linux status
- [`../DESIGN.md`](../DESIGN.md) — the four effect classes and the two repository laws
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — implemented architecture and epistemic status
- [`macos-v1.md`](macos-v1.md) — the profile envelope in full
- [`security-model.md`](security-model.md) — execution closure, endpoint brokerage, information labels
- [`contracts/plan-runtime.md`](contracts/plan-runtime.md) — the Plan/runtime seam and the contract-change checklist
- [`acceptance.md`](acceptance.md) — the v1 claim boundary
- [`programs/`](programs/) — the *Airlock Programs* field guide and its runnable snippets
- [`rfc/dispatch-classes-and-provider-contract.md`](rfc/dispatch-classes-and-provider-contract.md) — the external-effect growth path
