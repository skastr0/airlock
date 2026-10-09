import { Result, Schema, SchemaAST } from "effect"

/** Closed transport shapes. Opaque schemas confer no operations to a program. */
export type SchemaModel =
  | { readonly kind: "string" | "number" | "boolean" | "never" }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "record"; readonly fields: Readonly<Record<string, { readonly type: SchemaModel; readonly optional: boolean }>> }
  | { readonly kind: "list"; readonly item: SchemaModel; readonly maxLength?: number }
  | { readonly kind: "union"; readonly members: ReadonlyArray<SchemaModel> }
  | { readonly kind: "nominal"; readonly identity: string; readonly base?: SchemaModel }

const validators = new WeakMap<object, Schema.Codec<unknown, unknown>>()

/** Read only the built-in length check; arbitrary annotations are not proof. */
const maximumLength = (checks: SchemaAST.Checks | undefined): number | undefined => {
  const bounds: Array<number> = []
  const inspect = (check: SchemaAST.Check<unknown>) => {
    if (check._tag === "FilterGroup") { check.checks.forEach(inspect); return }
    const representation = check.annotations?.representation
    if (representation?.id !== "effect/schema/isMaxLength") return
    const payload = representation.payload
    if (typeof payload === "object" && payload !== null && "maxLength" in payload &&
      typeof payload.maxLength === "number" && Number.isSafeInteger(payload.maxLength) && payload.maxLength >= 0) {
      bounds.push(payload.maxLength)
    }
  }
  checks?.forEach(inspect)
  return bounds.length === 0 ? undefined : Math.min(...bounds)
}

/**
 * Models encoded tool inputs and decoded boundary results separately. Every
 * custom check and encoded-side transform remains a nominal requirement.
 * Unsupported nodes become opaque, never `any` or invented records.
 */
export const modelSchema = (schema: Schema.Codec<unknown, unknown>, options: {
  readonly identity: string
  readonly side: "encoded" | "decoded"
}): SchemaModel => {
  const active = new Set<SchemaAST.AST>()
  const build = (original: SchemaAST.AST, identity: string, depth: number, ignoreRequirement = false): SchemaModel => {
    const codec = Schema.make<Schema.Codec<unknown, unknown>>(original)
    const selected = options.side === "encoded" ? Schema.toEncoded(codec) : Schema.toType(codec)
    const ast = selected.ast
    const register = (model: SchemaModel): SchemaModel => {
      Object.freeze(model)
      validators.set(model, options.side === "encoded" ? codec : Schema.toType(codec))
      return model
    }
    if (depth > 32 || active.has(original)) return register({ kind: "nominal", identity })
    if (!ignoreRequirement && ((original.checks?.length ?? 0) > 0 || (options.side === "encoded" && original.encoding !== undefined))) {
      const base = build(original, identity, depth, true)
      return register({ kind: "nominal", identity, base })
    }
    active.add(original)
    try {
      if (SchemaAST.isNever(ast)) return register({ kind: "never" })
      if (SchemaAST.isString(ast)) return register({ kind: "string" })
      if (SchemaAST.isNumber(ast)) return register({ kind: "number" })
      if (SchemaAST.isBoolean(ast)) return register({ kind: "boolean" })
      if (SchemaAST.isLiteral(ast) && (ast.literal === null || typeof ast.literal === "string" ||
        typeof ast.literal === "boolean" || (typeof ast.literal === "number" && Number.isFinite(ast.literal)))) {
        return register({ kind: "literal", value: ast.literal })
      }
      if (SchemaAST.isObjects(ast) && ast.indexSignatures.length === 0 && ast.propertySignatures.length > 0 &&
        ast.propertySignatures.every((field) => typeof field.name === "string")) {
        const fields: Record<string, { readonly type: SchemaModel; readonly optional: boolean }> = Object.create(null)
        for (const field of ast.propertySignatures) {
          const name = String(field.name)
          const source = SchemaAST.isObjects(original)
            ? original.propertySignatures.find((candidate) => candidate.name === field.name)?.type ?? field.type
            : field.type
          fields[name] = Object.freeze({
            type: build(source, `${identity}/${encodeURIComponent(name)}`, depth + 1),
            optional: SchemaAST.isOptional(field.type)
          })
        }
        return register({ kind: "record", fields: Object.freeze(fields) })
      }
      if (SchemaAST.isArrays(ast) && ast.elements.length === 0 && ast.rest.length === 1) {
        const maxLength = maximumLength(original.checks)
        const item = SchemaAST.isArrays(original) && original.rest.length === 1 ? original.rest[0]! : ast.rest[0]!
        return register({ kind: "list", item: build(item, `${identity}/[]`, depth + 1),
          ...(maxLength === undefined ? {} : { maxLength }) })
      }
      if (SchemaAST.isUnion(ast) && ast.options?.mode !== "oneOf") {
        return register({ kind: "union", members: Object.freeze(ast.types.map((member, index) =>
          build(SchemaAST.isUnion(original) ? original.types[index] ?? member : member, `${identity}/|${index}`, depth + 1)
        )) })
      }
      return register({ kind: "nominal", identity })
    } finally {
      active.delete(original)
    }
  }
  return build(schema.ast, options.identity, 0)
}

/** Literal admission uses the actual codec, including transformations/checks. */
export const acceptsLiteral = (model: SchemaModel, value: Schema.Json): boolean => {
  const schema = validators.get(model)
  if (schema === undefined) return false
  try {
    return Result.isSuccess(Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(value))
  } catch {
    return false
  }
}
