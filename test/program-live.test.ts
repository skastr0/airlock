import { DateTime, Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AdmissionPolicy } from "../src/admission/index.ts"
import {
  NativeMkdirReceipt,
  NativeMoveReceipt,
  NativeStat,
  NativeWriteReceipt
} from "../src/native/index.ts"
import {
  Artifact,
  ArtifactId,
  Digest,
  type InvokeNode,
  type PlanNode
} from "../src/plan/index.ts"
import {
  canonicalizeProgramAction,
  InlineArtifact,
  ProgramExecutionLive,
  ProgramRequest,
  ProgramRunner,
  draftForAction
} from "../src/program/index.ts"
import {
  Runtime,
  RuntimeArtifact,
  RuntimeProcessEvidence,
  RuntimeRun
} from "../src/runtime/index.ts"
import { OutboxEmission } from "../src/Outbox.ts"
import {
  HttpIntentSummary,
  RedactedEmissionRequest
} from "../src/outbox/Contract.ts"
import { ActId, EmissionId, RemoveReceipt } from "../src/domain.ts"
import { ProcessReceipt } from "../src/process/Process.ts"

const now = DateTime.unsafeFromDate(new Date("2026-07-29T00:00:00.000Z"))
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const nativeWrites: Array<{ readonly path: string; readonly text: string }> = []

const runtimeInputs: Array<ReadonlyArray<InlineArtifact>> = []
const staged: string[] = []
let invocation = 0

const artifact = (
  id: ArtifactId,
  bytes: Uint8Array,
  provenance: string,
  mediaType = "application/octet-stream"
) => new RuntimeArtifact({
  artifact: new Artifact({
    id,
    digest: Digest.make(`sha256:${id}:${bytes.byteLength}`),
    mediaType,
    byteLength: bytes.byteLength,
    provenance
  }),
  bytes
})

const encodedArtifact = <A, I>(
  id: ArtifactId,
  schema: Schema.Schema<A, I, never>,
  value: A,
  provenance: string
) => artifact(
  id,
  encoder.encode(Schema.encodeSync(Schema.parseJson(schema))(value)),
  provenance,
  "application/json"
)

const writeReceipt = (target: string, bytes: number) => new NativeWriteReceipt({
  receipt: {
    id: ActId.make("act-write"),
    source: "/private/stage",
    target,
    kind: "file",
    previousHeld: false,
    at: now,
    metadata: { device: 1, inode: 2, mode: 0o600, bytes }
  },
  bytes
})

const RuntimeTest = Layer.succeed(Runtime, Runtime.of({
  execute: (authority, inputs = []) => {
    const plan = authority.admission.plan
    const artifacts: RuntimeArtifact[] = [
      ...inputs.map((input) => new RuntimeArtifact({
        artifact: new Artifact({
          id: input.id,
          digest: Digest.make("sha256:input"),
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          provenance: input.provenance
        }),
        bytes: input.bytes
      }))
    ]
    const processes: RuntimeProcessEvidence[] = []

    const materialize = (node: PlanNode) => {
      switch (node._tag) {
        case "Capture": {
          const id = node.produces[0]!
          if (node.operation === "read") {
            const bytes = node.format === "json"
              ? encoder.encode('{"value":"seed"}')
              : encoder.encode("seed")
            artifacts.push(artifact(
              id,
              bytes,
              `test:capture:${node.operation}`,
              node.format === "json" ? "application/json" : "text/plain"
            ))
            return
          }
          if (node.operation === "list") {
            artifacts.push(encodedArtifact(
              id,
              Schema.Array(Schema.Unknown),
              [],
              "test:capture:list"
            ))
            return
          }
          if (node.operation === "glob") {
            artifacts.push(encodedArtifact(
              id,
              Schema.Array(Schema.String),
              [],
              "test:capture:glob"
            ))
            return
          }
          artifacts.push(encodedArtifact(
            id,
            NativeStat,
            new NativeStat({
              path: node.locator,
              kind: "file",
              bytes: 4,
              mode: 0o600,
              device: 1,
              inode: 2
            }),
            `test:capture:${node.operation}`
          ))
          return
        }
        case "Apply": {
          if (node.operation === "merge") return
          const id = node.produces[0]!
          switch (node.operation) {
            case "write": {
              const source = artifacts.find(
                (candidate) => candidate.artifact.id === node.sourceArtifact
              )
              const bytes = source?.bytes ?? new Uint8Array()
              nativeWrites.push({ path: node.target, text: decoder.decode(bytes) })
              artifacts.push(encodedArtifact(
                id,
                NativeWriteReceipt,
                writeReceipt(node.target, bytes.byteLength),
                "test:apply:write"
              ))
              return
            }
            case "remove":
              artifacts.push(encodedArtifact(
                id,
                RemoveReceipt,
                new RemoveReceipt({
                  id: ActId.make("act-remove"),
                  target: node.target,
                  kind: "file",
                  at: now
                }),
                "test:apply:remove"
              ))
              return
            case "copy":
              artifacts.push(encodedArtifact(
                id,
                NativeWriteReceipt,
                writeReceipt(node.target, 4),
                "test:apply:copy"
              ))
              return
            case "move":
              artifacts.push(encodedArtifact(
                id,
                NativeMoveReceipt,
                new NativeMoveReceipt({
                  install: writeReceipt(node.target, 4),
                  sourceRemoval: new RemoveReceipt({
                    id: ActId.make("act-move-remove"),
                    target: node.source!,
                    kind: "file",
                    at: now
                  })
                }),
                "test:apply:move"
              ))
              return
            case "mkdir":
              artifacts.push(encodedArtifact(
                id,
                NativeMkdirReceipt,
                new NativeMkdirReceipt({ path: node.target, installs: [] }),
                "test:apply:mkdir"
              ))
              return
          }
        }
        case "Invoke": {
          invocation += 1
          runtimeInputs.push(inputs.map((input) => new InlineArtifact({
            id: input.id,
            bytes: input.bytes,
            mediaType: input.mediaType,
            provenance: input.provenance
          })))
          const stdin = node.stdin === undefined
            ? new Uint8Array()
            : inputs.find((input) => input.id === node.stdin)?.bytes ??
              artifacts.find((candidate) => candidate.artifact.id === node.stdin)?.bytes ??
              new Uint8Array()
          const stdout = encoder.encode(`${decoder.decode(stdin)}:${invocation}`)
          const stderr = new Uint8Array()
          const receipt = new ProcessReceipt({
            executable: node.executable,
            args: node.args,
            cwd: node.cwd ?? "/work",
            pid: invocation,
            exitCode: 0,
            signal: null,
            stdout,
            stderr,
            startedAt: now,
            finishedAt: now
          })
          processes.push(new RuntimeProcessEvidence({
            nodeId: node.id,
            outcome: "exited",
            receipt
          }))
          if (node.stdoutArtifact !== undefined) {
            artifacts.push(artifact(node.stdoutArtifact, stdout, "test:invoke:stdout"))
          }
          if (node.stderrArtifact !== undefined) {
            artifacts.push(artifact(node.stderrArtifact, stderr, "test:invoke:stderr"))
          }
          return
        }
        case "RequestExternal": {
          const id = node.produces[0]!
          staged.push(node.endpoint)
          artifacts.push(encodedArtifact(
            id,
            OutboxEmission,
            new OutboxEmission({
              id: EmissionId.make("emi_test"),
              status: "staged",
              intent: new HttpIntentSummary({
                kind: "http",
                method: node.method,
                endpoint: node.endpoint,
                headerNames: Object.keys(node.headers),
                bodyBytes: encoder.encode(node.body ?? "").byteLength
              }),
              request: new RedactedEmissionRequest({
                method: node.method,
                url: node.endpoint,
                headers: {}
              }),
              stagedAt: now,
              holdUntil: DateTime.add(now, { millis: node.holdMillis })
            }),
            "test:external:stage"
          ))
        }
      }
    }

    for (const node of plan.nodes) materialize(node)

    return Effect.succeed(new RuntimeRun({
      planId: plan.id,
      state: "succeeded",
      startedAt: now,
      finishedAt: now,
      receipts: [],
      artifacts,
      processes
    }))
  }
}))

const policy = new AdmissionPolicy({
  schemaVersion: "airlock/admission-policy/v1",
  profile: "compatibility",
  principal: "test-agent",
  realm: "local",
  admittedBy: "test",
  pathAllowlist: [],
  executableAllowlist: [],
  endpointAllowlist: []
})

const ProgramTest = ProgramExecutionLive(policy).pipe(
  Layer.provide(RuntimeTest)
)

describe("ProgramExecutionLive", () => {
  it("drives admitted native, process, and staged external actions with lexical artifact flow", async () => {
    nativeWrites.length = 0
    runtimeInputs.length = 0
    staged.length = 0
    invocation = 0

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const program = yield* ProgramRunner
        return yield* program.run(new ProgramRequest({
          source: `
            let source = file.read({ path: "/work/input.txt", format: "text" })
            let first = process.run({ executable: "/usr/bin/printf", args: [], cwd: "/work", stdin: { kind: "text", value: source }, cellProfile: "compatibility" })
            let second = process.run({ executable: "/usr/bin/printf", args: [], cwd: "/work", stdin: { kind: "artifact", id: first.stdout_artifact.id }, cellProfile: "compatibility" })
            let written = file.write({ path: "/work/output.txt", content: second.stdout })
            let emission = http.stage({ endpoint: "https://example.test/collect", method: "POST", body: second.stdout, holdMillis: 5000 })
            return { output: second.stdout, process_outcome: second.process_outcome, exit_code: second.exit_code, process_signal: second.signal, write_state: written.state, emission_state: emission.state }
          `
        }))
      }).pipe(Effect.provide(ProgramTest))
    )

    expect(result.result).toEqual({
      output: "seed:1:2",
      process_outcome: "exited",
      exit_code: 0,
      process_signal: null,
      write_state: "applied",
      emission_state: "staged"
    })
    expect(runtimeInputs).toHaveLength(2)
    expect(new TextDecoder().decode(runtimeInputs[0]![0]!.bytes)).toBe("seed")
    expect(new TextDecoder().decode(runtimeInputs[1]![0]!.bytes)).toBe("seed:1")
    expect(nativeWrites).toEqual([{ path: "/work/output.txt", text: "seed:1:2" }])
    expect(staged).toEqual(["https://example.test/collect"])
    expect(result.plans.every((plan) => plan.actionReference.includes("@sha256:"))).toBe(true)
    expect(
      result.plans.flatMap((plan) => plan.nodes).find((node) => node._tag === "RequestExternal")
    ).toMatchObject({
      _tag: "RequestExternal",
      endpoint: "https://example.test/collect",
      body: "seed:1:2",
      headers: {}
    })
  })

  it("binds referenced artifact bytes into the admitted action reference", async () => {
    const id = ArtifactId.make("artifact/stdin")
    const call = await Effect.runPromise(canonicalizeProgramAction("process.run", {
      action: "process.run",
      executable: "/usr/bin/printf",
      args: [],
      cwd: "/work",
      stdin: { kind: "artifact", id }
    }))
    const left = await Effect.runPromise(draftForAction(call, 0, "fixed", [
      new InlineArtifact({ id, bytes: new TextEncoder().encode("left"), mediaType: "text/plain", provenance: "test" })
    ]))
    const right = await Effect.runPromise(draftForAction(call, 0, "fixed", [
      new InlineArtifact({ id, bytes: new TextEncoder().encode("right"), mediaType: "text/plain", provenance: "test" })
    ]))

    expect(left.draft.actionReference).not.toBe(right.draft.actionReference)
  })

  it("lowers contained process work to named outputs plus Apply.merge", async () => {
    const call = await Effect.runPromise(canonicalizeProgramAction("process.run", {
      action: "process.run",
      executable: "/usr/bin/true",
      args: [],
      cwd: "/work",
      cellProfile: "native-contained"
    }))
    const request = await Effect.runPromise(draftForAction(call, 0, "contained"))
    const invoke = request.draft.nodes[0]!
    const apply = request.draft.nodes[1]!

    expect(invoke).toMatchObject({
      _tag: "Invoke",
      stdoutArtifact: request.draft.nodes[0]!.produces[0],
      stderrArtifact: request.draft.nodes[0]!.produces[1],
      deltaArtifact: request.draft.nodes[0]!.produces[2]
    })
    expect(apply).toMatchObject({
      _tag: "Apply",
      operation: "merge",
      target: "/work",
      sourceArtifact: request.draft.nodes[0]!.produces[2]
    })
  })

  it("preserves explicit compatibility stdin inheritance in the Plan", async () => {
    const call = await Effect.runPromise(canonicalizeProgramAction("process.run", {
      action: "process.run",
      executable: "/usr/bin/cat",
      args: [],
      cwd: "/work",
      stdin: "inherit",
      cellProfile: "compatibility"
    }))
    const request = await Effect.runPromise(
      draftForAction(call, 0, "stdin-inherit")
    )

    expect(request.draft.nodes[0]).toMatchObject({
      _tag: "Invoke",
      stdinDisposition: "inherit"
    })
    expect(request.inlineArtifacts).toEqual([])
  })

  it("keeps native observation and mutation semantics entirely in the admitted Plan", async () => {
    const calls = [
      {
        input: {
          action: "file.glob",
          root: "/work",
          pattern: "**/*.ts"
        },
        node: {
          _tag: "Capture",
          operation: "glob",
          locator: "/work",
          pattern: "**/*.ts"
        }
      },
      {
        input: {
          action: "file.copy",
          source: "/work/source",
          destination: "/work/copy"
        },
        node: {
          _tag: "Apply",
          operation: "copy",
          source: "/work/source",
          target: "/work/copy"
        }
      },
      {
        input: {
          action: "file.move",
          source: "/work/copy",
          destination: "/work/moved"
        },
        node: {
          _tag: "Apply",
          operation: "move",
          source: "/work/copy",
          target: "/work/moved"
        }
      },
      {
        input: {
          action: "file.mkdir",
          path: "/work/nested/path",
          parents: true
        },
        node: {
          _tag: "Apply",
          operation: "mkdir",
          target: "/work/nested/path",
          parents: true
        }
      }
    ] as const

    for (const [index, fixture] of calls.entries()) {
      const call = await Effect.runPromise(
        canonicalizeProgramAction(fixture.input.action, fixture.input)
      )
      const request = await Effect.runPromise(draftForAction(call, index, "native-contract"))
      expect(request.draft.nodes).toHaveLength(1)
      expect(request.draft.nodes[0]).toMatchObject(fixture.node)
      expect(request.draft.nodes[0]!.produces).toHaveLength(1)
    }
  })
})
