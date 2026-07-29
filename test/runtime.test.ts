import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AirlockHome from "../src/AirlockHome.ts"
import {
  Cell,
  CellLive,
  CellReceipt,
  CellRequest,
  CellUnavailable,
  WorkspaceDeltaCandidate,
  WorkspaceDrift,
  WorkspaceEntryFingerprint,
  WorkspaceFingerprint
} from "../src/cell/index.ts"
import { Hold, HoldFilesystemError, HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import {
  NativeFileSystemLive,
  NativeFilesystemConfig
} from "../src/native/index.ts"
import { OutboxLive } from "../src/Outbox.ts"
import {
  ArtifactId, AuthorityAdmission, CaptureNode, Digest, NodeId, Plan, PlanId, RequestExternalNode, ApplyNode, InvokeNode
} from "../src/plan/index.ts"
import { MacosPlatformLive } from "../src/platform/macos/index.ts"
import { ProcessReceipt, ProcessRunner, ProcessRunnerLive } from "../src/process/Process.ts"
import {
  Runtime,
  RuntimeConfig,
  RuntimeConfigLive,
  RuntimeInitialArtifact,
  RuntimeLive
} from "../src/runtime/index.ts"
import { MacosExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const HoldTestLive = HoldLayer.pipe(
  Layer.provide(MacosExclusiveRenameTestLive)
)

const node = (id: string) => NodeId.make(id)
const artifact = (id: string) => ArtifactId.make(id)
const now = () => DateTime.unsafeMake(new Date("2026-07-29T00:00:00.000Z"))
const darwinCell = globalThis.process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && typeof Bun !== "undefined"

const plan = (nodes: Plan["nodes"]) => new Plan({
  schemaVersion: "airlock/plan/v1", id: PlanId.make("plan/runtime-test"), actionReference: "test.runtime", nodes,
  handles: [], resolutions: [], admission: new AuthorityAdmission({ grantIds: [], admittedBy: "test", admittedAt: now() }),
  definitionDigests: [], planDigest: Digest.make("sha256:test")
})

const impossibleCell = Layer.succeed(Cell, Cell.of({
  run: () => Effect.die("compatibility never calls Cell.run"),
  revalidate: () => Effect.die("compatibility never calls Cell.revalidate")
}))

const compatibilityLayer = (workspace: string, home: string) => RuntimeLive.pipe(
  Layer.provideMerge(Layer.succeed(ProcessRunner, ProcessRunner.of({
    run: (request) => Effect.map(DateTime.now, (at) => new ProcessReceipt({
      executable: request.executable, args: request.args, cwd: request.cwd, pid: 1, exitCode: 0, signal: null,
      stdout: typeof request.stdin === "object" && request.stdin._tag === "bytes"
        ? request.stdin.bytes
        : new TextEncoder().encode(request.args.join("|")),
      stderr: new Uint8Array(), startedAt: at, finishedAt: at
    }))
  }))),
  Layer.provideMerge(impossibleCell),
  Layer.provideMerge(NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))),
  Layer.provideMerge(HoldTestLive), Layer.provideMerge(OutboxLive), Layer.provideMerge(LedgerLive),
  Layer.provideMerge(AirlockHome.layer(home)),
  Layer.provideMerge(RuntimeConfigLive(new RuntimeConfig({ workspace }))),
  Layer.provideMerge(BunContext.layer)
)

const nativeLayer = (
  workspace: string,
  home: string,
  cell: Layer.Layer<Cell, any, any>,
  hold: Layer.Layer<Hold, any, any> = HoldTestLive
) => RuntimeLive.pipe(
  Layer.provideMerge(cell), Layer.provideMerge(ProcessRunnerLive), Layer.provideMerge(MacosPlatformLive),
  Layer.provideMerge(NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))),
  Layer.provideMerge(hold), Layer.provideMerge(OutboxLive), Layer.provideMerge(LedgerLive),
  Layer.provideMerge(AirlockHome.layer(home)),
  Layer.provideMerge(RuntimeConfigLive(new RuntimeConfig({ workspace, profile: "native-contained" }))),
  Layer.provideMerge(BunContext.layer)
)

const execute = (
  value: Plan,
  layer: Layer.Layer<Runtime, any, any>,
  initialArtifacts: ReadonlyArray<RuntimeInitialArtifact> = []
) =>
  Effect.flatMap(Runtime, (runtime) => runtime.execute(value, initialArtifacts)).pipe(
    Effect.provide(layer)
  )

const fingerprint = (absolute: string, display: string): WorkspaceEntryFingerprint => {
  const info = lstatSync(absolute)
  const kind = info.isFile() ? "file" as const : info.isDirectory() ? "directory" as const : "other" as const
  const material = kind === "file"
    ? readFileSync(absolute)
    : kind === "directory"
      ? readdirSync(absolute).sort().map((entry) => `${entry}\0${fingerprint(join(absolute, entry), entry).digest}\0`).join("")
      : ""
  return new WorkspaceEntryFingerprint({
    path: display, kind, bytes: info.size, mode: info.mode,
    digest: createHash("sha256").update(`${kind}\0${info.mode}\0${info.size}\0`).update(material).digest("hex")
  })
}

const processReceipt = (workspace: string, exitCode = 0) => new ProcessReceipt({
  executable: "/bin/true", args: [], cwd: workspace, pid: 1, exitCode, signal: null,
  stdout: new Uint8Array(), stderr: new Uint8Array(), startedAt: now(), finishedAt: now()
})

const workspaceFingerprint = (root: string) => {
  const entries = readdirSync(root).sort().map((entry) => fingerprint(join(root, entry), entry))
  return new WorkspaceFingerprint({
    root,
    entries,
    digest: createHash("sha256")
      .update(entries.map((entry) => `${entry.path}\0${entry.digest}\0`).join(""))
      .digest("hex")
  })
}

const noDeltaReceipt = (
  request: CellRequest,
  workspace: string,
  exitCode = 0
) => new CellReceipt({
  sourceWorkspace: workspace,
  privateWorkspace: request.privateWorkspace,
  network: "deny",
  readAuthority: "ambient-host-read",
  process: request.process,
  processReceipt: processReceipt(workspace, exitCode),
  baseline: workspaceFingerprint(workspace),
  live: workspaceFingerprint(workspace),
  private: workspaceFingerprint(request.privateWorkspace),
  delta: [],
  drift: []
})

describe("runtime Plan interpreter", () => {
  it.effect("uses compatibility ProcessRunner with executable separate from argv atoms", () =>
    Effect.sync(() => mkdtempSync(join(tmpdir(), "airlock-runtime-"))).pipe(
      Effect.flatMap((workspace) => Effect.gen(function* () {
        const result = yield* execute(plan([
          new InvokeNode({
            id: node("invoke"), dependsOn: [], requires: [], produces: [artifact("output")], executable: "/usr/bin/printf",
            args: ["%s", "a value; never shell syntax"], cwd: workspace, env: { LANG: "C" }, stdoutArtifact: artifact("output"),
            stdout: "capture", stderr: "discard", cellProfile: "compatibility"
          }),
          new ApplyNode({ id: node("apply"), dependsOn: [node("invoke")], requires: [], produces: [], operation: "write", target: "result.txt", sourceArtifact: artifact("output") })
        ]), compatibilityLayer(workspace, join(workspace, ".airlock-home")))
        expect(result.state).toBe("succeeded")
        expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("%s|a value; never shell syntax")
      }))
    )
  )

  it.effect("feeds explicit initial artifact bytes to stdin without materializing an ambient file", () =>
    Effect.sync(() => mkdtempSync(join(tmpdir(), "airlock-runtime-"))).pipe(
      Effect.flatMap((workspace) => {
        const stdin = artifact("stdin")
        const stdout = artifact("stdout")
        const input = new RuntimeInitialArtifact({
          id: stdin,
          bytes: new TextEncoder().encode("structured pipe"),
          mediaType: "text/plain; charset=utf-8",
          provenance: "test:inline"
        })
        return Effect.gen(function* () {
          const result = yield* execute(
            plan([
              new InvokeNode({
                id: node("consume"),
                dependsOn: [],
                requires: [],
                produces: [stdout],
                executable: "/usr/bin/cat",
                args: [],
                cwd: workspace,
                env: {},
                stdin,
                stdoutArtifact: stdout,
                stdout: "capture",
                stderr: "discard",
                cellProfile: "compatibility"
              })
            ]),
            compatibilityLayer(workspace, join(workspace, ".airlock-home")),
            [input]
          )
          const output = result.artifacts.find((entry) => entry.artifact.id === stdout)
          expect(new TextDecoder().decode(output?.bytes)).toBe("structured pipe")
          expect(output?.artifact.provenance).toBe("invoke:stdout:/usr/bin/cat")
        })
      })
    )
  )

  it.effect("stages external work through Outbox and never dispatches it", () =>
    Effect.sync(() => mkdtempSync(join(tmpdir(), "airlock-runtime-"))).pipe(
      Effect.flatMap((workspace) => Effect.gen(function* () {
        const home = join(workspace, ".airlock-home")
        const result = yield* execute(plan([
          new RequestExternalNode({
            id: node("stage"),
            dependsOn: [],
            requires: [],
            produces: [],
            endpoint: "https://example.invalid/never-dispatched",
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer never-expose"
            },
            body: "{\"phase\":\"stage-only\"}",
            holdMillis: 60_000
          })
        ]), compatibilityLayer(workspace, home))
        expect(result.state).toBe("succeeded")
        expect(existsSync(join(home, "outbox"))).toBe(true)
        const [stateDirectory] = readdirSync(join(home, "outbox"))
        expect(stateDirectory).toMatch(/^emi_.+\.staged$/)
        const manifest = JSON.parse(
          readFileSync(join(home, "outbox", stateDirectory!, "manifest.json"), "utf8")
        ) as {
          readonly intent: { readonly headerNames: ReadonlyArray<string>; readonly bodyBytes: number }
          readonly request: { readonly headers: Record<string, string>; readonly body?: string }
        }
        expect(manifest.intent.headerNames).toEqual(["authorization", "content-type"])
        expect(manifest.intent.bodyBytes).toBe(new TextEncoder().encode("{\"phase\":\"stage-only\"}").byteLength)
        expect(manifest.request.headers.authorization).toBe("[redacted]")
        expect(manifest.request.body).not.toContain("stage-only")
      }))
    )
  )

  it.effect("records failed and dependent-cancelled receipts instead of inventing success", () =>
    Effect.sync(() => mkdtempSync(join(tmpdir(), "airlock-runtime-"))).pipe(
      Effect.flatMap((workspace) => Effect.gen(function* () {
        const result = yield* execute(plan([
          new CaptureNode({ id: node("missing"), dependsOn: [], requires: [], produces: [artifact("missing")], source: "file", locator: "does-not-exist" }),
          new ApplyNode({ id: node("blocked"), dependsOn: [node("missing")], requires: [], produces: [], operation: "write", target: "nope.txt", sourceArtifact: artifact("missing") })
        ]), compatibilityLayer(workspace, join(workspace, ".airlock-home")))
        expect(result.state).toBe("failed")
        expect(result.receipts.map((receipt) => receipt.state)).toEqual(["failed", "cancelled"])
      }))
    )
  )
})

describe.skipIf(!darwinCell)("native-contained runtime on macOS", () => {
  it.effect("keeps process edits private until Apply and makes the merge undoable", () =>
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "airlock-runtime-cell-"))
      const workspace = join(root, "workspace")
      mkdirSync(workspace)
      writeFileSync(join(workspace, "changed.txt"), "live-before")
      return { workspace, home: join(root, ".airlock-home") }
    }).pipe(Effect.flatMap(({ workspace, home }) => Effect.gen(function* () {
      const layer = nativeLayer(workspace, home, CellLive)
      const result = yield* Effect.gen(function* () {
        const runtime = yield* Runtime
        const run = yield* runtime.execute(plan([
          new InvokeNode({
            id: node("private-edit"), dependsOn: [], requires: [], produces: [artifact("delta")], executable: "/bin/sh", args: ["-c", "printf private-after > changed.txt"],
            cwd: workspace, env: {}, deltaArtifact: artifact("delta"), stdout: "discard", stderr: "discard", cellProfile: "native-contained"
          }),
          new CaptureNode({ id: node("observe-live"), dependsOn: [node("private-edit")], requires: [], produces: [artifact("before-apply")], source: "file", locator: "changed.txt" }),
          new ApplyNode({ id: node("merge"), dependsOn: [node("observe-live")], requires: [], produces: [], operation: "merge", target: ".", sourceArtifact: artifact("delta") })
        ]))
        const hold = yield* Hold
        const undo = yield* hold.undoLast
        return { run, undo }
      }).pipe(Effect.provide(layer))
      const before = result.run.artifacts.find((entry) => entry.artifact.id === artifact("before-apply"))
      expect(new TextDecoder().decode(before?.bytes)).toBe("live-before")
      expect(readFileSync(join(workspace, "changed.txt"), "utf8")).toBe("live-before")
      expect(result.undo.target).toBe(join(workspace, "changed.txt"))
    })))
  )

})

describe("native-contained runtime", () => {
  it.effect("merges a top-level private directory through Hold and undoes it", () =>
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "airlock-runtime-merge-"))
      const workspace = join(root, "workspace")
      mkdirSync(join(workspace, "bundle"), { recursive: true })
      writeFileSync(join(workspace, "bundle", "state.txt"), "live-before")
      return { workspace, home: join(root, ".airlock-home") }
    }).pipe(Effect.flatMap(({ workspace, home }) => Effect.gen(function* () {
      const baselineEntry = fingerprint(join(workspace, "bundle"), "bundle")
      const baseline = new WorkspaceFingerprint({ root: workspace, entries: [baselineEntry], digest: "baseline" })
      const fakeCell = Layer.succeed(Cell, Cell.of({
        run: (request) => Effect.sync(() => {
          mkdirSync(join(request.privateWorkspace, "bundle"), { recursive: true })
          writeFileSync(join(request.privateWorkspace, "bundle", "state.txt"), "private-after")
          const privateEntry = fingerprint(join(request.privateWorkspace, "bundle"), "bundle")
          const privateView = new WorkspaceFingerprint({
            root: request.privateWorkspace,
            entries: [privateEntry],
            digest: "private"
          })
          return new CellReceipt({
            sourceWorkspace: workspace,
            privateWorkspace: request.privateWorkspace,
            network: "deny",
            readAuthority: "ambient-host-read",
            process: request.process,
            processReceipt: processReceipt(workspace),
            baseline,
            live: baseline,
            private: privateView,
            delta: [new WorkspaceDeltaCandidate({
              path: "bundle",
              kind: "modified",
              baseline: baselineEntry,
              private: privateEntry
            })],
            drift: []
          })
        }),
        revalidate: () => Effect.succeed([])
      }))
      const layer = nativeLayer(workspace, home, fakeCell)
      const result = yield* Effect.gen(function* () {
        const runtime = yield* Runtime
        const run = yield* runtime.execute(plan([
          new InvokeNode({
            id: node("private-directory"), dependsOn: [], requires: [], produces: [artifact("delta")],
            executable: "/bin/true", args: [], cwd: workspace, env: {}, deltaArtifact: artifact("delta"),
            stdout: "discard", stderr: "discard", cellProfile: "native-contained"
          }),
          new ApplyNode({
            id: node("merge-directory"), dependsOn: [node("private-directory")], requires: [], produces: [],
            operation: "merge", target: ".", sourceArtifact: artifact("delta")
          })
        ]))
        const afterMerge = readFileSync(join(workspace, "bundle", "state.txt"), "utf8")
        const hold = yield* Hold
        const undo = yield* hold.undoLast
        return { run, afterMerge, undo }
      }).pipe(Effect.provide(layer))
      expect(result.run.state).toBe("succeeded")
      expect(result.run.lifecycle).toEqual([
        expect.objectContaining({
          _tag: "RuntimeCellWorkspaceHeld",
          state: "held",
          nodeId: node("private-directory")
        })
      ])
      expect(result.afterMerge).toBe("private-after")
      expect(result.undo.target).toBe(join(workspace, "bundle"))
      expect(readFileSync(join(workspace, "bundle", "state.txt"), "utf8")).toBe("live-before")
    })))
  )

  it.effect("refuses a Cell delta when revalidation reports drift before Hold transitions", () =>
    Effect.sync(() => mkdtempSync(join(tmpdir(), "airlock-runtime-drift-"))).pipe(
      Effect.flatMap((workspace) => Effect.gen(function* () {
        writeFileSync(join(workspace, "changed.txt"), "live")
        const entry = new WorkspaceEntryFingerprint({ path: "changed.txt", kind: "file", bytes: 4, mode: 0o100644, digest: "baseline" })
        const baselineFingerprint = new WorkspaceFingerprint({ root: workspace, entries: [entry], digest: "workspace" })
        const driftCell = Layer.succeed(Cell, Cell.of({
          run: (request) => Effect.sync(() => {
            mkdirSync(request.privateWorkspace, { recursive: true })
            writeFileSync(join(request.privateWorkspace, "changed.txt"), "live")
            const privateEntry = fingerprint(
              join(request.privateWorkspace, "changed.txt"),
              "changed.txt"
            )
            const privateView = new WorkspaceFingerprint({
              root: request.privateWorkspace,
              entries: [privateEntry],
              digest: "private"
            })
            return new CellReceipt({
              sourceWorkspace: workspace,
              privateWorkspace: request.privateWorkspace,
              network: "deny",
              readAuthority: "ambient-host-read",
              process: request.process,
              processReceipt: processReceipt(workspace),
              baseline: baselineFingerprint,
              live: baselineFingerprint,
              private: privateView,
              delta: [new WorkspaceDeltaCandidate({
                path: "changed.txt",
                kind: "modified",
                baseline: entry,
                private: privateEntry
              })],
              drift: []
            })
          }),
          revalidate: () => Effect.succeed([new WorkspaceDrift({ path: "changed.txt", baseline: entry, live: entry })])
        }))
        const result = yield* execute(plan([
          new InvokeNode({ id: node("invoke"), dependsOn: [], requires: [], produces: [artifact("delta")], executable: "/bin/true", args: [], cwd: workspace, env: {}, deltaArtifact: artifact("delta"), stdout: "discard", stderr: "discard", cellProfile: "native-contained" }),
          new ApplyNode({ id: node("apply"), dependsOn: [node("invoke")], requires: [], produces: [], operation: "merge", target: ".", sourceArtifact: artifact("delta") })
        ]), nativeLayer(workspace, join(workspace, ".airlock-home"), driftCell))
        expect(result.state).toBe("partial")
        expect(result.receipts.at(-1)?.errorTag).toBe("RuntimeMergeDrift")
        expect(result.lifecycle).toEqual([
          expect.objectContaining({
            _tag: "RuntimeCellWorkspaceHeld",
            state: "held",
            nodeId: node("invoke")
          })
        ])
        expect(readFileSync(join(workspace, "changed.txt"), "utf8")).toBe("live")
      }))
    )
  )

  it.effect("retains the exact private workspace after Invoke failure without sweeping a foreign Cell", () =>
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "airlock-runtime-invoke-failure-"))
      const workspace = join(root, "workspace")
      const foreign = join(root, ".airlock-cell-foreign")
      mkdirSync(workspace)
      mkdirSync(foreign)
      writeFileSync(join(foreign, "owned-by-someone-else"), "preserve")
      return { root, workspace, foreign, home: join(root, ".airlock-home") }
    }).pipe(
      Effect.flatMap(({ workspace, foreign, home }) => {
        let registered = ""
        const failedCell = Layer.succeed(Cell, Cell.of({
          run: (request) => Effect.sync(() => {
            registered = request.privateWorkspace
            mkdirSync(request.privateWorkspace)
            writeFileSync(join(request.privateWorkspace, "retained-evidence"), "private")
            return noDeltaReceipt(request, workspace, 17)
          }),
          revalidate: () => Effect.succeed([])
        }))
        const layer = nativeLayer(workspace, home, failedCell)
        return Effect.gen(function* () {
          const runtime = yield* Runtime
          const run = yield* runtime.execute(plan([
            new InvokeNode({
              id: node("failed-invoke"),
              dependsOn: [],
              requires: [],
              produces: [artifact("unused-delta")],
              executable: "/bin/false",
              args: [],
              cwd: workspace,
              env: {},
              deltaArtifact: artifact("unused-delta"),
              stdout: "discard",
              stderr: "discard",
              cellProfile: "native-contained"
            })
          ]))
          const hold = yield* Hold
          const held = yield* hold.held
          const lifecycle = run.lifecycle[0]

          expect(run.state).toBe("failed")
          expect(run.receipts[0]?.errorTag).toBe("RuntimeProcessFailure")
          expect(lifecycle).toMatchObject({
            _tag: "RuntimeCellWorkspaceHeld",
            state: "held",
            nodeId: node("failed-invoke"),
            privateWorkspace: registered
          })
          expect(existsSync(registered)).toBe(false)
          expect(readFileSync(join(foreign, "owned-by-someone-else"), "utf8")).toBe("preserve")
          expect(held).toEqual([
            expect.objectContaining({
              target: registered,
              purpose: "runtime-private",
              status: "held"
            })
          ])
        }).pipe(Effect.provide(layer))
      })
    )
  )

  it.effect("records absent retention when Cell preparation fails before creating a workspace", () =>
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "airlock-runtime-cell-absent-"))
      const workspace = join(root, "workspace")
      mkdirSync(workspace)
      return { workspace, home: join(root, ".airlock-home") }
    }).pipe(
      Effect.flatMap(({ workspace, home }) => {
        const unavailableCell = Layer.succeed(Cell, Cell.of({
          run: () => Effect.fail(new CellUnavailable({
            capability: "test Cell",
            reason: "failed before private workspace preparation"
          })),
          revalidate: () => Effect.succeed([])
        }))
        return execute(plan([
          new InvokeNode({
            id: node("unprepared"),
            dependsOn: [],
            requires: [],
            produces: [artifact("unused-delta")],
            executable: "/bin/true",
            args: [],
            cwd: workspace,
            env: {},
            deltaArtifact: artifact("unused-delta"),
            stdout: "discard",
            stderr: "discard",
            cellProfile: "native-contained"
          })
        ]), nativeLayer(workspace, home, unavailableCell)).pipe(
          Effect.tap((run) => Effect.sync(() => {
            expect(run.state).toBe("failed")
            expect(run.lifecycle).toEqual([
              expect.objectContaining({
                _tag: "RuntimeCellWorkspaceAbsent",
                state: "absent",
                nodeId: node("unprepared")
              })
            ])
          }))
        )
      })
    )
  )

  it.effect("marks a successful Plan partial when private-workspace retention fails", () =>
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "airlock-runtime-retention-failure-"))
      const workspace = join(root, "workspace")
      mkdirSync(workspace)
      return { workspace, home: join(root, ".airlock-home") }
    }).pipe(
      Effect.flatMap(({ workspace, home }) => {
        let registered = ""
        const successfulCell = Layer.succeed(Cell, Cell.of({
          run: (request) => Effect.sync(() => {
            registered = request.privateWorkspace
            mkdirSync(request.privateWorkspace)
            writeFileSync(join(request.privateWorkspace, "private"), "retain me")
            return noDeltaReceipt(request, workspace)
          }),
          revalidate: () => Effect.succeed([])
        }))
        const unused = () => Effect.die("unused Hold operation")
        const retentionFailure = Layer.succeed(Hold, Hold.of({
          remove: unused,
          overwrite: unused,
          retireRuntimePrivate: (target) => Effect.fail(new HoldFilesystemError({
            operation: "retain runtime-private workspace",
            target,
            reason: "injected retention failure"
          })),
          replaceFrom: unused,
          replaceByStaging: unused,
          undo: unused,
          undoLast: Effect.die("unused Hold operation"),
          held: Effect.die("unused Hold operation"),
          reap: unused
        }))
        return execute(plan([
          new InvokeNode({
            id: node("successful-invoke"),
            dependsOn: [],
            requires: [],
            produces: [artifact("delta")],
            executable: "/bin/true",
            args: [],
            cwd: workspace,
            env: {},
            deltaArtifact: artifact("delta"),
            stdout: "discard",
            stderr: "discard",
            cellProfile: "native-contained"
          })
        ]), nativeLayer(workspace, home, successfulCell, retentionFailure)).pipe(
          Effect.tap((run) => Effect.sync(() => {
            expect(run.receipts[0]?.state).toBe("succeeded")
            expect(run.state).toBe("partial")
            expect(run.lifecycle).toEqual([
              expect.objectContaining({
                _tag: "RuntimeCellWorkspaceRetentionFailed",
                state: "failed",
                nodeId: node("successful-invoke"),
                privateWorkspace: registered,
                errorTag: "HoldFilesystemError",
                reason: expect.stringContaining("injected retention failure")
              })
            ])
            expect(existsSync(registered)).toBe(true)
          }))
        )
      })
    )
  )

  it.effect("retains an in-flight private workspace before cancellation completes", () =>
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "airlock-runtime-cancel-"))
      const workspace = join(root, "workspace")
      mkdirSync(workspace)
      return { workspace, home: join(root, ".airlock-home") }
    }).pipe(
      Effect.flatMap(({ workspace, home }) => Effect.gen(function* () {
        const ready = yield* Deferred.make<string>()
        const interruptedCell = Layer.succeed(Cell, Cell.of({
          run: (request) => Effect.gen(function* () {
            yield* Effect.sync(() => {
              mkdirSync(request.privateWorkspace)
              writeFileSync(join(request.privateWorkspace, "in-flight"), "retain on cancel")
            })
            yield* Deferred.succeed(ready, request.privateWorkspace)
            return yield* Effect.never
          }),
          revalidate: () => Effect.succeed([])
        }))
        const layer = nativeLayer(workspace, home, interruptedCell)
        yield* Effect.gen(function* () {
          const runtime = yield* Runtime
          const fiber = yield* runtime.execute(plan([
            new InvokeNode({
              id: node("cancelled-invoke"),
              dependsOn: [],
              requires: [],
              produces: [artifact("unused-delta")],
              executable: "/bin/sleep",
              args: ["60"],
              cwd: workspace,
              env: {},
              deltaArtifact: artifact("unused-delta"),
              stdout: "discard",
              stderr: "discard",
              cellProfile: "native-contained"
            })
          ])).pipe(Effect.fork)
          const privateWorkspace = yield* Deferred.await(ready)
          const exit = yield* Fiber.interrupt(fiber)
          const hold = yield* Hold
          const held = yield* hold.held

          expect(exit._tag).toBe("Failure")
          expect(existsSync(privateWorkspace)).toBe(false)
          expect(held).toEqual([
            expect.objectContaining({
              target: privateWorkspace,
              purpose: "runtime-private",
              status: "held"
            })
          ])
        }).pipe(Effect.provide(layer))
      }))
    )
  )
})
