/**
 * The storage-agnostic Airlock kernel. Everything here runs on any host that
 * can provide the ports: an OutboxStore, a Ledger, a Dispatcher, and
 * `effect/Crypto`. Nothing here names a file, a process, or an operating system.
 */
export * as Actions from "./actions/index.ts"
export * as Admission from "./admission/index.ts"
export {
  type Airlock,
  AirlockFailure,
  type ByName,
  defineAirlock,
  type EmissionView,
  type GuestSurface,
  type StagedReceipt,
  type Supervisor
} from "./airlock/Airlock.ts"
export { guestDeclaration, guestDescription } from "./airlock/Declaration.ts"
export {
  handlersFor,
  type ImplementContext,
  type Implementations,
  Refused,
  refused
} from "./airlock/Implement.ts"
export * as Canonical from "./Canonical.ts"
export {
  defineToolContract,
  type ToolContract,
  type ToolShape,
  ToolSummary
} from "./contract/ToolContract.ts"
export * as Hold from "./domain.ts"
export * as Labels from "./labels/index.ts"
export * as Language from "./language/index.ts"
export * as Plan from "./plan/index.ts"
export * as Tools from "./tools/index.ts"
export * as WebCrypto from "./WebCrypto.ts"
export { EffectClass, Ledger, LedgerEntry, LedgerFailed } from "./ledger/Ledger.ts"
export {
  type Delivery,
  DispatchFailed,
  type DispatchHandlers,
  DispatchRefused,
  type DispatchRequest
} from "./outbox/Dispatcher.ts"
export { HttpDispatch, HttpIntent, HttpMethod, HttpOutcome, HttpSummary } from "./outbox/HttpIntent.ts"
export {
  type ClosedUnderCompensation,
  type CompensableTag,
  type Compensation,
  compensateWith,
  defineIntentKind,
  type Intent,
  type IntentKind,
  type IntentKinds
} from "./outbox/Intent.ts"
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
  type CompensateError,
  defineOutbox,
  DISPATCH_TIMEOUT_MILLIS,
  type DispatcherOf,
  type DispatchPermit,
  type Emission,
  EmissionDispatchUncertain,
  EmissionNotPending,
  EmissionRefused,
  IdempotencyConflict,
  InvalidDispatchAuthorization,
  InvalidHoldDuration,
  isLivePermit,
  NotCompensable,
  type OutboxDefinition,
  type OutboxOf,
  OutboxRecoveryRequired,
  type OutboxService,
  type Performed,
  type PerformError,
  type ReadError,
  RESPONSE_LIMIT_BYTES,
  type StageError,
  type StageRequest
} from "./outbox/Outbox.ts"
export { OutboxStore } from "./outbox/OutboxStore.ts"
export {
  type GuestBridge,
  guestLimits,
  invalidSource,
  makeGuestBridge,
  settleGuest
} from "./runner/GuestHost.ts"
export {
  defaultGuestLimits,
  GuestFailureReason,
  GuestLimits,
  GuestOutcome,
  type GuestRun,
  GuestRunner
} from "./runner/GuestRunner.ts"
export { guestRuntimeSource } from "./runner/GuestRuntime.ts"
export {
  type CallResult,
  InvalidToolInput,
  InvalidToolSession,
  openToolSession,
  SessionBudgetExceeded,
  type Staged,
  type ToolCallError,
  ToolCallNotGranted,
  type ToolContracts,
  type ToolSession,
  type ToolSessionOptions
} from "./session/ToolSession.ts"
export { ToolPolicy, toolPolicy, toolPolicyDigest, type ToolPolicyFor } from "./session/ToolPolicy.ts"
export {
  acknowledge,
  advance,
  type Arrival,
  type Arrivals,
  CancelledEmission,
  CommitAuthority,
  CommittedEmission,
  CommittingEmission,
  DispatchAuthorization,
  DispatchProvenance,
  EmissionAdmission,
  EmissionId,
  EmissionRecord,
  IdempotencyKey,
  InvalidIntent,
  LedgerPhase,
  OutboxStateCorrupt,
  OutboxStoreFailed,
  owedPhases,
  owesReceipt,
  rebuild,
  type RecordIn,
  RefusedEmission,
  ResponseCapture,
  SealedDispatch,
  StagedEmission,
  TransitionConflict,
  UncertainEmission,
  UncertainReason,
  UnknownEmission
} from "./outbox/Records.ts"
