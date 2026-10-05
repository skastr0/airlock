import { Effect, Layer } from "effect"
import { Ledger, type LedgerEntry } from "../ledger/Ledger.ts"

/** The state behind one in-memory ledger; a second Layer over it is a restart. */
export interface MemoryLedgerState {
  readonly entries: Array<LedgerEntry>
}

export const makeMemoryLedgerState = (): MemoryLedgerState => ({ entries: [] })

export const memoryLedger = (state: MemoryLedgerState): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, Ledger.of({
    record: (entry) =>
      Effect.sync(() => {
        if (entry.key !== undefined && state.entries.some((held) => held.key === entry.key)) return
        state.entries.push(entry)
      }),
    entries: Effect.sync(() => [...state.entries])
  }))
