import { Effect, Layer, Option, Result, Semaphore } from "effect"
import { OutboxStore } from "../outbox/OutboxStore.ts"
import type { EmissionState } from "../outbox/Lifecycle.ts"
import {
  advance,
  type EmissionId,
  type EmissionRecord,
  type RecordIn,
  type SealedDispatch,
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
  readonly lock: Semaphore.Semaphore
}

export const makeMemoryOutboxState = (): MemoryOutboxState => ({
  records: new Map(),
  dispatches: new Map(),
  responses: new Map(),
  lock: Semaphore.makeUnsafe(1)
})

/**
 * Reference adapter. Each operation is one synchronous step, so it is atomic
 * by construction; it is the executable statement of what the port means.
 */
export const memoryOutboxStore = (state: MemoryOutboxState): Layer.Layer<OutboxStore> =>
  Layer.succeed(OutboxStore, OutboxStore.of({
    exclusive: (effect) => state.lock.withPermits(1)(effect),
    putIfAbsent: (record, dispatch) =>
      Effect.sync(() => {
        const existing = state.records.get(record.id)
        if (existing !== undefined) return { created: false, record: existing }
        state.records.set(record.id, record)
        state.dispatches.set(record.id, dispatch)
        return { created: true, record }
      }),
    read: (id) => Effect.sync(() => Option.fromNullishOr(state.records.get(id))),
    readDispatch: (id) =>
      Effect.suspend(() => {
        const dispatch = state.dispatches.get(id)
        return dispatch === undefined
          ? Effect.fail(new UnknownEmission({ id }))
          : Effect.succeed(dispatch)
      }),
    transition: (id, from, arrival) =>
      Effect.gen(function* () {
        const record = state.records.get(id)
        if (record === undefined) return yield* new UnknownEmission({ id })
        const next = advance(record, from, arrival)
        if (Result.isFailure(next)) return yield* next.failure
        state.records.set(id, next.success)
        if (arrival.state === "committed") state.responses.set(id, arrival.response.slice())
        return next.success
      }),
    readResponse: (id) =>
      Effect.sync(() => Option.map(Option.fromNullishOr(state.responses.get(id)), (bytes) => bytes.slice())),
    list: <State extends EmissionState>(wanted?: State) =>
      Effect.sync(() =>
        [...state.records.values()].filter((record): record is RecordIn<State> =>
          wanted === undefined || record.state === wanted
        )
      )
  }))
