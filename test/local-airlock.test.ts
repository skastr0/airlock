import { Effect, FileSystem, Layer, Path, type Scope } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as AirlockHome from "../src/AirlockHome.ts"
import type { AirlockFailure } from "../src/core/airlock/Airlock.ts"
import type { GuestReceipt } from "../src/core/contract/Receipt.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import type { ToolHost } from "../src/core/contract/ToolHost.ts"
import { toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { makeMemoryLedgerState, makeMemoryOutboxState, memoryLedger, memoryOutboxStore } from "../src/core/testing/index.ts"
import * as WebCrypto from "../src/core/WebCrypto.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { FileLedgerLive } from "../src/host/FileLedger.ts"
import { HeldCalls, HeldCallsConfig, HeldCallsLive } from "../src/host/HeldCalls.ts"
import { localAirlock } from "../src/host/LocalAirlock.ts"
import { localRecovery } from "../src/host/LocalRecovery.ts"
import { localToolHost } from "../src/host/LocalToolHost.ts"
import { FileMove, FileRead, FileRemove, FileWrite, NativeFileSystem, NativeFileSystemLive, NativeFilesystemConfig } from "../src/native/index.ts"
import { memoryArtifacts } from "./support/MemoryArtifacts.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

/**
 * The local machine driven the way every host is: a guest calls tools by
 * name through the kernel, a supervisor commits what waits. The files are
 * real, Hold is real, and nothing here calls an implementation directly.
 */

const unused = <A>(what: string) => new Proxy({}, { get: () => { throw new Error(`${what} is not used here`) } }) as A

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly at: (name: string) => string
  readonly workspace: string
  readonly outside: string
  readonly host: ToolHost
  readonly hold: typeof Hold.Service
  /** Opens a guest and a supervisor for a policy over this machine. */
  readonly open: (policy: (workspace: string) => Parameters<typeof localAirlock>[0]["policy"]) => Effect.Effect<{
    readonly call: (tool: string, input: unknown) => Effect.Effect<GuestReceipt, AirlockFailure>
    readonly commit: (id: string) => Effect.Effect<unknown, AirlockFailure>
    readonly restore: (id: string) => Effect.Effect<unknown, AirlockFailure>
    readonly pending: Effect.Effect<ReadonlyArray<{ readonly id: string }>, AirlockFailure>
  }, unknown, Scope.Scope>
  readonly path: Path.Path
}) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const workspace = path.join(root, "workspace")
      const outside = path.join(root, "outside")
      yield* fs.makeDirectory(workspace)
      yield* fs.makeDirectory(outside)
      const services = yield* Effect.gen(function* () {
        return { calls: yield* HeldCalls, hold: yield* Hold, files: yield* NativeFileSystem }
      }).pipe(Effect.provide(
        HeldCallsLive(new HeldCallsConfig({ retentionMillis: 60_000 })).pipe(
          Layer.provideMerge(NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))),
          Layer.provideMerge(HoldLayer.pipe(Layer.provide(ExclusiveRenameTestLive))),
          Layer.provideMerge(FileLedgerLive),
          Layer.provideMerge(AirlockHome.layer(path.join(root, "airlock-home"))),
          Layer.provideMerge(BunServices.layer)
        )
      ))
      const host = yield* localToolHost({ workspace, confiningProfiles: [], recovery: localRecovery(services.calls) })
      let runs = 0
      return yield* body({
        fs,
        path,
        at: (name) => path.join(workspace, name),
        workspace,
        outside,
        host,
        hold: services.hold,
        open: (policy) =>
          Effect.gen(function* () {
            const airlock = localAirlock({
              services: {
                ...services,
                process: unused("the process runner"),
                cell: unused("the Cell"),
                workspace,
                environment: {},
                confiningProfiles: [],
                responseLimitBytes: 1_024,
                artifacts: memoryArtifacts().store
              },
              host,
              policy: policy(workspace)
            })
            const ledger = makeMemoryLedgerState()
            const context = yield* Layer.build(airlock.layer(undefined).pipe(Layer.provideMerge(Layer.mergeAll(
              memoryOutboxStore(makeMemoryOutboxState(), ledger), memoryLedger(ledger), WebCrypto.layer
            ))))
            const guest = yield* airlock.guest({ runId: `run-${++runs}`, env: undefined }).pipe(Effect.provide(context))
            const supervisor = yield* airlock.supervisor(undefined).pipe(Effect.provide(context))
            return {
              call: (tool, input) => guest.call(tool, input).pipe(Effect.provide(context)),
              commit: (id) => supervisor.commit(id).pipe(Effect.provide(context)),
              restore: (id) => supervisor.restore(id).pipe(Effect.provide(context)),
              pending: supervisor.pending.pipe(Effect.provide(context))
            }
          })
      })
    })
  ).pipe(Effect.provide(BunServices.layer))

const budget = { maxCalls: 50, maxInputBytes: 1_000_000 }

describe("the local machine as an Airlock", () => {
  it.effect("reads at once, changes files at once through Hold, and the change can be put back", () =>
    world(({ fs, at, hold, open }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("note.txt"), "before")
        const { call, restore } = yield* open((workspace) => toolPolicy({
          toolGrants: [
            toolGrant(FileRead, { id: "read", when: "now" }),
            toolGrant(FileWrite, { id: "write", when: "now" })
          ],
          resources: { path: [workspace] },
          budget
        }))
        expect(yield* call("file.read", { path: "note.txt", format: "text" })).toMatchObject({ state: "done", result: "before" })
        const written = yield* call("file.write", { path: "note.txt", content: "after" })
        // A change made at once says, in its receipt, how it can be put back.
        expect(written).toMatchObject({
          state: "done",
          result: { previous_held: true, bytes: 5 },
          wayBack: { callId: expect.any(String), recoveryId: expect.any(String), heldUntil: expect.any(String) }
        })
        // A read has nothing to put back.
        expect(yield* call("file.read", { path: "note.txt", format: "text" })).not.toHaveProperty("wayBack")
        expect(yield* fs.readFileString(at("note.txt"))).toBe("after")

        // The supervisor puts the call back through the same host, by the call's id.
        expect((yield* hold.held).filter((act) => act.status === "held")).toHaveLength(1)
        if (written.state !== "done") throw new Error("the write did not complete")
        expect(yield* restore(written.id)).toMatchObject({ state: "restored" })
        expect(yield* fs.readFileString(at("note.txt"))).toBe("before")
        // Putting it back twice changes nothing more.
        expect(yield* restore(written.id)).toMatchObject({ state: "restored" })
        expect(yield* fs.readFileString(at("note.txt"))).toBe("before")
      })
    )
  )

  it.effect("makes an approved change wait for the supervisor, and then makes it through Hold", () =>
    world(({ fs, at, hold, open }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("a.txt"), "source")
        const { call, commit, pending, restore } = yield* open((workspace) => toolPolicy({
          toolGrants: [toolGrant(FileMove, { id: "move" }), toolGrant(FileRemove, { id: "remove" })],
          resources: { path: [workspace] },
          budget
        }))
        const staged = yield* call("file.move", { source: "a.txt", destination: "b.txt" })
        expect(staged).toEqual({ state: "staged", id: expect.any(String) })
        expect(yield* fs.exists(at("a.txt"))).toBe(true)
        expect(yield* fs.exists(at("b.txt"))).toBe(false)
        expect(yield* pending).toHaveLength(1)

        if (staged.state !== "staged") throw new Error("the move did not wait")
        yield* commit(staged.id)
        expect(yield* fs.exists(at("a.txt"))).toBe(false)
        expect(yield* fs.readFileString(at("b.txt"))).toBe("source")
        // Nothing was unlinked: the source is in Hold.
        expect((yield* hold.held).filter((act) => act.status === "held").length).toBeGreaterThanOrEqual(1)
        // An approved change can be put back too, whole.
        expect(yield* restore(staged.id)).toMatchObject({ state: "restored" })
        expect(yield* fs.readFileString(at("a.txt"))).toBe("source")
        expect(yield* fs.exists(at("b.txt"))).toBe(false)
      })
    )
  )

  it.effect("keeps every path inside the ceiling, by where it really is", () =>
    world(({ fs, at, path, outside, open }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret")
        yield* fs.symlink(outside, at("escape"))
        yield* fs.makeDirectory(at("sub"))
        yield* fs.writeFileString(at("sub/in.txt"), "in")
        yield* fs.writeFileString(at("top.txt"), "top")
        const { call } = yield* open((workspace) => toolPolicy({
          toolGrants: [
            toolGrant(FileRead, { id: "read-sub", when: "now", where: { path: { within: [path.join(workspace, "sub")] } } }),
            toolGrant(FileWrite, { id: "write", when: "now" })
          ],
          resources: { path: [workspace] },
          budget
        }))
        expect(yield* call("file.read", { path: "sub/in.txt", format: "text" })).toMatchObject({ state: "done", result: "in" })
        // A refusal is an answer, not a fault: the run goes on and nothing happened.
        const refusedCode = (tool: string, input: unknown) =>
          call(tool, input).pipe(Effect.map((receipt) => receipt.state === "refused" ? receipt.refusal.code : receipt.state))
        // Inside the ceiling but outside the grant's narrowing.
        expect(yield* refusedCode("file.read", { path: "top.txt", format: "text" })).toBe("not-allowed")
        // Outside the ceiling: by spelling, by `..`, and through a symlinked directory.
        expect(yield* refusedCode("file.read", { path: path.join(outside, "secret.txt"), format: "text" })).toBe("not-allowed")
        expect(yield* refusedCode("file.write", { path: "../outside/new.txt", content: "x" })).toBe("not-allowed")
        expect(yield* refusedCode("file.write", { path: "escape/new.txt", content: "x" })).toBe("not-allowed")
        expect(yield* fs.readDirectory(outside)).toEqual(["secret.txt"])
      })
    )
  )

  it.effect("refuses to load a policy this machine cannot honour", () =>
    world(({ open }) =>
      Effect.gen(function* () {
        // A resource-bearing tool with no ceiling.
        const noCeiling = yield* open(() => toolPolicy({
          toolGrants: [toolGrant(FileRead, { id: "read", when: "now" })],
          budget
        })).pipe(Effect.flip)
        expect(noCeiling).toMatchObject({ code: "invalid-policy" })
      })
    )
  )
})
