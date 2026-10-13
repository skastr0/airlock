import { Effect, FileSystem, Layer, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { FileLedgerLive } from "../src/host/FileLedger.ts"
import {
  type HeldCallClaim,
  HeldCalls,
  HeldCallsConfig,
  HeldCallsLive
} from "../src/host/HeldCalls.ts"
import { filesystemRecovery } from "../src/host/FilesystemRecovery.ts"
import { Sha256Digest } from "@skastr0/airlock"
import { NativeFileSystem, NativeFileSystemLive, NativeFilesystemConfig } from "../src/native/index.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const claim = (callId: string, extra: Partial<HeldCallClaim> = {}): HeldCallClaim => ({
  callId,
  runId: "run-1",
  tool: "file.move",
  version: "1",
  inputDigest: "sha256:input",
  resources: [],
  ...extra
})

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly at: (name: string) => string
  readonly native: typeof NativeFileSystem.Service
  readonly hold: typeof Hold.Service
  readonly calls: typeof HeldCalls.Service
  /** A second process over the same home: fresh services, same files. */
  readonly reopen: Effect.Effect<{ readonly calls: typeof HeldCalls.Service; readonly hold: typeof Hold.Service }>
}) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const workspace = path.join(root, "workspace")
      yield* fs.makeDirectory(workspace)
      const layer = HeldCallsLive(new HeldCallsConfig({ retentionMillis: 60_000 })).pipe(
        Layer.provideMerge(NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))),
        Layer.provideMerge(HoldLayer.pipe(Layer.provide(ExclusiveRenameTestLive))),
        Layer.provideMerge(FileLedgerLive),
        Layer.provideMerge(AirlockHome.layer(path.join(root, "airlock-home"))),
        Layer.provideMerge(BunServices.layer)
      )
      const open = Effect.gen(function* () {
        return { calls: yield* HeldCalls, hold: yield* Hold, native: yield* NativeFileSystem }
      }).pipe(Effect.provide(layer), Effect.orDie)
      const first = yield* open
      return yield* body({ fs, at: (name) => path.join(workspace, name), ...first, reopen: open })
    })
  ).pipe(Effect.provide(BunServices.layer))

describe("HeldCalls", () => {
  it.effect("claims a call once, and refuses the same id with different content", () =>
    world(({ calls }) =>
      Effect.gen(function* () {
        const first = yield* calls.prepare(claim("call-a"))
        const again = yield* calls.prepare(claim("call-a"))
        expect(again).toEqual(first)
        expect(first.recoveryId).toMatch(/^[0-9a-f]{64}$/)
        expect(first.recoveryId).not.toContain("call-a")
        const other = yield* calls.prepare(claim("call-a", { inputDigest: "sha256:other" })).pipe(Effect.flip)
        expect(other._tag).toBe("HeldCallMismatch")
        expect((yield* calls.inspect(first)).state).toBe("prepared")
      })
    )
  )

  it.effect("owns every act of a compound call in order and puts the whole call back", () =>
    world(({ fs, at, native, calls }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("a.txt"), "source")
        yield* fs.writeFileString(at("b.txt"), "destination before")
        const reference = yield* calls.prepare(claim("call-move"))
        const outcome = yield* calls.run(reference, native.move("a.txt", "b.txt"))
        expect(outcome._tag).toBe("done")
        expect(yield* fs.exists(at("a.txt"))).toBe(false)
        expect(yield* fs.readFileString(at("b.txt"))).toBe("source")

        const state = yield* calls.inspect(reference)
        expect(state.state).toBe("done")
        expect(state.acts).toHaveLength(2)
        expect(Date.parse(reference.heldUntil)).toBeGreaterThan(Date.now())

        const restored = yield* calls.restore(reference)
        expect(restored.state).toBe("restored")
        expect(restored.acts.map((act) => act.status)).toEqual(["restored", "restored"])
        expect(yield* fs.readFileString(at("a.txt"))).toBe("source")
        expect(yield* fs.readFileString(at("b.txt"))).toBe("destination before")
        expect((yield* calls.restore(reference)).state).toBe("restored")
        expect((yield* calls.inspect(reference)).state).toBe("restored")
      })
    )
  )

  it.effect("never runs forward work twice", () =>
    world(({ fs, at, native, calls }) =>
      Effect.gen(function* () {
        const reference = yield* calls.prepare(claim("call-once"))
        yield* calls.run(reference, native.writeText("once.txt", "first"))
        const second = yield* calls.run(reference, native.writeText("once.txt", "second")).pipe(Effect.flip)
        expect(second._tag).toBe("HeldCallNotFresh")
        expect(yield* fs.readFileString(at("once.txt"))).toBe("first")
        yield* calls.restore(reference)
        const afterRestore = yield* calls.run(reference, native.writeText("once.txt", "third")).pipe(Effect.flip)
        expect(afterRestore._tag).toBe("HeldCallNotFresh")
        expect(yield* fs.exists(at("once.txt"))).toBe(false)
      })
    )
  )

  it.effect("refuses a call whose forward work fails, saying whether anything had happened", () =>
    world(({ fs, at, native, calls }) =>
      Effect.gen(function* () {
        const nothing = yield* calls.prepare(claim("call-nothing"))
        const refused = yield* calls.run(nothing, native.remove("absent.txt"))
        expect(refused).toEqual({ _tag: "refused", reason: "nothing-applied", expired: false })

        yield* fs.writeFileString(at("kept.txt"), "before")
        const partial = yield* calls.prepare(claim("call-partial"))
        const outcome = yield* calls.run(
          partial,
          Effect.andThen(native.writeText("kept.txt", "after"), native.remove("absent.txt"))
        )
        expect(outcome).toEqual({ _tag: "refused", reason: "partial-application-restored", expired: false })
        expect(yield* fs.readFileString(at("kept.txt"))).toBe("before")
        const state = yield* calls.inspect(partial)
        expect(state).toMatchObject({ state: "refused", reason: "partial-application-restored" })
        expect(state.acts.map((act) => act.status)).toEqual(["restored"])
        // A refused call is final: it cannot be run again or put back.
        expect((yield* calls.run(partial, Effect.void).pipe(Effect.flip))._tag).toBe("HeldCallNotFresh")
        expect((yield* calls.restore(partial)).state).toBe("not-done")
      })
    )
  )

  it.effect("settles a call that died half-way by reversing it, from another process", () =>
    world(({ fs, at, native, calls, reopen }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("config.txt"), "before")
        const reference = yield* calls.prepare(claim("call-crash"))
        const died = yield* calls.run(
          reference,
          Effect.andThen(native.writeText("config.txt", "after"), Effect.die("process killed"))
        ).pipe(Effect.exit)
        expect(died._tag).toBe("Failure")
        // Nothing recorded the call as finished, and the change is in place.
        expect(yield* fs.readFileString(at("config.txt"))).toBe("after")

        const later = yield* reopen
        const state = yield* later.calls.inspect(reference)
        expect(state).toMatchObject({ state: "refused", reason: "partial-application-restored" })
        expect(yield* fs.readFileString(at("config.txt"))).toBe("before")
        expect((yield* later.calls.run(reference, Effect.void).pipe(Effect.flip))._tag).toBe("HeldCallNotFresh")
      })
    )
  )

  it.effect("changes nothing when any act of the call can no longer be reversed", () =>
    world(({ fs, at, native, calls }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("one.txt"), "one before")
        yield* fs.writeFileString(at("two.txt"), "two before")
        const reference = yield* calls.prepare(claim("call-conflict"))
        yield* calls.run(
          reference,
          Effect.andThen(native.writeText("one.txt", "one after"), native.writeText("two.txt", "two after"))
        )
        // Someone edits the first file after the call. The later act is
        // still reversible; it must not be reversed alone.
        yield* fs.writeFileString(at("one.txt"), "edited since, longer than before")

        const restored = yield* calls.restore(reference)
        expect(restored.state).toBe("conflict")
        expect(restored.acts.map((act) => act.status)).toEqual(["conflict", "held"])
        expect(yield* fs.readFileString(at("one.txt"))).toBe("edited since, longer than before")
        expect(yield* fs.readFileString(at("two.txt"))).toBe("two after")
        expect((yield* calls.inspect(reference)).state).toBe("done")
      })
    )
  )

  it.effect("says a before-image is no longer held once Hold has reaped it", () =>
    world(({ fs, at, native, hold, calls }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("old.txt"), "before")
        const reference = yield* calls.prepare(claim("call-reaped"))
        yield* calls.run(reference, native.writeText("old.txt", "after"))
        yield* hold.reap(0)

        expect((yield* calls.inspect(reference)).state).toBe("no-longer-held")
        const restored = yield* calls.restore(reference)
        expect(restored.state).toBe("no-longer-held")
        expect(restored.acts.map((act) => act.status)).toEqual(["no-longer-held"])
        expect(yield* fs.readFileString(at("old.txt"))).toBe("after")
      })
    )
  )

  it.effect("resumes a restore that died after a reverse and before its progress record", () =>
    world(({ fs, at, native, hold, calls, reopen }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("one.txt"), "one before")
        yield* fs.writeFileString(at("two.txt"), "two before")
        const reference = yield* calls.prepare(claim("call-resume"))
        yield* calls.run(
          reference,
          Effect.andThen(native.writeText("one.txt", "one after"), native.writeText("two.txt", "two after"))
        )
        const acts = (yield* calls.inspect(reference)).acts
        // The newest act went back, and the process died before saying so.
        yield* hold.undoIfUnchanged(acts[1]!.id)
        expect(yield* fs.readFileString(at("two.txt"))).toBe("two before")

        const later = yield* reopen
        const restored = yield* later.calls.restore(reference)
        expect(restored.state).toBe("restored")
        expect(yield* fs.readFileString(at("one.txt"))).toBe("one before")
        expect(yield* fs.readFileString(at("two.txt"))).toBe("two before")
      })
    )
  )

  it.effect("reports a partial restore, never an unchanged or a finished one, when an older act conflicts", () =>
    world(({ fs, at, native, hold, calls }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("one.txt"), "one before")
        yield* fs.writeFileString(at("two.txt"), "two before")
        const reference = yield* calls.prepare(claim("call-partial-restore"))
        yield* calls.run(
          reference,
          Effect.andThen(native.writeText("one.txt", "one after"), native.writeText("two.txt", "two after"))
        )
        const acts = (yield* calls.inspect(reference)).acts
        yield* hold.undoIfUnchanged(acts[1]!.id)
        yield* fs.writeFileString(at("one.txt"), "edited since, longer than before")

        const restored = yield* calls.restore(reference)
        expect(restored.state).toBe("partial")
        expect(restored.acts.map((act) => act.status)).toEqual(["conflict", "restored"])
        expect(yield* fs.readFileString(at("one.txt"))).toBe("edited since, longer than before")
        expect((yield* calls.inspect(reference)).state).toBe("done")
      })
    )
  )

  it.effect("stops forward work when the grant runs out, before the next act, and still puts calls back", () =>
    world(({ fs, at, native, calls }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("one.txt"), "one before")
        yield* fs.writeFileString(at("two.txt"), "two before")
        // The same clock the kernel reads; the test clock starts at zero.
        const validUntil = 60_000
        // Already expired: nothing starts.
        const late = yield* calls.prepare(claim("call-late"))
        expect(yield* calls.run(late, native.writeText("one.txt", "late"), { validUntil: 0 }))
          .toEqual({ _tag: "refused", reason: "nothing-applied", expired: true })
        expect(yield* fs.readFileString(at("one.txt"))).toBe("one before")

        // It runs out between two acts: the second never starts and the first goes back.
        const between = yield* calls.prepare(claim("call-between"))
        const outcome = yield* calls.run(
          between,
          native.writeText("one.txt", "one after").pipe(
            Effect.tap(() => TestClock.setTime(validUntil)),
            Effect.andThen(native.writeText("two.txt", "two after"))
          ),
          { validUntil }
        )
        expect(outcome).toEqual({ _tag: "refused", reason: "partial-application-restored", expired: true })
        expect(yield* fs.readFileString(at("one.txt"))).toBe("one before")
        expect(yield* fs.readFileString(at("two.txt"))).toBe("two before")

        // A call that finished in time can be put back long after the grant ran out.
        const done = yield* calls.prepare(claim("call-in-time"))
        yield* calls.run(done, native.writeText("one.txt", "in time"), { validUntil: validUntil + 60_000 })
        yield* TestClock.setTime(validUntil + 3_600_000)
        expect((yield* calls.restore(done)).state).toBe("restored")
        expect(yield* fs.readFileString(at("one.txt"))).toBe("one before")
      })
    )
  )

  it.effect("leaves acts outside a call unclaimed", () =>
    world(({ fs, at, native, hold, calls }) =>
      Effect.gen(function* () {
        const reference = yield* calls.prepare(claim("call-scope"))
        yield* native.writeText("outside.txt", "not part of any call")
        yield* calls.run(reference, native.writeText("inside.txt", "part of the call"))
        expect((yield* calls.inspect(reference)).acts).toHaveLength(1)
        expect(yield* hold.held).toHaveLength(2)
        yield* calls.restore(reference)
        expect(yield* fs.exists(at("inside.txt"))).toBe(false)
        expect(yield* fs.readFileString(at("outside.txt"))).toBe("not part of any call")
      })
    )
  )
})

describe("filesystemRecovery", () => {
  it.effect("answers the kernel's recovery port from Hold", () =>
    world(({ fs, at, native, hold, calls }) =>
      Effect.gen(function* () {
        const recovery = filesystemRecovery(calls)
        const call = {
          callId: "session:1:run:0:file.write:abc",
          runId: "run",
          tool: "file.write",
          version: "1",
          inputDigest: Sha256Digest.make(`sha256:${"a".repeat(64)}`),
          resources: [],
          host: {}
        }
        yield* fs.writeFileString(at("port.txt"), "before")
        const reference = yield* recovery.prepare(call)
        expect(yield* recovery.prepare(call)).toEqual(reference)
        expect((yield* recovery.prepare({ ...call, version: "2" }).pipe(Effect.flip))._tag).toBe("RecoveryFailed")
        expect((yield* recovery.inspect(reference)).state).toBe("prepared")
        // A finished call that was never run cannot be put back, and says so.
        expect(yield* recovery.restore(reference)).toMatchObject({ state: "conflict", reason: "call is not done" })

        yield* calls.run(
          { callId: reference.callId, recoveryId: reference.recoveryId, heldUntil: "" },
          native.writeText("port.txt", "after")
        )
        expect((yield* recovery.inspect(reference)).state).toBe("done")
        expect((yield* recovery.restore(reference)).state).toBe("restored")
        expect(yield* fs.readFileString(at("port.txt"))).toBe("before")
        expect(yield* recovery.inspect(reference)).toMatchObject({ state: "refused", reason: "restored" })

        const second = yield* recovery.prepare({ ...call, callId: "session:1:run:1:file.write:def" })
        yield* calls.run(
          { callId: second.callId, recoveryId: second.recoveryId, heldUntil: "" },
          native.writeText("port.txt", "again")
        )
        yield* hold.reap(0)
        expect((yield* recovery.inspect(second)).state).toBe("no-longer-held")
        expect((yield* recovery.restore(second)).state).toBe("no-longer-held")
        expect(yield* fs.readFileString(at("port.txt"))).toBe("again")
      })
    )
  )
})
