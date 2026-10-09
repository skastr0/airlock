import type { Expression, Program, Statement } from "./ast.ts"

/**
 * The language calls actions by identifier only. A host that names its actions
 * with dots (`mail.send`, `file.read`) resolves them here, before evaluation:
 * a call whose callee is a dotted path of identifiers naming an action becomes
 * a call of that one action. Nothing is looked up at run time, so the language
 * gains no reflective call surface.
 */
const dottedName = (expression: Expression): string | undefined => {
  if (expression.kind === "IdentifierExpression") return expression.name
  if (expression.kind !== "FieldExpression") return undefined
  const prefix = dottedName(expression.object)
  return prefix === undefined ? undefined : `${prefix}.${expression.field}`
}

type IsAction = (name: string) => boolean

const resolveExpression = (expression: Expression, isAction: IsAction): Expression => {
  switch (expression.kind) {
    case "CallExpression": {
      const dotted = dottedName(expression.callee)
      const callee = dotted !== undefined && isAction(dotted)
        ? { kind: "IdentifierExpression" as const, name: dotted, span: expression.callee.span }
        : resolveExpression(expression.callee, isAction)
      return { ...expression, callee, arguments: expression.arguments.map((item) => resolveExpression(item, isAction)) }
    }
    case "ListExpression": return { ...expression, items: expression.items.map((item) => resolveExpression(item, isAction)) }
    case "RecordExpression": return { ...expression, entries: expression.entries.map((entry) => ({ ...entry, value: resolveExpression(entry.value, isAction) })) }
    case "UnaryExpression": return { ...expression, operand: resolveExpression(expression.operand, isAction) }
    case "BinaryExpression": return { ...expression, left: resolveExpression(expression.left, isAction), right: resolveExpression(expression.right, isAction) }
    case "FieldExpression": return { ...expression, object: resolveExpression(expression.object, isAction) }
    case "IndexExpression": return { ...expression, object: resolveExpression(expression.object, isAction), index: resolveExpression(expression.index, isAction) }
    default: return expression
  }
}

const resolveStatement = (statement: Statement, isAction: IsAction): Statement => {
  switch (statement.kind) {
    case "LetStatement": return { ...statement, value: resolveExpression(statement.value, isAction) }
    case "ExpressionStatement": return { ...statement, expression: resolveExpression(statement.expression, isAction) }
    case "ReturnStatement": return { ...statement, ...(statement.value === undefined ? {} : { value: resolveExpression(statement.value, isAction) }) }
    case "AssertStatement": return { ...statement, test: resolveExpression(statement.test, isAction), ...(statement.message === undefined ? {} : { message: resolveExpression(statement.message, isAction) }) }
    case "IfStatement": return { ...statement, test: resolveExpression(statement.test, isAction), consequent: statement.consequent.map((item) => resolveStatement(item, isAction)), ...(statement.alternate === undefined ? {} : { alternate: statement.alternate.map((item) => resolveStatement(item, isAction)) }) }
    case "ForStatement": {
      const body = statement.body.map((item) => resolveStatement(item, isAction))
      return statement.iteration === "list"
        ? { ...statement, source: resolveExpression(statement.source, isAction), body }
        : { ...statement, from: resolveExpression(statement.from, isAction), to: resolveExpression(statement.to, isAction), body }
    }
  }
}

/** Rewrites every call of a dotted action name into a call of that action. */
export const resolveDottedActions = (program: Program, isAction: IsAction): Program =>
  ({ ...program, body: program.body.map((statement) => resolveStatement(statement, isAction)) })
