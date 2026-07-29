import { Effect } from "effect"
import type { AssertStatement, BinaryOperator, Duration, Expression, Program, Span, Statement } from "./ast.ts"
import { LanguageDiagnostic, tokenize, type Token } from "./lexer.ts"

const precedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6 }
const joined = (start: Span, end: Span): Span => ({ start: start.start, end: end.end, line: start.line, column: start.column })

export class Parser {
  private current = 0
  constructor(private readonly source: string, private readonly tokens = tokenize(source)) {}
  parse(): Program {
    const start = this.peek().span; const body = this.statements("eof"); const end = this.peek().span
    return { kind: "Program", body, span: joined(start, end) }
  }
  private statements(until: string): Statement[] {
    const body: Statement[] = []; this.separators()
    while (this.peek().text !== until && this.peek().kind !== "eof") {
      body.push(this.statement())
      if (!this.isSeparator() && this.peek().text !== until && this.peek().kind !== "eof") this.error("expected a newline or ';' between statements")
      this.separators()
    }
    if (until !== "eof") this.expect(until)
    return body
  }
  private statement(): Statement {
    const start = this.peek().span
    if (this.match("let")) { const name = this.expectIdentifier(); this.expect("="); const value = this.expression(); return { kind: "LetStatement", name: name.text, value, span: joined(start, value.span) } }
    if (this.match("if")) {
      const test = this.expression(); this.expect("{"); const consequent = this.statements("}")
      let alternate: readonly Statement[] | undefined
      let end = this.previous().span
      // A newline before `else` is whitespace, but only consume it if this is
      // actually an else branch; otherwise it remains the statement separator.
      const afterConsequent = this.current
      this.separators()
      if (this.peek().text !== "else") this.current = afterConsequent
      if (this.match("else")) { this.expect("{"); alternate = this.statements("}"); end = this.previous().span }
      return { kind: "IfStatement", test, consequent, alternate, span: joined(start, end) }
    }
    if (this.match("for")) {
      const variable = this.expectIdentifier(); this.expect("in"); const from = this.expression()
      if (!this.match("..")) this.error("for requires a bounded integer literal range", from.span)
      const to = this.expression()
      if (from.kind !== "LiteralExpression" || typeof from.value !== "number" || to.kind !== "LiteralExpression" || typeof to.value !== "number" || !Number.isInteger(from.value) || !Number.isInteger(to.value)) this.error("for bounds must be integer literals", from.span)
      this.expect("{"); const body = this.statements("}")
      return { kind: "ForStatement", variable: variable.text, from, to, body, span: joined(start, this.previous().span) }
    }
    if (this.match("return")) { if (this.isSeparator() || this.peek().text === "}") return { kind: "ReturnStatement", value: undefined, span: start }; const value = this.expression(); return { kind: "ReturnStatement", value, span: joined(start, value.span) } }
    if (this.match("assert")) { const test = this.expression(); let message: Expression | undefined; if (this.match(",")) message = this.expression(); const result: AssertStatement = { kind: "AssertStatement", test, message, span: joined(start, (message ?? test).span) }; return result }
    const expression = this.expression(); return { kind: "ExpressionStatement", expression, span: expression.span }
  }
  private expression(min = 0): Expression {
    let left = this.prefix()
    while (true) { const operator = this.peek(); const power = precedence[operator.text] ?? -1; if (power < min) break; this.advance(); const right = this.expression(power + 1); left = { kind: "BinaryExpression", operator: operator.text as BinaryOperator, left, right, span: joined(left.span, right.span) } }
    return left
  }
  private prefix(): Expression {
    const token = this.advance()
    let expression: Expression
    if (token.kind === "number") expression = { kind: "LiteralExpression", value: Number(token.text), span: token.span }
    else if (token.kind === "duration") { const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(token.text)!; expression = { kind: "LiteralExpression", value: { kind: "Duration", value: Number(match[1]), unit: match[2] as Duration["unit"] }, span: token.span } }
    else if (token.kind === "string") expression = { kind: "LiteralExpression", value: token.text, span: token.span }
    else if (token.text === "true" || token.text === "false") expression = { kind: "LiteralExpression", value: token.text === "true", span: token.span }
    else if (token.text === "null") expression = { kind: "LiteralExpression", value: null, span: token.span }
    else if (token.kind === "identifier") expression = { kind: "IdentifierExpression", name: token.text, span: token.span }
    else if (token.text === "!" || token.text === "-") { const operand = this.expression(7); expression = { kind: "UnaryExpression", operator: token.text, operand, span: joined(token.span, operand.span) } }
    else if (token.text === "(") { expression = this.expression(); this.expect(")") }
    else if (token.text === "[") { const items = this.delimitedExpressions("]"); expression = { kind: "ListExpression", items, span: joined(token.span, this.previous().span) } }
    else if (token.text === "{") { const entries: { key: string; value: Expression; span: Span }[] = []; if (this.peek().text !== "}") do { const key = this.advance(); if (key.kind !== "identifier" && key.kind !== "string") this.error("record keys must be identifiers or strings", key.span); this.expect(":"); const value = this.expression(); entries.push({ key: key.text, value, span: joined(key.span, value.span) }) } while (this.match(",")); this.expect("}"); expression = { kind: "RecordExpression", entries, span: joined(token.span, this.previous().span) } }
    else this.error(`expected an expression, found '${token.text || "end of input"}'`, token.span)
    while (true) { if (this.match("(")) { const args = this.delimitedExpressions(")"); expression = { kind: "CallExpression", callee: expression, arguments: args, span: joined(expression.span, this.previous().span) } } else if (this.match(".")) { const field = this.expectIdentifier(); expression = { kind: "FieldExpression", object: expression, field: field.text, span: joined(expression.span, field.span) } } else if (this.match("[")) { const index = this.expression(); const closing = this.expect("]"); expression = { kind: "IndexExpression", object: expression, index, span: joined(expression.span, closing.span) } } else break }
    return expression
  }
  private delimitedExpressions(close: string): Expression[] {
    const result: Expression[] = []
    if (this.peek().text !== close) {
      do result.push(this.expression())
      while (this.match(","))
    }
    this.expect(close)
    return result
  }
  private separators() { while (this.peek().kind === "newline" || this.peek().text === ";") this.advance() }
  private isSeparator() { return this.peek().kind === "newline" || this.peek().text === ";" }
  private match(text: string) { if (this.peek().text !== text) return false; this.advance(); return true }
  private expect(text: string) { if (this.peek().text !== text) this.error(`expected '${text}', found '${this.peek().text || "end of input"}'`); return this.advance() }
  private expectIdentifier() { if (this.peek().kind !== "identifier") this.error(`expected identifier, found '${this.peek().text || "end of input"}'`); return this.advance() }
  private peek() { return this.tokens[this.current]! }
  private previous() { return this.tokens[this.current - 1]! }
  private advance() { const token = this.peek(); if (token.kind !== "eof") this.current++; return token }
  private error(detail: string, span = this.peek().span): never { throw new LanguageDiagnostic({ detail, span, source: this.source }) }
}

/** Parse source without granting the language component any runtime capability. */
export const parseSync = (source: string): Program => new Parser(source).parse()
/** Typed parse boundary for callers that already compose in Effect. */
export const parse = (source: string): Effect.Effect<Program, LanguageDiagnostic> =>
  Effect.try({
    try: () => parseSync(source),
    catch: (cause) => cause instanceof LanguageDiagnostic
      ? cause
      : new LanguageDiagnostic({ detail: String(cause), span: { start: 0, end: 0, line: 1, column: 1 }, source })
  })
