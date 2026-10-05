import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import {
  Hold,
  HoldLayer,
  HoldReapRecoveryRequired,
  HoldRecoveryRequired
} from "../src/Hold.ts"
import { FileLedger } from "../src/host/FileLedger.ts"
import { DispatchProvenance, IdempotencyKey } from "../src/core/index.ts"
import { Outbox, OutboxLive } from "../src/Outbox.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

type LedgerAct = "remove" | "reap" | "stage" | "commit"

const blockingLedger = (
  act: LedgerAct,
  started: Deferred.Deferred<void>
) =>
  Layer.succeed(
    FileLedger,
    FileLedger.of({
      record: (entry) =>
        entry.act === act
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never)
            )
          : Effect.void,
      entries: Effect.succeed([])
    })
  )

const typedFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

const realDelay = (milliseconds: number) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), milliseconds)
    return Effect.sync(() => clearTimeout(timer))
  })

const supervisorCommit = new DispatchProvenance({ committedBy: "supervisor" })

describe("durable cancellation receipts", () => {
  it.effect("keeps cancellation interruptible before Reaper enters terminal authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const home = path.join(temporary, "airlock-home")
        const expiredTarget = path.join(temporary, "expired.txt")
        const lockOwnerTarget = path.join(temporary, "lock-owner.txt")
        yield* fs.writeFileString(expiredTarget, "expired recovery bytes")
        yield* fs.writeFileString(lockOwnerTarget, "lock owner bytes")

        const noOpLedger = Layer.succeed(
          FileLedger,
          FileLedger.of({
            record: () => Effect.void,
            entries: Effect.succeed([])
          })
        )
        const initialLayer = HoldLayer.pipe(
          Layer.provideMerge(ExclusiveRenameTestLive),
          Layer.provideMerge(noOpLedger),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunServices.layer)
        )
        const expired = yield* Effect.gen(function* () {
          const hold = yield* Hold
          return yield* hold.remove(expiredTarget)
        }).pipe(Effect.provide(initialLayer))

        const ownerInLedger = yield* Deferred.make<void>()
        const contendedLayer = HoldLayer.pipe(
          Layer.provideMerge(ExclusiveRenameTestLive),
          Layer.provideMerge(
            blockingLedger("remove", ownerInLedger)
          ),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunServices.layer)
        )

        yield* Effect.gen(function* () {
          const hold = yield* Hold
          const owner = yield* hold.remove(lockOwnerTarget).pipe(Effect.forkChild)
          yield* Deferred.await(ownerInLedger)
          const reaper = yield* hold.reap(0).pipe(Effect.forkChild)
          yield* realDelay(40)
          const reaperExit = yield* Fiber.interrupt(reaper).pipe(Effect.andThen(Fiber.await(reaper)))

          expect(Exit.isFailure(reaperExit)).toBe(true)
          if (Exit.isFailure(reaperExit)) {
            expect(Cause.hasInterruptsOnly(reaperExit.cause)).toBe(true)
            expect(reaperExit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([])
          }
          expect(yield* fs.exists(
            path.join(home, "hold", expired.id)
          )).toBe(true)

          // Release the shared kernel lease through the owner's ordinary
          // cancellation-recovery path; no fiber or descriptor leaks.
          yield* Fiber.interrupt(owner)
        }).pipe(Effect.provide(contendedLayer))
      })
    ).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("returns exact Reaper recovery when cancellation follows terminal removal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const home = path.join(temporary, "airlock-home")
        const target = path.join(temporary, "expired.txt")
        yield* fs.writeFileString(target, "unique recovery bytes")

        const noOpLedger = Layer.succeed(
          FileLedger,
          FileLedger.of({
            record: () => Effect.void,
            entries: Effect.succeed([])
          })
        )
        const initialLayer = HoldLayer.pipe(
          Layer.provideMerge(ExclusiveRenameTestLive),
          Layer.provideMerge(noOpLedger),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunServices.layer)
        )
        const expired = yield* Effect.gen(function* () {
          const hold = yield* Hold
          return yield* hold.remove(target)
        }).pipe(Effect.provide(initialLayer))

        const ledgerStarted = yield* Deferred.make<void>()
        const reaperLayer = HoldLayer.pipe(
          Layer.provideMerge(ExclusiveRenameTestLive),
          Layer.provideMerge(blockingLedger("reap", ledgerStarted)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunServices.layer)
        )

        yield* Effect.gen(function* () {
          const hold = yield* Hold
          const fiber = yield* hold.reap(0).pipe(Effect.forkChild)
          yield* Deferred.await(ledgerStarted)
          expect(yield* fs.exists(
            path.join(home, "hold", expired.id)
          )).toBe(false)

          const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
          const failure = typedFailure(exit)
          expect(failure).toBeInstanceOf(HoldReapRecoveryRequired)
          if (!(failure instanceof HoldReapRecoveryRequired)) return
          expect(failure).toMatchObject({
            reaped: [expired.id],
            current: expired.id,
            phase: "ledger",
            currentRemoval: "confirmed",
            reason: expect.stringContaining(
              "ledger append interrupted after confirmed reap"
            )
          })
        }).pipe(Effect.provide(reaperLayer))
      })
    ).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("returns a Hold recovery act when removal is interrupted during FileLedger publication", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const home = path.join(temporary, "airlock-home")
        const target = path.join(temporary, "precious.txt")
        yield* fs.writeFileString(target, "precious")
        const started = yield* Deferred.make<void>()
        const layer = HoldLayer.pipe(
          Layer.provideMerge(ExclusiveRenameTestLive),
          Layer.provideMerge(blockingLedger("remove", started)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunServices.layer)
        )

        yield* Effect.gen(function* () {
          const hold = yield* Hold
          const fiber = yield* hold.remove(target).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
          const failure = typedFailure(exit)

          expect(failure).toBeInstanceOf(HoldRecoveryRequired)
          if (!(failure instanceof HoldRecoveryRequired)) return
          expect(failure).toMatchObject({
            target,
            phase: "ledger"
          })
          expect(yield* fs.exists(target)).toBe(false)
          expect(yield* hold.held).toEqual([
            expect.objectContaining({
              id: failure.id,
              target,
              status: "held"
            })
          ])
        }).pipe(Effect.provide(layer))
      })
    ).pipe(Effect.provide(BunServices.layer))
  )

  /**
   * A ledger whose named act signals that it began and then waits to be
   * released: the instant between publishing an emission and recording it.
   */
  const gatedLedger = (
    act: "stage" | "commit",
    started: Deferred.Deferred<void>,
    release: Deferred.Deferred<void>
  ) =>
    Layer.succeed(
      FileLedger,
      FileLedger.of({
        record: (entry) =>
          entry.act === act
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release))
              )
            : Effect.void,
        entries: Effect.succeed([])
      })
    )

  const stageRequest = (url: string, holdMillis: number) => ({
    key: IdempotencyKey.make(`cancellation:${url}`),
    intent: {
      kind: "http" as const,
      dispatch: { url, method: "POST" as const, headers: {}, body: "payload" }
    },
    holdMillis
  })

  it.effect("an interrupt cannot tear staging apart: the same key names the one emission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const home = path.join(temporary, "airlock-home")
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const layer = OutboxLive.pipe(
          Layer.provideMerge(gatedLedger("stage", started, release)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunServices.layer)
        )

        yield* Effect.gen(function* () {
          const outbox = yield* Outbox
          const request = stageRequest("https://example.invalid/staged-only", 60_000)
          const fiber = yield* outbox.stage(request).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          // The emission is published and its receipt is being written. The
          // interrupt must wait for that write instead of abandoning it.
          const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
          yield* realDelay(40)
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interruption)

          const pending = yield* outbox.pending
          expect(pending).toHaveLength(1)
          expect(pending[0]).toMatchObject({ state: "staged", ledgered: ["stage"] })
          // The interrupted caller lost its return value, not the emission:
          // replaying the key returns it and stages nothing new.
          const replayed = yield* outbox.stage(request)
          expect(replayed.id).toBe(pending[0]!.id)
          expect(yield* outbox.pending).toHaveLength(1)
        }).pipe(Effect.provide(layer))
      })
    ).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("an interrupt during the commit receipt leaves one committed dispatch, never a second", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const home = path.join(temporary, "airlock-home")
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let hits = 0
        const server = yield* Effect.acquireRelease(
          Effect.callback<http.Server>((resume) => {
            const value = http.createServer((_request, response) => {
              hits += 1
              response.writeHead(200)
              response.end("ok")
            })
            value.listen(0, "127.0.0.1", () =>
              resume(Effect.succeed(value))
            )
          }),
          (value) =>
            Effect.callback<void>((resume) => {
              value.close(() => resume(Effect.void))
            })
        )
        const address = server.address() as AddressInfo
        const layer = OutboxLive.pipe(
          Layer.provideMerge(gatedLedger("commit", started, release)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunServices.layer)
        )

        yield* Effect.gen(function* () {
          const outbox = yield* Outbox
          const staged = yield* outbox.stage(
            stageRequest(`http://127.0.0.1:${address.port}/hook`, 0)
          )
          const fiber = yield* outbox.commit(staged.id, supervisorCommit).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
          yield* realDelay(40)
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interruption)

          expect(yield* outbox.inspect(staged.id)).toMatchObject({
            state: "committed",
            outcome: { status: 200 },
            ledgered: ["stage", "commit"]
          })
          const retry = yield* outbox.commit(staged.id, supervisorCommit).pipe(Effect.flip)
          expect(retry._tag).toBe("EmissionNotPending")
          expect(hits).toBe(1)
        }).pipe(Effect.provide(layer))
      })
    ).pipe(Effect.provide(BunServices.layer))
  )
})
