import { Result, Schema } from "effect"
import { combine, InformationLabel } from "../labels/Labels.ts"
import { isTrackedValue, type TrackedValue } from "./Decoder.ts"

/** Origins have separate roles even when their aggregate label is identical. */
export const RoleLabels = Schema.Struct({ data: InformationLabel, selection: InformationLabel, control: InformationLabel })
export type RoleLabels = typeof RoleLabels.Type

const WitnessTypeId: unique symbol = Symbol("airlock/RoleWitness")
const IssuerTypeId: unique symbol = Symbol("airlock/RoleWitnessIssuer")
export interface RoleWitness { readonly [WitnessTypeId]: true }

export class InvalidRoleWitness extends Schema.TaggedError<InvalidRoleWitness>()("InvalidRoleWitness", {
  reason: Schema.Literals(["issuer", "value", "roles", "aggregate"])
}) {}

/** Trusted evaluator authority for one execution, never handed to a program. */
export interface RoleWitnessIssuer {
  readonly [IssuerTypeId]: true
  readonly runId: string
  readonly issue: (this: RoleWitnessIssuer, value: TrackedValue, roles: RoleLabels) => Result.Result<RoleWitness, InvalidRoleWitness>
  readonly inspect: (this: RoleWitnessIssuer, value: TrackedValue, witness: unknown) => RoleLabels | undefined
}

const issuers = new WeakSet<object>()
const witnesses = new WeakMap<object, { readonly issuer: RoleWitnessIssuer; readonly value: TrackedValue; readonly roles: RoleLabels }>()
export const isRoleWitnessIssuer = (issuer: unknown): issuer is RoleWitnessIssuer =>
  typeof issuer === "object" && issuer !== null && issuers.has(issuer)

const sameLabel = (left: InformationLabel, right: InformationLabel): boolean =>
  left.confidentiality === right.confidentiality && left.integrity === right.integrity &&
  JSON.stringify([...new Set(left.provenance)].sort()) === JSON.stringify([...new Set(right.provenance)].sort())

const ownLabel = (label: InformationLabel): InformationLabel => {
  const owned = new InformationLabel({ ...label, provenance: [...label.provenance] })
  Object.freeze(owned.provenance)
  return Object.freeze(owned)
}

/** New issuer identity on every execution, including a repeated run id. */
export const createRoleWitnessIssuer = (runId: string): RoleWitnessIssuer => {
  if (typeof runId !== "string" || runId.trim() === "") throw new InvalidRoleWitness({ reason: "issuer" })
  const issuer: RoleWitnessIssuer = Object.freeze({
    [IssuerTypeId]: true as const,
    runId,
    issue(this: RoleWitnessIssuer, value: TrackedValue, given: RoleLabels): Result.Result<RoleWitness, InvalidRoleWitness> {
      const reject = (reason: InvalidRoleWitness["reason"]) => Result.fail(new InvalidRoleWitness({ reason }))
      if (this !== issuer || !issuers.has(this)) return reject("issuer")
      if (!isTrackedValue(value)) return reject("value")
      const decoded = Schema.decodeUnknownResult(RoleLabels, { onExcessProperty: "error" })(given)
      if (Result.isFailure(decoded)) return reject("roles")
      const roles: RoleLabels = Object.freeze({ data: ownLabel(decoded.success.data), selection: ownLabel(decoded.success.selection), control: ownLabel(decoded.success.control) })
      if (!sameLabel(combine(roles.data, roles.selection, roles.control), value.label)) return reject("aggregate")
      const witness: RoleWitness = Object.freeze({ [WitnessTypeId]: true as const })
      witnesses.set(witness, { issuer, value, roles })
      return Result.succeed(witness)
    },
    inspect(this: RoleWitnessIssuer, value: TrackedValue, witness: unknown): RoleLabels | undefined {
      if (this !== issuer || !issuers.has(this) || !isTrackedValue(value) || typeof witness !== "object" || witness === null) return undefined
      const issued = witnesses.get(witness)
      return issued?.issuer === issuer && issued.value === value ? issued.roles : undefined
    }
  })
  issuers.add(issuer)
  return issuer
}
