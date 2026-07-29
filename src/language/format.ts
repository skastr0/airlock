import type { Expression, Program, Statement } from "./ast.ts"

const expression = (node: Expression, parent = 0): string => {
  const binaryPower: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6 }
  switch (node.kind) {
    case "LiteralExpression": return typeof node.value === "string" ? JSON.stringify(node.value) : typeof node.value === "object" && node.value !== null ? `${node.value.value}${node.value.unit}` : String(node.value)
    case "IdentifierExpression": return node.name
    case "ListExpression": return `[${node.items.map((item) => expression(item)).join(", ")}]`
    case "RecordExpression": return `{ ${node.entries.map((entry) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key) ? entry.key : JSON.stringify(entry.key)}: ${expression(entry.value)}`).join(", ")} }`
    case "UnaryExpression": return `${node.operator}${expression(node.operand, 7)}`
    case "BinaryExpression": { const power = binaryPower[node.operator]!; const text = `${expression(node.left, power)} ${node.operator} ${expression(node.right, power + 1)}`; return power < parent ? `(${text})` : text }
    case "CallExpression": return `${expression(node.callee, 8)}(${node.arguments.map((argument) => expression(argument)).join(", ")})`
    case "FieldExpression": return `${expression(node.object, 8)}.${node.field}`
    case "IndexExpression": return `${expression(node.object, 8)}[${expression(node.index)}]`
  }
}
const block = (statements: readonly Statement[], level: number) => statements.map((statement) => `${"  ".repeat(level)}${formatStatement(statement, level)}`).join("\n")
const formatStatement = (statement: Statement, level: number): string => {
  switch (statement.kind) {
    case "LetStatement": return `let ${statement.name} = ${expression(statement.value)}`
    case "ExpressionStatement": return expression(statement.expression)
    case "ReturnStatement": return statement.value ? `return ${expression(statement.value)}` : "return"
    case "AssertStatement": return `assert ${expression(statement.test)}${statement.message ? `, ${expression(statement.message)}` : ""}`
    case "ForStatement": return `for ${statement.variable} in ${expression(statement.from)}..${expression(statement.to)} {${statement.body.length ? `\n${block(statement.body, level + 1)}\n${"  ".repeat(level)}` : ""}}`
    case "IfStatement": return `if ${expression(statement.test)} {${statement.consequent.length ? `\n${block(statement.consequent, level + 1)}\n${"  ".repeat(level)}` : ""}}${statement.alternate ? ` else {${statement.alternate.length ? `\n${block(statement.alternate, level + 1)}\n${"  ".repeat(level)}` : ""}}` : ""}`
  }
}
/** Canonical source printer. It intentionally never emits shell syntax. */
export const format = (program: Program): string => block(program.body, 0) + (program.body.length ? "\n" : "")
