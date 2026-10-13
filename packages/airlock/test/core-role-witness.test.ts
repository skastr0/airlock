import { describe, expect, it } from "vitest"
import { Result, Schema } from "effect"
import { addInfluence, attestValue, defineDecoder, deriveValue, hasRefinement, isTrackedValue, labeledValue } from "../src/contract/Decoder.ts"
import { createRoleWitnessIssuer, isRoleWitnessIssuer } from "../src/contract/RoleWitness.ts"
import { combine, InformationLabel } from "../src/labels/Labels.ts"

const neutral = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const payload = new InformationLabel({ confidentiality: "public", integrity: "operator", provenance: ["payload"] })
const control = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: ["selection"] })
const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

describe("core: authenticated origin role witnesses", () => {
  it("adds influence monotonically while preserving exact JSON and genuine refinement proofs", () => {
    const decoder = defineDecoder({ name: "negative-zero", version: "1", schema: Schema.Struct({ zero: Schema.Number.check(Schema.makeFilter((value) => Object.is(value, -0))) }) })
    const original = success(attestValue(labeledValue({ zero: -0 }, payload), decoder))
    const influenced = success(addInfluence(original, control))
    expect(influenced.value).toBe(original.value)
    expect(Object.is(influenced.value.zero, -0)).toBe(true)
    expect(Object.isFrozen(influenced.value)).toBe(true)
    expect(influenced.label).toEqual(combine(payload, control))
    expect(hasRefinement(influenced, decoder)).toBe(true)
    expect(isTrackedValue(influenced)).toBe(true)
    expect(success(addInfluence(influenced, neutral)).label).toEqual(influenced.label)
    expect(hasRefinement(deriveValue({ zero: -0 }, influenced), decoder)).toBe(false)
    expect(Result.isFailure(addInfluence({ ...original }, control))).toBe(true)
    expect(Result.isFailure(addInfluence(original, { ...control, confidentiality: "invented" } as never))).toBe(true)
  })

  it("binds immutable roles to the exact tracked wrapper and fresh execution issuer", () => {
    const issuer = createRoleWitnessIssuer("run")
    const value = success(addInfluence(labeledValue("public payload", payload), control))
    const roles = { data: payload, selection: control, control: neutral }
    const witness = success(issuer.issue(value, roles))
    const read = issuer.inspect(value, witness)!
    expect(read).toEqual(roles)
    expect(Object.isFrozen(read)).toBe(true)
    expect(Object.isFrozen(read.selection)).toBe(true)
    expect(Object.isFrozen(read.selection.provenance)).toBe(true)
    expect(issuer.inspect({ ...value }, witness)).toBeUndefined()
    expect(issuer.inspect(labeledValue(value.value, value.label), witness)).toBeUndefined()
    expect(issuer.inspect(value, { ...witness })).toBeUndefined()
    expect(issuer.inspect(value, Object.create(witness))).toBeUndefined()
    expect(issuer.inspect(value, JSON.parse(JSON.stringify(witness)))).toBeUndefined()
    expect(createRoleWitnessIssuer("run").inspect(value, witness)).toBeUndefined()
    expect(createRoleWitnessIssuer("later-run").inspect(value, witness)).toBeUndefined()
    expect(isRoleWitnessIssuer({ ...issuer })).toBe(false)
    expect(({ ...issuer }).inspect(value, witness)).toBeUndefined()
    expect(Result.isFailure(({ ...issuer }).issue(value, roles))).toBe(true)
  })

  it("rejects missing origins or lowered aggregate labels and owns mutable author labels", () => {
    const issuer = createRoleWitnessIssuer("owned-roles")
    const value = success(addInfluence(labeledValue(1, payload), control))
    expect(Result.isFailure(issuer.issue(value, { data: payload, selection: neutral, control: neutral }))).toBe(true)
    expect(Result.isFailure(issuer.issue(value, { data: neutral, selection: control, control: neutral }))).toBe(true)
    expect(Result.isFailure(issuer.issue(labeledValue(1, payload), { data: payload, selection: control, control: neutral }))).toBe(true)
    expect(Result.isFailure(issuer.issue({ ...value }, { data: payload, selection: control, control: neutral }))).toBe(true)
    const editable = new InformationLabel({ ...control, provenance: [...control.provenance] })
    const witness = success(issuer.issue(value, { data: payload, selection: editable, control: neutral }))
    ;(editable.provenance as string[]).push("invented")
    expect(issuer.inspect(value, witness)?.selection.provenance).toEqual(["selection"])
    expect(issuer.inspect(value, undefined)).toBeUndefined()
    for (const primitive of [null, "witness", 1, true]) expect(issuer.inspect(value, primitive)).toBeUndefined()
  })
})
