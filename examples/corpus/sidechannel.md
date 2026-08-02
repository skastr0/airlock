# Airlock cold-start brief

You write one Airlock program (`.air`). A supervisor runs it for you and
returns a JSON receipt. You have no shell, no repository, and no second
way to reach the world: every effect is one of the actions below.

## Actions

The complete verb surface. Nothing else is callable.

```json
{
  "schemaVersion": "airlock/actions/v1",
  "actions": [
    {
      "name": "file.inspect",
      "node": "Capture",
      "summary": "Capture an identity-safe filesystem inspection."
    },
    {
      "name": "file.read",
      "node": "Capture",
      "summary": "Capture file bytes, text, or JSON."
    },
    {
      "name": "file.list",
      "node": "Capture",
      "summary": "Capture a directory listing."
    },
    {
      "name": "file.glob",
      "node": "Capture",
      "summary": "Capture a glob expansion rooted at an explicit path."
    },
    {
      "name": "file.stat",
      "node": "Capture",
      "summary": "Capture filesystem metadata without following symlinks by default."
    },
    {
      "name": "file.write",
      "node": "Apply",
      "summary": "Apply a held file write from content or an artifact."
    },
    {
      "name": "file.remove",
      "node": "Apply",
      "summary": "Apply a held removal."
    },
    {
      "name": "file.move",
      "node": "Apply",
      "summary": "Apply a managed move."
    },
    {
      "name": "file.copy",
      "node": "Apply",
      "summary": "Apply a managed copy."
    },
    {
      "name": "file.mkdir",
      "node": "Apply",
      "summary": "Apply managed directory creation."
    },
    {
      "name": "process.run",
      "node": "Invoke",
      "summary": "Invoke one structured executable + args contract inside a Cell."
    },
    {
      "name": "http.stage",
      "node": "RequestExternal",
      "summary": "Stage an HTTP intent; it cannot dispatch from this lowering."
    }
  ],
  "definitions": []
}
```

## Action input schemas

Five schemas in full. The remaining verbs take the obvious subset of
`path`, `source`, `destination`, `parents`, and `realm`.

### process.run

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "process.run",
    "node": "Invoke",
    "summary": "Invoke one structured executable + args contract inside a Cell.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "ResourceNeed": {
          "type": "object",
          "required": [
            "kind",
            "realm",
            "selector",
            "rights"
          ],
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "path",
                "executable",
                "endpoint",
                "artifact",
                "secret",
                "stream"
              ]
            },
            "realm": {
              "type": "string"
            },
            "selector": {
              "type": "string"
            },
            "rights": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "read",
                  "write",
                  "invoke",
                  "execute",
                  "connect",
                  "emit"
                ]
              }
            }
          },
          "additionalProperties": false
        }
      },
      "type": "object",
      "required": [
        "executable",
        "args",
        "cwd"
      ],
      "properties": {
        "executable": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "descendantExecutables": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "env": {
          "type": "object",
          "required": [],
          "properties": {},
          "additionalProperties": {
            "type": "string"
          }
        },
        "cellProfile": {
          "type": "string",
          "enum": [
            "compatibility",
            "native-contained",
            "vm-enclosed"
          ]
        },
        "timeoutMs": {
          "type": "number"
        },
        "stdin": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "discard",
                "inherit"
              ]
            },
            {
              "type": "object",
              "required": [
                "kind",
                "value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "text"
                  ]
                },
                "value": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            },
            {
              "type": "object",
              "required": [
                "kind",
                "id"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "artifact"
                  ]
                },
                "id": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            }
          ]
        },
        "stdout": {
          "type": "string",
          "enum": [
            "capture",
            "discard",
            "inherit"
          ]
        },
        "stderr": {
          "type": "string",
          "enum": [
            "capture",
            "discard",
            "inherit"
          ]
        },
        "outputLimitBytes": {
          "type": "number"
        },
        "readable": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ResourceNeed"
          }
        },
        "writable": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ResourceNeed"
          }
        },
        "realm": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

### file.read

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "file.read",
    "node": "Capture",
    "summary": "Capture file bytes, text, or JSON.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "realm": {
          "type": "string"
        },
        "format": {
          "type": "string",
          "enum": [
            "text",
            "bytes",
            "json"
          ]
        }
      },
      "additionalProperties": false
    }
  }
}
```

### file.glob

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "file.glob",
    "node": "Capture",
    "summary": "Capture a glob expansion rooted at an explicit path.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "root",
        "pattern"
      ],
      "properties": {
        "root": {
          "type": "string"
        },
        "pattern": {
          "type": "string"
        },
        "realm": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

### file.write

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "file.write",
    "node": "Apply",
    "summary": "Apply a held file write from content or an artifact.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "realm": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "sourceArtifact": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

### http.stage

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "http.stage",
    "node": "RequestExternal",
    "summary": "Stage an HTTP intent; it cannot dispatch from this lowering.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "endpoint",
        "method"
      ],
      "properties": {
        "endpoint": {
          "type": "string"
        },
        "method": {
          "type": "string",
          "enum": [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE"
          ]
        },
        "headers": {
          "type": "object",
          "required": [],
          "properties": {},
          "additionalProperties": {
            "type": "string"
          }
        },
        "body": {
          "type": "string"
        },
        "bodyArtifact": {
          "type": "string"
        },
        "holdMillis": {
          "type": "number"
        },
        "realm": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

## Language

The whole grammar:

- `let <name> = <expression>` — bind a value. There is no assignment, so a
  loop cannot accumulate into an outer variable.
- `if <expression> { … } else { … }` — the `else` arm is optional.
- `for <name> in <from>..<to> { … }` — finite integer range.
- `for <name> in <captured list> { … }` — iterate a captured list.
- `assert <expression>, "message"` — fail the run on a false test.
- `return <expression>` — the program result.

Values: strings, numbers, booleans, null, durations (`30s`, `5m`), lists
(`[a, b]`), and records (`{ key: value }`). Field access `a.b`, index
access `a[0]`, operators `|| && == != < <= > >= + - * / ! -`. String `+`
concatenates.

There are no functions, no `while`, no recursion, no imports, no shell
strings, and no way to define a new action. An action call is always an
identifier applied to one record literal.

Bindings supplied by the supervisor appear as free identifiers. `workspace`
is always bound to the absolute workspace path; use it for `cwd`. File
paths in `file.*` actions are relative to the workspace.

## Worked programs

Bounded control: assert, for, if, and a managed write.

```
assert enabled, "the supervisor must enable this workload"

for entry in writes {
  let written = file.write({
    path: entry.path,
    content: entry.content
  })
  assert written.state == "applied", "write failed"
}

if expected == 3 {
  return { state: "complete", iterations: expected }
} else {
  return { state: "unexpected-input", iterations: expected }
}
```

Two processes joined by a captured stdout artifact — no shell pipe.

```
let selected = process.run({
  executable: "/usr/bin/grep",
  args: ["-n", "needle", "input.txt"],
  cwd: workspace,
  stdin: "discard",
  stdout: "capture",
  stderr: "capture",
  cellProfile: "compatibility"
})
assert selected.state == "succeeded", "grep failed"

let upper = process.run({
  executable: "/usr/bin/tr",
  args: ["a-z", "A-Z"],
  cwd: workspace,
  stdin: {
    kind: "artifact",
    id: selected.stdout_artifact.id
  },
  stdout: "capture",
  stderr: "capture",
  cellProfile: "compatibility"
})
assert upper.state == "succeeded", "tr failed"

return {
  selected: selected.stdout,
  transformed: upper.stdout
}
```

External intent is staged, never sent.

```
let staged = http.stage({
  endpoint: endpoint,
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: "{\"operation\":\"snapshot-ready\"}",
  holdMillis: 300000
})

assert staged.state == "staged"
return staged
```

## Reading a failure and repairing

A failed run returns a receipt containing a `failure` record:

```json
{
  "state": "failed",
  "failure": {
    "action": "file.read",
    "phase": "runtime",
    "causeTag": "RuntimeNodeFailure",
    "reason": "runtime node program/<plan>/0/node/0 finished failed"
  }
}
```

Repair from the leaves, not from a guess:

1. `causeTag` names the typed error that fired. It is the single most
   specific fact available — read it first.
2. `reason` is the leaf message underneath that tag.
3. `phase` names the seam that refused: `language` (the program did not
   parse or evaluate), `contract` (the call did not match the action
   schema), `admission` (policy refused the resource), `native-filesystem`
   or `runtime` (the effect itself failed), `outbox` (staging failed).
4. `action` names the call that failed.

Change only what the tag and reason implicate, then resubmit the whole
program. A `phase` of `admission` is a refusal, not a bug to work around:
no rewrite of the program can widen what the supervisor granted.
