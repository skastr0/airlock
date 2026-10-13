/**
 * The storage-agnostic Airlock kernel. Everything here runs on any host that
 * can provide the ports: an OutboxStore, a Ledger, a Dispatcher, and
 * `effect/Crypto`. Nothing here names a file, a process, or an operating system.
 */
export * as Admission from "./admission/index.ts"
export {
  type Airlock,
  AirlockFailure,
  type ByName,
  defineAirlock,
  type EmissionView,
  type GuestSurface,
  type Supervisor
} from "./airlock/Airlock.ts"
export { CallReceipt, CallRefusal, type Done, type GuestReceipt } from "./contract/Receipt.ts"
export { type GuestAction, guestDescription, LANGUAGE_PRIMER, STAGED_RECEIPT_SHAPE } from "./airlock/Declaration.ts"
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
  consumePermit,
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
  CaptureFailed,
  type CaptureError,
  type CaptureRequest,
  type CaptureTag,
  type PerformError,
  type ReadError,
  RESPONSE_LIMIT_BYTES,
  type StageError,
  type StageRequest,
  takeWireRequest,
  type WireToken
} from "./outbox/Outbox.ts"
export { OutboxStore } from "./outbox/OutboxStore.ts"
export { guestLimits } from "./runner/Bounds.ts"
export {
  defaultGuestLimits,
  GuestFailureReason,
  GuestFault,
  GuestLimits,
  GuestOutcome,
  GuestReview,
  GuestToolFailure,
  type GuestRun,
  GuestRunner
} from "./runner/GuestRunner.ts"
export { programRunner } from "./runner/ProgramRunner.ts"
export {
  type CallResult,
  InvalidToolInput,
  InvalidToolSession,
  openToolSession,
  SessionBudgetExceeded,
  type Staged,
  type ToolCallError,
  ToolCallNotGranted,
  ToolGrantExpired,
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

export { CaptureAdmission, CaptureEntry, CaptureOutcome, CaptureRetention, CapturedEmission,
  CAPTURE_RESULT_LIMIT_BYTES, InvalidCapture, StoredCaptureResult, validateCaptureEntry } from "./outbox/Capture.ts"

export { addInfluence, InfluenceRejected } from "./contract/Decoder.ts"
export { createRoleWitnessIssuer, InvalidRoleWitness, isRoleWitnessIssuer, RoleLabels,
  type RoleWitness, type RoleWitnessIssuer } from "./contract/RoleWitness.ts"

/** The ports a host implements, and the exact-JSON codec canonical records use. */
export {
  type BoundResource,
  type BoundScope,
  GrantWhen,
  type HostGrant,
  HostGrantRefused,
  HostParameters,
  HeldReference,
  type HostRecovery,
  RecoveryFailed,
  RecoveryCall,
  RecoveryInspection,
  RecoveryRestoration,
  ResourceBinding,
  ResourceRefused,
  type ResourceBindRequest,
  type ResourceResolver,
  type ToolHost
} from "./contract/ToolHost.ts"
export { endpointResources, portableToolHost } from "./contract/PortableToolHost.ts"
export { type ExactJson, exactJsonText, canonicalExactJson, exactJsonCodec } from "./ExactJson.ts"
export { Sha256Digest, canonicalJson } from "./Canonical.ts"

/** The Hold domain, both as a namespace and as the named records hosts implement. */
export {
  ActId,
  type HoldPurpose,
  HeldManifest,
  RemoveReceipt,
  RuntimePrivateRetentionReceipt,
  OverwriteReceipt,
  UndoReceipt,
  ReapReport,
  TargetNotFound,
  ProtectedPath,
  ScopeEscape,
  UnknownAct,
  NotHeld,
  UndoConflict,
  NothingToUndo,
  RuntimePrivateNotUndoable
} from "./domain.ts"

/** Admission makers and the box-grant format a sealed entrypoint embeds. */
export { BoxGrant, BoxGrantVerb, decodeBoxGrant, decodeAndHashBoxGrant, hashBoxGrant } from "./admission/BoxGrant.ts"
export { FieldMatch, toolGrant, ToolGrantPolicy } from "./admission/ToolGrant.ts"
export type { ReviewContext } from "./review/Surface.ts"
