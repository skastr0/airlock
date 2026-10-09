import { Effect, Result, Schema, SchemaAST } from "effect"
import { decodeValue, deriveValue, hasRefinement, labeledValue, projectValue, type TrackedValue } from "../../src/core/contract/Decoder.ts"
import { combine, InformationLabel } from "../../src/core/labels/Labels.ts"
import type { Expression, Span, Statement } from "../../src/core/language/ast.ts"
import { SpanSchema } from "../../src/core/language/ast.ts"
import { decoderIdentity, staticPath, type Review } from "./air-review.ts"

export class PrototypeStop extends Schema.TaggedError<PrototypeStop>()("PrototypeStop", {
  reason: Schema.Literals(["dynamic-type-error", "host-result", "budget", "out-of-plan", "refinement", "value-limit"]), span: SpanSchema
}) {}
export interface PrototypeHost<E = never, R = never> {
  readonly resolve: (tool: string, input: Schema.Json, control: InformationLabel) => Effect.Effect<Schema.Json, E, R>
}
interface Box { readonly tracked: TrackedValue; readonly children: ReadonlyMap<string | number, Box> }
type Scope = ReadonlyMap<string, Box>
const literalLabel = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const empty = () => labeledValue(false, literalLabel)
const stop: (reason: PrototypeStop["reason"], span: Span) => never = (reason, span) => { throw new PrototypeStop({ reason, span }) }

/** Dynamic checks are deliberately retained, even after successful review. */
export const runReviewedPrototype = <E, R>(review: Review, host: PrototypeHost<E, R>): Effect.Effect<Schema.Json, PrototypeStop, R> => Effect.gen(function* () {
  const callCounts = new Map<string, number>()
  let iterations = 0, fuel = 20_000
  const effect = <A>(body: () => A, span: Span): Effect.Effect<A, PrototypeStop> => Effect.try({ try: body, catch: (error) => error instanceof PrototypeStop ? error : new PrototypeStop({ reason: "dynamic-type-error", span }) })
  const primitive = (value: Schema.Json, parents: readonly Box[] = []): Box => ({ tracked: parents.length === 0 ? labeledValue(value, literalLabel) : deriveValue(value, parents[0]!.tracked, ...parents.slice(1).map((parent) => parent.tracked)), children: new Map() })
  const record = (children: ReadonlyMap<string | number, Box>): Box => {
    const raw: Record<string, Schema.Json> = {}
    for (const [name, child] of children) Object.defineProperty(raw, name, { value: child.tracked.value, enumerable: true })
    return { ...primitive(raw, [...children.values()]), children }
  }
  const list = (items: readonly Box[]): Box => ({ ...primitive(items.map((item) => item.tracked.value), items), children: new Map(items.map((item, index) => [index, item])) })
  const variant = (state: string, fields: ReadonlyArray<readonly [string, Box]> = [], parents: readonly Box[] = []): Box => record(new Map([["state", primitive(state, parents)], ...fields]))
  const tracked = (value: TrackedValue): Box => ({ tracked: value, children: new Map() })
  const boundary = (source: TrackedValue, ast: SchemaAST.AST, span: Span): Box => {
    const value = source.value
    if (SchemaAST.isObjects(ast)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) stop("host-result", span)
      const children = new Map<string | number, Box>()
      for (const property of ast.propertySignatures) {
        if (typeof property.name !== "string") stop("host-result", span)
        const present = Object.hasOwn(value, property.name)
        if (!present && !SchemaAST.isOptional(property.type)) stop("host-result", span)
        if (SchemaAST.isOptional(property.type)) children.set(property.name, present ? variant("some", [["value", boundary(projectValue(source, property.name), property.type, span)]], [tracked(source)]) : variant("none", [], [tracked(source)]))
        else children.set(property.name, boundary(projectValue(source, property.name), property.type, span))
      }
      return { tracked: source, children }
    }
    if (SchemaAST.isArrays(ast)) {
      if (!Array.isArray(value) || value.length > review.environment.maxListItems) stop("value-limit", span)
      return { tracked: source, children: new Map(value.map((_, index) => [index, boundary(projectValue(source, index), ast.rest[0]!, span)])) }
    }
    if (value === null || typeof value === "object" || (typeof value === "number" && !Number.isFinite(value))) stop("host-result", span)
    return tracked(source)
  }
  const boolean = (value: Box, span: Span): boolean => { if (typeof value.tracked.value !== "boolean") stop("dynamic-type-error", span); return value.tracked.value }
  const evaluate = (expression: Expression, scope: Scope, pc: TrackedValue): Effect.Effect<Box, PrototypeStop, R> => Effect.gen(function* () {
    if (--fuel < 0) return yield* Effect.fail(new PrototypeStop({ reason: "budget", span: expression.span }))
    switch (expression.kind) {
      case "LiteralExpression": return yield* effect(() => { if (typeof expression.value !== "string" && typeof expression.value !== "number" && typeof expression.value !== "boolean") stop("dynamic-type-error", expression.span); return primitive(expression.value) }, expression.span)
      case "IdentifierExpression": return yield* effect(() => { const value = scope.get(expression.name); if (value === undefined) stop("dynamic-type-error", expression.span); return value }, expression.span)
      case "RecordExpression": {
        const children = new Map<string | number, Box>()
        for (const entry of expression.entries) children.set(entry.key, yield* evaluate(entry.value, scope, pc))
        return record(children)
      }
      case "ListExpression": return list(yield* Effect.forEach(expression.items, (item) => evaluate(item, scope, pc)))
      case "FieldExpression": {
        const object = yield* evaluate(expression.object, scope, pc)
        return yield* effect(() => { const value = object.children.get(expression.field); if (value === undefined) stop("dynamic-type-error", expression.span); return value }, expression.span)
      }
      case "IndexExpression": {
        const object = yield* evaluate(expression.object, scope, pc), index = yield* evaluate(expression.index, scope, pc)
        return yield* effect(() => {
          if (!Array.isArray(object.tracked.value) || typeof index.tracked.value !== "number") stop("dynamic-type-error", expression.span)
          const selected = Number.isSafeInteger(index.tracked.value) ? object.children.get(index.tracked.value) : undefined
          return selected === undefined ? variant("none", [], [object, index]) : variant("some", [["value", selected]], [object, index])
        }, expression.span)
      }
      case "UnaryExpression": { const operand = yield* evaluate(expression.operand, scope, pc); return yield* effect(() => primitive(!boolean(operand, expression.span), [operand]), expression.span) }
      case "BinaryExpression": {
        const left = yield* evaluate(expression.left, scope, pc)
        if (expression.operator === "&&" && !boolean(left, expression.span)) return left
        if (expression.operator === "||" && boolean(left, expression.span)) return left
        const right = yield* evaluate(expression.right, scope, deriveValue(false, pc, left.tracked))
        return yield* effect(() => {
          const a = left.tracked.value, b = right.tracked.value
          if (typeof a !== typeof b || a === null || typeof a === "object" || b === null || typeof b === "object") stop("dynamic-type-error", expression.span)
          switch (expression.operator) {
            case "&&": case "||": return primitive(boolean(right, expression.span), [left, right])
            case "==": return primitive(a === b, [left, right])
            case "!=": return primitive(a !== b, [left, right])
            case "<": return primitive(a < b, [left, right])
            case "<=": return primitive(a <= b, [left, right])
            case ">": return primitive(a > b, [left, right])
            case ">=": return primitive(a >= b, [left, right])
            case "+": if (typeof a === "string" && typeof b === "string") return primitive(a + b, [left, right]); return stop("dynamic-type-error", expression.span)
            default: return stop("dynamic-type-error", expression.span)
          }
        }, expression.span)
      }
      case "CallExpression": {
        const name = staticPath(expression.callee)
        if (name === "decode") {
          const handle = staticPath(expression.arguments[0]!), decoder = handle === undefined ? undefined : review.environment.decoders[handle.slice(7)]
          const source = yield* evaluate(expression.arguments[1]!, scope, pc)
          return yield* effect(() => {
            if (decoder === undefined) stop("out-of-plan", expression.span)
            const result = decodeValue(decoder, source.tracked)
            return Result.isFailure(result) ? variant("err", [["error", primitive(result.failure.reason, [source])]], [source]) : variant("ok", [["value", boundary(result.success, Schema.toType(decoder.schema).ast, expression.span)]], [source])
          }, expression.span)
        }
        const argument = yield* evaluate(expression.arguments[0]!, scope, pc)
        const selected = yield* effect(() => {
          if (name === undefined || !review.calls.some((call) => call.tool === name && call.span.start === expression.span.start)) stop("out-of-plan", expression.span)
          const tool = review.environment.tools[name]
          if (tool === undefined || !review.environment.granted.has(name)) stop("out-of-plan", expression.span)
          const count = (callCounts.get(name) ?? 0) + 1
          if (count > (review.maximumCalls[name] ?? 0)) stop("budget", expression.span)
          callCounts.set(name, count)
          if (Result.isFailure(Schema.decodeUnknownResult(tool.contract.input, { onExcessProperty: "error" })(argument.tracked.value))) stop("dynamic-type-error", expression.span)
          for (const [field, identity] of Object.entries(tool.requires ?? {})) {
            const decoder = Object.values(review.environment.decoders).find((decoder) => decoderIdentity(decoder) === identity), input = argument.children.get(field)
            if (decoder === undefined || input === undefined || !hasRefinement(input.tracked, decoder)) stop("refinement", expression.span)
          }
          return { name, tool }
        }, expression.span)
        const response = yield* host.resolve(selected.name, argument.tracked.value, combine(pc.label, argument.tracked.label)).pipe(Effect.mapError(() => new PrototypeStop({ reason: "host-result", span: expression.span })))
        return yield* effect(() => {
          const receipt = Schema.decodeUnknownResult(Receipt, { onExcessProperty: "error" })(response)
          if (Result.isFailure(receipt)) stop("host-result", expression.span)
          const label = new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [`${selected.name}@${expression.span.start}`] })
          const received = receipt.success
          if (received.state === "done") {
            const decoded = Schema.decodeUnknownResult(selected.tool.contract.outcome, { onExcessProperty: "error" })(received.result)
            if (Result.isFailure(decoded)) stop("host-result", expression.span)
            const raw = Schema.decodeUnknownResult(Schema.Json)(decoded.success)
            if (Result.isFailure(raw)) stop("host-result", expression.span)
            const owned = labeledValue(raw.success, combine(label, pc.label, argument.tracked.label))
            if (Result.isFailure(Schema.decodeUnknownResult(Schema.toType(selected.tool.contract.outcome))(owned.value))) stop("host-result", expression.span)
            return variant("done", [["id", tracked(labeledValue(received.id, label))], ["result", boundary(owned, Schema.toType(selected.tool.contract.outcome).ast, expression.span)]], [tracked(labeledValue(false, label))])
          }
          if (received.state === "staged") return variant("staged", [["id", tracked(labeledValue(received.id, label))]], [tracked(labeledValue(false, label))])
          return variant("refused", [["refusal", record(new Map([["code", tracked(labeledValue(received.refusal.code, label))], ["message", tracked(labeledValue(received.refusal.message, label))]]))]], [tracked(labeledValue(false, label))])
        }, expression.span)
      }
    }
  })
  const statements = (body: readonly Statement[], outer: Scope, control: TrackedValue): Effect.Effect<{ returned: boolean; value: Box }, PrototypeStop, R> => Effect.gen(function* () {
    const scope = new Map(outer); let pc = control
    for (const statement of body) {
      switch (statement.kind) {
        case "LetStatement": scope.set(statement.name, yield* evaluate(statement.value, scope, pc)); break
        case "ExpressionStatement": { const value = yield* evaluate(statement.expression, scope, pc); pc = deriveValue(false, pc, value.tracked); break }
        case "ReturnStatement": return { returned: true, value: statement.value === undefined ? variant("none") : yield* evaluate(statement.value, scope, pc) }
        case "AssertStatement": return yield* Effect.fail(new PrototypeStop({ reason: "dynamic-type-error", span: statement.span }))
        case "IfStatement": {
          const test = yield* evaluate(statement.test, scope, pc)
          pc = deriveValue(false, pc, test.tracked)
          const condition = yield* effect(() => boolean(test, statement.span), statement.span)
          const branch = yield* statements(condition ? statement.consequent : statement.alternate ?? [], scope, pc)
          if (branch.returned) return branch
          break
        }
        case "ForStatement": {
          if (statement.iteration !== "list") return yield* Effect.fail(new PrototypeStop({ reason: "dynamic-type-error", span: statement.span }))
          const source = yield* evaluate(statement.source, scope, pc)
          if (!Array.isArray(source.tracked.value)) return yield* Effect.fail(new PrototypeStop({ reason: "dynamic-type-error", span: statement.span }))
          pc = deriveValue(false, pc, source.tracked)
          for (let index = 0; index < source.tracked.value.length; index++) {
            if (++iterations > review.environment.maxIterations) return yield* Effect.fail(new PrototypeStop({ reason: "budget", span: statement.span }))
            const scopeForItem = new Map(scope); scopeForItem.set(statement.variable, source.children.get(index)!)
            const child = yield* statements(statement.body, scopeForItem, pc)
            if (child.returned) return child
          }
          break
        }
      }
    }
    return { returned: false, value: variant("none") }
  })
  return (yield* statements(review.program.body, new Map(), empty())).value.tracked.value
})

const Receipt = Schema.Union([
  Schema.Struct({ state: Schema.Literal("done"), id: Schema.String, result: Schema.Json, wayBack: Schema.optionalKey(Schema.Json) }),
  Schema.Struct({ state: Schema.Literal("staged"), id: Schema.String }),
  Schema.Struct({ state: Schema.Literal("refused"), refusal: Schema.Struct({ code: Schema.String, message: Schema.String }) })
])
