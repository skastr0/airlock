# Using Airlock

Airlock runs a program an agent wrote, and holds every call that program makes
to a policy a person wrote. A program is a short `.air` file. It cannot touch
anything directly: each thing it wants done is a call to a granted tool, and
each call either runs at once, waits for a person, or is refused. Changes to
files go through Hold, so a person can put them back.

Two binaries share one command set:

- `airlock` is the person's. It has every command.
- `airlock-agent` is the agent's. It has no command that decides: no
  `approve-plan`, `commit`, `cancel`, `undo` or `reap`.

Every command prints JSON on stdout. A failure prints one JSON error on stderr
and exits 1.

## 1. A first program

Ask what this workspace allows and how to write a program:

```sh
airlock-agent describe --workspace .
```

`actions` lists each tool a program may call, the one record it takes, what it
returns, and whether a call runs at once. `description` is the language in a
page. That page is the agent's briefing; it is generated from the policy, so it
is always current.

A program:

```text
let note = file.read({ path: "notes.md", format: "text" })
assert note.state == "done", "could not read notes.md"
let w = file.write({ path: "notes.bak", content: "backed up" })
return { wrote: w.state }
```

Run it from a file or inline:

```sh
airlock-agent run backup.air --workspace .
airlock-agent eval --workspace . --source 'return file.stat({ path: "notes.md" })'
```

Every call returns a receipt:

| `state` | Meaning |
| --- | --- |
| `done` | It ran. `result` is what it returned; `id` names the call. |
| `staged` | It was recorded and waits for a person. `id` names it. |
| `refused` | Nothing happened. `refusal.code` and `refusal.message` say why. |

A program may read `receipt.result` only where the state is known to be
`done`: inside `if receipt.state == "done" { ... }` or after an `assert`.

The whole program is checked before anything runs. An unknown tool or field,
a wrong type, or a call the policy cannot grant fails the run with
`invalid_code` and the line and column, and no call is made.

### The run report

```json
{
  "runId": "run-6f1c…",
  "workspace": "/Users/me/project",
  "outcome": { "ok": true, "result": { "wrote": "done" }, "toolCalls": 2 }
}
```

`workspace` is the real path of the directory, with symlinks resolved. A run
that did not produce a result has `"ok": false`, a `reason`, and exits 1:

| `reason` | What happened |
| --- | --- |
| `invalid_code` | The program did not check. `at` gives the line and column, `fault` the kind of mistake. Nothing ran. |
| `review_refused` | The review found calls the policy refuses. `refusals` lists them. Nothing ran. |
| `plan_mismatch` | Run with `--plan`, but this program's plan is not that plan. Nothing ran. |
| `assert_failed` | An `assert` was false. Calls before it already ran. |
| `tool_failed` | A call ended the run. `failure` names the tool, a code and a message. |
| `tool_call_limit`, `tool_input_limit`, `tool_result_limit`, `loop_limit`, `step_limit`, `value_limit`, `output_limit`, `timeout` | A budget ran out. |

### Names a program can read

`workspace` is always bound to the workspace's real path. Anything else is
passed as a JSON object:

```sh
airlock-agent run greet.air --bindings '{"name":"ada"}'
```

`--bindings` may not set `workspace`.

### Running again

Every run has an id, `run-<uuid>` unless `--run-id` names one. Running the
same id again returns the recorded receipt for each call that already ran,
instead of making it again. A call is recorded against the files it named as
they were. If one of those files has changed since, the run stops with
`tool_failed` and code `conflict`, and nothing is written.

## 2. The policy

With no policy file, a program may read and change files in its workspace and
nothing else. Reads run at once. Changes run at once through Hold.

A person can write a policy and point `AIRLOCK_POLICY_FILE` at it:

```json
{
  "schemaVersion": "airlock/tool-policy/v1",
  "toolGrants": [
    { "id": "read", "tool": "file.read", "when": "now" },
    { "id": "write", "tool": "file.write" },
    { "id": "build", "tool": "process.run", "when": "now", "host": { "profile": "native-contained" } },
    { "id": "hook", "tool": "http.stage" }
  ],
  "resources": {
    "path": ["/Users/me/project"],
    "executable": { "roots": ["/usr/bin/make"], "edges": [] },
    "endpoint": ["https://hooks.example.com/build"]
  },
  "budget": { "maxCalls": 64, "maxInputBytes": 1000000 }
}
```

- **`toolGrants`** names each tool a program may call. A tool with no grant
  does not exist for the program; `describe` does not list it.
- **`when`** is `now` (runs at once) or `approved`, the default (waits for a
  person).
- **`resources`** are ceilings. Every path, executable and endpoint a call
  names must fall inside them. Paths are resolved to the file they really
  are: `..`, absolute paths outside the ceiling, and symlinks out of it are
  refused.
- **`executable.roots`** are the programs `process.run` may start.
  `executable.edges` lists, for a root, what it may in turn run
  (`{ "root": "/usr/bin/git", "descendants": ["/bin/sh"] }`). A call must also
  name those descendants in `descendantExecutables`.
- **`budget`** caps calls and input bytes for one run.

The file must be exactly this shape: an unknown field, bad JSON or an
inconsistent rule fails the command with a `CliInputError` naming
`AIRLOCK_POLICY_FILE`.

### What may run at once

`now` is accepted only where this machine can put things back:

| Tool | May run at once? |
| --- | --- |
| `file.read`, `file.stat`, `file.list`, `file.glob`, `file.inspect` | Yes. |
| `file.write`, `file.remove`, `file.mkdir`, `file.copy`, `file.move` | Yes. Hold keeps what they replace, so `undo` puts it back. |
| `process.run` | Only with `host.profile` `native-contained`, on a machine that enforces it (`airlock doctor`). The process runs in a private copy of the workspace with no network; when it exits cleanly, what it changed is merged back through Hold. |
| `http.stage` | Never. A request always waits for a person. |

A grant that asks for more than this fails every command that opens the policy,
with an `AirlockFailure` whose code is `invalid-policy`.

## 3. The person's commands

```sh
airlock pending                 # calls waiting for a decision
airlock inspect <id>            # one recorded call
airlock commit <id>             # approve it and carry it out now
airlock cancel <id>             # drop it; it never happens
airlock undo <id>               # put back what a completed call changed
airlock reap --older-than 30d   # discard what Hold kept longer ago than that
airlock ledger                  # the append-only record of every act
```

Hold keeps what every change replaced, and a copy of the workspace for every
contained process, until `reap` discards it. `--older-than` defaults to and may
not be less than 7d, the time every `done` receipt promises in its `heldUntil`.
After a reap, `undo` cannot reach what was discarded.

`undo` takes the `id` from a `done` receipt. For a process, it puts back
everything the process's merge changed.

### Approving a plan once

A person can approve what a program will do before it runs:

```sh
airlock review job.air          # its plan, any refusals, and whether the plan is approved
airlock approve-plan <plan id>
airlock-agent run job.air --plan <plan id>
```

Under an approved plan, reads and fully fixed requests the plan names run
without waiting. Changes and processes still follow their grant: an approved
plan does not let an unconfined process or a `when: "approved"` change skip
approval. A different program run with `--plan` fails with `plan_mismatch`.

## 4. Sealed installs

A sealed install pins the policy and the commands into a signed grant, so
neither the agent nor its environment can change them. A sealed install is the
agent's, so no seal grants a command that decides; a person decides with the
unsealed `airlock` over the box's home. See
[local-sealed-box.md](local-sealed-box.md).

## 5. Reviewed local changes

`airlock change` stages, reviews and applies a change to a local file as one
reviewed unit. See [changes.md](changes.md).

## 6. Checking the machine

```sh
airlock doctor
```

reports which fences this machine enforces. `native-contained` is available
only when every one of them is.
