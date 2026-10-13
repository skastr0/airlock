import { Layer } from "effect"
import { makeMemoryLedgerState, memoryLedger } from "../../src/testing/MemoryLedger.ts"
import { makeMemoryOutboxState, memoryOutboxStore } from "../../src/testing/MemoryOutboxStore.ts"

/** One store and Ledger share the state an atomic capture publishes into. */
export const memoryAdapters = (state = makeMemoryOutboxState(), ledger = makeMemoryLedgerState()) =>
  Layer.mergeAll(memoryOutboxStore(state, ledger), memoryLedger(ledger))
