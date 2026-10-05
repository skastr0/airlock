import { Effect, Layer, Option, Result, Semaphore } from "effect"
import type { EmissionState } from "../outbox/Lifecycle.ts"
import { OutboxStore } from "../outbox/OutboxStore.ts"
import {
  acknowledge,
  advance,
  type EmissionId,
  type EmissionRecord,
  OutboxStateCorrupt,
  type RecordIn,
  SealedDispatch,
  UnknownEmission
} from "../outbox/Records.ts"

/**
 * The state behind one in-memory store. Create it once per world and build as
 * many Layers over it as the test needs: a second Layer over the same state is
 * a restart.
 */
export interface MemoryOutboxState {
  readonly records: Map<EmissionId, EmissionRecord>
  readonly dispatches: Map<EmissionId, SealedDispatch>
  readonly responses: Map<EmissionId, Uint8Array>
  /** Ids whose stored record has been damaged and no longer decodes. */
  readonly damaged: Set<EmissionId>
  readonly lock: Semaphore.Semaphore
}

export const makeMemoryOutboxState = (): MemoryOutboxState => ({
  records: new Map(),
  dispatches: new Map(),
  responses: new Map(),
  damaged: new Set(),
  lock: Semaphore.makeUnsafe(1)
})

/** What an attacker with write access to the store could do, for conformance worlds. */
export const memoryOutboxFaults = (state: MemoryOutboxState) => ({
  corruptRecord: (id: EmissionId) => Effect.sync(() => void state.damaged.add(id)),
  tamperDispatch: (id: EmissionId) =>
    Effect.sync(() => {
      const sealed = state.dispatches.get(id)
      if (sealed !== undefined) {
        state.dispatches.set(id, new SealedDispatch({
          digest: sealed.digest,
          canonical: `${sealed.canonical} `
        }))
      }
    })
})

/**
 * Reference adapter. Each operation is one synchronous step, so it is atomic
 * by construction; it is the executable statement of what the port means.
 */
export const memoryOutboxStore = (state: MemoryOutboxState): Layer.Layer<OutboxStore> => {
  const damaged = (id: EmissionId) =>
    new OutboxStateCorrupt({ id, part: "record", reason: "stored record does not decode" })

  /** The stored record, refusing one that is damaged. */
  const load = (id: EmissionId) =>
    Effect.suspend(() =>
      state.damaged.has(id)
        ? Effect.fail(damaged(id))
        : Effect.succeed(Option.fromNullishOr(state.records.get(id)))
    )

  const required = (id: EmissionId) =>
    Effect.flatMap(load(id), Option.match({
      onNone: () => Effect.fail(new UnknownEmission({ id })),
      onSome: (record) => Effect.succeed(record)
    }))

  return Layer.succeed(OutboxStore, OutboxStore.of({
    exclusive: (effect) => state.lock.withPermits(1)(effect),
    putIfAbsent: (record, dispatch) =>
      Effect.map(load(record.id), (existing) => {
        if (Option.isSome(existing)) return { created: false, record: existing.value }
        state.records.set(record.id, record)
        state.dispatches.set(record.id, dispatch)
        return { created: true, record }
      }),
    read: load,
    readDispatch: (id) =>
      Effect.suspend(() => {
        const dispatch = state.dispatches.get(id)
        return dispatch === undefined
          ? Effect.fail(new UnknownEmission({ id }))
          : Effect.succeed(dispatch)
      }),
    transition: (id, from, arrival) =>
      Effect.gen(function* () {
        const next = advance(yield* required(id), from, arrival)
        if (Result.isFailure(next)) return yield* next.failure
        state.records.set(id, next.success)
        if (arrival.state === "committed") state.responses.set(id, arrival.response.slice())
        return next.success
      }),
    acknowledge: (id, phase) =>
      Effect.map(required(id), (record) => {
        const next = acknowledge(record, phase)
        state.records.set(id, next)
        return next
      }),
    readResponse: (id) =>
      Effect.sync(() => Option.map(Option.fromNullishOr(state.responses.get(id)), (bytes) => bytes.slice())),
    list: <State extends EmissionState>(wanted?: State) =>
      Effect.suspend(() => {
        const broken = [...state.damaged][0]
        return broken !== undefined
          ? Effect.fail(damaged(broken))
          : Effect.succeed(
              [...state.records.values()].filter((record): record is RecordIn<State> =>
                wanted === undefined || record.state === wanted
              )
            )
      })
  }))
}
