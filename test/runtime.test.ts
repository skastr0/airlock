import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AirlockHome from "../src/AirlockHome.ts"
import { HoldLive } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { OutboxLive } from "../src/Outbox.ts"
import {
  ArtifactId,
  AuthorityAdmission,
  CaptureNode,
  Digest,
  NodeId,
  Plan,
  PlanId,
  RequestExternalNode,
  ApplyNode,
  InvokeNode
} from "../src/plan/index.ts"
import { ProcessReceipt, ProcessRunner } from "../src/process/Process.ts"
import { Runtime, RuntimeConfig, RuntimeConfigLive, RuntimeLive } from "../src/runtime/index.ts"

const node = (id: string) => NodeId.make(id)
const artifact = (id: string) => ArtifactId.make(id)

const plan = (nodes: Plan["nodes"]) =>
  new Plan({
    schemaVersion: "airlock/plan/v1",
    id: PlanId.make("plan/runtime-test"),
    actionReference: "test.runtime",
    nodes,
    handles: [],
    resolutions: [],
    admission: new AuthorityAdmission({
      grantIds: [], admittedBy: "test", admittedAt: DateTime.unsafeMake(new Date("2026-01-01T00:00:00.000Z"))
    }),
    definitionDigests: [],
    planDigest: Digest.make("sha256:test")
  })

const runtimeLayer = (workspace: string, home: string) =>
  RuntimeLive.pipe(
    Layer.provideMerge(
      Layer.succeed(
        ProcessRunner,
        ProcessRunner.of({
          run: (request) =>
            Effect.map(DateTime.now, (now) =>
              new ProcessReceipt({
                executable: request.executable,
                argv: request.argv,
                cwd: request.cwd,
                pid: 1,
                exitCode: 0,
                signal: null,
                stdout: request.stdin !== undefined && typeof request.stdin === "object"
                  ? request.stdin._tag === "bytes"
                    ? request.stdin.bytes
                    : new TextEncoder().encode(request.stdin.text)
                  : new Uint8Array(),
                stderr: new Uint8Array(),
                startedAt: now,
                finishedAt: now
              })
            )
        })
      )
    ),
    Layer.provideMerge(HoldLive),
    Layer.provideMerge(OutboxLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(RuntimeConfigLive(new RuntimeConfig({ workspace }))),
    Layer.provideMerge(BunContext.layer)
  )

const execute = (workspace: string, home: string, value: Plan) =>
  Effect.flatMap(Runtime, (runtime) => runtime.execute(value)).pipe(
    Effect.provide(runtimeLayer(workspace, home))
  )

describe("runtime Plan interpreter", () => {
  it.effect("captures, invokes with argv atoms, and applies the output through Hold", () =>
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "airlock-runtime-"))).pipe(
      Effect.flatMap((workspace) =>
        Effect.gen(function* () {
          const home = join(workspace, ".airlock-home")
          const source = join(workspace, "input.txt")
          yield* Effect.promise(() => writeFile(source, "hello airlock"))
          const result = yield* execute(workspace, home, plan([
            new CaptureNode({
              id: node("capture"), dependsOn: [], requires: [], produces: [artifact("input")],
              source: "file", locator: "input.txt"
            }),
            new InvokeNode({
              id: node("invoke"), dependsOn: [node("capture")], requires: [], produces: [artifact("output")],
              argv: ["/bin/cat"], cellProfile: "compatibility", stdin: artifact("input")
            }),
            new ApplyNode({
              id: node("apply"), dependsOn: [node("invoke")], requires: [], produces: [],
              operation: "write", target: "result.txt", sourceArtifact: artifact("output")
            })
          ]))
          expect(result.state).toBe("succeeded")
          expect(result.receipts.map((receipt) => receipt.state)).toEqual(["succeeded", "succeeded", "succeeded"])
          expect(yield* Effect.promise(() => readFile(join(workspace, "result.txt"), "utf8"))).toBe("hello airlock")
        })
      )
    )
  )

  it.effect("stages external work through Outbox and never dispatches it", () =>
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "airlock-runtime-"))).pipe(
      Effect.flatMap((workspace) =>
        Effect.gen(function* () {
          const result = yield* execute(workspace, join(workspace, ".airlock-home"), plan([
            new RequestExternalNode({
              id: node("stage"), dependsOn: [], requires: [], produces: [],
              endpoint: "https://example.invalid/never-dispatched", method: "POST", holdMillis: 60_000
            })
          ]))
          expect(result.state).toBe("succeeded")
          expect(result.receipts[0]?.state).toBe("succeeded")
          expect(yield* Effect.promise(() => stat(join(workspace, ".airlock-home", "outbox")))).toBeDefined()
        })
      )
    )
  )

  it.effect("records failed and dependent-cancelled receipts instead of inventing a success", () =>
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "airlock-runtime-"))).pipe(
      Effect.flatMap((workspace) =>
        Effect.gen(function* () {
          const result = yield* execute(workspace, join(workspace, ".airlock-home"), plan([
            new CaptureNode({
              id: node("missing"), dependsOn: [], requires: [], produces: [artifact("missing")],
              source: "file", locator: "does-not-exist"
            }),
            new ApplyNode({
              id: node("blocked"), dependsOn: [node("missing")], requires: [], produces: [],
              operation: "write", target: "nope.txt", sourceArtifact: artifact("missing")
            })
          ]))
          expect(result.state).toBe("failed")
          expect(result.receipts.map((receipt) => receipt.state)).toEqual(["failed", "cancelled"])
        })
      )
    )
  )
})
