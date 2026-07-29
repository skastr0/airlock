import { DateTime, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AdmissionPolicy } from "../src/admission/index.ts"
import {
  NativeFileSystem,
  NativeMkdirReceipt,
  NativeMoveReceipt,
  NativeStat,
  NativeWriteReceipt
} from "../src/native/index.ts"
import {
  Artifact,
  Digest,
  type InvokeNode
} from "../src/plan/index.ts"
import {
  canonicalizeProgramAction,
  InlineArtifact,
  ProgramExecutionLive,
  ProgramRequest,
  ProgramRunner,
  draftForAction
} from "../src/program/index.ts"
import { Runtime, RuntimeArtifact, RuntimeRun } from "../src/runtime/index.ts"
import { Outbox, OutboxEmission } from "../src/Outbox.ts"
import {
  HttpIntentSummary,
  RedactedEmissionRequest
} from "../src/outbox/Contract.ts"
import { ArtifactId } from "../src/plan/index.ts"
import { ActId, EmissionId } from "../src/domain.ts"

const now = DateTime.unsafeFromDate(new Date("2026-07-29T00:00:00.000Z"))

const nativeWrites: Array<{ readonly path: string; readonly text: string }> = []

const NativeTest = Layer.succeed(NativeFileSystem, NativeFileSystem.of({
  workspace: "/work",
  inspect: (path) => Effect.succeed(new NativeStat({
    path, kind: "file", bytes: 4, mode: 0o600, device: 1, inode: 2
  })),
  stat: (path) => Effect.succeed(new NativeStat({
    path, kind: "file", bytes: 4, mode: 0o600, device: 1, inode: 2
  })),
  readBytes: () => Effect.succeed(new TextEncoder().encode("seed")),
  readText: () => Effect.succeed("seed"),
  readJson: () => Effect.succeed({ value: "seed" }),
  list: () => Effect.succeed([]),
  glob: () => Effect.succeed([]),
  writeBytes: (path, bytes) => {
    nativeWrites.push({ path, text: new TextDecoder().decode(bytes) })
    return Effect.succeed(new NativeWriteReceipt({
      receipt: {
        id: "act-write",
        source: "/private/stage",
        target: path,
        kind: "file",
        previousHeld: false,
        at: now,
        metadata: { device: 1, inode: 2, mode: 0o600, bytes: bytes.byteLength }
      },
      bytes: bytes.byteLength
    }))
  },
  writeText: (path, text) => {
    nativeWrites.push({ path, text })
    return Effect.succeed(new NativeWriteReceipt({
      receipt: {
        id: "act-write",
        source: "/private/stage",
        target: path,
        kind: "file",
        previousHeld: false,
        at: now,
        metadata: { device: 1, inode: 2, mode: 0o600, bytes: text.length }
      },
      bytes: text.length
    }))
  },
  remove: (target) => Effect.succeed({
    id: ActId.make("act-remove"), target, kind: "file", at: now
  }),
  copy: (_source, target) => Effect.succeed(new NativeWriteReceipt({
    receipt: {
      id: "act-copy", source: "/private/stage", target, kind: "file",
      previousHeld: false, at: now,
      metadata: { device: 1, inode: 2, mode: 0o600, bytes: 4 }
    },
    bytes: 4
  })),
  move: (source, target) => Effect.succeed(new NativeMoveReceipt({
    install: new NativeWriteReceipt({
      receipt: {
        id: "act-move-install", source: "/private/stage", target, kind: "file",
        previousHeld: false, at: now,
        metadata: { device: 1, inode: 2, mode: 0o600, bytes: 4 }
      },
      bytes: 4
    }),
    sourceRemoval: { id: "act-move-remove", target: source, kind: "file", at: now }
  })),
  mkdir: (path) => Effect.succeed(new NativeMkdirReceipt({ path, installs: [] }))
}))

const runtimeInputs: Array<ReadonlyArray<InlineArtifact>> = []
let invocation = 0

const RuntimeTest = Layer.succeed(Runtime, Runtime.of({
  execute: (plan, inputs = []) => {
    invocation += 1
    runtimeInputs.push(inputs.map((input) => new InlineArtifact({
      id: input.id,
      bytes: input.bytes,
      mediaType: input.mediaType,
      provenance: input.provenance
    })))
    const invoke = plan.nodes.find((node): node is InvokeNode => node._tag === "Invoke")!
    const stdin = invoke.stdin === undefined
      ? new Uint8Array()
      : inputs.find((input) => input.id === invoke.stdin)?.bytes ?? new Uint8Array()
    const stdout = new TextEncoder().encode(`${new TextDecoder().decode(stdin)}:${invocation}`)
    const artifacts = [
      ...inputs.map((input) => new RuntimeArtifact({
        artifact: new Artifact({
          id: input.id,
          digest: Digest.make("sha256:input"),
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          provenance: input.provenance
        }),
        bytes: input.bytes
      })),
      ...(invoke.stdoutArtifact === undefined ? [] : [new RuntimeArtifact({
        artifact: new Artifact({
          id: invoke.stdoutArtifact,
          digest: Digest.make(`sha256:stdout-${invocation}`),
          mediaType: "application/octet-stream",
          byteLength: stdout.byteLength,
          provenance: "test:stdout"
        }),
        bytes: stdout
      })]),
      ...(invoke.stderrArtifact === undefined ? [] : [new RuntimeArtifact({
        artifact: new Artifact({
          id: invoke.stderrArtifact,
          digest: Digest.make(`sha256:stderr-${invocation}`),
          mediaType: "application/octet-stream",
          byteLength: 0,
          provenance: "test:stderr"
        }),
        bytes: new Uint8Array()
      })])
    ]
    return Effect.succeed(new RuntimeRun({
      planId: plan.id,
      state: "succeeded",
      startedAt: now,
      finishedAt: now,
      receipts: [],
      artifacts
    }))
  }
}))

const staged: string[] = []
const OutboxTest = Layer.succeed(Outbox, Outbox.of({
  stage: (request, holdMillis) => {
    if ("_tag" in request && request._tag === "ExternalCommandIntent") {
      return Effect.never
    }
    const endpoint = request.url
    staged.push(endpoint)
    return Effect.succeed(new OutboxEmission({
      id: EmissionId.make("emi_test"),
      status: "staged",
      intent: new HttpIntentSummary({
        kind: "http",
        method: request.method,
        endpoint,
        headerNames: [],
        bodyBytes: 0
      }),
      request: new RedactedEmissionRequest({
        method: request.method,
        url: endpoint,
        headers: {}
      }),
      stagedAt: now,
      holdUntil: DateTime.add(now, { millis: holdMillis })
    }))
  },
  inspect: () => Effect.never,
  commit: () => Effect.never,
  cancel: () => Effect.never,
  pending: Effect.succeed([]),
  flush: Effect.succeed({ committed: [], failed: [], waiting: 0 })
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
  Layer.provide(Layer.mergeAll(NativeTest, RuntimeTest, OutboxTest))
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
            return { output: second.stdout, write_state: written.state, emission_state: emission.state }
          `
        }))
      }).pipe(Effect.provide(ProgramTest))
    )

    expect(result.result).toEqual({
      output: "seed:1:2",
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
