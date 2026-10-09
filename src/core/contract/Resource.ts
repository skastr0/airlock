import { Schema, SchemaAST } from "effect"

export const ResourceKind = Schema.Literals(["path", "executable", "endpoint"])
export type ResourceKind = typeof ResourceKind.Type

const collection = { collection: Schema.optionalKey(Schema.Literal("each")) }

/** Authority-bearing public input fields, not permissions issued by a contract. */
export const ResourceField = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("path"),
    rights: Schema.NonEmptyArray(Schema.Literals(["read", "write"])),
    ...collection
  }),
  Schema.Struct({
    kind: Schema.Literal("executable"),
    role: Schema.Literal("root"),
    rights: Schema.NonEmptyArray(Schema.Literal("invoke")),
    ...collection
  }),
  Schema.Struct({
    kind: Schema.Literal("executable"),
    role: Schema.Literal("descendant"),
    parent: Schema.String,
    rights: Schema.NonEmptyArray(Schema.Literal("execute")),
    ...collection
  }),
  Schema.Struct({
    kind: Schema.Literal("endpoint"),
    rights: Schema.NonEmptyArray(Schema.Literals(["connect", "emit"])),
    ...collection
  })
])
export type ResourceField = typeof ResourceField.Type

type FieldFor<Value, Public extends string> =
  Exclude<Value, undefined> extends string
    ? ScalarField<Public> & { readonly collection?: never }
    : Exclude<Value, undefined> extends ReadonlyArray<string>
      ? ScalarField<Public> & { readonly collection: "each" }
      : never

type ScalarField<Public extends string> =
  | Exclude<ResourceField, { readonly role: "descendant" }>
  | (Extract<ResourceField, { readonly role: "descendant" }> & { readonly parent: Public })

export type ResourceFields<Wire, Public extends keyof Wire & string> = {
  readonly [Field in Public]?: FieldFor<Wire[Field], Public>
}

const stringField = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isString(ast) ||
  (SchemaAST.isLiteral(ast) && typeof ast.literal === "string") ||
  (SchemaAST.isUnion(ast) && ast.types.length > 0 && ast.types.every(stringField))

/** Check descriptors arriving from JavaScript against the encoded field types. */
export const resourceFieldFits = (input: Schema.Top, name: string, descriptor: ResourceField): boolean => {
  return [Schema.toEncoded(input).ast, Schema.toType(input).ast].every((ast) => {
    if (!SchemaAST.isObjects(ast)) return false
    const field = ast.propertySignatures.find((field) => field.name === name)?.type
    if (field === undefined) return false
    if (descriptor.collection === undefined) return stringField(field)
    return SchemaAST.isArrays(field) &&
      [...field.elements, ...field.rest].every(stringField)
  })
}
