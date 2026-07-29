import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import {
  InformationLabel,
  LabelFlowDenied,
  LabelReceiptId,
  LabelSubject,
  LabelTransitionDenied,
  LabeledReference,
  LabelRealm,
  SinkPolicy,
  SupervisorCapability,
  SupervisorCapabilityId,
  SupervisorCapabilityInvalid,
  checkSink,
  combine,
  declassify,
  derive,
  endorse
} from "../src/labels/index.ts"

const at = new Date("2026-07-29T12:00:00.000Z")
const future = DateTime.unsafeFromDate(new Date("2026-07-30T12:00:00.000Z"))
const past = DateTime.unsafeFromDate(new Date("2026-07-28T12:00:00.000Z"))

const label = (confidentiality: InformationLabel["confidentiality"], integrity: InformationLabel["integrity"], provenance: ReadonlyArray<string>) =>
  new InformationLabel({ confidentiality, integrity, provenance: [...provenance] })

const subject = new LabeledReference({
  subject: LabelSubject.make("artifact/state"),
  realm: LabelRealm.make("workspace"),
  label: label("secret", "untrusted", ["capture:state"])
})

const capability = (fields: Partial<ConstructorParameters<typeof SupervisorCapability>[0]> = {}) =>
  new SupervisorCapability({
    id: SupervisorCapabilityId.make("supervisor/1"),
    operation: "declassify",
    subject: subject.subject,
    realm: subject.realm,
    issuedBy: "operator:alice",
    validUntil: future,
    declassifyTo: "project",
    ...fields
  })

describe("label flow", () => {
  it("conservatively joins secrecy upward and integrity downward", () => {
    expect(combine(
      label("project", "runtime", ["capture:a"]),
      label("secret", "project", ["capture:b", "capture:a"])
    )).toEqual(label("secret", "project", ["capture:a", "capture:b"]))

    expect(derive(["invoke:formatter"], label("private", "operator", ["capture:input"]))).toEqual(
      label("private", "operator", ["capture:input", "invoke:formatter"])
    )
  })

  it.effect("rejects flows that exceed confidentiality release and integrity control boundaries", () =>
    Effect.gen(function* () {
      const confidential = yield* checkSink(label("private", "operator", ["capture:private"]), new SinkPolicy({
        id: "endpoint/public", confidentialityCeiling: "project", minimumIntegrity: "project"
      })).pipe(Effect.flip)
      expect(confidential).toBeInstanceOf(LabelFlowDenied)
      expect(confidential).toMatchObject({ reason: "confidentiality", actual: "private", required: "project" })

      const lowIntegrity = yield* checkSink(label("project", "untrusted", ["capture:download"]), new SinkPolicy({
        id: "control/definition", confidentialityCeiling: "secret", minimumIntegrity: "operator"
      })).pipe(Effect.flip)
      expect(lowIntegrity).toMatchObject({ reason: "integrity", actual: "untrusted", required: "operator" })

      yield* checkSink(label("project", "operator", ["capture:approved"]), new SinkPolicy({
        id: "control/definition", confidentialityCeiling: "private", minimumIntegrity: "operator"
      }))
    })
  )

  it.effect("requires a scoped, concrete supervisor capability to lower confidentiality and emits a receipt", () =>
    Effect.gen(function* () {
      const [result, receipt] = yield* declassify(subject, capability(), "project", LabelReceiptId.make("receipt/1"), at)
      expect(result.label).toEqual(label("project", "untrusted", ["capture:state"]))
      expect(receipt).toMatchObject({
        transition: "declassification",
        subject: subject.subject,
        capabilityId: SupervisorCapabilityId.make("supervisor/1"),
        supervisor: "operator:alice",
        from: subject.label,
        to: result.label
      })

      const ordinaryLowering = yield* declassify(subject, capability({ declassifyTo: "secret" }), "secret", LabelReceiptId.make("receipt/2"), at).pipe(Effect.flip)
      expect(ordinaryLowering).toBeInstanceOf(LabelTransitionDenied)
      expect(ordinaryLowering).toMatchObject({ transition: "declassification", reason: "not-a-lowering" })
    })
  )

  it.effect("refuses wrong, expired, and out-of-scope capabilities instead of accepting an agent-mintable boolean", () =>
    Effect.gen(function* () {
      const wrongScope = yield* declassify(subject, capability({ subject: LabelSubject.make("artifact/other") }), "project", LabelReceiptId.make("receipt/3"), at).pipe(Effect.flip)
      expect(wrongScope).toBeInstanceOf(SupervisorCapabilityInvalid)
      expect(wrongScope).toMatchObject({ reason: "scope" })

      const expired = yield* declassify(subject, capability({ validUntil: past }), "project", LabelReceiptId.make("receipt/4"), at).pipe(Effect.flip)
      expect(expired).toMatchObject({ reason: "expired" })

      const mismatchedTarget = yield* declassify(subject, capability({ declassifyTo: "public" }), "project", LabelReceiptId.make("receipt/5"), at).pipe(Effect.flip)
      expect(mismatchedTarget).toMatchObject({ reason: "target" })
    })
  )

  it.effect("permits integrity promotion only through a separately scoped endorsement", () =>
    Effect.gen(function* () {
      const endorsement = capability({
        id: SupervisorCapabilityId.make("supervisor/endorse"),
        operation: "endorse",
        declassifyTo: undefined,
        endorseTo: "operator"
      })
      const [result, receipt] = yield* endorse(subject, endorsement, "operator", LabelReceiptId.make("receipt/6"), at)
      expect(result.label).toEqual(label("secret", "operator", ["capture:state"]))
      expect(receipt.transition).toBe("endorsement")

      const notRaise = yield* endorse(subject, new SupervisorCapability({
        ...endorsement,
        id: SupervisorCapabilityId.make("supervisor/endorse-untrusted"),
        endorseTo: "untrusted"
      }), "untrusted", LabelReceiptId.make("receipt/7"), at).pipe(Effect.flip)
      expect(notRaise).toMatchObject({ transition: "endorsement", reason: "not-a-raise" })
    })
  )
})
