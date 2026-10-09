import { Result, Schema } from "effect"
import { canonicalJson } from "../Canonical.ts"
import type { Compensation, IntentKind } from "../outbox/Intent.ts"
import { InvalidIntent } from "../outbox/Records.ts"
import { PlanEffect } from "../plan/Plan.ts"
import { ResourceField, type ResourceFields, resourceFieldFits } from "./Resource.ts"

/**
 * What a tool call looks like to everything except its handler: which tool,
 * which fields were supplied, how large the input was, and the values of the
 * fields its contract declares public. No other value appears. The input's
 * digest is the record's `dispatchDigest`.
 */
export const ToolSummary = Schema.Struct({
  tool: Schema.String,
  version: Schema.String,
  /** What a supervisor grant is matched against. */
  target: Schema.String,
  /** What the contract claims the call does; the grant decides when it runs. */
  effect: PlanEffect,
  /** Names of the input fields supplied, sorted. */
  fields: Schema.Array(Schema.String),
  /** Size of the canonical encoded input in UTF-8 bytes. */
  inputBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Encoded values of the public fields that were supplied. */
  public: Schema.Record(Schema.String, Schema.Json)
})
export type ToolSummary = typeof ToolSummary.Type

type JsonRecord = { readonly [field: string]: Schema.Json }

/** Everything about one tool that its types depend on. */
export interface ToolShape {
  readonly name: string
  /** The decoded input a handler receives. */
  readonly input: unknown
  /** The JSON a caller supplies; the input schema decodes it. */
  readonly wire: JsonRecord
  readonly output: unknown
  /** Names of the public input fields. */
  readonly public: string
  readonly effect: PlanEffect
  readonly resources: Readonly<Record<string, ResourceField>>
  /** Name of the contract that answers a committed call; `never` when irreversible. */
  readonly answer: string
}

/**
 * One tool, as one intent kind: its handler is total over this tool alone and
 * its dispatch material is this tool's typed input.
 */
export interface ToolContract<Shape extends ToolShape>
  extends IntentKind<Shape["name"], Shape["input"], ToolSummary, Shape["output"], Shape["answer"]>
{
  readonly version: string
  readonly input: Schema.Codec<Shape["input"], Shape["wire"]>
  readonly effect: Shape["effect"]
  /** The only input fields whose values a summary, grant or receipt may see. */
  readonly publicFields: ReadonlyArray<Shape["public"]>
  readonly resources: Shape["resources"]
}

export declare namespace ToolContract {
  export type Any = ToolContract<any>
  export type ShapeOf<Contract> = Contract extends ToolContract<infer Shape> ? Shape : never
  export type PublicOf<Contract> = ShapeOf<Contract>["public"]
  export type WireOf<Contract> = ShapeOf<Contract>["wire"]
  export type OutputOf<Contract> = ShapeOf<Contract>["output"]
  export type EffectOf<Contract> = ShapeOf<Contract>["effect"]
  export type ResourcesOf<Contract> = ShapeOf<Contract>["resources"]
}

export class InvalidToolContract extends Schema.TaggedError<InvalidToolContract>()("InvalidToolContract", {
  tool: Schema.String,
  field: Schema.String,
  reason: Schema.String
}) {}

const encoder = new TextEncoder()

/**
 * Declares a tool contract. Redaction is the default, not an option: a field's
 * value is visible outside the handler only if `public` names it.
 *
 * `effect` is the author's description, not an authorization to execute.
 * A contract with no `compensate` has no declared answering act.
 *
 * Field names are those of the encoded input, which must be a JSON object.
 */
export const defineToolContract = <
  const Name extends string,
  Input,
  Wire extends JsonRecord,
  Output,
  const Declared extends PlanEffect,
  const Public extends keyof Wire & string = never,
  Answer extends IntentKind.Any = never,
  const Resources extends Readonly<Record<string, ResourceField>> = {}
>(spec: {
  readonly name: Name
  readonly version: string
  readonly input: Schema.Codec<Input, Wire>
  readonly output: Schema.Codec<Output, Schema.Json>
  readonly effect: Declared
  readonly public?: ReadonlyArray<Public>
  readonly resources?: Resources & ResourceFields<Wire, Public> & { readonly [Field in Exclude<keyof Resources, Public>]: never }
  /** Defaults to `tool:<name>`. Must not reveal a field that is not public. */
  readonly target?: (input: Input) => string
  /**
   * The contract that answers a committed call of this one, and how to build
   * its input from what was sent and what came back. Omit it and the tool is
   * irreversible: `Outbox.compensate` will not accept its emissions.
   */
  readonly compensate?: {
    readonly with: Answer
    readonly intent: (committed: {
      readonly dispatch: Input
      readonly outcome: Output
    }) => IntentKind.DispatchOf<Answer>
  }
}): ToolContract<{
  readonly name: Name
  readonly input: Input
  readonly wire: Wire
  readonly output: Output
  readonly public: Public
  readonly effect: Declared
  readonly resources: Resources
  readonly answer: Answer["tag"]
}> => {
  const answer: Compensation<Input, Output, Answer["tag"]> | undefined = spec.compensate === undefined
    ? undefined
    : { kind: spec.compensate.with.tag, with: spec.compensate.with, intent: spec.compensate.intent }
  const publicFields = Object.freeze([...(spec.public ?? [])])
  const declared = spec.resources ?? {}
  const decoded = Schema.decodeUnknownResult(Schema.Record(Schema.String, ResourceField), { onExcessProperty: "error" })(declared)
  const invalid = (field: string, reason: string) => new InvalidToolContract({ tool: spec.name, field, reason })
  if (Result.isFailure(decoded)) throw invalid("resources", "must contain valid resource descriptors")
  const resources: Record<string, ResourceField> = Object.create(null)
  for (const [field, descriptor] of Object.entries(decoded.success)) {
    if (!publicFields.includes(field as Public)) throw invalid(`resources.${field}`, "must name a public encoded input field")
    if (!resourceFieldFits(spec.input, field, descriptor)) {
      throw invalid(`resources.${field}`, "must match a string field or each element of a string list on the encoded input")
    }
    if (new Set(descriptor.rights).size !== descriptor.rights.length) throw invalid(`resources.${field}.rights`, "must not repeat rights")
    if (descriptor.kind === "executable" && descriptor.role === "descendant") {
      const parent = decoded.success[descriptor.parent]
      if (descriptor.parent === field || parent?.kind !== "executable" || parent.role !== "root" || parent.collection !== undefined) {
        throw invalid(`resources.${field}.parent`, "must name a scalar executable root field")
      }
    }
    resources[field] = Object.freeze({ ...descriptor, rights: Object.freeze([...descriptor.rights]) }) as ResourceField
  }
  const encodeInput = Schema.encodeResult(spec.input)
  return {
    tag: spec.name,
    version: spec.version,
    input: spec.input,
    effect: spec.effect,
    publicFields,
    resources: Object.freeze(resources) as Resources,
    dispatch: spec.input,
    summary: ToolSummary,
    outcome: spec.output,
    summarize: (input) => {
      const encoded = encodeInput(input)
      if (Result.isFailure(encoded)) {
        return Result.fail(
          new InvalidIntent({ kind: spec.name, field: "input", reason: "does not match the tool's input schema" })
        )
      }
      const supplied = encoded.success
      const visible: { [field: string]: Schema.Json } = Object.create(null)
      for (const field of publicFields) {
        const value = supplied[field]
        if (Object.hasOwn(supplied, field) && value !== undefined) visible[field] = value
      }
      return Result.succeed({
        tool: spec.name,
        version: spec.version,
        target: spec.target === undefined ? `tool:${spec.name}` : spec.target(input),
        effect: spec.effect,
        fields: Object.keys(supplied).sort(),
        inputBytes: encoder.encode(canonicalJson(supplied)).byteLength,
        public: visible
      })
    },
    target: (summary) => summary.target,
    ...(answer === undefined ? {} : { compensate: answer })
  }
}
