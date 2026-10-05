/**
 * Conformance suites and reference adapters. An adapter earns the name Airlock
 * by passing the suite for its port.
 */
export { holds, InvariantViolated, type Runner, same } from "./Check.ts"
export { exampleContracts, LabelAdd, LabelRemove, MailList, MailSend } from "./ExampleContracts.ts"
export { ledgerConformance, type LedgerWorld } from "./LedgerConformance.ts"
export { makeMemoryLedgerState, type MemoryLedgerState, memoryLedger } from "./MemoryLedger.ts"
export {
  makeMemoryOutboxState,
  memoryOutboxFaults,
  type MemoryOutboxState,
  memoryOutboxStore
} from "./MemoryOutboxStore.ts"
export { outboxConformance, type OutboxWorld } from "./OutboxConformance.ts"
export { outboxStoreConformance, type OutboxStoreWorld } from "./OutboxStoreConformance.ts"
export { expectedTranscript, runWorkedExample, type WorkedExampleAdapters } from "./WorkedExample.ts"
