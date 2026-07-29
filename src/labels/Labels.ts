import { DateTime, Effect, Schema } from "effect"

/**
 * Candidate domain capability: node-level information flow. The component is
 * deliberately pure: policy/admission decides which supervisor capabilities
 * exist; adapters persist receipts and enforce selected profile policy.
 *
 * It is not yet an earned pristine component. Its lattice is stable enough to
 * centralize, but real tool, broker, and cross-plan workloads must still
 * establish its selector and revocation semantics.
 */

export const Confidentiality = Schema.Literal("public", "project", "private", "secret")
export type Confidentiality = typeof Confidentiality.Type

export const Integrity = Schema.Literal("untrusted", "project", "operator", "runtime")
export type Integrity = typeof Integrity.Type

export const LabelSubject = Schema.String.pipe(Schema.brand("LabelSubject"))
export type LabelSubject = typeof LabelSubject.Type

export const LabelRealm = Schema.String.pipe(Schema.brand("LabelRealm"))
export type LabelRealm = typeof LabelRealm.Type

export const LabelReceiptId = Schema.String.pipe(Schema.brand("LabelReceiptId"))
export type LabelReceiptId = typeof LabelReceiptId.Type

export const SupervisorCapabilityId = Schema.String.pipe(Schema.brand("SupervisorCapabilityId"))
export type SupervisorCapabilityId = typeof SupervisorCapabilityId.Type

export const SupervisorOperation = Schema.Literal("declassify", "endorse")
export type SupervisorOperation = typeof SupervisorOperation.Type

export class InformationLabel extends Schema.Class<InformationLabel>("InformationLabel")({
  confidentiality: Confidentiality,
  integrity: Integrity,
  /** Immutable source references, not claims about arbitrary binary internals. */
  provenance: Schema.Array(Schema.String)
}) {}

/** A Schema-shaped reference for artifacts, streams, handles, or control inputs. */
export class LabeledReference extends Schema.Class<LabeledReference>("LabeledReference")({
  subject: LabelSubject,
  realm: LabelRealm,
  label: InformationLabel
}) {}

/**
 * A supervisor-issued value is distinct from a policy boolean. Issue and
 * revocation are outside this pure component; callers must pass the concrete,
 * narrowly scoped value into each promotion/release transition.
 */
export class SupervisorCapability extends Schema.Class<SupervisorCapability>("SupervisorCapability")({
  id: SupervisorCapabilityId,
  operation: SupervisorOperation,
  subject: LabelSubject,
  realm: LabelRealm,
  issuedBy: Schema.String,
  validUntil: Schema.DateTimeUtc,
  /** Present only for a declassification capability and must equal its target. */
  declassifyTo: Schema.optional(Confidentiality),
  /** Present only for an endorsement capability and must equal its target. */
  endorseTo: Schema.optional(Integrity)
}) {}

export class SinkPolicy extends Schema.Class<SinkPolicy>("SinkPolicy")({
  id: Schema.String,
  confidentialityCeiling: Confidentiality,
  minimumIntegrity: Integrity
}) {}

export const LabelTransition = Schema.Literal("declassification", "endorsement")
export type LabelTransition = typeof LabelTransition.Type

export class LabelTransitionReceipt extends Schema.Class<LabelTransitionReceipt>("LabelTransitionReceipt")({
  id: LabelReceiptId,
  transition: LabelTransition,
  subject: LabelSubject,
  realm: LabelRealm,
  capabilityId: SupervisorCapabilityId,
  supervisor: Schema.String,
  from: InformationLabel,
  to: InformationLabel,
  at: Schema.DateTimeUtc
}) {}

export const encodeInformationLabelJson = Schema.encode(Schema.parseJson(InformationLabel))
export const decodeInformationLabelJson = Schema.decode(Schema.parseJson(InformationLabel))
export const encodeLabelTransitionReceiptJson = Schema.encode(Schema.parseJson(LabelTransitionReceipt))
export const decodeLabelTransitionReceiptJson = Schema.decode(Schema.parseJson(LabelTransitionReceipt))

export class LabelFlowDenied extends Schema.TaggedError<LabelFlowDenied>()("LabelFlowDenied", {
  sinkId: Schema.String,
  reason: Schema.Literal("confidentiality", "integrity"),
  actual: Schema.String,
  required: Schema.String
}) {}

export class SupervisorCapabilityInvalid extends Schema.TaggedError<SupervisorCapabilityInvalid>()(
  "SupervisorCapabilityInvalid",
  {
    capabilityId: Schema.String,
    reason: Schema.Literal("operation", "scope", "expired", "target")
  }
) {}

export class LabelTransitionDenied extends Schema.TaggedError<LabelTransitionDenied>()(
  "LabelTransitionDenied",
  {
    transition: LabelTransition,
    reason: Schema.Literal("not-a-lowering", "not-a-raise")
  }
) {}

const confidentialityRank: Readonly<Record<Confidentiality, number>> = {
  public: 0,
  project: 1,
  private: 2,
  secret: 3
}

const integrityRank: Readonly<Record<Integrity, number>> = {
  untrusted: 0,
  project: 1,
  operator: 2,
  runtime: 3
}

const sortedConfidentiality = Object.entries(confidentialityRank) as ReadonlyArray<readonly [Confidentiality, number]>
const sortedIntegrity = Object.entries(integrityRank) as ReadonlyArray<readonly [Integrity, number]>

const confidentialityAt = (rank: number): Confidentiality =>
  sortedConfidentiality.find(([, candidate]) => candidate === rank)?.[0] ?? "secret"

const integrityAt = (rank: number): Integrity =>
  sortedIntegrity.find(([, candidate]) => candidate === rank)?.[0] ?? "untrusted"

const unique = (values: ReadonlyArray<string>) => [...new Set(values)]

/** Conservative node-level join: secrecy rises, integrity falls. */
export const combine = (
  head: InformationLabel,
  ...tail: ReadonlyArray<InformationLabel>
): InformationLabel => {
  const labels = [head, ...tail]
  return new InformationLabel({
    confidentiality: confidentialityAt(Math.max(...labels.map((label) => confidentialityRank[label.confidentiality]))),
    integrity: integrityAt(Math.min(...labels.map((label) => integrityRank[label.integrity]))),
    provenance: unique(labels.flatMap((label) => label.provenance))
  })
}

/** Ordinary computation cannot relax either part of a label. */
export const derive = (
  outputProvenance: ReadonlyArray<string>,
  head: InformationLabel,
  ...tail: ReadonlyArray<InformationLabel>
): InformationLabel => {
  const inherited = combine(head, ...tail)
  return new InformationLabel({ ...inherited, provenance: unique([...inherited.provenance, ...outputProvenance]) })
}

/** Reject a flow that exceeds a sink's release or control boundary. */
export const checkSink = (
  label: InformationLabel,
  sink: SinkPolicy
): Effect.Effect<void, LabelFlowDenied> => {
  if (confidentialityRank[label.confidentiality] > confidentialityRank[sink.confidentialityCeiling]) {
    return Effect.fail(new LabelFlowDenied({
      sinkId: sink.id,
      reason: "confidentiality",
      actual: label.confidentiality,
      required: sink.confidentialityCeiling
    }))
  }
  if (integrityRank[label.integrity] < integrityRank[sink.minimumIntegrity]) {
    return Effect.fail(new LabelFlowDenied({
      sinkId: sink.id,
      reason: "integrity",
      actual: label.integrity,
      required: sink.minimumIntegrity
    }))
  }
  return Effect.void
}

const capabilityError = (capability: SupervisorCapability, reason: SupervisorCapabilityInvalid["reason"]) =>
  new SupervisorCapabilityInvalid({ capabilityId: capability.id, reason })

const validateCapability = (
  capability: SupervisorCapability,
  subject: LabeledReference,
  operation: SupervisorOperation,
  now: Date
): Effect.Effect<void, SupervisorCapabilityInvalid> => {
  if (capability.operation !== operation) return Effect.fail(capabilityError(capability, "operation"))
  if (capability.subject !== subject.subject || capability.realm !== subject.realm) {
    return Effect.fail(capabilityError(capability, "scope"))
  }
  if (DateTime.toDateUtc(capability.validUntil).getTime() <= now.getTime()) {
    return Effect.fail(capabilityError(capability, "expired"))
  }
  return Effect.void
}

export type LabelTransitionError = SupervisorCapabilityInvalid | LabelTransitionDenied

/**
 * Lower confidentiality only with a scoped, unexpired supervisor capability.
 * The capability authorizes one exact target label rather than a broad boolean.
 */
export const declassify = (
  subject: LabeledReference,
  capability: SupervisorCapability,
  target: Confidentiality,
  receiptId: LabelReceiptId,
  at: Date = new Date()
): Effect.Effect<readonly [LabeledReference, LabelTransitionReceipt], LabelTransitionError> =>
  Effect.gen(function* () {
    yield* validateCapability(capability, subject, "declassify", at)
    if (capability.declassifyTo !== target || capability.endorseTo !== undefined) {
      return yield* Effect.fail(capabilityError(capability, "target"))
    }
    if (confidentialityRank[target] >= confidentialityRank[subject.label.confidentiality]) {
      return yield* Effect.fail(new LabelTransitionDenied({ transition: "declassification", reason: "not-a-lowering" }))
    }
    const label = new InformationLabel({ ...subject.label, confidentiality: target })
    const result = new LabeledReference({ ...subject, label })
    return [result, new LabelTransitionReceipt({
      id: receiptId,
      transition: "declassification",
      subject: subject.subject,
      realm: subject.realm,
      capabilityId: capability.id,
      supervisor: capability.issuedBy,
      from: subject.label,
      to: label,
      at: DateTime.unsafeFromDate(at)
    })] as const
  })

/** Raise integrity only with a scoped, unexpired supervisor capability. */
export const endorse = (
  subject: LabeledReference,
  capability: SupervisorCapability,
  target: Integrity,
  receiptId: LabelReceiptId,
  at: Date = new Date()
): Effect.Effect<readonly [LabeledReference, LabelTransitionReceipt], LabelTransitionError> =>
  Effect.gen(function* () {
    yield* validateCapability(capability, subject, "endorse", at)
    if (capability.endorseTo !== target || capability.declassifyTo !== undefined) {
      return yield* Effect.fail(capabilityError(capability, "target"))
    }
    if (integrityRank[target] <= integrityRank[subject.label.integrity]) {
      return yield* Effect.fail(new LabelTransitionDenied({ transition: "endorsement", reason: "not-a-raise" }))
    }
    const label = new InformationLabel({ ...subject.label, integrity: target })
    const result = new LabeledReference({ ...subject, label })
    return [result, new LabelTransitionReceipt({
      id: receiptId,
      transition: "endorsement",
      subject: subject.subject,
      realm: subject.realm,
      capabilityId: capability.id,
      supervisor: capability.issuedBy,
      from: subject.label,
      to: label,
      at: DateTime.unsafeFromDate(at)
    })] as const
  })
