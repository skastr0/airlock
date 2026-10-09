import { Result, Schema, SchemaAST } from "effect"
import { InformationLabel } from "../labels/Labels.ts"
import { DecoderIdentity, type TrustedDecoder } from "./Decoder.ts"

/** Labels describe origins; sinks and refinements describe obligations, never permission. */
export const ToolFlow = Schema.Struct({
  sources: Schema.Record(Schema.String, InformationLabel),
  sinks: Schema.Array(Schema.String),
  requires: Schema.Record(Schema.String, Schema.NonEmptyArray(DecoderIdentity)),
  provides: Schema.Record(Schema.String, Schema.NonEmptyArray(DecoderIdentity))
})
export type ToolFlow = typeof ToolFlow.Type

type ResultField<Output> = "$" | (Output extends object ? keyof Output & string : never)

export interface ToolFlowFor<Wire, Output> {
  readonly sources?: { readonly [Field in ResultField<Output>]?: InformationLabel }
  readonly sinks?: ReadonlyArray<keyof Wire & string>
  readonly requires?: { readonly [Field in keyof Wire & string]?: ReadonlyArray<DecoderIdentity> }
  readonly provides?: { readonly [Field in ResultField<Output>]?: ReadonlyArray<DecoderIdentity> }
}

export interface FlowRejection {
  readonly field: string
  readonly reason: string
}

/** Requests disclose every argument; the author cannot hide one by omitting it. */
export const requestSinkFields = (schema: Schema.Top): ReadonlyArray<string> => {
  const fields = (ast: SchemaAST.AST): ReadonlyArray<string> => {
    if (SchemaAST.isObjects(ast)) return ast.propertySignatures.flatMap((field) => typeof field.name === "string" ? [field.name] : [])
    if (SchemaAST.isUnion(ast)) return [...new Set(ast.types.flatMap(fields))]
    return []
  }
  return fields(Schema.toEncoded(schema).ast)
}

const hasField = (schema: Schema.Top, field: string, side: "encoded" | "decoded"): boolean => {
  const ast = (side === "encoded" ? Schema.toEncoded(schema) : Schema.toType(schema)).ast
  const contains = (ast: SchemaAST.AST): boolean =>
    SchemaAST.isObjects(ast) ? ast.propertySignatures.some((property) => property.name === field) :
    SchemaAST.isUnion(ast) && ast.types.some(contains)
  return contains(ast)
}

/** Own declaration graphs so neither labels nor proof references can drift. */
export const ownToolFlow = (given: unknown): Result.Result<ToolFlow, FlowRejection> => {
  if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given))) {
    return Result.fail({ field: "flow", reason: "must be a flow declaration record" })
  }
  const decoded = Schema.decodeUnknownResult(ToolFlow, { onExcessProperty: "error" })({
    sources: {}, sinks: [], requires: {}, provides: {}, ...given
  })
  if (Result.isFailure(decoded)) return Result.fail({ field: "flow", reason: "must contain valid labels, sink fields and nonempty decoder references" })
  const sources: Record<string, InformationLabel> = Object.create(null)
  for (const [field, label] of Object.entries(decoded.success.sources)) {
    const copy = new InformationLabel({ ...label, provenance: [...label.provenance] })
    Object.freeze(copy.provenance)
    sources[field] = Object.freeze(copy)
  }
  const references = (map: ToolFlow["requires"]): ToolFlow["requires"] => {
    const owned: Record<string, ToolFlow["requires"][string]> = Object.create(null)
    for (const [field, refs] of Object.entries(map)) {
      const copy = refs.map((ref) => Object.freeze({ ...ref })) as [DecoderIdentity, ...Array<DecoderIdentity>]
      owned[field] = Object.freeze(copy)
    }
    return Object.freeze(owned)
  }
  return Result.succeed(Object.freeze({
    sources: Object.freeze(sources), sinks: Object.freeze([...decoded.success.sinks]),
    requires: references(decoded.success.requires), provides: references(decoded.success.provides)
  }))
}

export const validateToolFlow = (flow: ToolFlow, input: Schema.Top, output: Schema.Top): FlowRejection | undefined => {
  if (new Set(flow.sinks).size !== flow.sinks.length) return { field: "flow.sinks", reason: "must not repeat fields" }
  for (const field of [...flow.sinks, ...Object.keys(flow.requires)]) {
    if (!hasField(input, field, "encoded")) return { field: `flow.input.${field}`, reason: "must name an encoded input field" }
  }
  for (const field of [...Object.keys(flow.sources), ...Object.keys(flow.provides)]) {
    if (field !== "$" && !hasField(output, field, "decoded")) return { field: `flow.result.${field}`, reason: "must name a decoded result field or $ for the whole result" }
  }
  for (const [section, map] of [["requires", flow.requires], ["provides", flow.provides]] as const) {
    for (const [field, refs] of Object.entries(map)) {
      const identities = refs.map((ref) => JSON.stringify([ref.name, ref.version]))
      if (refs.some((ref) => ref.name.trim() === "" || ref.version.trim() === "") || new Set(identities).size !== identities.length) {
        return { field: `flow.${section}.${field}`, reason: "must name distinct non-blank decoder identities" }
      }
    }
  }
  return undefined
}

/** A same-name schema at another version cannot meet an obligation. */
export const validateFlowDecoders = (flow: ToolFlow, catalog: Readonly<Record<string, TrustedDecoder.Any>>): FlowRejection | undefined => {
  for (const [section, map] of [["requires", flow.requires], ["provides", flow.provides]] as const) {
    for (const [field, refs] of Object.entries(map)) {
      for (const ref of refs) {
        const decoder = Object.hasOwn(catalog, ref.name) ? catalog[ref.name] : undefined
        if (decoder === undefined || decoder.version !== ref.version) {
          return { field: `flow.${section}.${field}`, reason: `no trusted decoder ${ref.name} at version ${ref.version}` }
        }
      }
    }
  }
  return undefined
}
