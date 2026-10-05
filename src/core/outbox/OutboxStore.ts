import { Context, type Effect, type Option } from "effect"
import type { ActiveState, EmissionState, Next } from "./Lifecycle.ts"
import type {
  Arrival,
  EmissionId,
  EmissionRecord,
  LedgerPhase,
  OutboxStateCorrupt,
  OutboxStoreFailed,
  RecordIn,
  SealedDispatch,
  StagedEmission,
  TransitionConflict,
  UnknownEmission
} from "./Records.ts"

/**
 * A transactional emission store. It persists typed records the kernel built
 * and hands them back unchanged; it never encodes, hashes, or decides a state.
 *
 * Every operation is atomic and durable when it succeeds: a caller that sees
 * success may crash immediately and find the same state afterwards.
 */
export class OutboxStore extends Context.Service<
  OutboxStore,
  {
    /**
     * Serializes a section against every other holder of this store. A file
     * lock on a multi-process host; the identity function inside a
     * single-threaded Durable Object.
     */
    readonly exclusive: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | OutboxStoreFailed, R>
    /**
     * Stores a newly staged emission and its sealed dispatch, keyed by the
     * record's id, unless that id already exists. Returns the stored record:
     * the new one with `created: true`, or the existing one, in whatever state
     * it reached, with `created: false`. An existing record and its dispatch
     * are never modified.
     */
    readonly putIfAbsent: (
      record: StagedEmission,
      dispatch: SealedDispatch
    ) => Effect.Effect<
      { readonly created: boolean; readonly record: EmissionRecord },
      OutboxStoreFailed | OutboxStateCorrupt
    >
    readonly read: (
      id: EmissionId
    ) => Effect.Effect<Option.Option<EmissionRecord>, OutboxStoreFailed | OutboxStateCorrupt>
    readonly readDispatch: (
      id: EmissionId
    ) => Effect.Effect<SealedDispatch, UnknownEmission | OutboxStoreFailed | OutboxStateCorrupt>
    /**
     * Compare-and-set. Moves the emission from `from` to the arrival's state
     * only if it is in `from` now, persisting `advance(record, arrival)`; a
     * `committed` arrival's response bytes become the emission's blob in the
     * same step. An illegal move does not typecheck.
     */
    readonly transition: <From extends ActiveState, const To extends Arrival<Next<From>>>(
      id: EmissionId,
      from: From,
      arrival: To
    ) => Effect.Effect<
      RecordIn<To["state"]>,
      UnknownEmission | TransitionConflict | OutboxStoreFailed | OutboxStateCorrupt
    >
    /**
     * Marks one Ledger phase as durably recorded, persisting
     * `acknowledge(record, phase)`. It changes no state and is idempotent.
     */
    readonly acknowledge: (
      id: EmissionId,
      phase: LedgerPhase
    ) => Effect.Effect<EmissionRecord, UnknownEmission | OutboxStoreFailed | OutboxStateCorrupt>
    /** The bounded response blob of a committed emission. */
    readonly readResponse: (
      id: EmissionId
    ) => Effect.Effect<Option.Option<Uint8Array>, OutboxStoreFailed | OutboxStateCorrupt>
    readonly list: <State extends EmissionState = EmissionState>(
      state?: State
    ) => Effect.Effect<ReadonlyArray<RecordIn<State>>, OutboxStoreFailed | OutboxStateCorrupt>
  }
>()("airlock/core/OutboxStore") {}
