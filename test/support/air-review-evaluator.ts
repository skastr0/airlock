import { Effect, Result, Schema } from "effect"
import { attestValue, decodeValue, deriveValue, hasRefinement, labeledValue, projectValue, type TrackedValue } from "../../src/core/contract/Decoder.ts"
import { combine, InformationLabel } from "../../src/core/labels/Labels.ts"
import type { Expression, Span, Statement } from "../../src/core/language/ast.ts"
import { DurationSchema, SpanSchema } from "../../src/core/language/ast.ts"
import { decoderIdentity, encodeConstructedInput, staticPath, type Review } from "./air-review.ts"
import { acceptsLiteral, hasSameSchema, modelSchema, type SchemaModel } from "../../src/core/contract/SchemaModel.ts"
import type { ToolFlow } from "../../src/core/contract/Flow.ts"
import { HeldReference } from "../../src/core/contract/ToolHost.ts"

export class PrototypeStop extends Schema.TaggedError<PrototypeStop>()("PrototypeStop", {
  reason: Schema.Literals(["dynamic-type-error", "host-result", "budget", "out-of-plan", "refinement", "value-limit", "arithmetic_failure", "index_out_of_range", "range_bound", "assert_failed"]), span: SpanSchema
}) {}
export interface CallObservation {
  readonly tool: string
  readonly span: Span
  readonly fields: Readonly<Record<string, InformationLabel>>
  readonly argument: InformationLabel
  readonly control: InformationLabel
}
export interface PrototypeHost<E = never, R = never> {
  readonly observe?: (call: CallObservation) => void
  readonly resolve: (tool: string, input: Schema.Json, control: InformationLabel) => Effect.Effect<Schema.Json, E, R>
}
interface Box { readonly tracked: TrackedValue; readonly children: ReadonlyMap<string | number, Box>; readonly duration?: boolean; readonly influence?: InformationLabel; readonly constructed?: boolean; readonly selectionLabel?: InformationLabel }
type Scope = ReadonlyMap<string, Box>
const literalLabel = new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [] })
const durationModel = modelSchema(DurationSchema, { identity: "language.Duration", side: "decoded" })
const empty = () => labeledValue(false, literalLabel)
const stop: (reason: PrototypeStop["reason"], span: Span) => never = (reason, span) => { throw new PrototypeStop({ reason, span }) }

/** Dynamic checks are deliberately retained, even after successful review. */
export const runReviewedPrototype = <E, R>(review: Review, host: PrototypeHost<E, R>): Effect.Effect<Schema.Json, PrototypeStop, R> => Effect.gen(function* () {
  const callCounts = new Map<string, number>()
  let iterations = 0, fuel = 20_000
  const effect = <A>(body: () => A, span: Span): Effect.Effect<A, PrototypeStop> => Effect.try({ try: body, catch: (error) => error instanceof PrototypeStop ? error : new PrototypeStop({ reason: "dynamic-type-error", span }) })
  const labelOf = (box: Box): InformationLabel => combine(box.tracked.label, box.influence ?? literalLabel)
  // Selection changes influence, not the selected JSON or its exact-value proof.
  const influenced = (box: Box, ...parents: readonly Box[]): Box => {
    const influence = combine(labelOf(box), ...parents.map(labelOf))
    return { ...box, influence, ...(box.selectionLabel === undefined ? {} : { selectionLabel: combine(box.selectionLabel, ...parents.map(labelOf)) }), children: new Map([...box.children].map(([key, child]) => [key, influenced(child, ...parents)])) }
  }
  const primitive = (value: Schema.Json, parents: readonly Box[] = []): Box => ({ tracked: parents.length === 0 ? labeledValue(value, literalLabel) : deriveValue(value, parents[0]!.tracked, ...parents.slice(1).map((parent) => parent.tracked), ...parents.map((parent) => labeledValue(false, labelOf(parent)))), children: new Map() })
  const record = (children: ReadonlyMap<string | number, Box>): Box => {
    const raw: Record<string, Schema.Json> = {}
    for (const [name, child] of children) Object.defineProperty(raw, name, { value: child.tracked.value, enumerable: true })
    return { ...primitive(raw, [...children.values()]), children, constructed: true }
  }
  const list = (items: readonly Box[]): Box => ({ ...primitive(items.map((item) => item.tracked.value), items), children: new Map(items.map((item, index) => [index, item])), selectionLabel: literalLabel })
  const variant = (state: string, fields: ReadonlyArray<readonly [string, Box]> = [], parents: readonly Box[] = []): Box => record(new Map([["state", primitive(state, parents)], ...fields]))
  const tracked = (value: TrackedValue): Box => ({ tracked: value, children: new Map() })
  interface Origin { readonly path: string; readonly field: string; readonly flow: ToolFlow; readonly dependencies: InformationLabel }
  const sourceLabel = (origin: Origin) => combine(
    origin.flow.sources[origin.field] ?? origin.flow.sources["$"] ?? new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [] }),
    origin.dependencies,
    new InformationLabel({ confidentiality: "public", integrity: "runtime", provenance: [origin.path] })
  )
  const boundary = (source: TrackedValue, model: SchemaModel, span: Span, origin?: Origin): Box => {
    if (origin !== undefined) source = labeledValue(source.value, sourceLabel(origin))
    const value = source.value
    if (hasSameSchema(model, durationModel)) return { ...tracked(source), duration: true }
    if (model.kind === "nominal") return model.base === undefined ? tracked(source) : boundary(source, model.base, span, origin)
    if (model.kind === "record") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) stop("host-result", span)
      const children = new Map<string | number, Box>()
      for (const [name, field] of Object.entries(model.fields)) {
        const present = Object.hasOwn(value, name)
        if (!present && !field.optional) stop("host-result", span)
        const childOrigin = origin === undefined ? undefined : { ...origin, path: `${origin.path}.${name}`, field: origin.field === "$" ? name : origin.field }
        children.set(name, present ? boundary(projectValue(source, name), field.type, span, childOrigin) : tracked(labeledValue(null, childOrigin === undefined ? source.label : sourceLabel(childOrigin))))
      }
      return { tracked: origin === undefined ? source : labeledValue(source.value, combine(source.label, ...[...children.values()].map(labelOf))), children }
    }
    if (model.kind === "list") {
      if (!Array.isArray(value) || value.length > review.environment.maxListItems) stop("value-limit", span)
      const children = new Map(value.map((_, index) => [index, boundary(projectValue(source, index), model.item, span, origin === undefined ? undefined : { ...origin, path: `${origin.path}[]` })]))
      return { tracked: origin === undefined ? source : labeledValue(source.value, combine(source.label, ...[...children.values()].map(labelOf))), children, selectionLabel: source.label }
    }
    if (model.kind === "union") {
      const matching = model.members.find((member) => acceptsLiteral(member, value))
      if (matching === undefined) stop("host-result", span)
      return boundary(source, matching, span, origin)
    }
    if (value === null && model.kind === "literal" && model.value === null) return tracked(source)
    if (value === null || typeof value === "object" || (typeof value === "number" && !Number.isFinite(value))) stop("host-result", span)
    return tracked(source)
  }
  const boolean = (value: Box, span: Span): boolean => { if (typeof value.tracked.value !== "boolean") stop("dynamic-type-error", span); return value.tracked.value }
  const equal = (a: Schema.Json, b: Schema.Json): boolean => {
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b)
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]!))
    if (Array.isArray(a) || Array.isArray(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(Reflect.get(a, key), Reflect.get(b, key)))
  }
  const millis = (box: Box, span: Span) => {
    const value = Schema.decodeUnknownSync(DurationSchema)(box.tracked.value)
    const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
    const result = value.value * factors[value.unit]
    if (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result))) stop("arithmetic_failure", span)
    return result
  }
  const equalBoxes = (a: Box, b: Box, span: Span): boolean => {
    if (a.duration === true || b.duration === true) return a.duration === true && b.duration === true && millis(a, span) === millis(b, span)
    const left = a.tracked.value, right = b.tracked.value
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return Object.is(left, right)
    if (Array.isArray(left) !== Array.isArray(right)) return false
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every((key) => {
      if (!Object.hasOwn(right, key)) return false
      const selector = Array.isArray(left) ? Number(key) : key
      const x = a.children.get(selector), y = b.children.get(selector)
      return x === undefined || y === undefined ? equal(Reflect.get(left, key), Reflect.get(right, key)) : equalBoxes(x, y, span)
    })
  }
  const evaluate = (expression: Expression, scope: Scope, pc: TrackedValue): Effect.Effect<Box, PrototypeStop, R> => Effect.gen(function* () {
    if (--fuel < 0) return yield* Effect.fail(new PrototypeStop({ reason: "budget", span: expression.span }))
    switch (expression.kind) {
      case "LiteralExpression": return yield* effect(() => { if (typeof expression.value === "object" && expression.value !== null) { const value = { ...primitive({ kind: "Duration", value: expression.value.value, unit: expression.value.unit }), duration: true }; millis(value, expression.span); return value }; return primitive(expression.value) }, expression.span)
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
          if (selected === undefined) stop("index_out_of_range", expression.span)
          return influenced(selected, index, tracked(labeledValue(false, object.selectionLabel ?? literalLabel)))
        }, expression.span)
      }
      case "UnaryExpression": {
        const operand = yield* evaluate(expression.operand, scope, pc)
        return yield* effect(() => {
          if (expression.operator === "!") return primitive(!boolean(operand, expression.span), [operand])
          if (typeof operand.tracked.value !== "number") stop("dynamic-type-error", expression.span)
          const value = -operand.tracked.value
          if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) stop("arithmetic_failure", expression.span)
          return primitive(value, [operand])
        }, expression.span)
      }
      case "BinaryExpression": {
        const left = yield* evaluate(expression.left, scope, pc)
        if (expression.operator === "&&" && !boolean(left, expression.span)) return left
        if (expression.operator === "||" && boolean(left, expression.span)) return left
        const right = yield* evaluate(expression.right, scope, labeledValue(false, combine(pc.label, labelOf(left))))
        return yield* effect(() => {
          const a = left.tracked.value, b = right.tracked.value
          if (left.duration === true && right.duration === true) {
            const x = millis(left, expression.span), y = millis(right, expression.span)
            const result = expression.operator === "==" ? x === y : expression.operator === "!=" ? x !== y : expression.operator === "<" ? x < y : expression.operator === "<=" ? x <= y : expression.operator === ">" ? x > y : expression.operator === ">=" ? x >= y : undefined
            if (result === undefined) stop("dynamic-type-error", expression.span)
            return primitive(result, [left, right])
          }
          if (expression.operator === "==" || expression.operator === "!=") {
            const same = equalBoxes(left, right, expression.span)
            return primitive(expression.operator === "==" ? same : !same, [left, right])
          }
          if (typeof a !== typeof b || a === null || typeof a === "object" || b === null || typeof b === "object") stop("dynamic-type-error", expression.span)
          switch (expression.operator) {
            case "&&": case "||": return primitive(boolean(right, expression.span), [left, right])
            case "<": return primitive(a < b, [left, right])
            case "<=": return primitive(a <= b, [left, right])
            case ">": return primitive(a > b, [left, right])
            case ">=": return primitive(a >= b, [left, right])
            case "+": if (typeof a === "string" && typeof b === "string") return primitive(a + b, [left, right]); break
            case "-": case "*": case "/": break
            default: return stop("dynamic-type-error", expression.span)
          }
          if (typeof a !== "number" || typeof b !== "number") stop("dynamic-type-error", expression.span)
          if (expression.operator === "/" && b === 0) stop("arithmetic_failure", expression.span)
          const value = expression.operator === "+" ? a + b : expression.operator === "-" ? a - b : expression.operator === "*" ? a * b : a / b
          if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) stop("arithmetic_failure", expression.span)
          return primitive(value, [left, right])
        }, expression.span)
      }
      case "CallExpression": {
        const name = staticPath(expression.callee)
        if (name === "at") {
          const object = yield* evaluate(expression.arguments[0]!, scope, pc), index = yield* evaluate(expression.arguments[1]!, scope, pc)
          return yield* effect(() => {
            if (!Array.isArray(object.tracked.value) || typeof index.tracked.value !== "number") stop("dynamic-type-error", expression.span)
            const selected = Number.isSafeInteger(index.tracked.value) ? object.children.get(index.tracked.value) : undefined
            return selected === undefined ? primitive(null, [index, tracked(labeledValue(false, object.selectionLabel ?? literalLabel))]) : influenced(selected, index, tracked(labeledValue(false, object.selectionLabel ?? literalLabel)))
          }, expression.span)
        }
        if (name === "decode") {
          const handle = staticPath(expression.arguments[0]!), decoder = handle === undefined ? undefined : review.environment.decoders[handle.slice(7)]
          const source = yield* evaluate(expression.arguments[1]!, scope, pc)
          return yield* effect(() => {
            if (decoder === undefined) stop("out-of-plan", expression.span)
            const result = decodeValue(decoder, source.tracked)
            return Result.isFailure(result) ? variant("err", [["error", primitive(result.failure.reason, [source])]], [source]) : variant("ok", [["value", influenced(boundary(result.success, modelSchema(decoder.schema, { identity: decoderIdentity(decoder), side: "decoded" }), expression.span), source)]], [source])
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
          const input = argument.constructed ? encodeConstructedInput(argument.tracked.value, tool.contract.model.input) : argument.tracked.value
          if (Result.isFailure(Schema.decodeUnknownResult(tool.contract.input, { onExcessProperty: "error" })(input))) stop("dynamic-type-error", expression.span)
          const requirements: ToolFlow["requires"] = tool.contract.flow.requires
          for (const [field, identities] of Object.entries(requirements)) {
            const input = argument.children.get(field)
            for (const identity of identities) {
              const decoder = review.environment.decoders[identity.name]
              if (decoder === undefined || decoder.version !== identity.version || input === undefined || !hasRefinement(input.tracked, decoder)) stop("refinement", expression.span)
            }
          }
          return { name, tool, input }
        }, expression.span)
        yield* effect(() => host.observe?.({
          tool: selected.name, span: expression.span, argument: labelOf(argument), control: pc.label,
          fields: Object.fromEntries([...argument.children].filter(([field]) => typeof field === "string" && selected.input !== null && typeof selected.input === "object" && Object.hasOwn(selected.input, field)).map(([field, child]) => [field, labelOf(child)]))
        }), expression.span)
        const response = yield* host.resolve(selected.name, selected.input, combine(pc.label, labelOf(argument))).pipe(Effect.catchCause(() => Effect.fail(new PrototypeStop({ reason: "host-result", span: expression.span }))))
        return yield* effect(() => {
          const receipt = Schema.decodeUnknownResult(Receipt, { onExcessProperty: "error" })(response)
          if (Result.isFailure(receipt)) stop("host-result", expression.span)
          const wire = Schema.decodeUnknownResult(Schema.toEncoded(Receipt), { onExcessProperty: "error" })(response)
          if (Result.isFailure(wire)) stop("host-result", expression.span)
          const label = combine(new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [`${selected.name}@${expression.span.start}.state`] }), pc.label, labelOf(argument))
          const receiptField = (field: string, value: Schema.Json) => tracked(labeledValue(value, combine(new InformationLabel({ confidentiality: "private", integrity: "untrusted", provenance: [`${selected.name}@${expression.span.start}.${field}`] }), pc.label, labelOf(argument))))
          const received = receipt.success
          if (received.state === "done") {
            const decoded = Schema.decodeUnknownResult(selected.tool.contract.outcome, { onExcessProperty: "error" })(received.result)
            if (Result.isFailure(decoded)) stop("host-result", expression.span)
            const raw = Schema.decodeUnknownResult(Schema.Json)(decoded.success)
            if (Result.isFailure(raw)) stop("host-result", expression.span)
            const owned = labeledValue(raw.success, combine(label, pc.label, labelOf(argument)))
            if (Result.isFailure(Schema.decodeUnknownResult(Schema.toType(selected.tool.contract.outcome))(owned.value))) stop("host-result", expression.span)
            let result = boundary(owned, selected.tool.contract.model.output, expression.span, { path: `${selected.name}@${expression.span.start}.result`, field: "$", flow: selected.tool.contract.flow, dependencies: combine(pc.label, labelOf(argument)) })
            const provides: ToolFlow["provides"] = selected.tool.contract.flow.provides
            for (const [field, identities] of Object.entries(provides)) {
              if (field !== "$" && (result.tracked.value === null || typeof result.tracked.value !== "object" || !Object.hasOwn(result.tracked.value, field))) continue
              let value = field === "$" ? result : result.children.get(field)
              if (value === undefined) continue
              for (const identity of identities) {
                const decoder = review.environment.decoders[identity.name]
                if (decoder === undefined || decoder.version !== identity.version) stop("out-of-plan", expression.span)
                const attested: ReturnType<typeof attestValue> = attestValue(value.tracked, decoder)
                if (Result.isFailure(attested)) stop("host-result", expression.span)
                value = { ...value, tracked: attested.success }
              }
              if (field === "$") result = value
              else { const children = new Map(result.children); children.set(field, value); result = { ...result, children } }
            }
            const wayBackLabel = combine(new InformationLabel({ confidentiality: "private", integrity: "runtime", provenance: [`${selected.name}@${expression.span.start}.wayBack`] }), pc.label, labelOf(argument))
            const held = wire.success.state === "done" ? wire.success.wayBack : undefined
            const wayBack = held === undefined ? tracked(labeledValue(null, wayBackLabel)) : boundary(labeledValue(held, wayBackLabel), modelSchema(HeldReference, { identity: "receipt.wayBack", side: "encoded" }), expression.span, { path: `${selected.name}@${expression.span.start}.wayBack`, field: "$", flow: { sources: { "$": new InformationLabel({ confidentiality: "private", integrity: "runtime", provenance: [] }) }, sinks: [], requires: {}, provides: {} }, dependencies: combine(pc.label, labelOf(argument)) })
            return variant("done", [["id", receiptField("id", received.id)], ["result", result], ["wayBack", wayBack]], [tracked(labeledValue(false, label))])
          }
          if (received.state === "staged") return variant("staged", [["id", receiptField("id", received.id)]], [tracked(labeledValue(false, label))])
          return variant("refused", [["refusal", record(new Map([["code", receiptField("refusal.code", received.refusal.code)], ["message", receiptField("refusal.message", received.refusal.message)]]))]], [tracked(labeledValue(false, label))])
        }, expression.span)
      }
    }
  })
  const statements = (body: readonly Statement[], outer: Scope, control: TrackedValue): Effect.Effect<{ returned: boolean; value: Box; control: TrackedValue }, PrototypeStop, R> => Effect.gen(function* () {
    const scope = new Map(outer); let pc = control
    for (const statement of body) {
      switch (statement.kind) {
        case "LetStatement": scope.set(statement.name, yield* evaluate(statement.value, scope, pc)); break
        case "ExpressionStatement": { const value = yield* evaluate(statement.expression, scope, pc); pc = labeledValue(false, combine(pc.label, labelOf(value))); break }
        case "ReturnStatement": return { returned: true, control: pc, value: statement.value === undefined ? primitive(null) : yield* evaluate(statement.value, scope, pc) }
        case "AssertStatement": {
          const condition = yield* evaluate(statement.test, scope, pc)
          const passed = yield* effect(() => boolean(condition, statement.span), statement.span)
          if (!passed) {
            if (statement.message !== undefined) yield* evaluate(statement.message, scope, pc)
            return yield* Effect.fail(new PrototypeStop({ reason: "assert_failed", span: statement.span }))
          }
          pc = labeledValue(false, combine(pc.label, labelOf(condition)))
          break
        }
        case "IfStatement": {
          const test = yield* evaluate(statement.test, scope, pc)
          pc = labeledValue(false, combine(pc.label, labelOf(test)))
          const condition = yield* effect(() => boolean(test, statement.span), statement.span)
          const branch = yield* statements(condition ? statement.consequent : statement.alternate ?? [], scope, pc)
          if (branch.returned) return branch
          pc = branch.control
          break
        }
        case "ForStatement": {
          if (statement.iteration === "range") {
            const from = yield* evaluate(statement.from, scope, pc), to = yield* evaluate(statement.to, scope, pc)
            const endpoints = yield* effect(() => {
              if (typeof from.tracked.value !== "number" || typeof to.tracked.value !== "number") stop("dynamic-type-error", statement.span)
              if (!Number.isSafeInteger(from.tracked.value) || !Number.isSafeInteger(to.tracked.value)) stop("range_bound", statement.span)
              return { from: from.tracked.value, to: to.tracked.value }
            }, statement.span)
            pc = labeledValue(false, combine(pc.label, labelOf(from), labelOf(to)))
            for (let index = endpoints.from; index < endpoints.to; index++) {
              if (++iterations > review.environment.maxIterations) return yield* Effect.fail(new PrototypeStop({ reason: "budget", span: statement.span }))
              const inner = new Map(scope); inner.set(statement.variable, primitive(index, [from, to]))
              const child = yield* statements(statement.body, inner, pc); if (child.returned) return child; pc = child.control
            }
            break
          }
          const source = yield* evaluate(statement.source, scope, pc)
          if (!Array.isArray(source.tracked.value)) return yield* Effect.fail(new PrototypeStop({ reason: "dynamic-type-error", span: statement.span }))
          pc = labeledValue(false, combine(pc.label, labelOf(source)))
          for (let index = 0; index < source.tracked.value.length; index++) {
            if (++iterations > review.environment.maxIterations) return yield* Effect.fail(new PrototypeStop({ reason: "budget", span: statement.span }))
            const scopeForItem = new Map(scope); scopeForItem.set(statement.variable, source.children.get(index)!)
            const child = yield* statements(statement.body, scopeForItem, pc)
            if (child.returned) return child
            pc = child.control
          }
          break
        }
      }
    }
    return { returned: false, value: primitive(null), control: pc }
  })
  const bindings = yield* effect(() => {
    const scope = new Map<string, Box>()
    for (const [name, binding] of Object.entries(review.environment.bindings ?? {})) {
      const decoded = Schema.decodeUnknownResult(binding.schema, { onExcessProperty: "error" })(binding.value)
      if (Result.isFailure(decoded)) stop("host-result", review.program.span)
      const json = Schema.decodeUnknownResult(Schema.Json)(decoded.success)
      if (Result.isFailure(json)) stop("host-result", review.program.span)
      const owned = labeledValue(json.success, binding.label)
      if (Result.isFailure(Schema.decodeUnknownResult(Schema.toType(binding.schema))(owned.value))) stop("host-result", review.program.span)
      scope.set(name, boundary(owned, modelSchema(binding.schema, { identity: JSON.stringify(["binding", name]), side: "decoded" }), review.program.span, {
        path: `binding.${name}`, field: "$", flow: { sources: { "$": binding.label }, sinks: [], requires: {}, provides: {} }, dependencies: literalLabel
      }))
    }
    return scope
  }, review.program.span)
  return (yield* statements(review.program.body, bindings, empty())).value.tracked.value
})

const Receipt = Schema.Union([
  Schema.Struct({ state: Schema.Literal("done"), id: Schema.String, result: Schema.Json, wayBack: Schema.optionalKey(HeldReference) }),
  Schema.Struct({ state: Schema.Literal("staged"), id: Schema.String }),
  Schema.Struct({ state: Schema.Literal("refused"), refusal: Schema.Struct({ code: Schema.String, message: Schema.String }) })
])
