import { Effect, Schema } from "effect"
import type { Duration, Expression, Program, Span, Statement } from "./ast.ts"
import { DurationSchema, SpanSchema } from "./ast.ts"

/**
 * The evaluator is a candidate language component, not a capability source.
 * Its only effect boundary is an injected ActionResolver.  Parsing, values,
 * control flow, and arithmetic remain pure and portable across runtimes.
 */

export type LanguageScalar = string | number | boolean | null | Duration
export interface LanguageList extends ReadonlyArray<LanguageValue> {}
export interface LanguageRecord { readonly [key: string]: LanguageValue }
export type LanguageValue = LanguageScalar | LanguageList | LanguageRecord

export const LanguageValueSchema: Schema.Schema<LanguageValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    DurationSchema,
    Schema.Array(LanguageValueSchema),
    Schema.Record({ key: Schema.String, value: LanguageValueSchema })
  )
).annotations({
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

export type EvaluationError =
  | UnboundIdentifier
  | InvalidLanguageOperation
  | InvalidCallTarget
  | MissingRecordField
  | InvalidIndex
  | AssertionFailed
  | DuplicateRecordField
  | LoopLimitExceeded

/** The sole language-to-world seam; resolvers are supplied by the runtime. */
export interface ActionResolver<R = never, E = never> {
  readonly resolve: (
    action: string,
    args: readonly LanguageValue[]
  ) => Effect.Effect<LanguageValue, E, R>
}

export interface EvaluateOptions {
  /** One shared safety budget consumed by every visited list or range item. */
  readonly maxLoopIterations?: number
  /** Explicit non-privileged values made available to the program. */
  readonly bindings?: Readonly<Record<string, LanguageValue>>
}

type Scope = ReadonlyMap<string, LanguageValue>
type Control = { readonly returned: boolean; readonly value: LanguageValue }
interface LoopBudget {
  readonly limit: number
  used: number
}
const normal = (value: LanguageValue = null): Control => ({ returned: false, value })
const returned = (value: LanguageValue): Control => ({ returned: true, value })
const defaultLoopLimit = 10_000

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

const finiteNumber = (value: number, operation: string, span: Span): Effect.Effect<number, InvalidLanguageOperation> =>
  Number.isFinite(value)
    ? Effect.succeed(value)
    : Effect.fail(invalid(operation, "result must be a finite number", span))

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
    return Object.freeze(value.map(freezeValue))
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
  switch (statement.kind) {
    case "LetStatement": {
      const value = yield* evaluateExpression(statement.value, scope, resolver, budget)
      const next = new Map(scope); next.set(statement.name, value)
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
          yield* consumeLoopIteration(budget, statement.span)
          const scoped = new Map(scope)
          scoped.set(statement.variable, item)
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
        return yield* Effect.fail(
          invalid("for", "bounds must evaluate to safe integers", statement.span)
        )
      }
      const iterations = Math.max(0, to - from)
      yield* ensureLoopCapacity(iterations, budget, statement.span)
      let control = normal()
      for (let value = from; value < to; value++) {
        yield* consumeLoopIteration(budget, statement.span)
        const scoped = new Map(scope); scoped.set(statement.variable, value)
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
  switch (expression.kind) {
    case "LiteralExpression":
      if (typeof expression.value === "number") return yield* finiteNumber(expression.value, "literal", expression.span)
      return freezeValue(expression.value)
    case "IdentifierExpression": {
      const value = scope.get(expression.name)
      return value === undefined
        ? yield* Effect.fail(new UnboundIdentifier({ name: expression.name, span: expression.span }))
        : value
    }
    case "ListExpression":
      return Object.freeze(yield* Effect.forEach(expression.items, (item) => evaluateExpression(item, scope, resolver, budget)))
    case "RecordExpression": {
      const record: Record<string, LanguageValue> = Object.create(null)
      for (const entry of expression.entries) {
        if (Object.hasOwn(record, entry.key)) return yield* Effect.fail(new DuplicateRecordField({ field: entry.key, span: entry.span }))
        record[entry.key] = yield* evaluateExpression(entry.value, scope, resolver, budget)
      }
      return Object.freeze(record)
    }
    case "UnaryExpression": {
      const value = yield* evaluateExpression(expression.operand, scope, resolver, budget)
      if (expression.operator === "!") return !(yield* truthy(value, expression.span))
      if (typeof value !== "number") return yield* Effect.fail(invalid("-", "requires a number", expression.span))
      return yield* finiteNumber(-value, "-", expression.span)
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
      if (expression.operator === "+" && typeof left === "string" && typeof right === "string") return left + right
      if (typeof left !== "number" || typeof right !== "number") return yield* Effect.fail(invalid(expression.operator, "requires numbers (or strings for +)", expression.span))
      if (expression.operator === "/" && right === 0) return yield* Effect.fail(invalid("/", "division by zero", expression.span))
      const value = expression.operator === "+" ? left + right : expression.operator === "-" ? left - right : expression.operator === "*" ? left * right : left / right
      return yield* finiteNumber(value, expression.operator, expression.span)
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
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= object.length) {
        return yield* Effect.fail(new InvalidIndex({ detail: "requires an in-range integer list index", span: expression.span }))
      }
      return object[index]!
    }
    case "CallExpression": {
      const action = actionName(expression.callee)
      if (action === undefined) return yield* Effect.fail(new InvalidCallTarget({ detail: "only identifier action calls are supported", span: expression.callee.span }))
      const args = yield* Effect.forEach(expression.arguments, (argument) => evaluateExpression(argument, scope, resolver, budget))
      return freezeValue(yield* resolver.resolve(action, Object.freeze(args)))
    }
  }
})

/** Evaluates a parsed program without ambient filesystem, process, or network authority. */
export const evaluate = <R = never, E = never>(
  program: Program,
  resolver: ActionResolver<R, E>,
  options: EvaluateOptions = {}
): Effect.Effect<EvaluationResult, EvaluationError | E, R> => Effect.gen(function* () {
  const loopLimit = options.maxLoopIterations ?? defaultLoopLimit
  if (!Number.isSafeInteger(loopLimit) || loopLimit < 0) {
    return yield* Effect.fail(invalid("maxLoopIterations", "must be a non-negative safe integer", program.span))
  }
  const budget: LoopBudget = { limit: loopLimit, used: 0 }
  const scope = new Map<string, LanguageValue>()
  for (const [name, value] of Object.entries(options.bindings ?? {})) scope.set(name, freezeValue(value))
  const result = yield* evaluateStatements(program.body, scope, resolver, budget)
  return new EvaluationResult({ returned: result.returned, value: result.value })
})
