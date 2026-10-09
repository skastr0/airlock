import { Effect, Result, Schema } from "effect"
import type { ToolContract } from "../../src/core/contract/ToolContract.ts"
import { decodeValue, labeledValue, type TrustedDecoder } from "../../src/core/contract/Decoder.ts"
import { InformationLabel } from "../../src/core/labels/Labels.ts"
import { modelSchema, type SchemaModel } from "../../src/core/contract/SchemaModel.ts"
import { validateBindings } from "../../src/core/language/bindings.ts"
import type { Expression, Program, Span, Statement } from "../../src/core/language/ast.ts"
import { SpanSchema } from "../../src/core/language/ast.ts"
import { parse } from "../../src/core/language/parser.ts"

/** Test-only checker over the current parser. No runner imports this prototype. */
export class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", { detail: Schema.String, span: SpanSchema }) {}
export interface PrototypeTool {
  readonly contract: ToolContract.Any
  /** Provisional adapter for contract-owned metadata; not a policy authority. */
  readonly requires?: Readonly<Record<string, string>>
}
export interface ReviewEnvironment {
  readonly tools: Readonly<Record<string, PrototypeTool>>
  readonly decoders: Readonly<Record<string, TrustedDecoder.Any>>
  readonly granted: ReadonlySet<string>
  readonly maxListItems: number
  readonly maxCalls: number
  readonly maxIterations: number
}
type Kind = "string" | "number" | "boolean" | "never"
export type Type =
  | { readonly kind: Kind }
  | { readonly kind: "record"; readonly fields: ReadonlyMap<string, Fact> }
  | { readonly kind: "list"; readonly item: Fact; readonly bound: number }
  | { readonly kind: "union"; readonly cases: ReadonlyMap<string, Fact> }
  | { readonly kind: "schema"; readonly name: string }
export interface Fact {
  readonly type: Type
  readonly origins: readonly string[]
  readonly refinements: readonly string[]
  readonly constant?: Schema.Json
}
export interface CallFact {
  readonly tool: string
  readonly span: Span
  readonly arguments: Fact
  readonly control: readonly string[]
  readonly maximumOccurrences: number
}
export interface Review {
  readonly program: Program
  readonly environment: ReviewEnvironment
  readonly tools: readonly string[]
  readonly maximumCalls: Readonly<Record<string, number>>
  readonly calls: readonly CallFact[]
  readonly iterations: number
  readonly expressionFacts: ReadonlyMap<Expression, Fact>
}
type Counts = Record<string, number>
type Scope = ReadonlyMap<string, Fact>
const unique = (...sets: readonly (readonly string[])[]) => [...new Set(sets.flat())]
const fact = (type: Type, origins: readonly string[] = [], refinements: readonly string[] = [], constant?: Schema.Json): Fact => ({ type, origins, refinements, ...(constant === undefined ? {} : { constant }) })
const scalar = (kind: Kind) => fact({ kind })
const record = (fields: ReadonlyMap<string, Fact>, origins: readonly string[] = []) => fact({ kind: "record", fields }, origins)
const union = (cases: ReadonlyMap<string, Fact>, origins: readonly string[] = []) => fact({ kind: "union", cases }, origins)
const option = (value: Fact) => union(new Map([["some", record(new Map([["value", value]]))], ["none", record(new Map())]]), value.origins)
export const staticPath = (expr: Expression): string | undefined => expr.kind === "IdentifierExpression" ? expr.name : expr.kind === "FieldExpression" ? (() => { const path = staticPath(expr.object); return path === undefined ? undefined : `${path}.${expr.field}` })() : undefined
const add = (left: Counts, right: Counts): Counts => Object.fromEntries(unique(Object.keys(left), Object.keys(right)).map((key) => [key, (left[key] ?? 0) + (right[key] ?? 0)]))
const maximum = (left: Counts, right: Counts): Counts => Object.fromEntries(unique(Object.keys(left), Object.keys(right)).map((key) => [key, Math.max(left[key] ?? 0, right[key] ?? 0)]))
const scale = (counts: Counts, count: number): Counts => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * count]))

export const reviewPrototype = (source: string, environment: ReviewEnvironment): Effect.Effect<Review, ReviewError | import("../../src/core/language/bindings.ts").DuplicateBinding | import("../../src/core/language/lexer.ts").LanguageDiagnostic> => Effect.gen(function* () {
  const parsed = yield* parse(source)
  yield* validateBindings(parsed, ["schema"])
  return yield* Effect.try({ try: () => check(parsed, environment), catch: (error) => error instanceof ReviewError ? error : new ReviewError({ detail: "unsupported contract or program", span: parsed.span }) })
})

const check = (program: Program, environment: ReviewEnvironment): Review => {
  const fail: (detail: string, span?: Span) => never = (detail, span = program.span) => { throw new ReviewError({ detail, span }) }
  for (const limit of [environment.maxCalls, environment.maxIterations, environment.maxListItems]) if (!Number.isSafeInteger(limit) || limit < 0) fail("invalid review limit")
  const calls: CallFact[] = [], tools = new Set<string>()
  const expressionFacts = new Map<Expression, Fact>()
  let occurrences = 1
  let fuel = 20_000
  const consume = (span: Span) => { if (--fuel < 0) fail("review complexity limit", span) }
  // Unsupported schemas fail closed. The production contract lane owns the
  // eventual closed representation; this prototype never invents an any type.
  const fromModel = (model: SchemaModel, origin: string, input = false): Fact => {
    const origins = origin === "" ? [] : [origin]
    if (["string", "number", "boolean", "never"].includes(model.kind) && model.kind !== "literal" && model.kind !== "record" && model.kind !== "list" && model.kind !== "union" && model.kind !== "nominal") return fact({ kind: model.kind }, origins)
    if (model.kind === "literal" && model.value !== null) return fact({ kind: primitiveKind(model.value) }, origins, [], model.value)
    if (model.kind === "nominal") {
      if (model.base === undefined) fail(`opaque schema ${model.identity} not supported by prototype`)
      const base = fromModel(model.base, origin, input)
      return { ...base, refinements: unique(base.refinements, [model.identity]) }
    }
    if (model.kind === "record") {
      const fields = new Map<string, Fact>()
      for (const [name, field] of Object.entries(model.fields)) {
        if (input && field.optional) fail("optional input encoding pending")
        const value = fromModel(field.type, `${origin}.${name}`, input)
        fields.set(name, field.optional ? option(value) : value)
      }
      return fact({ kind: "record", fields }, origins)
    }
    if (model.kind === "list") return fact({ kind: "list", item: fromModel(model.item, `${origin}[]`, input), bound: Math.min(model.maxLength ?? environment.maxListItems, environment.maxListItems) }, origins)
    return fail(`unsupported schema ${model.kind}`)
  }
  const compatible = (value: Fact, expected: Fact, span: Span) => {
    if (value.type.kind === "never") return
    if (value.type.kind !== expected.type.kind) fail(`expected ${expected.type.kind}, received ${value.type.kind}`, span)
    if (expected.constant !== undefined && value.constant !== expected.constant) fail("literal type mismatch", span)
    if (expected.refinements.some((proof) => !value.refinements.includes(proof))) fail("missing schema refinement", span)
    if (expected.type.kind === "record" && value.type.kind === "record") {
      if (expected.type.fields.size !== value.type.fields.size) fail("record fields must match exactly", span)
      for (const [key, field] of expected.type.fields) { const actual = value.type.fields.get(key); if (actual === undefined) fail(`missing field ${key}`, span); compatible(actual, field, span) }
    }
    if (expected.type.kind === "list" && value.type.kind === "list") compatible(value.type.item, expected.type.item, span)
  }
  const merge = (left: Fact, right: Fact, span: Span): Fact => {
    if (left.type.kind === "never") return right
    if (right.type.kind === "never") return left
    if (left.type.kind !== right.type.kind) fail("list items must have one type", span)
    if (left.type.kind === "record" && right.type.kind === "record") {
      if (left.type.fields.size !== right.type.fields.size) fail("list records must have exact fields", span)
      const fields = new Map<string, Fact>()
      for (const [key, value] of left.type.fields) { const other = right.type.fields.get(key); if (other === undefined) fail("list record field mismatch", span); fields.set(key, merge(value, other, span)) }
      return record(fields, unique(left.origins, right.origins))
    }
    if (left.type.kind === "list" && right.type.kind === "list") return fact({ kind: "list", item: merge(left.type.item, right.type.item, span), bound: Math.max(left.type.bound, right.type.bound) }, unique(left.origins, right.origins))
    if (left.type.kind === "union" && right.type.kind === "union") {
      const cases = new Map<string, Fact>()
      for (const key of unique([...left.type.cases.keys()], [...right.type.cases.keys()])) {
        const a = left.type.cases.get(key), b = right.type.cases.get(key)
        cases.set(key, a === undefined ? b! : b === undefined ? a : merge(a, b, span))
      }
      return union(cases, unique(left.origins, right.origins))
    }
    return fact(left.type, unique(left.origins, right.origins), left.refinements.filter((proof) => right.refinements.includes(proof)), left.constant === right.constant ? left.constant : undefined)
  }
  const narrow = (test: Expression, scope: Scope, truth: boolean): Scope => {
    if (test.kind !== "BinaryExpression" || !["==", "!="].includes(test.operator)) return scope
    const selector = test.left, tag = test.right
    if (selector.kind !== "FieldExpression" || selector.field !== "state" || selector.object.kind !== "IdentifierExpression" || tag.kind !== "LiteralExpression" || typeof tag.value !== "string") return scope
    const current = scope.get(selector.object.name)
    if (current?.type.kind !== "union") return scope
    const equal = test.operator === "==" ? truth : !truth
    const selected = [...current.type.cases].filter(([name]) => (name === tag.value) === equal)
    const next = new Map(scope)
    next.set(selector.object.name, selected.length === 1 ? selected[0]![1] : union(new Map(selected), current.origins))
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
        if (typeof expression.value !== "string" && typeof expression.value !== "number" && typeof expression.value !== "boolean") fail("null/duration not in sound prototype", expression.span)
        if (typeof expression.value === "number" && !Number.isFinite(expression.value)) fail("nonfinite literal", expression.span)
        return pure(fact({ kind: primitiveKind(expression.value) }, [], [], expression.value))
      case "IdentifierExpression": { const value = scope.get(expression.name); if (value === undefined) fail(`unbound ${expression.name}`, expression.span); return pure(value) }
      case "ListExpression": {
        let item = scalar("never"), counts: Counts = {}; const values: Schema.Json[] = []; let known = true
        for (const element of expression.items) { const result = expr(element, scope, control); item = merge(item, result.value, element.span); counts = add(counts, result.counts); if (result.value.constant === undefined) known = false; else values.push(result.value.constant) }
        if (expression.items.length > environment.maxListItems) fail("list bound exceeded", expression.span)
        return { value: fact({ kind: "list", item, bound: expression.items.length }, item.origins, [], known ? values : undefined), counts }
      }
      case "RecordExpression": {
        const fields = new Map<string, Fact>(); let counts: Counts = {}; const value: Record<string, Schema.Json> = {}; let known = true
        for (const entry of expression.entries) { if (fields.has(entry.key)) fail("duplicate record field", entry.span); const result = expr(entry.value, scope, control); fields.set(entry.key, result.value); counts = add(counts, result.counts); if (result.value.constant === undefined) known = false; else Object.defineProperty(value, entry.key, { value: result.value.constant, enumerable: true }) }
        return { value: fact({ kind: "record", fields }, unique(...[...fields.values()].map((field) => field.origins)), [], known ? value : undefined), counts }
      }
      case "FieldExpression": {
        const object = expr(expression.object, scope, control)
        if (object.value.type.kind === "union" && expression.field === "state") return { ...object, value: fact({ kind: "string" }, object.value.origins) }
        if (object.value.type.kind !== "record") fail("field access requires a narrowed record", expression.span)
        const value = object.value.type.fields.get(expression.field)
        if (value === undefined) fail(`missing field ${expression.field}`, expression.span)
        return { ...object, value }
      }
      case "IndexExpression": {
        const object = expr(expression.object, scope, control), index = expr(expression.index, scope, control)
        if (object.value.type.kind !== "list" || index.value.type.kind !== "number") fail("safe index requires list and number", expression.span)
        return { value: option(fact(object.value.type.item.type, unique(object.value.type.item.origins, index.value.origins), object.value.type.item.refinements)), counts: add(object.counts, index.counts) }
      }
      case "UnaryExpression": {
        const operand = expr(expression.operand, scope, control)
        if (expression.operator !== "!" || operand.value.type.kind !== "boolean") fail("unsupported unary operation", expression.span)
        return { ...operand, value: fact({ kind: "boolean" }, operand.value.origins) }
      }
      case "BinaryExpression": {
        const left = expr(expression.left, scope, control), right = expr(expression.right, ["&&", "||"].includes(expression.operator) ? narrow(expression.left, scope, expression.operator === "&&") : scope, unique(control, left.value.origins))
        const origins = unique(left.value.origins, right.value.origins), counts = add(left.counts, right.counts)
        if (["&&", "||"].includes(expression.operator)) { compatible(left.value, scalar("boolean"), expression.span); compatible(right.value, scalar("boolean"), expression.span); return { value: fact({ kind: "boolean" }, origins), counts } }
        if (["==", "!=", "<", ">", "<=", ">="].includes(expression.operator)) {
          if (!["string", "number", "boolean"].includes(left.value.type.kind) || left.value.type.kind !== right.value.type.kind) fail("comparison shape mismatch", expression.span)
          if (!["==", "!="].includes(expression.operator) && left.value.type.kind === "boolean") fail("ordered comparison requires string/number", expression.span)
          return { value: fact({ kind: "boolean" }, origins), counts }
        }
        if (expression.operator === "+" && left.value.type.kind === "string" && right.value.type.kind === "string") return { value: fact({ kind: "string" }, origins, [], typeof left.value.constant === "string" && typeof right.value.constant === "string" ? left.value.constant + right.value.constant : undefined), counts }
        // Numeric partiality awaits its total Result surface. Fail closed now.
        fail("numeric arithmetic requires the pending total-number design", expression.span)
      }
      case "CallExpression": {
        const name = staticPath(expression.callee)
        if (name === undefined) fail("computed tool name", expression.span)
        if (name === "decode") {
          if (expression.arguments.length !== 2) fail("decode takes schema and value", expression.span)
          const handle = staticPath(expression.arguments[0]!)
          if (handle === undefined || !handle.startsWith("schema.")) fail("decode requires a trusted schema name", expression.span)
          const decoder = environment.decoders[handle.slice(7)]
          if (decoder === undefined) fail("unknown decoder", expression.span)
          const source = expr(expression.arguments[1]!, scope, control)
          const carryOrigins = (value: Fact): Fact => ({ ...value, origins: source.value.origins, type: value.type.kind === "record" ? { ...value.type, fields: new Map([...value.type.fields].map(([key, field]) => [key, carryOrigins(field)])) } : value.type.kind === "list" ? { ...value.type, item: carryOrigins(value.type.item) } : value.type })
          const decoded = carryOrigins(fromModel(modelSchema(decoder.schema, { identity: decoderIdentity(decoder), side: "decoded" }), ""))
          const folded = source.value.constant === undefined ? undefined : decodeValue(decoder, labeledValue(source.value.constant, new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })))
          const value = { ...decoded, refinements: unique(decoded.refinements, [decoderIdentity(decoder)]), ...(folded !== undefined && Result.isSuccess(folded) ? { constant: folded.success.value } : {}) }
          return { value: union(new Map([["ok", record(new Map([["state", fact({ kind: "string" }, [], [], "ok")], ["value", value]]), source.value.origins)], ["err", record(new Map([["state", fact({ kind: "string" }, [], [], "err")], ["error", scalar("string")]]), source.value.origins)]]), source.value.origins), counts: source.counts }
        }
        const tool = environment.tools[name]
        if (tool === undefined || !environment.granted.has(name)) fail(`ungranted tool ${name}`, expression.span)
        tools.add(name)
        if (expression.arguments.length !== 1) fail("tool call takes one record", expression.span)
        const argument = expr(expression.arguments[0]!, scope, control)
        const expected = fromModel(modelSchema(tool.contract.input, { identity: `${name}@${tool.contract.version}/input`, side: "encoded" }), "", true)
        if (argument.value.constant !== undefined) {
          if (Result.isFailure(Schema.decodeUnknownResult(tool.contract.input, { onExcessProperty: "error" })(argument.value.constant))) fail("static input violates schema", expression.span)
        } else compatible(argument.value, expected, expression.span)
        for (const [field, required] of Object.entries(tool.requires ?? {})) {
          if (argument.value.type.kind !== "record" || !argument.value.type.fields.get(field)?.refinements.includes(required)) fail(`missing required refinement on ${field}`, expression.span)
        }
        calls.push({ tool: name, span: expression.span, arguments: argument.value, control, maximumOccurrences: occurrences })
        const result = fromModel(modelSchema(tool.contract.outcome, { identity: `${name}@${tool.contract.version}/output`, side: "decoded" }), `${name}@${expression.span.start}.result`)
        const state = (tag: string, fields: ReadonlyArray<readonly [string, Fact]>) => record(new Map([["state", fact({ kind: "string" }, [`${name}@${expression.span.start}.state`], [], tag)], ...fields]), [`${name}@${expression.span.start}.state`])
        return { value: union(new Map([["done", state("done", [["id", scalar("string")], ["result", result]])], ["staged", state("staged", [["id", scalar("string")]])], ["refused", state("refused", [["refusal", record(new Map([["code", scalar("string")], ["message", scalar("string")]]))]])]]), [`${name}@${expression.span.start}.state`]), counts: add(argument.counts, { [name]: 1 }) }
      }
    }
  }
  const statements = (body: readonly Statement[], outer: Scope, control: readonly string[]): { counts: Counts; iterations: number } => {
    let scope = new Map(outer), pc = control, counts: Counts = {}, iterations = 0
    for (const statement of body) {
      switch (statement.kind) {
        case "LetStatement": { const result = expr(statement.value, scope, pc); scope.set(statement.name, result.value); counts = add(counts, result.counts); break }
        case "ExpressionStatement": { const result = expr(statement.expression, scope, pc); counts = add(counts, result.counts); pc = unique(pc, result.value.origins); break }
        case "ReturnStatement": if (statement.value !== undefined) { const result = expr(statement.value, scope, pc); counts = add(counts, result.counts) } break
        case "AssertStatement": fail("assert is not in sound prototype termination set", statement.span)
        case "IfStatement": {
          const test = expr(statement.test, scope, pc); compatible(test.value, scalar("boolean"), statement.test.span)
          const branchPc = unique(pc, test.value.origins)
          const yes = statements(statement.consequent, narrow(statement.test, scope, true), branchPc)
          const no = statements(statement.alternate ?? [], narrow(statement.test, scope, false), branchPc)
          counts = add(counts, add(test.counts, maximum(yes.counts, no.counts))); iterations += Math.max(yes.iterations, no.iterations)
          // Includes whether later code is reached, even for an absent branch.
          pc = branchPc
          break
        }
        case "ForStatement": {
          if (statement.iteration !== "list") fail("range requires pending total-number design", statement.span)
          const source = expr(statement.source, scope, pc)
          if (source.value.type.kind !== "list") fail("for source must be finite list", statement.span)
          const inner = new Map(scope); inner.set(statement.variable, source.value.type.item)
          const loopPc = unique(pc, source.value.origins, source.value.type.item.origins)
          const bound = source.value.type.bound, previousOccurrences = occurrences
          occurrences *= bound
          const child = statements(statement.body, inner, loopPc)
          occurrences = previousOccurrences
          counts = add(counts, add(source.counts, scale(child.counts, bound))); iterations += bound * (1 + child.iterations); pc = loopPc
          break
        }
      }
    }
    return { counts, iterations }
  }
  const result = statements(program.body, new Map(), [])
  if (Object.values(result.counts).reduce((sum, count) => sum + count, 0) > environment.maxCalls || result.iterations > environment.maxIterations) fail("reviewed bound exceeds budget")
  return { program, environment, tools: [...tools].sort(), maximumCalls: result.counts, calls, iterations: result.iterations, expressionFacts }
}

export const decoderIdentity = (decoder: TrustedDecoder.Any): string => `${decoder.name}@${decoder.version}`
const primitiveKind = (value: string | number | boolean): Kind => typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean"
