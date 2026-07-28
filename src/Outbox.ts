import { FileSystem, Path } from "@effect/platform"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { AirlockHome } from "./AirlockHome.ts"
import {
  EmissionFailed,
  EmissionId,
  EmissionNotPending,
  EmissionRequest,
  LedgerEntry,
  StagedEmission,
  UnknownEmission
} from "./domain.ts"
import { Ledger } from "./Ledger.ts"

// Emissions are external effects: once sent there is no undo. So nothing is
// sent at stage time — the emission is a value in the outbox until its hold
// expires (flush) or it is affirmatively committed. Cancel deletes a queued
// value; it never has to reverse anything.

export class Outbox extends Context.Tag("airlock/Outbox")<
  Outbox,
  {
    readonly stage: (
      request: EmissionRequest,
      holdMillis: number
    ) => Effect.Effect<StagedEmission>
    readonly commit: (
      id: EmissionId
    ) => Effect.Effect<
      StagedEmission,
      UnknownEmission | EmissionNotPending | EmissionFailed
    >
    readonly cancel: (
      id: EmissionId
    ) => Effect.Effect<StagedEmission, UnknownEmission | EmissionNotPending>
    readonly pending: Effect.Effect<ReadonlyArray<StagedEmission>>
    readonly flush: Effect.Effect<{
      readonly committed: ReadonlyArray<StagedEmission>
      readonly failed: ReadonlyArray<string>
      readonly waiting: number
    }>
  }
>() {}

const encodeEmission = Schema.encode(Schema.parseJson(StagedEmission))
const decodeEmission = Schema.decode(Schema.parseJson(StagedEmission))

const newEmissionId = () =>
  EmissionId.make(`emi_${crypto.randomUUID().slice(0, 13)}`)

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* AirlockHome
  const ledger = yield* Ledger

  const emissionFile = (id: string) => path.join(home.outboxDir, `${id}.json`)

  const write = (emission: StagedEmission) =>
    encodeEmission(emission).pipe(
      Effect.flatMap((json) => fs.writeFileString(emissionFile(emission.id), json)),
      Effect.orDie
    )

  const read = (id: string) =>
    fs
      .readFileString(emissionFile(id))
      .pipe(
        Effect.flatMap(decodeEmission),
        Effect.mapError(() => new UnknownEmission({ id }))
      )

  const stage = Effect.fn("Outbox.stage")(function* (
    request: EmissionRequest,
    holdMillis: number
  ) {
    const stagedAt = yield* DateTime.now
    const emission = new StagedEmission({
      id: newEmissionId(),
      request,
      status: "staged",
      stagedAt,
      holdUntil: DateTime.add(stagedAt, { millis: holdMillis })
    })
    yield* write(emission)
    yield* ledger.record(
      new LedgerEntry({
        at: stagedAt,
        effect: "emission",
        act: "stage",
        ref: emission.id,
        detail: `${request.method} ${request.url}`
      })
    )
    return emission
  })

  // the point of no return: the only place in the codebase that talks to the
  // outside world
  const perform = (emission: StagedEmission) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(emission.request.url, {
          method: emission.request.method,
          headers: emission.request.headers,
          ...(emission.request.body !== undefined
            ? { body: emission.request.body }
            : {})
        })
        const body = await response.text()
        return { status: response.status, body: body.slice(0, 2048) }
      },
      catch: (cause) =>
        new EmissionFailed({ id: emission.id, cause: String(cause) })
    })

  const commit = Effect.fn("Outbox.commit")(function* (id: EmissionId) {
    const emission = yield* read(id)
    if (emission.status !== "staged") {
      return yield* new EmissionNotPending({ id, status: emission.status })
    }
    const outcome = yield* perform(emission)
    const at = yield* DateTime.now
    const committed = new StagedEmission({
      ...emission,
      status: "committed",
      outcome
    })
    yield* write(committed)
    yield* ledger.record(
      new LedgerEntry({
        at,
        effect: "emission",
        act: "commit",
        ref: id,
        detail: `${emission.request.method} ${emission.request.url} -> ${outcome.status}`
      })
    )
    return committed
  })

  const cancel = Effect.fn("Outbox.cancel")(function* (id: EmissionId) {
    const emission = yield* read(id)
    if (emission.status !== "staged") {
      return yield* new EmissionNotPending({ id, status: emission.status })
    }
    const at = yield* DateTime.now
    const cancelled = new StagedEmission({ ...emission, status: "cancelled" })
    yield* write(cancelled)
    yield* ledger.record(
      new LedgerEntry({
        at,
        effect: "emission",
        act: "cancel",
        ref: id,
        detail: `${emission.request.method} ${emission.request.url}`
      })
    )
    return cancelled
  })

  const all = fs.readDirectory(home.outboxDir).pipe(
    Effect.flatMap(
      Effect.forEach((entry) =>
        read(entry.replace(/\.json$/, "")).pipe(Effect.option)
      )
    ),
    Effect.map((options) =>
      options.flatMap((o) => (o._tag === "Some" ? [o.value] : []))
    ),
    Effect.orDie
  )

  const pending = all.pipe(
    Effect.map((emissions) =>
      emissions
        .filter((e) => e.status === "staged")
        .sort(
          (a, b) =>
            DateTime.toEpochMillis(a.stagedAt) -
            DateTime.toEpochMillis(b.stagedAt)
        )
    )
  )

  const flush = Effect.gen(function* () {
    const now = yield* DateTime.now
    const staged = yield* pending
    const due = staged.filter((e) => DateTime.lessThanOrEqualTo(e.holdUntil, now))
    const committed: Array<StagedEmission> = []
    const failed: Array<string> = []
    for (const emission of due) {
      const result = yield* commit(emission.id).pipe(Effect.either)
      if (result._tag === "Right") {
        committed.push(result.right)
      } else {
        failed.push(emission.id)
      }
    }
    return { committed, failed, waiting: staged.length - due.length }
  })

  return Outbox.of({ stage, commit, cancel, pending, flush })
})

export const OutboxLive = Layer.effect(Outbox, make)
