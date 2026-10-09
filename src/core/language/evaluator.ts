import { Effect, Schema } from "effect"
import type { Duration, Expression, Program, Span, Statement } from "./ast.ts"
import { DurationSchema, SpanSchema } from "./ast.ts"
import { DuplicateBinding, validateBindings } from "./bindings.ts"

/**
 * The evaluator is a candidate language component, not a capability source.
 * Its only effect boundary is an injected ActionResolver.  Parsing, values,
 * control flow, and arithmetic remain pure and portable across runtimes.
 */

export type LanguageScalar = string | number | boolean | null | Duration
export interface LanguageList extends ReadonlyArray<LanguageValue> {}
export interface LanguageRecord { readonly [key: string]: LanguageValue }
export type LanguageValue = LanguageScalar | LanguageList | LanguageRecord

export const LanguageValueSchema: Schema.Codec<LanguageValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    DurationSchema,
    Schema.Array(LanguageValueSchema),
    Schema.Record(Schema.String, LanguageValueSchema)
  ])
).annotate({
  identifier: "AirlockLanguageValue",
  description: "A recursive Airlock language value."
})

export class EvaluationResult extends Schema.Class<EvaluationResult>("EvaluationResult")({
  returned: Schema.Boolean,
  value: LanguageValueSchema
}) {}

export class UnboundIdentifier extends Schema.TaggedError<UnboundIdentifier>()(
  "UnboundIdentifier",
  { name: Schema.String, span: SpanSchema }
) {}

export class InvalidLanguageOperation extends Schema.TaggedError<InvalidLanguageOperation>()(
  "InvalidLanguageOperation",
  { operation: Schema.String, detail: Schema.String, span: SpanSchema }
) {}

export class InvalidCallTarget extends Schema.TaggedError<InvalidCallTarget>()(
  "InvalidCallTarget",
  { detail: Schema.String, span: SpanSchema }
) {}

export class MissingRecordField extends Schema.TaggedError<MissingRecordField>()(
  "MissingRecordField",
  { field: Schema.String, span: SpanSchema }
) {}

export class InvalidIndex extends Schema.TaggedError<InvalidIndex>()(
  "InvalidIndex",
  { detail: Schema.String, span: SpanSchema }
) {}

export class IndexOutOfRange extends Schema.TaggedError<IndexOutOfRange>()("IndexOutOfRange", { span: SpanSchema }) {}
export class RangeBound extends Schema.TaggedError<RangeBound>()("RangeBound", { span: SpanSchema }) {}
export class ArithmeticFailure extends Schema.TaggedError<ArithmeticFailure>()("ArithmeticFailure", {
  fault: Schema.Literals(["zero", "overflow"]), span: SpanSchema
}) {}

export class AssertionFailed extends Schema.TaggedError<AssertionFailed>()(
  "AssertionFailed",
  { message: Schema.String, span: SpanSchema }
) {}

export class DuplicateRecordField extends Schema.TaggedError<DuplicateRecordField>()(
  "DuplicateRecordField",
  { field: Schema.String, span: SpanSchema }
) {}

export class LoopLimitExceeded extends Schema.TaggedError<LoopLimitExceeded>()(
  "LoopLimitExceeded",
  { limit: Schema.Number, span: SpanSchema }
) {}

export class StepLimitExceeded extends Schema.TaggedError<StepLimitExceeded>()(
  "StepLimitExceeded",
  { limit: Schema.Number, span: SpanSchema }
) {}

/** A value the program built passed a limit its host set. */
export class ValueLimitExceeded extends Schema.TaggedError<ValueLimitExceeded>()(
  "ValueLimitExceeded",
  { limit: Schema.Number, measure: Schema.Literals(["string-length", "nodes", "total-nodes", "total-string-units"]), span: SpanSchema }
) {}

export type EvaluationError =
  | DuplicateBinding
  | UnboundIdentifier
  | InvalidLanguageOperation
  | InvalidCallTarget
  | MissingRecordField
  | InvalidIndex
  | IndexOutOfRange
  | RangeBound
  | ArithmeticFailure
  | AssertionFailed
  | DuplicateRecordField
  | LoopLimitExceeded
  | StepLimitExceeded
  | ValueLimitExceeded

/** The sole language-to-world seam; resolvers are supplied by the runtime. */
export interface ActionResolver<R = never, E = never> {
  readonly resolve: (
    action: string,
    args: readonly LanguageValue[]
  ) => Effect.Effect<LanguageValue, E, R>
}

export interface EvaluateOptions {
  /** Statements, expressions and loop iterations share this execution budget. */
  readonly maxSteps?: number
  /** One shared safety budget consumed by every visited list or range item. */
  readonly maxLoopIterations?: number
  /**
   * Longest string `+` may build, in UTF-16 units. Unset means no limit; a
   * host that evaluates untrusted programs in its own process sets it.
   */
  readonly maxStringLength?: number
  /**
   * Most nodes (scalars, lists and records, counted through every reference)
   * any one list or record may hold. Values are immutable and may share
   * structure, so without this a short program can describe a value whose
   * traversal is exponential. Unset means no limit.
   */
  readonly maxValueNodes?: number
  /** Conservative node total across live binding roots, counting each alias. */
  readonly maxTotalNodes?: number
  /** UTF-16 string units (including record keys) across live binding roots. */
  readonly maxTotalStringUnits?: number
  /** Explicit non-privileged values made available to the program. */
  readonly bindings?: Readonly<Record<string, LanguageValue>>
}

type Scope = ReadonlyMap<string, LanguageValue>
type Control = { readonly returned: boolean; readonly value: LanguageValue }
interface LoopBudget {
  readonly limit: number
  used: number
  readonly maxStringLength: number | undefined
  readonly maxValueNodes: number | undefined
  /** Node counts of values already measured, so a shared value is counted once per use, not walked. */
  readonly sizes: WeakMap<object, number>
  readonly stringSizes: WeakMap<object, number>
  readonly retained: WeakMap<Scope, { readonly nodes: number; readonly strings: number }>
  readonly maxTotalNodes: number | undefined
  readonly maxTotalStringUnits: number | undefined
  readonly maxSteps: number
  steps: number
}
const normal = (value: LanguageValue = null): Control => ({ returned: false, value })
const returned = (value: LanguageValue): Control => ({ returned: true, value })
const defaultLoopLimit = 10_000
const defaultStepLimit = 100_000

const consumeStep = (budget: LoopBudget, span: Span): Effect.Effect<void, StepLimitExceeded> =>
  Effect.suspend(() => budget.steps >= budget.maxSteps
    ? Effect.fail(new StepLimitExceeded({ limit: budget.maxSteps, span }))
    : Effect.sync(() => { budget.steps++ }))

const durationMillis = (value: Duration): number => {
  const factor: Record<Duration["unit"], number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return value.value * factor[value.unit]
}

const isDuration = (value: LanguageValue): value is Duration =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value && value.kind === "Duration"

const isRecord = (value: LanguageValue): value is Readonly<Record<string, LanguageValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isDuration(value)

const freezeValue = (value: LanguageValue): LanguageValue => {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue))
  if (isDuration(value)) return Object.freeze({ kind: "Duration" as const, value: value.value, unit: value.unit })
  if (isRecord(value)) {
    const result: Record<string, LanguageValue> = Object.create(null)
    for (const [key, item] of Object.entries(value)) result[key] = freezeValue(item)
    return Object.freeze(result)
  }
  return value
}

const invalid = (operation: string, detail: string, span: Span) =>
  new InvalidLanguageOperation({ operation, detail, span })

const nodesOf = (value: LanguageValue, budget: LoopBudget, limit: number): number => {
  if (typeof value !== "object" || value === null) return 1
  const known = budget.sizes.get(value)
  if (known !== undefined) return known
  let nodes = 1
  for (const item of Array.isArray(value) ? value : Object.values(value as LanguageRecord)) {
    nodes += nodesOf(item, budget, limit)
    if (nodes > limit) break
  }
  budget.sizes.set(value, nodes)
  return nodes
}

const stringUnitsOf = (value: LanguageValue, budget: LoopBudget, limit: number): number => {
  if (typeof value === "string") return value.length
  if (typeof value !== "object" || value === null) return 0
  const known = budget.stringSizes.get(value)
  if (known !== undefined) return known
  let units = 0
  for (const [key, child] of Object.entries(value)) {
    units += (Array.isArray(value) ? 0 : key.length) + stringUnitsOf(child, budget, limit)
    if (units > limit) break
  }
  budget.stringSizes.set(value, units)
  return units
}

const retainedWith = (scope: Scope, value: LanguageValue, budget: LoopBudget) => {
  const current = budget.retained.get(scope) ?? { nodes: 0, strings: 0 }
  return {
    nodes: current.nodes + (budget.maxTotalNodes === undefined ? 0 : nodesOf(value, budget, budget.maxTotalNodes)),
    strings: current.strings + (budget.maxTotalStringUnits === undefined ? 0 : stringUnitsOf(value, budget, budget.maxTotalStringUnits))
  }
}

const withinTotal = <Value extends LanguageValue>(value: Value, scope: Scope, budget: LoopBudget, span: Span): Effect.Effect<Value, ValueLimitExceeded> => {
  const next = retainedWith(scope, value, budget)
  if (budget.maxTotalNodes !== undefined && next.nodes > budget.maxTotalNodes) return Effect.fail(new ValueLimitExceeded({ limit: budget.maxTotalNodes, measure: "total-nodes", span }))
  if (budget.maxTotalStringUnits !== undefined && next.strings > budget.maxTotalStringUnits) return Effect.fail(new ValueLimitExceeded({ limit: budget.maxTotalStringUnits, measure: "total-string-units", span }))
  return Effect.succeed(value)
}

const extendScope = (scope: Scope, name: string, value: LanguageValue, budget: LoopBudget, span: Span): Effect.Effect<Scope, ValueLimitExceeded> =>
  Effect.map(withinTotal(value, scope, budget, span), () => {
    const next = new Map(scope)
    next.set(name, value)
    budget.retained.set(next, retainedWith(scope, value, budget))
    return next
  })

/** Fails if `value` holds more nodes than the host allows; otherwise returns it. */
const withinNodes = <Value extends LanguageValue>(
  value: Value,
  budget: LoopBudget,
  span: Span,
  scope?: Scope
): Effect.Effect<Value, ValueLimitExceeded> => {
  const limit = budget.maxValueNodes
  return limit === undefined || nodesOf(value, budget, limit) <= limit
    ? scope === undefined ? Effect.succeed(value) : withinTotal(value, scope, budget, span)
    : Effect.fail(new ValueLimitExceeded({ limit, measure: "nodes", span }))
}

const finiteNumber = (value: number, span: Span): Effect.Effect<number, ArithmeticFailure> =>
  Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
    ? Effect.succeed(value)
    : Effect.fail(new ArithmeticFailure({ fault: "overflow", span }))

const equal = (left: LanguageValue, right: LanguageValue): boolean => {
  if (isDuration(left) && isDuration(right)) return durationMillis(left) === durationMillis(right)
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return Object.is(left, right)
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]!))
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && equal(left[key]!, right[key]!))
  }
  return false
}

const comparable = (value: LanguageValue): value is string | number | Duration =>
  typeof value === "string" || typeof value === "number" || isDuration(value)

const compare = (left: string | number | Duration, right: string | number | Duration): number | undefined => {
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right)
  if (typeof left === "number" && typeof right === "number") return left - right
  if (isDuration(left) && isDuration(right)) return durationMillis(left) - durationMillis(right)
  return undefined
}

const truthy = (value: LanguageValue, span: Span): Effect.Effect<boolean, InvalidLanguageOperation> =>
  typeof value === "boolean"
    ? Effect.succeed(value)
    : Effect.fail(invalid("condition", "requires a boolean", span))

const ensureLoopCapacity = (
  iterations: number,
  budget: LoopBudget,
  span: Span
): Effect.Effect<void, LoopLimitExceeded> =>
  Number.isSafeInteger(iterations) &&
    iterations >= 0 &&
    iterations <= budget.limit - budget.used
    ? Effect.void
    : Effect.fail(new LoopLimitExceeded({ limit: budget.limit, span }))

const consumeLoopIteration = (
  budget: LoopBudget,
  span: Span
): Effect.Effect<void, LoopLimitExceeded> =>
  budget.used < budget.limit
    ? Effect.sync(() => {
        budget.used += 1
      })
    : Effect.fail(new LoopLimitExceeded({ limit: budget.limit, span }))

const snapshotList = (
  value: LanguageValue,
  sourceSpan: Span,
  loopSpan: Span,
  budget: LoopBudget
): Effect.Effect<LanguageList, InvalidLanguageOperation | LoopLimitExceeded> =>
  Effect.gen(function* () {
    if (!Array.isArray(value)) {
      return yield* Effect.fail(
        invalid("for", "source must evaluate to a finite list", sourceSpan)
      )
    }
    yield* ensureLoopCapacity(value.length, budget, loopSpan)
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return yield* Effect.fail(
          invalid("for", "source must be a dense finite list", sourceSpan)
        )
      }
    }
    // Every evaluator value is already deeply owned and frozen. Retain the
    // immutable snapshot instead of allocating a second copy of every item.
    return value
  })

const actionName = (expression: Expression): string | undefined =>
  expression.kind === "IdentifierExpression" ? expression.name : undefined

const evaluateStatements = <R, E>(
  statements: readonly Statement[],
  scope: Scope,
  resolver: ActionResolver<R, E>,
  budget: LoopBudget
): Effect.Effect<Control, EvaluationError | E, R> => Effect.gen(function* () {
  let local = scope
  let result = normal()
  for (const statement of statements) {
    const next = yield* evaluateStatement(statement, local, resolver, budget)
    local = next.scope
    result = next.control
    if (result.returned) break
  }
  return result
})

const evaluateStatement = <R, E>(
  statement: Statement,
  scope: Scope,
  resolver: ActionResolver<R, E>,
  budget: LoopBudget
): Effect.Effect<{ readonly scope: Scope; readonly control: Control }, EvaluationError | E, R> => Effect.gen(function* () {
  yield* consumeStep(budget, statement.span)
  switch (statement.kind) {
    case "LetStatement": {
      const value = yield* evaluateExpression(statement.value, scope, resolver, budget)
      const next = yield* extendScope(scope, statement.name, value, budget, statement.span)
      return { scope: next, control: normal(value) }
    }
    case "ExpressionStatement":
      return { scope, control: normal(yield* evaluateExpression(statement.expression, scope, resolver, budget)) }
    case "ReturnStatement":
      return { scope, control: returned(statement.value === undefined ? null : yield* evaluateExpression(statement.value, scope, resolver, budget)) }
    case "AssertStatement": {
      const condition = yield* evaluateExpression(statement.test, scope, resolver, budget)
      if (yield* truthy(condition, statement.test.span)) return { scope, control: normal(condition) }
      const message = statement.message === undefined ? "assertion failed" : yield* evaluateExpression(statement.message, scope, resolver, budget)
      return yield* Effect.fail(new AssertionFailed({ message: typeof message === "string" ? message : "assertion failed", span: statement.span }))
    }
    case "IfStatement": {
      const condition = yield* evaluateExpression(statement.test, scope, resolver, budget)
      const branch = (yield* truthy(condition, statement.test.span)) ? statement.consequent : (statement.alternate ?? [])
      const control = yield* evaluateStatements(branch, scope, resolver, budget)
      return { scope, control }
    }
    case "ForStatement": {
      if (statement.iteration === "list") {
        const evaluated = yield* evaluateExpression(
          statement.source,
          scope,
          resolver,
          budget
        )
        const items = yield* snapshotList(
          evaluated,
          statement.source.span,
          statement.span,
          budget
        )
        let control = normal()
        for (const item of items) {
          yield* consumeStep(budget, statement.span)
          yield* consumeLoopIteration(budget, statement.span)
          const scoped = yield* extendScope(scope, statement.variable, item, budget, statement.span)
          control = yield* evaluateStatements(
            statement.body,
            scoped,
            resolver,
            budget
          )
          if (control.returned) break
        }
        return { scope, control }
      }
      const from = yield* evaluateExpression(statement.from, scope, resolver, budget)
      const to = yield* evaluateExpression(statement.to, scope, resolver, budget)
      if (
        typeof from !== "number" ||
        typeof to !== "number" ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to)
      ) {
        return yield* Effect.fail(new RangeBound({ span: statement.span }))
      }
      const iterations = Math.max(0, to - from)
      yield* ensureLoopCapacity(iterations, budget, statement.span)
      let control = normal()
      for (let value = from; value < to; value++) {
        yield* consumeStep(budget, statement.span)
        yield* consumeLoopIteration(budget, statement.span)
        const scoped = yield* extendScope(scope, statement.variable, value, budget, statement.span)
        control = yield* evaluateStatements(statement.body, scoped, resolver, budget)
        if (control.returned) break
      }
      return { scope, control }
    }
  }
})

const evaluateExpression = <R, E>(
  expression: Expression,
  scope: Scope,
  resolver: ActionResolver<R, E>,
  budget: LoopBudget
): Effect.Effect<LanguageValue, EvaluationError | E, R> => Effect.gen(function* () {
  // Call nodes are charged here before their argument list is evaluated.
  yield* consumeStep(budget, expression.span)
  switch (expression.kind) {
    case "LiteralExpression":
      if (typeof expression.value === "number") return Number.isFinite(expression.value)
        ? expression.value
        : yield* Effect.fail(new ArithmeticFailure({ fault: "overflow", span: expression.span }))
      if (isDuration(expression.value)) yield* finiteNumber(durationMillis(expression.value), expression.span)
      return freezeValue(expression.value)
    case "IdentifierExpression": {
      const value = scope.get(expression.name)
      return value === undefined
        ? yield* Effect.fail(new UnboundIdentifier({ name: expression.name, span: expression.span }))
        : value
    }
    case "ListExpression":
      return yield* withinNodes(
        Object.freeze(yield* Effect.forEach(expression.items, (item) => evaluateExpression(item, scope, resolver, budget))),
        budget,
        expression.span,
        scope
      )
    case "RecordExpression": {
      const record: Record<string, LanguageValue> = Object.create(null)
      for (const entry of expression.entries) {
        if (Object.hasOwn(record, entry.key)) return yield* Effect.fail(new DuplicateRecordField({ field: entry.key, span: entry.span }))
        record[entry.key] = yield* evaluateExpression(entry.value, scope, resolver, budget)
      }
      return yield* withinNodes(Object.freeze(record), budget, expression.span, scope)
    }
    case "UnaryExpression": {
      const value = yield* evaluateExpression(expression.operand, scope, resolver, budget)
      if (expression.operator === "!") return !(yield* truthy(value, expression.span))
      if (typeof value !== "number") return yield* Effect.fail(invalid("-", "requires a number", expression.span))
      return yield* finiteNumber(-value, expression.span)
    }
    case "BinaryExpression": {
      const left = yield* evaluateExpression(expression.left, scope, resolver, budget)
      if (expression.operator === "&&") return (yield* truthy(left, expression.left.span)) ? yield* truthy(yield* evaluateExpression(expression.right, scope, resolver, budget), expression.right.span) : false
      if (expression.operator === "||") return (yield* truthy(left, expression.left.span)) ? true : yield* truthy(yield* evaluateExpression(expression.right, scope, resolver, budget), expression.right.span)
      const right = yield* evaluateExpression(expression.right, scope, resolver, budget)
      if (expression.operator === "==") return equal(left, right)
      if (expression.operator === "!=") return !equal(left, right)
      if (["<", "<=", ">", ">="].includes(expression.operator)) {
        if (!comparable(left) || !comparable(right)) return yield* Effect.fail(invalid(expression.operator, "requires comparable values of the same kind", expression.span))
        const order = compare(left, right)
        if (order === undefined) return yield* Effect.fail(invalid(expression.operator, "requires comparable values of the same kind", expression.span))
        return expression.operator === "<" ? order < 0 : expression.operator === "<=" ? order <= 0 : expression.operator === ">" ? order > 0 : order >= 0
      }
      if (expression.operator === "+" && typeof left === "string" && typeof right === "string") {
        const limit = budget.maxStringLength
        return limit === undefined || left.length + right.length <= limit
          ? left + right
          : yield* Effect.fail(new ValueLimitExceeded({ limit, measure: "string-length", span: expression.span }))
      }
      if (typeof left !== "number" || typeof right !== "number") return yield* Effect.fail(invalid(expression.operator, "requires numbers (or strings for +)", expression.span))
      if (expression.operator === "/" && right === 0) return yield* Effect.fail(new ArithmeticFailure({ fault: "zero", span: expression.span }))
      const value = expression.operator === "+" ? left + right : expression.operator === "-" ? left - right : expression.operator === "*" ? left * right : left / right
      return yield* finiteNumber(value, expression.span)
    }
    case "FieldExpression": {
      const object = yield* evaluateExpression(expression.object, scope, resolver, budget)
      if (!isRecord(object)) return yield* Effect.fail(invalid(".", "requires a record", expression.span))
      return Object.hasOwn(object, expression.field)
        ? object[expression.field]!
        : yield* Effect.fail(new MissingRecordField({ field: expression.field, span: expression.span }))
    }
    case "IndexExpression": {
      const object = yield* evaluateExpression(expression.object, scope, resolver, budget)
      const index = yield* evaluateExpression(expression.index, scope, resolver, budget)
      if (!Array.isArray(object)) return yield* Effect.fail(invalid("[]", "requires a list", expression.span))
      if (typeof index !== "number") return yield* Effect.fail(new InvalidIndex({ detail: "requires a number index", span: expression.span }))
      if (!Number.isSafeInteger(index) || index < 0 || index >= object.length) return yield* Effect.fail(new IndexOutOfRange({ span: expression.span }))
      return object[index]!
    }
    case "CallExpression": {
      const action = actionName(expression.callee)
      if (action === undefined) return yield* Effect.fail(new InvalidCallTarget({ detail: "only identifier action calls are supported", span: expression.callee.span }))
      const args = yield* Effect.forEach(expression.arguments, (argument) => evaluateExpression(argument, scope, resolver, budget))
      return yield* withinNodes(freezeValue(yield* resolver.resolve(action, Object.freeze(args))), budget, expression.span, scope)
    }
  }
})

/** Evaluates a parsed program without ambient filesystem, process, or network authority. */
export const evaluate = <R = never, E = never>(
  program: Program,
  resolver: ActionResolver<R, E>,
  options: EvaluateOptions = {}
): Effect.Effect<EvaluationResult, EvaluationError | E, R> => Effect.gen(function* () {
  yield* validateBindings(program, Object.keys(options.bindings ?? {}))
  const loopLimit = options.maxLoopIterations ?? defaultLoopLimit
  if (!Number.isSafeInteger(loopLimit) || loopLimit < 0) {
    return yield* Effect.fail(invalid("maxLoopIterations", "must be a non-negative safe integer", program.span))
  }
  for (const [name, limit] of [["maxStringLength", options.maxStringLength], ["maxValueNodes", options.maxValueNodes], ["maxSteps", options.maxSteps], ["maxTotalNodes", options.maxTotalNodes], ["maxTotalStringUnits", options.maxTotalStringUnits]] as const) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      return yield* Effect.fail(invalid(name, "must be a non-negative safe integer", program.span))
    }
  }
  const budget: LoopBudget = {
    limit: loopLimit,
    used: 0,
    maxStringLength: options.maxStringLength,
    maxValueNodes: options.maxValueNodes,
    sizes: new WeakMap(),
    stringSizes: new WeakMap(),
    retained: new WeakMap(),
    maxTotalNodes: options.maxTotalNodes,
    maxTotalStringUnits: options.maxTotalStringUnits,
    maxSteps: options.maxSteps ?? defaultStepLimit,
    steps: 0
  }
  let scope: Scope = new Map<string, LanguageValue>()
  for (const [name, value] of Object.entries(options.bindings ?? {})) {
    scope = yield* extendScope(scope, name, yield* withinNodes(freezeValue(value), budget, program.span), budget, program.span)
  }
  const result = yield* evaluateStatements(program.body, scope, resolver, budget)
  return new EvaluationResult({ returned: result.returned, value: result.value })
})
