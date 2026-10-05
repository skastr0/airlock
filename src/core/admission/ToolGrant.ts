import { Effect, Schema } from "effect"
import { canonicalJson } from "../Canonical.ts"
import type { ToolContract, ToolSummary } from "../contract/ToolContract.ts"
import {
  CommitMode,
  DispatchClass,
  type DispatchDecision,
  stricterDispatchClass
} from "./DispatchPolicy.ts"

/** A condition on one public field of a tool's input. */
export const FieldMatch = Schema.Union([
  Schema.Struct({ equals: Schema.Json }),
  Schema.Struct({ oneOf: Schema.Array(Schema.Json) }),
  Schema.Struct({ startsWith: Schema.String }),
  Schema.Struct({ endsWith: Schema.String })
])
export type FieldMatch = typeof FieldMatch.Type

/**
 * One supervisor grant for one tool. `where` narrows it to calls whose public
 * fields match, for example a recipient that ends with `@example.com`. Only
 * public fields can be named, because only they are visible to a grant at all.
 * A grant that names neither `class` nor `commit` grants the floor: an
 * irreversible send that stays staged until a supervisor commits it.
 */
export class ToolGrantPolicy extends Schema.Class<ToolGrantPolicy>("ToolGrantPolicy")({
  tool: Schema.String,
  class: DispatchClass.pipe(
    Schema.withDecodingDefault(Effect.succeed("irreversible-send" as const)),
    Schema.withConstructorDefault(Effect.succeed("irreversible-send" as const))
  ),
  commit: CommitMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("supervisor" as const)),
    Schema.withConstructorDefault(Effect.succeed("supervisor" as const))
  ),
  where: Schema.Record(Schema.String, FieldMatch).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.withConstructorDefault(Effect.succeed({}))
  )
}) {}

/**
 * A grant written against a contract. `where` accepts only that contract's
 * public field names, so a grant on a private field does not typecheck.
 */
export const toolGrant = <Contract extends ToolContract.Any>(
  contract: Contract,
  grant: {
    readonly class?: DispatchClass
    readonly commit?: CommitMode
    readonly where?: { readonly [Field in ToolContract.PublicOf<Contract>]?: FieldMatch }
  } = {}
): ToolGrantPolicy & { readonly tool: Contract["tag"] } =>
  new ToolGrantPolicy({
    tool: contract.tag,
    ...(grant.class === undefined ? {} : { class: grant.class }),
    ...(grant.commit === undefined ? {} : { commit: grant.commit }),
    ...(grant.where === undefined ? {} : { where: grant.where as { readonly [field: string]: FieldMatch } })
  })

export type ToolGrantRejection = Readonly<{ readonly field: string; readonly reason: string }>

/**
 * Checks grants that arrived as data against the contracts they name. A grant
 * for an unknown tool, on a field its contract does not declare public, or
 * auto-committing anything but a read, is rejected before it can match a call.
 */
export const validateToolGrants = (
  grants: ReadonlyArray<ToolGrantPolicy>,
  contracts: { readonly [name: string]: ToolContract.Any }
): ToolGrantRejection | undefined => {
  for (const [index, grant] of grants.entries()) {
    const at = `policy.toolGrants[${index}]`
    const contract = Object.hasOwn(contracts, grant.tool) ? contracts[grant.tool] : undefined
    if (contract === undefined) {
      return { field: `${at}.tool`, reason: `no contract is registered for tool ${grant.tool}` }
    }
    for (const field of Object.keys(grant.where)) {
      if (!contract.publicFields.includes(field)) {
        return {
          field: `${at}.where.${field}`,
          reason: `${field} is not a public field of ${grant.tool}; a grant can only constrain public fields`
        }
      }
    }
    if (grant.commit === "auto" && grant.class !== "read") {
      return { field: `${at}.commit`, reason: "auto-commit is only legal on class read" }
    }
  }
  return undefined
}

const matches = (match: FieldMatch, value: Schema.Json | undefined): boolean => {
  if (value === undefined) return false
  if ("equals" in match) return canonicalJson(match.equals) === canonicalJson(value)
  if ("oneOf" in match) return match.oneOf.some((allowed) => canonicalJson(allowed) === canonicalJson(value))
  if (typeof value !== "string") return false
  return "startsWith" in match ? value.startsWith(match.startsWith) : value.endsWith(match.endsWith)
}

/** The grants whose tool and every field condition fit this call. */
export const fittingToolGrants = (
  grants: ReadonlyArray<ToolGrantPolicy>,
  call: ToolSummary
): ReadonlyArray<ToolGrantPolicy> =>
  grants.filter((grant) =>
    grant.tool === call.tool &&
    Object.entries(grant.where).every(([field, match]) =>
      matches(match, Object.hasOwn(call.public, field) ? call.public[field] : undefined)
    )
  )

const awaitSupervisor = (reason: string): DispatchDecision => ({ _tag: "AwaitSupervisor", reason })

/**
 * Whether a staged tool call may be committed without a supervisor. It never
 * dispatches. Auto-commit needs every fitting grant to pre-authorize a read,
 * and the contract itself to describe the tool as a read: a contract that
 * claims nothing is an irreversible send and always waits.
 */
export const toolDispatchDecision = (
  grants: ReadonlyArray<ToolGrantPolicy>,
  contracts: { readonly [name: string]: ToolContract.Any },
  call: ToolSummary
): DispatchDecision => {
  if (validateToolGrants(grants, contracts) !== undefined) {
    return awaitSupervisor("policy tool grants are invalid")
  }
  const fitting = fittingToolGrants(grants, call)
  if (fitting.length === 0) return awaitSupervisor("no tool grant fits this call")
  if (!fitting.every((grant) => grant.commit === "auto" && grant.class === "read")) {
    return awaitSupervisor("a fitting grant does not pre-authorize commit")
  }
  const effectiveClass = stricterDispatchClass("read", call.emissionEffect ?? "irreversible-send")
  if (effectiveClass !== "read") {
    return awaitSupervisor(
      `effective class ${effectiveClass} is narrower than read; this call awaits a supervisor commit`
    )
  }
  return { _tag: "AutoCommit", selector: call.tool, effectiveClass }
}
