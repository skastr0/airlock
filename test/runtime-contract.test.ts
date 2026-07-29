import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Context, DateTime, Effect, Layer } from "effect"
import { ExecutionAuthority } from "../src/admission/index.ts"
import { Cell } from "../src/cell/index.ts"
import {
  ActId,
  EmissionId,
  RemoveReceipt
} from "../src/domain.ts"
import { Hold } from "../src/Hold.ts"
import {
  NativeFileSystem,
  NativeListEntry,
  NativeMkdirReceipt,
  NativeMoveReceipt,
  NativeStat,
  NativeWriteReceipt
} from "../src/native/index.ts"
import { Outbox, OutboxEmission } from "../src/Outbox.ts"
import {
  HttpIntentSummary,
  RedactedEmissionRequest
} from "../src/outbox/Contract.ts"
import {
  ApplyNode,
  ArtifactId,
  CaptureNode,
  InvokeNode,
  NodeId,
  type PlanNode,
  RequestExternalNode
} from "../src/plan/index.ts"
import {
  ProcessReceipt,
  ProcessRequest,
  ProcessRunner,
  ProcessTimedOut
} from "../src/process/Process.ts"
import {
  Runtime,
  RuntimeConfig,
  RuntimeConfigLive,
  RuntimeInitialArtifact,
  RuntimeLive,
  RuntimePlanInvalid
} from "../src/runtime/index.ts"
import {
  runtimeAuthority as plan,
  uncheckedRuntimeAuthority
} from "./support/RuntimeAuthority.ts"

const timestamp = DateTime.unsafeFromDate(new Date("2026-07-29T00:00:00.000Z"))
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const nodeId = (value: string) => NodeId.make(value)
const artifactId = (value: string) => ArtifactId.make(value)
type ProcessRun = Context.Tag.Service<typeof ProcessRunner>["run"]

const processReceipt = (
  request: ProcessRequest,
  options: {
    readonly exitCode?: number | null
    readonly signal?: string | null
    readonly stdout?: string
    readonly stderr?: string
  } = {}
) => new ProcessReceipt({
  executable: request.executable,
  args: request.args,
  cwd: request.cwd,
  pid: 42,
  exitCode: options.exitCode === undefined ? 0 : options.exitCode,
  signal: options.signal === undefined ? null : options.signal,
  stdout: encoder.encode(options.stdout ?? ""),
  stderr: encoder.encode(options.stderr ?? ""),
  startedAt: timestamp,
  finishedAt: timestamp
})

const writeReceipt = (target: string, bytes = 4) => new NativeWriteReceipt({
  receipt: {
    id: `act-write-${crypto.randomUUID()}`,
    source: "/private/stage",
    target,
    kind: "file",
    previousHeld: false,
    at: timestamp,
    metadata: {
      device: 1,
      inode: 2,
      mode: 0o600,
      bytes
    }
  },
  bytes
})

const impossibleHold = Layer.succeed(Hold, Hold.of({
  remove: () => Effect.die("Runtime must use NativeFileSystem for Apply.remove"),
  overwrite: () => Effect.die("Runtime must use NativeFileSystem for Apply.write"),
  retireRuntimePrivate: () => Effect.die("compatibility execution has no Cell workspace"),
  replaceFrom: () => Effect.die("compatibility execution has no Cell delta"),
  replaceByStaging: () => Effect.die("compatibility execution has no staged replacement"),
  undo: () => Effect.die("unused"),
  undoLast: Effect.die("unused"),
  held: Effect.succeed([]),
  reap: () => Effect.die("unused")
}))

const impossibleCell = Layer.succeed(Cell, Cell.of({
  run: () => Effect.die("validation and compatibility execution must not enter Cell"),
  revalidate: () => Effect.die("validation and compatibility execution have no Cell delta")
}))

type NativeCall = Readonly<{
  readonly operation: string
  readonly source?: string
  readonly target: string
}>

const nativeLayer = (calls: Array<NativeCall>) =>
  Layer.succeed(NativeFileSystem, NativeFileSystem.of({
    workspace: "/work",
    inspect: (path) => {
      calls.push({ operation: "inspect", target: path })
      return Effect.succeed(new NativeStat({
        path,
        kind: "file",
        bytes: 4,
        mode: 0o600,
        device: 1,
        inode: 2
      }))
    },
    stat: (path) => {
      calls.push({ operation: "stat", target: path })
      return Effect.succeed(new NativeStat({
        path,
        kind: "file",
        bytes: 4,
        mode: 0o600,
        device: 1,
        inode: 2
      }))
    },
    readBytes: (path) => {
      calls.push({ operation: "read", target: path })
      return Effect.succeed(encoder.encode("seed"))
    },
    readText: () => Effect.die("Runtime preserves Capture.file.read bytes"),
    readJson: () => Effect.die("Runtime preserves Capture.file.read bytes"),
    list: (path) => {
      calls.push({ operation: "list", target: path })
      return Effect.succeed([
        new NativeListEntry({
          name: "seed.txt",
          stat: new NativeStat({
            path: `${path}/seed.txt`,
            kind: "file",
            bytes: 4,
            mode: 0o600,
            device: 1,
            inode: 2
          })
        })
      ])
    },
    glob: (root, pattern) => {
      calls.push({ operation: `glob:${pattern}`, target: root })
      return Effect.succeed([`${root}/seed.txt`])
    },
    writeBytes: (target, bytes) => {
      calls.push({ operation: "write", target })
      return Effect.succeed(writeReceipt(target, bytes.byteLength))
    },
    writeText: () => Effect.die("Runtime lowers writes as artifact bytes"),
    remove: (target) => {
      calls.push({ operation: "remove", target })
      return Effect.succeed(new RemoveReceipt({
        id: ActId.make(`act-remove-${crypto.randomUUID()}`),
        target,
        kind: "file",
        at: timestamp
      }))
    },
    copy: (source, target) => {
      calls.push({ operation: "copy", source, target })
      return Effect.succeed(writeReceipt(target))
    },
    move: (source, target) => {
      calls.push({ operation: "move", source, target })
      return Effect.succeed(new NativeMoveReceipt({
        install: writeReceipt(target),
        sourceRemoval: {
          id: `act-move-${crypto.randomUUID()}`,
          target: source,
          kind: "file",
          at: timestamp
        }
      }))
    },
    mkdir: (target, options) => {
      calls.push({
        operation: options?.parents === true ? "mkdir:parents" : "mkdir",
        target
      })
      return Effect.succeed(new NativeMkdirReceipt({
        path: target,
        installs: []
      }))
    }
  }))

const outboxLayer = (requests: Array<string>) =>
  Layer.succeed(Outbox, Outbox.of({
    stage: (request, holdMillis) => {
      if ("_tag" in request) return Effect.die("external command intent is not a Plan v1 node")
      requests.push(request.url)
      return Effect.succeed(new OutboxEmission({
        id: EmissionId.make(`emi_${crypto.randomUUID()}`),
        status: "staged",
        intent: new HttpIntentSummary({
          kind: "http",
          method: request.method,
          endpoint: request.url,
          headerNames: Object.keys(request.headers).sort(),
          bodyBytes: encoder.encode(request.body ?? "").byteLength
        }),
        request: new RedactedEmissionRequest({
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(
            Object.keys(request.headers).map((name) => [name, "[redacted]"])
          ),
          ...(request.body === undefined ? {} : { body: "[redacted]" })
        }),
        stagedAt: timestamp,
        holdUntil: DateTime.add(timestamp, { millis: holdMillis })
      }))
    },
    inspect: () => Effect.die("unused"),
    commit: () => Effect.die("Runtime stages but never commits"),
    cancel: () => Effect.die("unused"),
    pending: Effect.succeed([]),
    flush: Effect.die("Runtime never flushes Outbox")
  }))

const runtimeLayer = (
  runner: ProcessRun,
  options: {
    readonly profile?: "compatibility" | "native-contained"
    readonly nativeCalls?: Array<NativeCall>
    readonly externalRequests?: Array<string>
  } = {}
) =>
  RuntimeLive.pipe(
    Layer.provideMerge(Layer.succeed(ProcessRunner, ProcessRunner.of({ run: runner }))),
    Layer.provideMerge(nativeLayer(options.nativeCalls ?? [])),
    Layer.provideMerge(outboxLayer(options.externalRequests ?? [])),
    Layer.provideMerge(impossibleCell),
    Layer.provideMerge(impossibleHold),
    Layer.provideMerge(RuntimeConfigLive(new RuntimeConfig({
      workspace: "/work",
      profile: options.profile ?? "compatibility",
      environment: { AIRLOCK_TEST: "present" }
    }))),
    Layer.provideMerge(BunContext.layer)
  )

const execute = (
  value: ExecutionAuthority,
  layer: Layer.Layer<Runtime, never, never>,
  inputs: ReadonlyArray<RuntimeInitialArtifact> = []
) =>
  Effect.flatMap(Runtime, (runtime) => runtime.execute(value, inputs)).pipe(
    Effect.provide(layer)
  )

describe("Runtime total Plan contract", () => {
  it.effect("revalidates grant lifetime immediately before node execution", () => {
    let processCalls = 0
    const runner: ProcessRun = (request) => {
      processCalls += 1
      return Effect.succeed(processReceipt(request))
    }
    const authority = plan([
      new InvokeNode({
        id: nodeId("expired-authority"),
        dependsOn: [],
        requires: [],
        produces: [],
        executable: "/usr/bin/true",
        args: [],
        cwd: "/work",
        env: {},
        stdout: "discard",
        stderr: "discard",
        cellProfile: "compatibility"
      })
    ], {
      grantTtlMillis: 1,
      admittedAt: new Date("2000-01-01T00:00:00.000Z")
    })

    return Effect.gen(function* () {
      const result = yield* execute(authority, runtimeLayer(runner))

      expect(processCalls).toBe(0)
      expect(result.state).toBe("failed")
      expect(result.receipts[0]).toMatchObject({
        nodeId: nodeId("expired-authority"),
        state: "failed",
        errorTag: "RuntimeAuthorityInvalid"
      })
      expect(result.processes).toEqual([])
    })
  })

  it.effect("refuses a missing retained node binding before execution", () => {
    let processCalls = 0
    const runner: ProcessRun = (request) => {
      processCalls += 1
      return Effect.succeed(processReceipt(request))
    }
    const admitted = plan([
      new InvokeNode({
        id: nodeId("tampered-authority"),
        dependsOn: [],
        requires: [],
        produces: [],
        executable: "/usr/bin/true",
        args: [],
        cwd: "/work",
        env: {},
        stdout: "discard",
        stderr: "discard",
        cellProfile: "compatibility"
      })
    ])
    const tampered = new ExecutionAuthority({
      ...admitted,
      bindings: []
    })

    return Effect.gen(function* () {
      const result = yield* execute(tampered, runtimeLayer(runner))

      expect(processCalls).toBe(0)
      expect(result.state).toBe("failed")
      expect(result.receipts[0]).toMatchObject({
        nodeId: nodeId("tampered-authority"),
        state: "failed",
        errorTag: "RuntimeAuthorityInvalid"
      })
    })
  })

  it.effect("preserves nonzero process evidence and both captured streams", () => {
    const stdout = artifactId("artifact/nonzero-stdout")
    const stderr = artifactId("artifact/nonzero-stderr")
    const runner: ProcessRun = (request) =>
      Effect.succeed(processReceipt(request, {
        exitCode: 7,
        stdout: "useful stdout",
        stderr: "useful stderr"
      }))
    return Effect.gen(function* () {
      const result = yield* execute(plan([
        new InvokeNode({
          id: nodeId("nonzero"),
          dependsOn: [],
          requires: [],
          produces: [stdout, stderr],
          executable: "/usr/bin/false",
          args: ["--structured"],
          cwd: "/work",
          env: {},
          stdoutArtifact: stdout,
          stderrArtifact: stderr,
          stdout: "capture",
          stderr: "capture",
          cellProfile: "compatibility"
        })
      ]), runtimeLayer(runner))

      expect(result.schemaVersion).toBe("airlock/runtime-run/v1")
      expect(result.state).toBe("failed")
      expect(result.receipts[0]).toMatchObject({
        schemaVersion: "airlock/receipt/v1",
        state: "failed",
        errorTag: "RuntimeProcessFailure",
        outputArtifacts: [stdout, stderr]
      })
      expect(result.processes).toHaveLength(1)
      expect(result.processes[0]).toMatchObject({
        nodeId: nodeId("nonzero"),
        outcome: "exited",
        receipt: {
          exitCode: 7,
          signal: null,
          pid: 42
        }
      })
      expect(decoder.decode(
        result.artifacts.find((entry) => entry.artifact.id === stdout)?.bytes
      )).toBe("useful stdout")
      expect(decoder.decode(
        result.artifacts.find((entry) => entry.artifact.id === stderr)?.bytes
      )).toBe("useful stderr")
    })
  })

  it.effect("preserves timeout receipts and partial process output", () => {
    const stdout = artifactId("artifact/timeout-stdout")
    const stderr = artifactId("artifact/timeout-stderr")
    const runner: ProcessRun = (request) => {
      const receipt = processReceipt(request, {
        exitCode: null,
        signal: "SIGTERM",
        stdout: "partial stdout",
        stderr: "timeout detail"
      })
      return Effect.fail(new ProcessTimedOut({
        timeoutMs: 50,
        receipt
      }))
    }
    return Effect.gen(function* () {
      const result = yield* execute(plan([
        new InvokeNode({
          id: nodeId("timeout"),
          dependsOn: [],
          requires: [],
          produces: [stdout, stderr],
          executable: "/bin/sleep",
          args: ["60"],
          cwd: "/work",
          env: {},
          stdoutArtifact: stdout,
          stderrArtifact: stderr,
          stdout: "capture",
          stderr: "capture",
          timeoutMs: 50,
          cellProfile: "compatibility"
        })
      ]), runtimeLayer(runner))

      expect(result.state).toBe("failed")
      expect(result.receipts[0]).toMatchObject({
        errorTag: "RuntimeProcessFailure",
        outputArtifacts: [stdout, stderr]
      })
      expect(result.processes[0]).toMatchObject({
        outcome: "timed-out",
        receipt: {
          exitCode: null,
          signal: "SIGTERM"
        }
      })
      expect(decoder.decode(
        result.artifacts.find((entry) => entry.artifact.id === stdout)?.bytes
      )).toBe("partial stdout")
      expect(decoder.decode(
        result.artifacts.find((entry) => entry.artifact.id === stderr)?.bytes
      )).toBe("timeout detail")
    })
  })

  it.effect("lowers every native Capture and Apply operation and receipts claim real artifacts", () => {
    const nativeCalls: NativeCall[] = []
    const externalRequests: string[] = []
    const source = artifactId("artifact/source")
    const produced = [
      "read",
      "inspect",
      "stat",
      "list",
      "glob",
      "environment",
      "clock",
      "write",
      "copy",
      "move",
      "mkdir",
      "remove",
      "external"
    ].map((name) => artifactId(`artifact/${name}`))
    const [read, inspect, stat, list, glob, environment, clock, write, copy, move, mkdir, remove, external] = produced
    const nodes: ReadonlyArray<PlanNode> = [
      new CaptureNode({
        id: nodeId("read"),
        dependsOn: [],
        requires: [],
        produces: [read!],
        source: "file",
        locator: "seed.txt",
        operation: "read",
        format: "bytes"
      }),
      new CaptureNode({
        id: nodeId("inspect"),
        dependsOn: [],
        requires: [],
        produces: [inspect!],
        source: "file",
        locator: "seed.txt",
        operation: "inspect"
      }),
      new CaptureNode({
        id: nodeId("stat"),
        dependsOn: [],
        requires: [],
        produces: [stat!],
        source: "file",
        locator: "seed.txt",
        operation: "stat"
      }),
      new CaptureNode({
        id: nodeId("list"),
        dependsOn: [],
        requires: [],
        produces: [list!],
        source: "file",
        locator: ".",
        operation: "list"
      }),
      new CaptureNode({
        id: nodeId("glob"),
        dependsOn: [],
        requires: [],
        produces: [glob!],
        source: "file",
        locator: ".",
        operation: "glob",
        pattern: "*.txt"
      }),
      new CaptureNode({
        id: nodeId("environment"),
        dependsOn: [],
        requires: [],
        produces: [environment!],
        source: "environment",
        locator: "AIRLOCK_TEST"
      }),
      new CaptureNode({
        id: nodeId("clock"),
        dependsOn: [],
        requires: [],
        produces: [clock!],
        source: "clock",
        locator: "now"
      }),
      new ApplyNode({
        id: nodeId("write"),
        dependsOn: [],
        requires: [],
        produces: [write!],
        operation: "write",
        target: "write.txt",
        sourceArtifact: source
      }),
      new ApplyNode({
        id: nodeId("copy"),
        dependsOn: [],
        requires: [],
        produces: [copy!],
        operation: "copy",
        source: "seed.txt",
        target: "copy.txt"
      }),
      new ApplyNode({
        id: nodeId("move"),
        dependsOn: [],
        requires: [],
        produces: [move!],
        operation: "move",
        source: "copy.txt",
        target: "moved.txt"
      }),
      new ApplyNode({
        id: nodeId("mkdir"),
        dependsOn: [],
        requires: [],
        produces: [mkdir!],
        operation: "mkdir",
        target: "nested/directory",
        parents: true
      }),
      new ApplyNode({
        id: nodeId("remove"),
        dependsOn: [],
        requires: [],
        produces: [remove!],
        operation: "remove",
        target: "obsolete.txt"
      }),
      new RequestExternalNode({
        id: nodeId("external"),
        dependsOn: [],
        requires: [],
        produces: [external!],
        method: "POST",
        endpoint: "https://example.test/jobs",
        headers: { "content-type": "application/json" },
        body: "{\"job\":\"test\"}",
        holdMillis: 10_000
      })
    ]
    const runner: ProcessRun = () => Effect.die("Plan contains no Invoke")

    return Effect.gen(function* () {
      const result = yield* execute(
        plan(nodes),
        runtimeLayer(runner, { nativeCalls, externalRequests }),
        [new RuntimeInitialArtifact({
          id: source,
          bytes: encoder.encode("payload"),
          mediaType: "text/plain; charset=utf-8",
          provenance: "test:inline"
        })]
      )

      expect(result.state).toBe("succeeded")
      expect(nativeCalls.map((call) => call.operation)).toEqual([
        "read",
        "inspect",
        "stat",
        "list",
        "glob:*.txt",
        "write",
        "copy",
        "move",
        "mkdir:parents",
        "remove"
      ])
      expect(externalRequests).toEqual(["https://example.test/jobs"])
      expect(result.receipts.map((receipt) => receipt.outputArtifacts)).toEqual(
        produced.map((id) => [id])
      )
      for (const id of produced) {
        expect(result.artifacts.some((entry) => entry.artifact.id === id)).toBe(true)
      }
    })
  })

  it.effect("preserves explicit inherited stdin only in compatibility execution", () => {
    let observed: ProcessRequest["stdin"] | undefined
    const runner: ProcessRun = (request) => {
      observed = request.stdin
      return Effect.succeed(processReceipt(request))
    }
    return Effect.gen(function* () {
      const result = yield* execute(plan([
        new InvokeNode({
          id: nodeId("inherit-compatible"),
          dependsOn: [],
          requires: [],
          produces: [],
          executable: "/usr/bin/true",
          args: [],
          cwd: "/work",
          env: {},
          stdinDisposition: "inherit",
          stdout: "discard",
          stderr: "discard",
          cellProfile: "compatibility"
        })
      ]), runtimeLayer(runner))

      expect(result.state).toBe("succeeded")
      expect(observed).toBe("inherit")
    })
  })

  for (const descriptor of ["stdin", "stdout", "stderr"] as const) {
    it.effect(`rejects native-contained ${descriptor} inheritance before Cell execution`, () => {
      const delta = artifactId(`artifact/${descriptor}-delta`)
      const invoke = new InvokeNode({
        id: nodeId(`inherit-${descriptor}`),
        dependsOn: [],
        requires: [],
        produces: [delta],
        executable: "/usr/bin/true",
        args: [],
        cwd: "/work",
        env: {},
        ...(descriptor === "stdin" ? { stdinDisposition: "inherit" as const } : {}),
        stdout: descriptor === "stdout" ? "inherit" : "discard",
        stderr: descriptor === "stderr" ? "inherit" : "discard",
        deltaArtifact: delta,
        cellProfile: "native-contained"
      })
      const runner: ProcessRun = () => Effect.die("validation must run first")
      return execute(
        uncheckedRuntimeAuthority([invoke]),
        runtimeLayer(runner, { profile: "native-contained" })
      ).pipe(
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => {
          expect(error).toBeInstanceOf(RuntimePlanInvalid)
          expect(error.reason).toContain("forbids inherited stdin, stdout, and stderr")
        }))
      )
    })
  }

  it.effect("rejects unsupported node contracts before any adapter gains authority", () => {
    const nativeCalls: NativeCall[] = []
    const externalRequests: string[] = []
    let processCalls = 0
    const runner: ProcessRun = (request) => {
      processCalls += 1
      return Effect.succeed(processReceipt(request))
    }
    const invalidPlans = [
      uncheckedRuntimeAuthority([
        new CaptureNode({
          id: nodeId("invalid-glob"),
          dependsOn: [],
          requires: [],
          produces: [artifactId("artifact/invalid-glob")],
          source: "file",
          locator: ".",
          operation: "glob"
        })
      ]),
      uncheckedRuntimeAuthority([
        new CaptureNode({
          id: nodeId("invalid-process-output"),
          dependsOn: [],
          requires: [],
          produces: [artifactId("artifact/process-output")],
          source: "process-output",
          locator: "stdout"
        })
      ]),
      uncheckedRuntimeAuthority([
        new ApplyNode({
          id: nodeId("invalid-copy"),
          dependsOn: [],
          requires: [],
          produces: [],
          operation: "copy",
          target: "copy.txt"
        })
      ]),
      uncheckedRuntimeAuthority([
        new InvokeNode({
          id: nodeId("missing-delta"),
          dependsOn: [],
          requires: [],
          produces: [],
          executable: "/usr/bin/true",
          args: [],
          cwd: "/work",
          env: {},
          stdout: "discard",
          stderr: "discard",
          cellProfile: "native-contained"
        })
      ]),
      uncheckedRuntimeAuthority([
        new RequestExternalNode({
          id: nodeId("two-bodies"),
          dependsOn: [],
          requires: [],
          produces: [],
          method: "POST",
          endpoint: "https://example.test",
          headers: {},
          body: "inline",
          bodyArtifact: artifactId("artifact/also-body"),
          holdMillis: 0
        })
      ])
    ]

    return Effect.gen(function* () {
      for (const invalid of invalidPlans) {
        const error = yield* execute(
          invalid,
          runtimeLayer(runner, { nativeCalls, externalRequests })
        ).pipe(Effect.flip)
        expect(error).toBeInstanceOf(RuntimePlanInvalid)
      }
      expect(processCalls).toBe(0)
      expect(nativeCalls).toEqual([])
      expect(externalRequests).toEqual([])
    })
  })
})
