import { Effect, Result, Schema } from "effect"
import type { ToolContract } from "../contract/ToolContract.ts"
import { HeldReference } from "../contract/ToolHost.ts"
import { decodeValue, labeledValue, type TrustedDecoder } from "../contract/Decoder.ts"
import { InformationLabel } from "../labels/Labels.ts"
import { acceptsLiteral, encodeModelValue, hasSameCodec, hasSameSchema, modelSchema, type SchemaModel } from "../contract/SchemaModel.ts"
import type { ToolFlow } from "../contract/Flow.ts"
import { validateFlowDecoders } from "../contract/Flow.ts"
import { validateBindings } from "./bindings.ts"
import type { Expression, Program, Span, Statement } from "./ast.ts"
import { DurationSchema, SpanSchema } from "./ast.ts"
import { parse } from "./parser.ts"

/** Types a parsed program against the granted contracts and bounds every call it can make. */
export class CheckError extends Schema.TaggedError<CheckError>()("CheckError", { detail: Schema.String, span: SpanSchema }) {}
export interface CheckedTool {
  readonly contract: ToolContract.Any
}
export interface CheckEnvironment {
  readonly tools: Readonly<Record<string, CheckedTool>>
  readonly decoders: Readonly<Record<string, TrustedDecoder.Any>>
  readonly granted: ReadonlySet<string>
  readonly maxListItems: number
  readonly maxCalls: number
  readonly maxIterations: number
  readonly bindings?: Readonly<Record<string, { readonly schema: Schema.Codec<unknown, Schema.Json>; readonly value: Schema.Json; readonly label: InformationLabel }>>
}
type Kind = "string" | "number" | "boolean" | "null" | "duration" | "never"
export type Type =
  | { readonly kind: Kind }
  | { readonly kind: "record"; readonly fields: ReadonlyMap<string, Fact>; readonly optional?: ReadonlySet<string>; readonly rawFields?: ReadonlyMap<string, Fact>; readonly omitNull?: ReadonlySet<string> }
  | { readonly kind: "list"; readonly item: Fact; readonly bound: number; readonly selectionOrigins?: readonly string[] }
  | { readonly kind: "union"; readonly cases: ReadonlyMap<string, Fact> }
  | { readonly kind: "schema"; readonly name: string }
  | { readonly kind: "nullable"; readonly value: Fact }
  | { readonly kind: "choices"; readonly members: readonly Fact[] }
  | { readonly kind: "opaque"; readonly identity: string }
export interface Fact {
  readonly type: Type
  readonly dataOrigins: readonly string[]
  readonly controlOrigins: readonly string[]
  /** Aggregate for diagnostics and PC computation; never policy authority. */
  readonly origins: readonly string[]
  readonly refinements: readonly string[]
  readonly constant?: Schema.Json
  readonly schemaProofs?: readonly SchemaModel[]
}
export interface CallFact {
  readonly tool: string
  readonly span: Span
  readonly arguments: Fact
  readonly control: readonly string[]
  readonly maximumOccurrences: number
}
export interface CheckedProgram {
  readonly program: Program
  readonly environment: CheckEnvironment
  readonly tools: readonly string[]
  readonly maximumCalls: Readonly<Record<string, number>>
  readonly calls: readonly CallFact[]
  readonly iterations: number
  readonly expressionFacts: ReadonlyMap<Expression, Fact>
}
type Counts = Record<string, number>
type Scope = ReadonlyMap<string, Fact>
const unique = (...sets: readonly (readonly string[])[]) => [...new Set(sets.flat())]
const fact = (type: Type, dataOrigins: readonly string[] = [], refinements: readonly string[] = [], constant?: Schema.Json, controlOrigins: readonly string[] = []): Fact => ({ type, dataOrigins, controlOrigins, origins: unique(dataOrigins, controlOrigins), refinements, ...(constant === undefined ? {} : { constant }) })
const roles = (value: Fact, dataOrigins: readonly string[], controlOrigins: readonly string[]): Fact => ({ ...value, dataOrigins, controlOrigins, origins: unique(dataOrigins, controlOrigins) })
const derivedFact = (value: Fact, parents: readonly Fact[]): Fact => roles(value, unique(...parents.map((parent) => parent.dataOrigins)), unique(...parents.map((parent) => parent.controlOrigins)))
const scalar = (kind: Kind) => fact({ kind })
const record = (fields: ReadonlyMap<string, Fact>, dataOrigins: readonly string[] = []) => fact({ kind: "record", fields }, unique(dataOrigins, ...[...fields.values()].map((child) => child.dataOrigins)), [], undefined, unique(...[...fields.values()].map((child) => child.controlOrigins)))
const union = (cases: ReadonlyMap<string, Fact>, dataOrigins: readonly string[] = []) => fact({ kind: "union", cases }, unique(dataOrigins, ...[...cases.values()].map((child) => child.dataOrigins)), [], undefined, unique(...[...cases.values()].map((child) => child.controlOrigins)))
const nullable = (value: Fact): Fact => value.type.kind === "nullable" || value.type.kind === "null" ? value : fact({ kind: "nullable", value }, value.dataOrigins, [], undefined, value.controlOrigins)
/** Influence follows selected values through every later projection. */
const influencedFact = (value: Fact, dependencies: readonly string[], dataDependencies: readonly string[] = []): Fact => {
  const map = (fields: ReadonlyMap<string, Fact>) => new Map([...fields].map(([key, child]) => [key, influencedFact(child, dependencies, dataDependencies)]))
  const type = value.type
  return { ...roles(value, unique(value.dataOrigins, dataDependencies), unique(value.controlOrigins, dependencies)), type: type.kind === "record" ? { ...type, fields: map(type.fields), ...(type.rawFields === undefined ? {} : { rawFields: map(type.rawFields) }) } : type.kind === "list" ? { ...type, item: influencedFact(type.item, dependencies, dataDependencies), selectionOrigins: unique(type.selectionOrigins ?? value.origins, dependencies, dataDependencies) } : type.kind === "nullable" ? { ...type, value: influencedFact(type.value, dependencies, dataDependencies) } : type.kind === "choices" ? { ...type, members: type.members.map((member) => influencedFact(member, dependencies, dataDependencies)) } : type.kind === "union" ? { ...type, cases: map(type.cases) } : type }
}
export const staticPath = (expr: Expression): string | undefined => expr.kind === "IdentifierExpression" ? expr.name : expr.kind === "FieldExpression" ? (() => { const path = staticPath(expr.object); return path === undefined ? undefined : `${path}.${expr.field}` })() : undefined
const add = (left: Counts, right: Counts): Counts => Object.fromEntries(unique(Object.keys(left), Object.keys(right)).map((key) => [key, (left[key] ?? 0) + (right[key] ?? 0)]))
const maximum = (left: Counts, right: Counts): Counts => Object.fromEntries(unique(Object.keys(left), Object.keys(right)).map((key) => [key, Math.max(left[key] ?? 0, right[key] ?? 0)]))
const scale = (counts: Counts, count: number): Counts => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * count]))
const durationModel = modelSchema(DurationSchema, { identity: "language.Duration", side: "decoded" })
const wayBackModel = modelSchema(HeldReference, { identity: "receipt.wayBack", side: "encoded" })

export const checkSource = (source: string, environment: CheckEnvironment): Effect.Effect<CheckedProgram, CheckError | import("./bindings.ts").DuplicateBinding | import("./lexer.ts").LanguageDiagnostic> => Effect.gen(function* () {
  const parsed = yield* parse(source)
  yield* validateBindings(parsed, ["schema", ...Object.keys(environment.bindings ?? {})])
  return yield* Effect.try({ try: () => check(parsed, environment), catch: (error) => error instanceof CheckError ? error : new CheckError({ detail: "unsupported contract or program", span: parsed.span }) })
})

const check = (program: Program, environment: CheckEnvironment): CheckedProgram => {
  const fail: (detail: string, span?: Span) => never = (detail, span = program.span) => { throw new CheckError({ detail, span }) }
  for (const limit of [environment.maxCalls, environment.maxIterations, environment.maxListItems]) if (!Number.isSafeInteger(limit) || limit < 0) fail("invalid review limit")
  const calls: CallFact[] = [], tools = new Set<string>()
  const expressionFacts = new Map<Expression, Fact>()
  let occurrences = 1
  let fuel = 20_000
  const consume = (span: Span) => { if (--fuel < 0) fail("review complexity limit", span) }
  // Unsupported schemas fail closed. The production contract lane owns the
  // eventual closed representation; the checker never invents an any type.
  const fromModel = (model: SchemaModel, origin: string, input = false): Fact => {
    const origins = origin === "" ? [] : [origin]
    if (hasSameSchema(model, durationModel)) return { ...fact({ kind: "duration" }, origins), schemaProofs: [model] }
    if (model.kind === "string" || model.kind === "number" || model.kind === "boolean" || model.kind === "never") return fact({ kind: model.kind }, origins)
    if (model.kind === "literal") {
      // Effect zero literals accept and preserve either sign; the language's
      // equality and exact-value refinements distinguish them.
      if (typeof model.value === "number" && model.value === 0) return fact({ kind: "choices", members: [fact({ kind: "number" }, origins, [], 0), fact({ kind: "number" }, origins, [], -0)] }, origins)
      return fact({ kind: model.value === null ? "null" : primitiveKind(model.value) }, origins, [], model.value)
    }
    if (model.kind === "nominal") {
      if (model.base === undefined) return { ...fact({ kind: "opaque", identity: model.identity }, origins, [model.identity]), schemaProofs: [model] }
      const base = fromModel(model.base, origin, input)
      return { ...base, refinements: unique(base.refinements, [model.identity]), schemaProofs: [...(base.schemaProofs ?? []), model] }
    }
    if (model.kind === "record") {
      const fields = new Map<string, Fact>()
      const optional = new Set<string>()
      const rawFields = new Map<string, Fact>(), omitNull = new Set<string>()
      for (const [name, field] of Object.entries(model.fields)) {
        const value = fromModel(field.type, origin === "" ? "" : `${origin}.${name}`, input)
        if (field.optional) optional.add(name)
        rawFields.set(name, value)
        if (field.optional && !acceptsLiteral(field.type, null)) omitNull.add(name)
        fields.set(name, field.optional && !input ? nullable(value) : value)
      }
      return fact({ kind: "record", fields, optional, omitNull, ...(!input ? { rawFields } : {}) }, unique(origins, ...[...fields.values()].map((child) => child.origins)))
    }
    if (model.kind === "list") { const item = fromModel(model.item, origin === "" ? "" : `${origin}[]`, input); return fact({ kind: "list", item, bound: Math.min(model.maxLength ?? environment.maxListItems, environment.maxListItems), selectionOrigins: origins }, unique(origins, item.origins)) }
    if (model.kind === "union") {
      const members = model.members.map((member) => fromModel(member, origin, input))
      const nonnull = members.filter((member) => member.type.kind !== "null")
      if (nonnull.length !== members.length && nonnull.length > 0) return nullable(nonnull.length === 1 ? nonnull[0]! : derivedFact(fact({ kind: "choices", members: nonnull }), nonnull))
      return members.length === 1 ? members[0]! : derivedFact(fact({ kind: "choices", members }), members)
    }
    return fail(`unsupported schema ${model.kind}`)
  }
  const compatible = (value: Fact, expected: Fact, span: Span) => {
    if (value.type.kind === "never") return
    if (value.type.kind === "opaque" && (value.schemaProofs ?? []).some((actual) => (expected.schemaProofs ?? []).some((required) => hasSameCodec(actual, required)))) return
    if (expected.refinements.some((proof) => {
      if (value.refinements.includes(proof)) return false
      const requirement = expected.schemaProofs?.find((model) => model.kind === "nominal" && model.identity === proof)
      return requirement === undefined || !(value.schemaProofs ?? []).some((model) => hasSameSchema(model, requirement))
    })) fail("missing schema refinement", span)
    if (value.type.kind === "choices") { for (const member of value.type.members) compatible(member, expected, span); return }
    if (expected.type.kind === "choices") {
      if (!expected.type.members.some((member) => { try { compatible(value, member, span); return true } catch (error) { if (error instanceof CheckError) return false; throw error } })) fail("union type mismatch", span)
      return
    }
    if (expected.type.kind === "nullable") { if (value.type.kind === "null") return; compatible(value.type.kind === "nullable" ? value.type.value : value, expected.type.value, span); return }
    if (value.type.kind !== expected.type.kind) fail(`expected ${expected.type.kind}, received ${value.type.kind}`, span)
    if (expected.constant !== undefined && value.constant !== expected.constant) fail("literal type mismatch", span)
    if (expected.refinements.some((proof) => {
      if (value.refinements.includes(proof)) return false
      const requirement = expected.schemaProofs?.find((model) => model.kind === "nominal" && model.identity === proof)
      return requirement === undefined || !(value.schemaProofs ?? []).some((model) => hasSameSchema(model, requirement))
    })) fail("missing schema refinement", span)
    if (expected.type.kind === "opaque" && value.type.kind === "opaque" && expected.type.identity !== value.type.identity && !(value.schemaProofs ?? []).some((actual) => (expected.schemaProofs ?? []).some((required) => hasSameSchema(actual, required)))) fail("opaque schema identity mismatch", span)
    if (expected.type.kind === "record" && value.type.kind === "record") {
      for (const key of value.type.fields.keys()) if (!expected.type.fields.has(key)) fail("record fields must match exactly", span)
      for (const [key, field] of expected.type.fields) {
        const actual = (value.type.rawFields ?? value.type.fields).get(key)
        if (actual === undefined) { if (expected.type.optional?.has(key)) continue; fail(`missing field ${key}`, span) }
        if (value.type.optional?.has(key) && !expected.type.optional?.has(key)) fail(`possibly omitted field ${key}`, span)
        if (value.type.rawFields === undefined && expected.type.omitNull?.has(key)) {
          if (actual.type.kind === "null") continue
          compatible(actual.type.kind === "nullable" ? actual.type.value : actual, field, span)
        } else compatible(actual, field, span)
      }
    }
    if (expected.type.kind === "list" && value.type.kind === "list") compatible(value.type.item, expected.type.item, span)
  }
  const merge = (left: Fact, right: Fact, span: Span): Fact => {
    if (left.type.kind === "never") return right
    if (right.type.kind === "never") return left
    const value = join(left, right, span)
    const schemaProofs = (left.schemaProofs ?? []).filter((model) => (right.schemaProofs ?? []).some((other) => hasSameSchema(model, other)))
    return { ...derivedFact(value, [left, right]), schemaProofs }
  }
  const join = (left: Fact, right: Fact, span: Span): Fact => {
    if (left.type.kind === "never") return right
    if (right.type.kind === "never") return left
    if (left.type.kind === "null") return { ...nullable(right), origins: unique(left.origins, right.origins) }
    if (right.type.kind === "null") return { ...nullable(left), origins: unique(left.origins, right.origins) }
    if (left.type.kind === "nullable" || right.type.kind === "nullable") return nullable(merge(left.type.kind === "nullable" ? left.type.value : left, right.type.kind === "nullable" ? right.type.value : right, span))
    if (left.type.kind !== right.type.kind) return fact({ kind: "choices", members: [...(left.type.kind === "choices" ? left.type.members : [left]), ...(right.type.kind === "choices" ? right.type.members : [right])] }, unique(left.origins, right.origins), left.refinements.filter((proof) => right.refinements.includes(proof)))
    if (left.type.kind === "choices" && right.type.kind === "choices") return fact({ kind: "choices", members: [...left.type.members, ...right.type.members] }, unique(left.origins, right.origins), left.refinements.filter((proof) => right.refinements.includes(proof)))
    if (left.type.kind === "record" && right.type.kind === "record") {
      const rightFields = right.type.fields
      if (left.type.fields.size !== rightFields.size || [...left.type.fields.keys()].some((key) => !rightFields.has(key))) return fact({ kind: "choices", members: [left, right] }, unique(left.origins, right.origins))
      const fields = new Map<string, Fact>()
      for (const [key, value] of left.type.fields) { const other = right.type.fields.get(key); if (other === undefined) fail("list record field mismatch", span); fields.set(key, merge(value, other, span)) }
      const rawFields = new Map<string, Fact>()
      for (const [key, value] of left.type.rawFields ?? left.type.fields) rawFields.set(key, merge(value, (right.type.rawFields ?? rightFields).get(key)!, span))
      return fact({ kind: "record", fields, optional: new Set(unique([...(left.type.optional ?? [])], [...(right.type.optional ?? [])])), ...((left.type.rawFields !== undefined || right.type.rawFields !== undefined) ? { rawFields } : {}) }, unique(left.origins, right.origins), left.refinements.filter((proof) => right.refinements.includes(proof)))
    }
    if (left.type.kind === "list" && right.type.kind === "list") return fact({ kind: "list", item: merge(left.type.item, right.type.item, span), bound: Math.max(left.type.bound, right.type.bound), selectionOrigins: unique(left.type.selectionOrigins ?? left.origins, right.type.selectionOrigins ?? right.origins) }, unique(left.origins, right.origins))
    if (left.type.kind === "union" && right.type.kind === "union") {
      const cases = new Map<string, Fact>()
      for (const key of unique([...left.type.cases.keys()], [...right.type.cases.keys()])) {
        const a = left.type.cases.get(key), b = right.type.cases.get(key)
        cases.set(key, a === undefined ? b! : b === undefined ? a : merge(a, b, span))
      }
      return union(cases, unique(left.origins, right.origins))
    }
    if (left.constant !== undefined && right.constant !== undefined && !Object.is(left.constant, right.constant)) return fact({ kind: "choices", members: [left, right] }, unique(left.origins, right.origins), left.refinements.filter((proof) => right.refinements.includes(proof)))
    return fact(left.type, unique(left.origins, right.origins), left.refinements.filter((proof) => right.refinements.includes(proof)), left.constant === right.constant ? left.constant : undefined)
  }
  const allKind = (value: Fact, kind: Kind): boolean => value.type.kind === "never" || value.type.kind === kind || (value.type.kind === "choices" && value.type.members.every((member) => allKind(member, kind)))
  const hasOpaque = (value: Fact): boolean => value.type.kind === "opaque" || (value.type.kind === "record" && [...value.type.fields.values()].some(hasOpaque)) || (value.type.kind === "list" && hasOpaque(value.type.item)) || (value.type.kind === "nullable" && hasOpaque(value.type.value)) || (value.type.kind === "choices" && value.type.members.some(hasOpaque))
  const equality = (left: Fact, right: Fact, span: Span): void => {
    if (!hasOpaque(left) && !hasOpaque(right)) return
    if (left.type.kind === "opaque" && right.type.kind === "opaque" && (left.schemaProofs ?? []).some((a) => (right.schemaProofs ?? []).some((b) => hasSameCodec(a, b)))) return
    if (left.type.kind === "record" && right.type.kind === "record") {
      const rightFields = right.type.fields
      if (left.type.fields.size !== rightFields.size) fail("opaque equality requires matching shapes", span)
      for (const [key, value] of left.type.fields) { const other = rightFields.get(key); if (other === undefined) fail("opaque equality requires matching shapes", span); equality(value, other, span) }
      return
    }
    if (left.type.kind === "list" && right.type.kind === "list") { equality(left.type.item, right.type.item, span); return }
    if (left.type.kind === "nullable" && right.type.kind === "null" || right.type.kind === "nullable" && left.type.kind === "null") return
    if (left.type.kind === "nullable" || right.type.kind === "nullable") { equality(left.type.kind === "nullable" ? left.type.value : left, right.type.kind === "nullable" ? right.type.value : right, span); return }
    fail("opaque equality requires the same codec identity", span)
  }
  const narrow = (test: Expression, scope: Scope, truth: boolean): Scope => {
    if (test.kind === "UnaryExpression" && test.operator === "!") return narrow(test.operand, scope, !truth)
    if (test.kind === "BinaryExpression" && ((test.operator === "&&" && truth) || (test.operator === "||" && !truth))) return narrow(test.right, narrow(test.left, scope, truth), truth)
    if (test.kind !== "BinaryExpression" || !["==", "!="].includes(test.operator)) return scope
    const reversed = test.left.kind === "LiteralExpression" && staticPath(test.right) !== undefined
    const selector = reversed ? test.right : test.left, tag = reversed ? test.left : test.right
    const selectedPath = staticPath(selector)
    if (selectedPath !== undefined && tag.kind === "LiteralExpression" && tag.value === null) {
      const parts = selectedPath.split("."), root = scope.get(parts[0]!)
      const equal = test.operator === "==" ? truth : !truth
      const refine = (current: Fact, depth: number): Fact => {
        if (depth === parts.length) return equal ? derivedFact(fact({ kind: "null" }, [], [], null), [current]) : current.type.kind === "nullable" ? current.type.value : current
        if (current.type.kind !== "record") return current
        const child = current.type.fields.get(parts[depth]!)
        if (child === undefined) return current
        const fields = new Map(current.type.fields); fields.set(parts[depth]!, refine(child, depth + 1))
        return { ...current, type: { kind: "record", fields } }
      }
      if (root === undefined) return scope
      const next = new Map(scope); next.set(parts[0]!, refine(root, 1)); return next
    }
    if (selectedPath !== undefined && tag.kind === "LiteralExpression" && (typeof tag.value !== "object" || tag.value === null)) {
      const parts = selectedPath.split("."), root = scope.get(parts[0]!)
      const equal = test.operator === "==" ? truth : !truth
      const refine = (current: Fact, depth: number): Fact => {
        if (current.type.kind === "choices") {
          const possible = current.type.members.map((member) => refine(member, depth)).filter((member) => member.type.kind !== "never")
          return possible.length === 0 ? scalar("never") : possible.length === 1 ? possible[0]! : { ...current, type: { kind: "choices", members: possible } }
        }
        if (depth === parts.length) return current.constant === undefined || (Object.is(current.constant, tag.value) === equal) ? current : scalar("never")
        if (current.type.kind !== "record") return current
        const child = current.type.fields.get(parts[depth]!)
        if (child === undefined) return current
        const selected = refine(child, depth + 1)
        if (selected.type.kind === "never") return scalar("never")
        const fields = new Map(current.type.fields); fields.set(parts[depth]!, selected)
        return { ...current, type: { ...current.type, fields } }
      }
      if (root !== undefined && root.type.kind !== "union") { const next = new Map(scope); next.set(parts[0]!, refine(root, 1)); return next }
    }
    if (selector.kind !== "FieldExpression" || selector.field !== "state" || selector.object.kind !== "IdentifierExpression" || tag.kind !== "LiteralExpression" || typeof tag.value !== "string") return scope
    const current = scope.get(selector.object.name)
    if (current?.type.kind !== "union") return scope
    const equal = test.operator === "==" ? truth : !truth
    const selected = [...current.type.cases].filter(([name]) => (name === tag.value) === equal)
    const next = new Map(scope)
    next.set(selector.object.name, selected.length === 1 ? selected[0]![1] : union(new Map(selected), current.dataOrigins))
    return next
  }
  const expr = (expression: Expression, scope: Scope, control: readonly string[]): { value: Fact; counts: Counts } => {
    const result = infer(expression, scope, control)
    expressionFacts.set(expression, result.value)
    return result
  }
  const infer = (expression: Expression, scope: Scope, control: readonly string[]): { value: Fact; counts: Counts } => {
    consume(expression.span)
    const pure = (value: Fact) => ({ value, counts: {} })
    switch (expression.kind) {
      case "LiteralExpression":
        if (expression.value === null) return pure(fact({ kind: "null" }, [], [], null))
        if (typeof expression.value === "object") return pure(fact({ kind: "duration" }, [], [], { kind: "Duration", value: expression.value.value, unit: expression.value.unit }))
        if (typeof expression.value === "number" && !Number.isFinite(expression.value)) fail("nonfinite literal", expression.span)
        return pure(fact({ kind: primitiveKind(expression.value) }, [], [], expression.value))
      case "IdentifierExpression": { const value = scope.get(expression.name); if (value === undefined) fail(`unbound ${expression.name}`, expression.span); return pure(value) }
      case "ListExpression": {
        let item = scalar("never"), counts: Counts = {}; const values: Schema.Json[] = []; let known = true
        for (const element of expression.items) { const result = expr(element, scope, control); item = merge(item, result.value, element.span); counts = add(counts, result.counts); if (result.value.constant === undefined) known = false; else values.push(result.value.constant) }
        if (expression.items.length > environment.maxListItems) fail("list bound exceeded", expression.span)
        return { value: fact({ kind: "list", item, bound: expression.items.length, selectionOrigins: [] }, item.dataOrigins, [], known ? values : undefined, item.controlOrigins), counts }
      }
      case "RecordExpression": {
        const fields = new Map<string, Fact>(); let counts: Counts = {}; const value: Record<string, Schema.Json> = {}; let known = true
        for (const entry of expression.entries) { if (fields.has(entry.key)) fail("duplicate record field", entry.span); const result = expr(entry.value, scope, control); fields.set(entry.key, result.value); counts = add(counts, result.counts); if (result.value.constant === undefined) known = false; else Object.defineProperty(value, entry.key, { value: result.value.constant, enumerable: true }) }
        return { value: { ...record(fields), ...(known ? { constant: value } : {}) }, counts }
      }
      case "FieldExpression": {
        const object = expr(expression.object, scope, control)
        const project = (value: Fact): Fact => {
          if (value.type.kind === "never") return value
          if (value.type.kind === "union" && expression.field === "state") return derivedFact(scalar("string"), [...value.type.cases.values()].map((arm) => arm.type.kind === "record" ? arm.type.fields.get("state") ?? arm : arm))
          if (value.type.kind === "choices") return value.type.members.map(project).reduce((a, b) => merge(a, b, expression.span))
          if (value.type.kind !== "record") fail("field access requires a narrowed record", expression.span)
          const child = value.type.fields.get(expression.field)
          if (child === undefined) fail(`missing field ${expression.field}`, expression.span)
          return child
        }
        return { ...object, value: project(object.value) }
      }
      case "IndexExpression": {
        const object = expr(expression.object, scope, control), index = expr(expression.index, scope, control)
        if (object.value.type.kind !== "list" || index.value.type.kind !== "number") fail("safe index requires list and number", expression.span)
        return { value: influencedFact(object.value.type.item, unique(object.value.type.selectionOrigins ?? object.value.origins, index.value.origins)), counts: add(object.counts, index.counts) }
      }
      case "UnaryExpression": {
        const operand = expr(expression.operand, scope, control)
        compatible(operand.value, scalar(expression.operator === "!" ? "boolean" : "number"), expression.span)
        const constant = expression.operator === "!" && typeof operand.value.constant === "boolean" ? !operand.value.constant
          : expression.operator === "-" && typeof operand.value.constant === "number" ? -operand.value.constant : undefined
        if (typeof constant === "number" && (!Number.isFinite(constant) || (Number.isInteger(constant) && !Number.isSafeInteger(constant)))) fail("certain arithmetic overflow failure", expression.span)
        return { ...operand, value: derivedFact(fact({ kind: expression.operator === "!" ? "boolean" : "number" }, [], [], constant), [operand.value]) }
      }
      case "BinaryExpression": {
        const left = expr(expression.left, scope, control), right = expr(expression.right, ["&&", "||"].includes(expression.operator) ? narrow(expression.left, scope, expression.operator === "&&") : scope, unique(control, left.value.origins))
        const counts = add(left.counts, right.counts)
        const computed = (value: Fact) => derivedFact(value, [left.value, right.value])
        if (["&&", "||"].includes(expression.operator)) { compatible(left.value, scalar("boolean"), expression.span); compatible(right.value, scalar("boolean"), expression.span); return { value: computed(scalar("boolean")), counts } }
        if (["==", "!=", "<", ">", "<=", ">="].includes(expression.operator)) {
          if (["==", "!="].includes(expression.operator)) { equality(left.value, right.value, expression.span); return { value: computed(scalar("boolean")), counts } }
          if (!(["string", "number", "duration"] as const).some((kind) => allKind(left.value, kind) && allKind(right.value, kind))) fail("comparison shape mismatch", expression.span)
          if (!["==", "!="].includes(expression.operator) && left.value.type.kind === "boolean") fail("ordered comparison requires string/number", expression.span)
          return { value: computed(scalar("boolean")), counts }
        }
        if (expression.operator === "+" && allKind(left.value, "string") && allKind(right.value, "string")) return { value: computed(fact({ kind: "string" }, [], [], typeof left.value.constant === "string" && typeof right.value.constant === "string" ? left.value.constant + right.value.constant : undefined)), counts }
        compatible(left.value, scalar("number"), expression.span); compatible(right.value, scalar("number"), expression.span)
        if (typeof left.value.constant === "number" && typeof right.value.constant === "number") {
          if (expression.operator === "/" && right.value.constant === 0) fail("certain arithmetic zero failure", expression.span)
          const a = left.value.constant, b = right.value.constant
          const constant = expression.operator === "+" ? a + b : expression.operator === "-" ? a - b : expression.operator === "*" ? a * b : a / b
          if (!Number.isFinite(constant) || (Number.isInteger(constant) && !Number.isSafeInteger(constant))) fail("certain arithmetic overflow failure", expression.span)
          return { value: computed(fact({ kind: "number" }, [], [], constant)), counts }
        }
        return { value: computed(scalar("number")), counts }
      }
      case "CallExpression": {
        const name = staticPath(expression.callee)
        if (name === undefined) fail("computed tool name", expression.span)
        if (name === "at") {
          if (expression.arguments.length !== 2) fail("at takes list and number", expression.span)
          const list = expr(expression.arguments[0]!, scope, control), index = expr(expression.arguments[1]!, scope, control)
          if (list.value.type.kind !== "list") fail("at requires list", expression.span)
          compatible(index.value, scalar("number"), expression.span)
          return { value: nullable(influencedFact(list.value.type.item, unique(list.value.type.selectionOrigins ?? list.value.origins, index.value.origins))), counts: add(list.counts, index.counts) }
        }
        if (name === "decode") {
          if (expression.arguments.length !== 2) fail("decode takes schema and value", expression.span)
          const handle = staticPath(expression.arguments[0]!)
          if (handle === undefined || !handle.startsWith("schema.")) fail("decode requires a trusted schema name", expression.span)
          const decoder = environment.decoders[handle.slice(7)]
          if (decoder === undefined) fail("unknown decoder", expression.span)
          const source = expr(expression.arguments[1]!, scope, control)
          if (hasOpaque(source.value)) fail("opaque values cannot be decoded by a program", expression.span)
          const carryOrigins = (value: Fact): Fact => {
            const map = (fields: ReadonlyMap<string, Fact>) => new Map([...fields].map(([key, child]) => [key, carryOrigins(child)]))
            return { ...roles(value, source.value.dataOrigins, source.value.controlOrigins), type: value.type.kind === "record" ? { ...value.type, fields: map(value.type.fields), ...(value.type.rawFields === undefined ? {} : { rawFields: map(value.type.rawFields) }) } : value.type.kind === "list" ? { ...value.type, item: carryOrigins(value.type.item), selectionOrigins: source.value.origins } : value.type.kind === "nullable" ? { ...value.type, value: carryOrigins(value.type.value) } : value.type.kind === "choices" ? { ...value.type, members: value.type.members.map(carryOrigins) } : value.type.kind === "union" ? { ...value.type, cases: map(value.type.cases) } : value.type }
          }
          const decoded = carryOrigins(fromModel(modelSchema(decoder.schema, { identity: decoderIdentity(decoder), side: "decoded" }), ""))
          const folded = source.value.constant === undefined ? undefined : decodeValue(decoder, labeledValue(source.value.constant, new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })))
          const value = { ...decoded, refinements: unique(decoded.refinements, [decoderIdentity(decoder)]), ...(folded !== undefined && Result.isSuccess(folded) ? { constant: folded.success.value } : {}) }
          return { value: carryOrigins(union(new Map([["ok", record(new Map([["state", fact({ kind: "string" }, [], [], "ok")], ["value", value]]))], ["err", record(new Map([["state", fact({ kind: "string" }, [], [], "err")], ["error", scalar("string")]]))]]))), counts: source.counts }
        }
        const tool = environment.tools[name]
        if (tool === undefined || !environment.granted.has(name)) fail(`ungranted tool ${name}`, expression.span)
        if (validateFlowDecoders(tool.contract.flow, environment.decoders) !== undefined) fail("unknown contract decoder", expression.span)
        tools.add(name)
        if (expression.arguments.length !== 1) fail("tool call takes one record", expression.span)
        const argument = expr(expression.arguments[0]!, scope, control)
        const expected = fromModel(tool.contract.model.input, "", true)
        if (argument.value.constant !== undefined) {
          const materialized = encodeConstructedInput(argument.value.constant, tool.contract.model.input)
          if (Result.isFailure(Schema.decodeUnknownResult(tool.contract.input, { onExcessProperty: "error" })(materialized))) fail("static input violates schema", expression.span)
        } else compatible(argument.value, expected, expression.span)
        const requirements: ToolFlow["requires"] = tool.contract.flow.requires
        if (Object.keys(requirements).length > 0 && argument.value.type.kind !== "record") fail("tool refinement requires modeled record", expression.span)
        const inputFields = argument.value.type.kind === "record" ? argument.value.type.fields : new Map<string, Fact>()
        for (const [field, required] of Object.entries(requirements)) {
          if (required.some((identity) => !inputFields.get(field)?.refinements.includes(decoderIdentity(identity)))) fail(`missing required refinement on ${field}`, expression.span)
        }
        calls.push({ tool: name, span: expression.span, arguments: argument.value, control, maximumOccurrences: occurrences })
        const dependencies = unique(control, argument.value.controlOrigins)
        const influenced = (value: Fact): Fact => influencedFact(value, dependencies, argument.value.dataOrigins)
        let result = influenced(fromModel(tool.contract.model.output, `${name}@${expression.span.start}.result`))
        const provides: ToolFlow["provides"] = tool.contract.flow.provides
        for (const [field, identities] of Object.entries(provides)) {
          const attest = (value: Fact): Fact => value.type.kind === "nullable" ? { ...value, type: { ...value.type, value: attest(value.type.value) } } : ({ ...value,
            refinements: unique(value.refinements, identities.map(decoderIdentity)),
            schemaProofs: [...(value.schemaProofs ?? []), ...identities.map((identity) => modelSchema(environment.decoders[identity.name]!.schema, { identity: decoderIdentity(identity), side: "decoded" }))]
          })
          if (field === "$") result = attest(result)
          else {
            const decorate = (value: Fact): Fact => {
              if (value.type.kind === "choices") return { ...value, type: { ...value.type, members: value.type.members.map(decorate) } }
              if (value.type.kind !== "record") fail("provided field requires modeled record", expression.span)
              const child = value.type.fields.get(field)
              if (child === undefined) return value
              const fields = new Map(value.type.fields); fields.set(field, attest(child))
              return { ...value, type: { ...value.type, fields } }
            }
            result = decorate(result)
          }
        }
        const receiptOrigins = [`${name}@${expression.span.start}.state`]
        const receiptField = (field: string) => fact({ kind: "string" }, [`${name}@${expression.span.start}.${field}`])
        const state = (tag: string, fields: ReadonlyArray<readonly [string, Fact]>) => record(new Map([["state", influenced(fact({ kind: "string" }, receiptOrigins, [], tag))], ...fields.map(([name, value]) => [name, influenced(value)] as const)]))
        return { value: union(new Map([["done", state("done", [["id", receiptField("id")], ["result", result], ["wayBack", nullable(fromModel(wayBackModel, `${name}@${expression.span.start}.wayBack`))]])], ["staged", state("staged", [["id", receiptField("id")]])], ["refused", state("refused", [["refusal", record(new Map([["code", receiptField("refusal.code")], ["message", receiptField("refusal.message")]]))]])]])), counts: add(argument.counts, { [name]: 1 }) }
      }
    }
  }
  const statements = (body: readonly Statement[], outer: Scope, control: readonly string[]): { counts: Counts; iterations: number; control: readonly string[] } => {
    let scope = new Map(outer), pc = control, counts: Counts = {}, iterations = 0
    for (const statement of body) {
      switch (statement.kind) {
        case "LetStatement": { const result = expr(statement.value, scope, pc); scope.set(statement.name, result.value); counts = add(counts, result.counts); break }
        case "ExpressionStatement": { const result = expr(statement.expression, scope, pc); counts = add(counts, result.counts); pc = unique(pc, result.value.origins); break }
        case "ReturnStatement": if (statement.value !== undefined) { const result = expr(statement.value, scope, pc); counts = add(counts, result.counts) } break
        case "AssertStatement": {
          const condition = expr(statement.test, scope, pc); compatible(condition.value, scalar("boolean"), statement.span)
          const message = statement.message === undefined ? { counts: {}, value: scalar("string") } : expr(statement.message, scope, unique(pc, condition.value.origins))
          compatible(message.value, scalar("string"), statement.span)
          counts = add(counts, add(condition.counts, message.counts)); pc = unique(pc, condition.value.origins)
          break
        }
        case "IfStatement": {
          const test = expr(statement.test, scope, pc); compatible(test.value, scalar("boolean"), statement.test.span)
          const branchPc = unique(pc, test.value.origins)
          const yes = statements(statement.consequent, narrow(statement.test, scope, true), branchPc)
          const no = statements(statement.alternate ?? [], narrow(statement.test, scope, false), branchPc)
          counts = add(counts, add(test.counts, maximum(yes.counts, no.counts))); iterations += Math.max(yes.iterations, no.iterations)
          // Includes whether later code is reached, even for an absent branch.
          pc = unique(branchPc, yes.control, no.control)
          break
        }
        case "ForStatement": {
          if (statement.iteration === "range") {
            const from = expr(statement.from, scope, pc), to = expr(statement.to, scope, pc)
            compatible(from.value, scalar("number"), statement.span); compatible(to.value, scalar("number"), statement.span)
            for (const endpoint of [from.value.constant, to.value.constant]) if (endpoint !== undefined && (typeof endpoint !== "number" || !Number.isSafeInteger(endpoint))) fail("certain invalid range bound", statement.span)
            const bound = typeof from.value.constant === "number" && typeof to.value.constant === "number" ? Math.max(0, to.value.constant - from.value.constant) : environment.maxIterations
            const loopPc = unique(pc, from.value.origins, to.value.origins), inner = new Map(scope)
            inner.set(statement.variable, derivedFact(scalar("number"), [from.value, to.value]))
            const previousOccurrences = occurrences; occurrences *= bound
            const child = loopBody(statement.body, inner, loopPc, bound); occurrences = previousOccurrences
            counts = add(counts, add(add(from.counts, to.counts), scale(child.counts, bound))); iterations += bound * (1 + child.iterations); pc = unique(loopPc, child.control)
            break
          }
          const source = expr(statement.source, scope, pc)
          if (source.value.type.kind !== "list") fail("for source must be finite list", statement.span)
          const inner = new Map(scope); inner.set(statement.variable, source.value.type.item)
          const loopPc = unique(pc, source.value.origins, source.value.type.item.origins)
          const bound = source.value.type.bound, previousOccurrences = occurrences
          occurrences *= bound
          const child = loopBody(statement.body, inner, loopPc, bound)
          occurrences = previousOccurrences
          counts = add(counts, add(source.counts, scale(child.counts, bound))); iterations += bound * (1 + child.iterations); pc = unique(loopPc, child.control)
          break
        }
      }
    }
    return { counts, iterations, control: pc }
  }
  // A later iteration can be reached through any earlier body outcome.
  // Iterate monotonically over finite source identities before recording facts.
  const loopBody = (body: readonly Statement[], scope: Scope, initial: readonly string[], bound: number): ReturnType<typeof statements> => {
    const firstCall = calls.length
    let control = initial
    for (;;) {
      calls.length = firstCall
      const child = statements(body, scope, control)
      const next = unique(control, child.control)
      if (bound <= 1 || next.length === control.length) return child
      control = next
    }
  }
  const bindings = new Map<string, Fact>()
  const jsonLeaves = (model: SchemaModel, value: unknown): boolean => {
    if (model.kind === "nominal") return model.base === undefined || jsonLeaves(model.base, value)
    if (model.kind === "union") { const selected = model.members.find((member) => Result.isSuccess(encodeModelValue(member, value))); return selected !== undefined && jsonLeaves(selected, value) }
    if (model.kind === "record") return value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(model.fields).every(([name, field]) => !Object.hasOwn(value, name) ? field.optional : jsonLeaves(field.type, Reflect.get(value, name)))
    if (model.kind === "list") return Array.isArray(value) && value.every((item) => jsonLeaves(model.item, item))
    return Result.isSuccess(Schema.decodeUnknownResult(Schema.Json)(value))
  }
  for (const [name, binding] of Object.entries(environment.bindings ?? {})) {
    if (Result.isFailure(Schema.decodeUnknownResult(Schema.Json)(binding.value))) fail(`invalid binding ${name}`)
    const decoded = Schema.decodeUnknownResult(binding.schema, { onExcessProperty: "error" })(binding.value)
    const model = modelSchema(binding.schema, { identity: JSON.stringify(["binding", name]), side: "decoded" })
    if (Result.isFailure(decoded) || !jsonLeaves(model, decoded.success)) fail(`invalid binding ${name}`)
    bindings.set(name, fromModel(model, `binding.${name}`))
  }
  const result = statements(program.body, bindings, [])
  if (Object.values(result.counts).reduce((sum, count) => sum + count, 0) > environment.maxCalls || result.iterations > environment.maxIterations) fail("reviewed bound exceeds budget")
  return { program, environment, tools: [...tools].sort(), maximumCalls: result.counts, calls, iterations: result.iterations, expressionFacts }
}

export const decoderIdentity = (decoder: { readonly name: string; readonly version: string }): string => JSON.stringify([decoder.name, decoder.version])
/** Schema-directed encoding for newly constructed records; decoded aliases are unchanged. */
export const encodeConstructedInput = (value: Schema.Json, model: SchemaModel): Schema.Json => {
  if (model.kind === "nominal" && model.base !== undefined) return encodeConstructedInput(value, model.base)
  if (model.kind === "union") {
    for (const member of model.members) { const candidate = encodeConstructedInput(value, member); if (acceptsLiteral(member, candidate)) return candidate }
    return value
  }
  if (model.kind === "record" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([name, child]) => {
      const field = model.fields[name]
      if (field === undefined) return [[name, child]]
      if (child === null && field.optional && !acceptsLiteral(field.type, null)) return []
      return [[name, encodeConstructedInput(child, field.type)]]
    }))
  }
  if (model.kind === "list" && Array.isArray(value)) return value.map((item) => encodeConstructedInput(item, model.item))
  return value
}
const primitiveKind = (value: string | number | boolean): Kind => typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean"
