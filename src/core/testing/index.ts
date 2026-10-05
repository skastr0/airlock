/**
 * Conformance suites and reference adapters. An adapter earns the name Airlock
 * by passing the suite for its port.
 */
export { holds, InvariantViolated, type Runner, same } from "./Check.ts"
export { ledgerConformance, type LedgerWorld } from "./LedgerConformance.ts"
export { makeMemoryLedgerState, type MemoryLedgerState, memoryLedger } from "./MemoryLedger.ts"
export {
  makeMemoryOutboxState,
  type MemoryOutboxState,
  memoryOutboxStore
} from "./MemoryOutboxStore.ts"
export { outboxStoreConformance, type OutboxStoreWorld } from "./OutboxStoreConformance.ts"
