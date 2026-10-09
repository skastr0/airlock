import { Effect, Layer, Option, Result, Schema, Semaphore } from "effect"
import {
  acknowledge,
  advance,
  type EmissionId,
  EmissionRecord,
  OutboxStateCorrupt,
  OutboxStore,
  OutboxStoreFailed,
  owesReceipt,
  type RecordIn,
  SealedDispatch,
  Canonical,
  TransitionConflict,
  UnknownEmission
} from "../core/index.ts"
import type { EmissionState } from "../core/index.ts"
import { type DurableStorage, ensureSchema, type SqlValue } from "./Storage.ts"

/**
 * One mutex per Durable Object storage, shared by every Layer built over it.
 *
 * Why a mutex at all. A Durable Object runs one JavaScript event at a time,
 * and its SQLite API is synchronous, so each store operation below is atomic
 * without help. But `exclusive` guards a whole section of the kernel, and
 * `commit` awaits the dispatch handler inside it. While an object awaits
 * anything other than its own storage, its input gate is open and another
 * request can start running in the same object. The gates therefore do not
 * serialize kernel sections:
 *
 * - the input gate blocks new events only while storage operations are
 *   pending, not while a handler's network call is in flight;
 * - the output gate holds outgoing messages until the writes before them are
 *   durable. That gives "the committing state is durable before the handler's
 *   request leaves" for free, and nothing about ordering two commits.
 *
 * So `exclusive` is a real lock, held across the handler's await.
 */
const locks = new WeakMap<DurableStorage, Semaphore.Semaphore>()
const lockFor = (storage: DurableStorage) => {
  const held = locks.get(storage)
  if (held !== undefined) return held
  const created = Semaphore.makeUnsafe(1)
  locks.set(storage, created)
  return created
}

type Row = { readonly state: string; readonly record: string }

/** The `owing` column: 1 while the record owes the Ledger a receipt. */
const owing = (record: EmissionRecord): number => (owesReceipt(record) ? 1 : 0)

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(EmissionRecord))
const decodeRecord = Schema.decodeUnknownResult(Schema.fromJsonString(EmissionRecord))

/** A failure raised inside a transaction, carried out of it as a value. */
class Abort {
  constructor(readonly error: UnknownEmission | TransitionConflict | OutboxStateCorrupt) {}
}

/**
 * OutboxStore over a Durable Object's SQLite storage. It holds no state of
 * its own besides the lock: every read comes from the database, so a new
 * object over the same storage sees exactly what the last one wrote.
 */
export const durableOutboxStore = (storage: DurableStorage): Layer.Layer<OutboxStore, OutboxStoreFailed> =>
  Layer.effect(
    OutboxStore,
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => ensureSchema(storage),
        catch: (cause) => new OutboxStoreFailed({ operation: "ensure-schema", reason: String(cause) })
      })
      const lock = lockFor(storage)

      /**
       * Runs one port operation as one SQLite transaction. A typed failure
       * thrown as `Abort` rolls the transaction back and becomes the Effect's
       * failure; anything else SQLite threw is a storage failure.
       */
      const transaction = <A, E extends UnknownEmission | TransitionConflict | OutboxStateCorrupt = never>(
        operation: string,
        id: string | undefined,
        body: () => A
      ): Effect.Effect<A, E | OutboxStoreFailed> =>
        Effect.try({
          try: () => storage.transactionSync(body),
          catch: (cause): E | OutboxStoreFailed =>
            cause instanceof Abort
              ? (cause.error as E)
              : new OutboxStoreFailed({
                  operation,
                  ...(id === undefined ? {} : { id }),
                  reason: cause instanceof Error ? cause.message : String(cause)
                })
        })

      const decode = (id: string, row: Row): EmissionRecord => {
        const decoded = decodeRecord(row.record)
        if (Result.isFailure(decoded)) {
          throw new Abort(new OutboxStateCorrupt({ id, part: "record", reason: "stored record does not decode" }))
        }
        // The column the compare-and-set reads must agree with the record it guards.
        if (decoded.success.state !== row.state || decoded.success.id !== id) {
          throw new Abort(new OutboxStateCorrupt({ id, part: "record", reason: "stored record contradicts its row" }))
        }
        return decoded.success
      }

      const find = (id: EmissionId): Option.Option<EmissionRecord> => {
        const rows = storage.sql
          .exec<Row>("SELECT state, record FROM airlock_emission WHERE id = ?", id)
          .toArray()
        const row = rows[0]
        return row === undefined ? Option.none() : Option.some(decode(id, row))
      }

      const required = (id: EmissionId): EmissionRecord => {
        const found = find(id)
        if (Option.isNone(found)) throw new Abort(new UnknownEmission({ id }))
        return found.value
      }

      return OutboxStore.of({
        exclusive: (effect) => lock.withPermits(1)(effect),

        putIfAbsent: (record, dispatch) =>
          transaction<{ readonly created: boolean; readonly record: EmissionRecord }, OutboxStateCorrupt>(
            "put-if-absent",
            record.id,
            () => {
              const existing = find(record.id)
              if (Option.isSome(existing)) return { created: false, record: existing.value }
              storage.sql.exec(
                "INSERT INTO airlock_emission (id, state, record, dispatch_digest, dispatch, owing) VALUES (?, ?, ?, ?, ?, ?)",
                record.id,
                record.state,
                encodeRecord(record),
                dispatch.digest,
                dispatch.canonical,
                owing(record)
              )
              return { created: true, record }
            }
          ),

        read: (id) =>
          transaction<Option.Option<EmissionRecord>, OutboxStateCorrupt>("read", id, () => find(id)),

        readDispatch: (id) =>
          transaction<SealedDispatch, UnknownEmission | OutboxStateCorrupt>("read-dispatch", id, () => {
            const rows = storage.sql
              .exec<{ readonly dispatch_digest: string; readonly dispatch: string }>(
                "SELECT dispatch_digest, dispatch FROM airlock_emission WHERE id = ?",
                id
              )
              .toArray()
            const row = rows[0]
            if (row === undefined) throw new Abort(new UnknownEmission({ id }))
            const digest = Schema.decodeUnknownResult(Canonical.Sha256Digest)(row.dispatch_digest)
            if (Result.isFailure(digest)) {
              throw new Abort(new OutboxStateCorrupt({ id, part: "dispatch", reason: "stored digest is malformed" }))
            }
            return new SealedDispatch({ digest: digest.success, canonical: row.dispatch })
          }),

        transition: (id, from, arrival) =>
          transaction("transition", id, () => {
            const next = advance(required(id), from, arrival)
            if (Result.isFailure(next)) throw new Abort(next.failure)
            // The WHERE clause is the compare-and-set: the row moves only if it
            // is still in `from`, in the same statement that writes it.
            const response: SqlValue = arrival.state === "committed"
              ? (arrival.response.slice().buffer as ArrayBuffer)
              : null
            // `rowsWritten` also counts index rows, so the moved row is counted
            // by what the statement returns.
            const moved = storage.sql.exec<{ readonly id: string }>(
              "UPDATE airlock_emission SET state = ?, record = ?, response = ?, owing = ? WHERE id = ? AND state = ? RETURNING id",
              arrival.state,
              encodeRecord(next.success),
              response,
              owing(next.success),
              id,
              from
            ).toArray().length
            if (moved !== 1) {
              throw new Abort(new TransitionConflict({ id, expected: from, actual: required(id).state }))
            }
            return next.success
          }),

        acknowledge: (id, phase) =>
          transaction<EmissionRecord, UnknownEmission | OutboxStateCorrupt>("acknowledge", id, () => {
            const next = acknowledge(required(id), phase)
            storage.sql.exec(
              "UPDATE airlock_emission SET record = ?, owing = ? WHERE id = ? AND state = ?",
              encodeRecord(next),
              owing(next),
              id,
              next.state
            )
            return next
          }),

        readResponse: (id) =>
          transaction<Option.Option<Uint8Array>, OutboxStateCorrupt>("read-response", id, () => {
            const rows = storage.sql
              .exec<{ readonly state: string; readonly response: ArrayBuffer | null }>(
                "SELECT state, response FROM airlock_emission WHERE id = ?",
                id
              )
              .toArray()
            const row = rows[0]
            if (row === undefined || row.state !== "committed") return Option.none()
            if (row.response === null) {
              throw new Abort(new OutboxStateCorrupt({ id, part: "response", reason: "a committed emission has no response" }))
            }
            return Option.some(new Uint8Array(row.response))
          }),

        listOwing: transaction<ReadonlyArray<EmissionRecord>, OutboxStateCorrupt>("list-owing", undefined, () =>
          storage.sql
            .exec<Row & { readonly id: string }>(
              "SELECT id, state, record FROM airlock_emission WHERE owing = 1 ORDER BY id"
            )
            .toArray()
            .map((row) => decode(row.id, row))),

        list: <State extends EmissionState>(wanted?: State) =>
          transaction<ReadonlyArray<RecordIn<State>>, OutboxStateCorrupt>("list", undefined, () => {
            const rows = wanted === undefined
              ? storage.sql.exec<Row & { readonly id: string }>(
                  "SELECT id, state, record FROM airlock_emission ORDER BY id"
                ).toArray()
              : storage.sql.exec<Row & { readonly id: string }>(
                  "SELECT id, state, record FROM airlock_emission WHERE state = ? ORDER BY id",
                  wanted
                ).toArray()
            return rows
              .map((row) => decode(row.id, row))
              .filter((record): record is RecordIn<State> => wanted === undefined || record.state === wanted)
          })
      })
    })
  )
