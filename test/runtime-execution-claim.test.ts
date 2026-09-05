import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Cell } from "../src/cell/index.ts"
import { HoldLayer } from "../src/Hold.ts"
import { LedgerLive } from "../src/Ledger.ts"
import {
  NativeFileSystemLive,
  NativeFilesystemConfig
} from "../src/native/index.ts"
import { OutboxLive } from "../src/Outbox.ts"
import {
  InvokeNode,
  NodeId
} from "../src/plan/index.ts"
import {
  ProcessReceipt,
  ProcessRequest,
  ProcessRunner
} from "../src/process/Process.ts"
import {
  Runtime,
  RuntimeConfig,
  RuntimeConfigLive,
  RuntimeExecutionClaimRejected,
  RuntimeLive,
  RuntimeRunSnapshot,
  makeFileRuntimeRunJournal
} from "../src/runtime/index.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"
import { runtimeAuthority } from "./support/RuntimeAuthority.ts"

const realDelay = (milliseconds: number) =>
  Effect.async<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), milliseconds)
    return Effect.sync(() => clearTimeout(timer))
  })

const impossibleCell = Layer.succeed(Cell, Cell.of({
  run: () => Effect.die("compatibility execution must not enter Cell"),
  revalidate: () => Effect.die("compatibility execution has no Cell delta")
}))

const holdLive = HoldLayer.pipe(
  Layer.provide(ExclusiveRenameTestLive)
)

const processReceipt = (
  request: ProcessRequest
) =>
  DateTime.now.pipe(
    Effect.map((at) =>
      new ProcessReceipt({
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        pid: process.pid,
        exitCode: 0,
        signal: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        startedAt: at,
        finishedAt: at
      })
    )
  )

const runtimeLayer = (
  workspace: string,
  home: string,
  runner: ProcessRunner["Type"],
  runJournalDirectory?: string
) =>
  RuntimeLive.pipe(
    Layer.provideMerge(
      Layer.succeed(ProcessRunner, runner)
    ),
    Layer.provideMerge(impossibleCell),
    Layer.provideMerge(
      NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))
    ),
    Layer.provideMerge(holdLive),
    Layer.provideMerge(OutboxLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(
      RuntimeConfigLive(new RuntimeConfig({
        workspace,
        ...(runJournalDirectory === undefined
          ? {}
          : { runJournalDirectory })
      }))
    ),
    Layer.provideMerge(BunContext.layer)
  )

const authority = (workspace: string, label: string) =>
  runtimeAuthority([
    new InvokeNode({
      id: NodeId.make(`invoke-${label}`),
      dependsOn: [],
      requires: [],
      produces: [],
      executable: "/usr/bin/true",
      args: [],
      cwd: workspace,
      env: {},
      stdout: "discard",
      stderr: "discard",
      cellProfile: "compatibility"
    })
  ], { label })

const temporaryRealm = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  return {
    workspace,
    home: join(root, ".airlock-home"),
    runs: join(root, ".airlock-home", "runs")
  }
}

describe("Runtime execution claim contract", () => {
  it.effect("refuses execution before adapter work without a persistent journal", () =>
    Effect.sync(() => temporaryRealm("airlock-runtime-no-journal-")).pipe(
      Effect.flatMap(({ workspace, home }) => {
        let calls = 0
        const runner = ProcessRunner.of({
          run: (request) =>
            Effect.sync(() => {
              calls += 1
            }).pipe(Effect.zipRight(processReceipt(request)))
        })
        const execution = authority(workspace, "persistent-journal-required")

        return Effect.gen(function* () {
          const runtime = yield* Runtime
          const error = yield* runtime.execute(execution).pipe(Effect.flip)

          expect(error).toBeInstanceOf(RuntimeExecutionClaimRejected)
          expect(error).toMatchObject({
            operation: "persistent-journal-required",
            planId: execution.admission.plan.id
          })
          expect(calls).toBe(0)
        }).pipe(Effect.provide(runtimeLayer(workspace, home, runner)))
      })
    )
  )
})

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "Runtime execution claims on the host kernel lock",
  () => {
    it.effect("serializes concurrent duplicate Plans and runs world work once", () =>
      Effect.sync(() => temporaryRealm("airlock-runtime-claim-race-")).pipe(
        Effect.flatMap(({ workspace, home, runs }) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let calls = 0
            const runner = ProcessRunner.of({
              run: (request) =>
                Effect.sync(() => {
                  calls += 1
                }).pipe(
                  Effect.zipRight(Deferred.succeed(entered, undefined)),
                  Effect.zipRight(Deferred.await(release)),
                  Effect.zipRight(processReceipt(request))
                )
            })
            const execution = authority(workspace, "concurrent-single-use")

            yield* Effect.gen(function* () {
              const runtime = yield* Runtime
              const owner = yield* runtime.execute(execution).pipe(Effect.fork)
              yield* Deferred.await(entered)
              const duplicate = yield* runtime.execute(execution).pipe(
                Effect.fork
              )
              yield* realDelay(40)

              expect(calls).toBe(1)
              yield* Deferred.succeed(release, undefined)
              const first = yield* Fiber.join(owner)
              const error = yield* Fiber.join(duplicate).pipe(Effect.flip)

              expect(first.state).toBe("succeeded")
              expect(error).toBeInstanceOf(RuntimeExecutionClaimRejected)
              expect(error).toMatchObject({
                operation: "replay",
                priorState: "succeeded"
              })
              expect(calls).toBe(1)
              expect(yield* runtime.inspect(execution.admission.plan.id))
                .toMatchObject({ state: "succeeded" })
            }).pipe(
              Effect.provide(runtimeLayer(workspace, home, runner, runs))
            )
          })
        )
      )
    )

    it.effect("cancels a waiting duplicate without stealing the live owner", () =>
      Effect.sync(() => temporaryRealm("airlock-runtime-claim-cancel-")).pipe(
        Effect.flatMap(({ workspace, home, runs }) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let calls = 0
            const runner = ProcessRunner.of({
              run: (request) =>
                Effect.sync(() => {
                  calls += 1
                }).pipe(
                  Effect.zipRight(Deferred.succeed(entered, undefined)),
                  Effect.zipRight(Deferred.await(release)),
                  Effect.zipRight(processReceipt(request))
                )
            })
            const execution = authority(workspace, "cancelled-claim-waiter")

            yield* Effect.gen(function* () {
              const runtime = yield* Runtime
              const owner = yield* runtime.execute(execution).pipe(Effect.fork)
              yield* Deferred.await(entered)

              const claimFile = join(
                runs,
                ".claims",
                `${createHash("sha256")
                  .update(execution.admission.plan.id)
                  .digest("hex")}.lock`
              )
              const ownerBefore = readFileSync(claimFile, "utf8")
              const waiter = yield* runtime.execute(execution).pipe(Effect.fork)
              yield* realDelay(40)
              const waiterExit = yield* Fiber.interrupt(waiter)
              const ownerAfter = readFileSync(claimFile, "utf8")

              expect(waiterExit._tag).toBe("Failure")
              expect(ownerAfter).toBe(ownerBefore)
              expect(calls).toBe(1)

              yield* Deferred.succeed(release, undefined)
              expect((yield* Fiber.join(owner)).state).toBe("succeeded")
              expect(calls).toBe(1)
              expect(yield* runtime.inspect(execution.admission.plan.id))
                .toMatchObject({ state: "succeeded" })
            }).pipe(
              Effect.provide(runtimeLayer(workspace, home, runner, runs))
            )
          })
        )
      )
    )

    it.effect("rejects a sequential replay after terminal state", () =>
      Effect.sync(() => temporaryRealm("airlock-runtime-claim-replay-")).pipe(
        Effect.flatMap(({ workspace, home, runs }) => {
          let calls = 0
          const runner = ProcessRunner.of({
            run: (request) =>
              Effect.sync(() => {
                calls += 1
              }).pipe(Effect.zipRight(processReceipt(request)))
          })
          const execution = authority(workspace, "terminal-single-use")

          return Effect.gen(function* () {
            const runtime = yield* Runtime
            expect((yield* runtime.execute(execution)).state).toBe("succeeded")
            const error = yield* runtime.execute(execution).pipe(Effect.flip)

            expect(error).toBeInstanceOf(RuntimeExecutionClaimRejected)
            expect(error).toMatchObject({
              operation: "replay",
              priorState: "succeeded"
            })
            expect(calls).toBe(1)
          }).pipe(
            Effect.provide(runtimeLayer(workspace, home, runner, runs))
          )
        })
      )
    )

    it.effect("never re-executes after running or finalizing evidence survives an owner", () =>
      Effect.sync(() => temporaryRealm("airlock-runtime-claim-recovery-")).pipe(
        Effect.flatMap(({ workspace, home, runs }) => {
          let calls = 0
          const runner = ProcessRunner.of({
            run: (request) =>
              Effect.sync(() => {
                calls += 1
              }).pipe(Effect.zipRight(processReceipt(request)))
          })
          const cases = (["running", "finalizing"] as const).map(
            (state, index) => ({
              state,
              sequence: index + 1,
              execution: authority(workspace, `prior-${state}`)
            })
          )

          return Effect.gen(function* () {
            const journal = makeFileRuntimeRunJournal(runs)
            const at = yield* DateTime.now
            for (const testCase of cases) {
              yield* journal.record(new RuntimeRunSnapshot({
                schemaVersion: "airlock/runtime-run-snapshot/v1",
                planId: testCase.execution.admission.plan.id,
                state: testCase.state,
                startedAt: at,
                observedAt: at,
                sequence: testCase.sequence,
                receipts: [],
                artifacts: [],
                lifecycle: [],
                recovery: []
              }))
            }

            yield* Effect.gen(function* () {
              const runtime = yield* Runtime
              for (const testCase of cases) {
                const error = yield* runtime.execute(
                  testCase.execution
                ).pipe(Effect.flip)
                expect(error).toBeInstanceOf(RuntimeExecutionClaimRejected)
                expect(error).toMatchObject({
                  operation: "replay",
                  priorState: testCase.state,
                  priorSequence: testCase.sequence
                })
              }
              expect(calls).toBe(0)
            }).pipe(
              Effect.provide(runtimeLayer(workspace, home, runner, runs))
            )
          })
        })
      )
    )
  }
)
