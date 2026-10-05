import { Result, Schema } from "effect"
import { canonicalJson } from "../Canonical.ts"
import type { Compensation, IntentKind } from "../outbox/Intent.ts"
import { InvalidIntent } from "../outbox/Records.ts"

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
  /** The author's claim about the far side; absent means it may be irreversible. */
  emissionEffect: Schema.optionalKey(Schema.Literals(["read", "mutate"])),
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
  /** What the author says the tool does; `undefined` claims nothing. */
  readonly effect: "read" | "mutate" | undefined
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
  readonly emissionEffect: Shape["effect"]
  /** The only input fields whose values a summary, grant or receipt may see. */
  readonly publicFields: ReadonlyArray<Shape["public"]>
}

export declare namespace ToolContract {
  export type Any = ToolContract<any>
  export type ShapeOf<Contract> = Contract extends ToolContract<infer Shape> ? Shape : never
  export type PublicOf<Contract> = ShapeOf<Contract>["public"]
  export type WireOf<Contract> = ShapeOf<Contract>["wire"]
  export type OutputOf<Contract> = ShapeOf<Contract>["output"]
  export type EffectOf<Contract> = ShapeOf<Contract>["effect"]
}

const encoder = new TextEncoder()

/**
 * Declares a tool contract. Redaction is the default, not an option: a field's
 * value is visible outside the handler only if `public` names it.
 *
 * `emissionEffect` is the author's description and can only narrow what a
 * supervisor grants; omitting it claims nothing, so the tool is treated as an
 * irreversible send. A contract with no `compensate` has no answer either.
 *
 * Field names are those of the encoded input, which must be a JSON object.
 */
export const defineToolContract = <
  const Name extends string,
  Input,
  Wire extends JsonRecord,
  Output,
  const Public extends keyof Input & string = never,
  Answer extends IntentKind.Any = never,
  const Declared extends "read" | "mutate" | undefined = undefined
>(spec: {
  readonly name: Name
  readonly version: string
  readonly input: Schema.Codec<Input, Wire>
  readonly output: Schema.Codec<Output, Schema.Json>
  readonly emissionEffect?: Declared
  readonly public?: ReadonlyArray<Public>
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
  readonly answer: Answer["tag"]
}> => {
  const answer: Compensation<Input, Output, Answer["tag"]> | undefined = spec.compensate === undefined
    ? undefined
    : { kind: spec.compensate.with.tag, with: spec.compensate.with, intent: spec.compensate.intent }
  const publicFields = spec.public ?? []
  const encodeInput = Schema.encodeResult(spec.input)
  return {
    tag: spec.name,
    version: spec.version,
    input: spec.input,
    // An omitted effect is `undefined`, which is what `Declared` defaults to.
    emissionEffect: spec.emissionEffect as Declared,
    publicFields,
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
      const visible: { [field: string]: Schema.Json } = {}
      for (const field of publicFields) {
        const value = supplied[field]
        if (Object.hasOwn(supplied, field) && value !== undefined) visible[field] = value
      }
      return Result.succeed({
        tool: spec.name,
        version: spec.version,
        target: spec.target === undefined ? `tool:${spec.name}` : spec.target(input),
        ...(spec.emissionEffect === undefined ? {} : { emissionEffect: spec.emissionEffect }),
        fields: Object.keys(supplied).sort(),
        inputBytes: encoder.encode(canonicalJson(supplied)).byteLength,
        public: visible
      })
    },
    target: (summary) => summary.target,
    ...(answer === undefined ? {} : { compensate: answer })
  }
}
