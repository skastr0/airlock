import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option
} from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as AirlockHome from "../src/AirlockHome.ts"
import { EmissionRequest } from "../src/domain.ts"
import {
  Hold,
  HoldLayer,
  HoldReapRecoveryRequired,
  HoldRecoveryRequired
} from "../src/Hold.ts"
import { Ledger } from "../src/Ledger.ts"
import {
  Outbox,
  OutboxLive,
  OutboxRecoveryRequired
} from "../src/Outbox.ts"
import { MacosExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

type LedgerAct = "remove" | "reap" | "stage" | "commit"

const blockingLedger = (
  act: LedgerAct,
  started: Deferred.Deferred<void>
) =>
  Layer.succeed(
    Ledger,
    Ledger.of({
      record: (entry) =>
        entry.act === act
          ? Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Effect.never)
            )
          : Effect.void,
      entries: Effect.succeed([])
    })
  )

const typedFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  return Option.getOrThrow(Cause.failureOption(exit.cause))
}

const realDelay = (milliseconds: number) =>
  Effect.async<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), milliseconds)
    return Effect.sync(() => clearTimeout(timer))
  })

const post = (url: string) =>
  new EmissionRequest({
    url,
    method: "POST",
    body: "payload"
  })

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
          Ledger,
          Ledger.of({
            record: () => Effect.void,
            entries: Effect.succeed([])
          })
        )
        const initialLayer = HoldLayer.pipe(
          Layer.provideMerge(MacosExclusiveRenameTestLive),
          Layer.provideMerge(noOpLedger),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunContext.layer)
        )
        const expired = yield* Effect.gen(function* () {
          const hold = yield* Hold
          return yield* hold.remove(expiredTarget)
        }).pipe(Effect.provide(initialLayer))

        const ownerInLedger = yield* Deferred.make<void>()
        const contendedLayer = HoldLayer.pipe(
          Layer.provideMerge(MacosExclusiveRenameTestLive),
          Layer.provideMerge(
            blockingLedger("remove", ownerInLedger)
          ),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunContext.layer)
        )

        yield* Effect.gen(function* () {
          const hold = yield* Hold
          const owner = yield* hold.remove(lockOwnerTarget).pipe(Effect.fork)
          yield* Deferred.await(ownerInLedger)
          const reaper = yield* hold.reap(0).pipe(Effect.fork)
          yield* realDelay(40)
          const reaperExit = yield* Fiber.interrupt(reaper)

          expect(Exit.isFailure(reaperExit)).toBe(true)
          if (Exit.isFailure(reaperExit)) {
            expect(Cause.isInterruptedOnly(reaperExit.cause)).toBe(true)
            expect(Array.from(Cause.failures(reaperExit.cause))).toEqual([])
          }
          expect(yield* fs.exists(
            path.join(home, "hold", expired.id)
          )).toBe(true)

          // Release the shared kernel lease through the owner's ordinary
          // cancellation-recovery path; no fiber or descriptor leaks.
          yield* Fiber.interrupt(owner)
        }).pipe(Effect.provide(contendedLayer))
      })
    ).pipe(Effect.provide(BunContext.layer))
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
          Ledger,
          Ledger.of({
            record: () => Effect.void,
            entries: Effect.succeed([])
          })
        )
        const initialLayer = HoldLayer.pipe(
          Layer.provideMerge(MacosExclusiveRenameTestLive),
          Layer.provideMerge(noOpLedger),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunContext.layer)
        )
        const expired = yield* Effect.gen(function* () {
          const hold = yield* Hold
          return yield* hold.remove(target)
        }).pipe(Effect.provide(initialLayer))

        const ledgerStarted = yield* Deferred.make<void>()
        const reaperLayer = HoldLayer.pipe(
          Layer.provideMerge(MacosExclusiveRenameTestLive),
          Layer.provideMerge(blockingLedger("reap", ledgerStarted)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunContext.layer)
        )

        yield* Effect.gen(function* () {
          const hold = yield* Hold
          const fiber = yield* hold.reap(0).pipe(Effect.fork)
          yield* Deferred.await(ledgerStarted)
          expect(yield* fs.exists(
            path.join(home, "hold", expired.id)
          )).toBe(false)

          const exit = yield* Fiber.interrupt(fiber)
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
    ).pipe(Effect.provide(BunContext.layer))
  )

  it.effect("returns a Hold recovery act when removal is interrupted during Ledger publication", () =>
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
          Layer.provideMerge(MacosExclusiveRenameTestLive),
          Layer.provideMerge(blockingLedger("remove", started)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunContext.layer)
        )

        yield* Effect.gen(function* () {
          const hold = yield* Hold
          const fiber = yield* hold.remove(target).pipe(Effect.fork)
          yield* Deferred.await(started)
          const exit = yield* Fiber.interrupt(fiber)
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
    ).pipe(Effect.provide(BunContext.layer))
  )

  it.effect("returns the generated Outbox id when staging is interrupted after publication", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const home = path.join(temporary, "airlock-home")
        const started = yield* Deferred.make<void>()
        const layer = OutboxLive.pipe(
          Layer.provideMerge(blockingLedger("stage", started)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunContext.layer)
        )

        yield* Effect.gen(function* () {
          const outbox = yield* Outbox
          const fiber = yield* outbox.stage(
            post("https://example.invalid/staged-only"),
            60_000
          ).pipe(Effect.fork)
          yield* Deferred.await(started)
          const exit = yield* Fiber.interrupt(fiber)
          const failure = typedFailure(exit)

          expect(failure).toBeInstanceOf(OutboxRecoveryRequired)
          if (!(failure instanceof OutboxRecoveryRequired)) return
          expect(failure).toMatchObject({
            phase: "ledger-after-stage",
            status: "staged",
            emission: {
              status: "staged"
            }
          })
          expect(yield* outbox.inspect(failure.id)).toEqual(
            failure.emission
          )
          expect((yield* outbox.pending).map(({ id }) => id)).toEqual([
            failure.id
          ])
        }).pipe(Effect.provide(layer))
      })
    ).pipe(Effect.provide(BunContext.layer))
  )

  it.effect("returns a committed outcome on interruption and never redispatches it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const home = path.join(temporary, "airlock-home")
        const started = yield* Deferred.make<void>()
        let hits = 0
        const server = yield* Effect.acquireRelease(
          Effect.async<http.Server>((resume) => {
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
            Effect.async<void>((resume) => {
              value.close(() => resume(Effect.void))
            })
        )
        const address = server.address() as AddressInfo
        const layer = OutboxLive.pipe(
          Layer.provideMerge(blockingLedger("commit", started)),
          Layer.provideMerge(AirlockHome.layer(home)),
          Layer.provideMerge(BunContext.layer)
        )

        yield* Effect.gen(function* () {
          const outbox = yield* Outbox
          const staged = yield* outbox.stage(
            post(`http://127.0.0.1:${address.port}/hook`),
            0
          )
          const fiber = yield* outbox.commit(staged.id).pipe(Effect.fork)
          yield* Deferred.await(started)
          const exit = yield* Fiber.interrupt(fiber)
          const failure = typedFailure(exit)

          expect(failure).toBeInstanceOf(OutboxRecoveryRequired)
          if (!(failure instanceof OutboxRecoveryRequired)) return
          expect(failure).toMatchObject({
            id: staged.id,
            phase: "ledger-after-commit",
            status: "committed",
            emission: {
              status: "committed",
              outcome: {
                status: 200
              }
            }
          })
          expect(yield* outbox.inspect(staged.id)).toEqual(
            failure.emission
          )
          const retry = yield* outbox.commit(staged.id).pipe(Effect.flip)
          expect(retry._tag).toBe("EmissionNotPending")
          expect(hits).toBe(1)
        }).pipe(Effect.provide(layer))
      })
    ).pipe(Effect.provide(BunContext.layer))
  )
})
