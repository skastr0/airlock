/**
 * The storage-agnostic Airlock kernel. Everything here runs on any host that
 * can provide the ports: an OutboxStore, a Ledger, a Dispatcher, and
 * `effect/Crypto`. Nothing here names a file, a process, or an operating system.
 */
export * as Canonical from "./Canonical.ts"
export * as WebCrypto from "./WebCrypto.ts"
export { EffectClass, Ledger, LedgerEntry, LedgerFailed } from "./ledger/Ledger.ts"
export { type Delivery, DispatchFailed, type DispatchHandlers, type DispatchRequest } from "./outbox/Dispatcher.ts"
export { HttpDispatch, HttpIntent, HttpMethod, HttpOutcome, HttpSummary } from "./outbox/HttpIntent.ts"
export { defineIntentKind, type Intent, type IntentKind, type IntentKinds } from "./outbox/Intent.ts"
export {
  type ActiveState,
  EmissionState,
  isLegalTransition,
  isTerminal,
  type Next,
  type TerminalState,
  transitions
} from "./outbox/Lifecycle.ts"
export {
  type CancelError,
  type CommitError,
  defineOutbox,
  DISPATCH_TIMEOUT_MILLIS,
  type DispatcherOf,
  type DispatchPermit,
  type Emission,
  EmissionDispatchUncertain,
  EmissionNotPending,
  IdempotencyConflict,
  InvalidDispatchAuthorization,
  InvalidHoldDuration,
  isLivePermit,
  type OutboxDefinition,
  type OutboxOf,
  OutboxRecoveryRequired,
  type OutboxService,
  type ReadError,
  RESPONSE_LIMIT_BYTES,
  type StageError,
  type StageRequest
} from "./outbox/Outbox.ts"
export { OutboxStore } from "./outbox/OutboxStore.ts"
export {
  advance,
  type Arrival,
  type Arrivals,
  CancelledEmission,
  CommitAuthority,
  CommittedEmission,
  CommittingEmission,
  DispatchAuthorization,
  DispatchProvenance,
  EmissionId,
  EmissionRecord,
  IdempotencyKey,
  InvalidIntent,
  OutboxStateCorrupt,
  OutboxStoreFailed,
  type RecordIn,
  ResponseCapture,
  SealedDispatch,
  StagedEmission,
  TransitionConflict,
  UncertainEmission,
  UncertainReason,
  UnknownEmission
} from "./outbox/Records.ts"
