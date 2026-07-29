import { Schema } from "effect"

/** A half-open byte offset range in the source text. */
export interface Span {
  readonly start: number
  readonly end: number
  readonly line: number
  readonly column: number
}

export interface Program {
  readonly kind: "Program"
  readonly body: readonly Statement[]
  readonly span: Span
}

export type Statement = LetStatement | IfStatement | ForStatement | ReturnStatement | AssertStatement | ExpressionStatement

export interface LetStatement { readonly kind: "LetStatement"; readonly name: string; readonly value: Expression; readonly span: Span }
export interface IfStatement { readonly kind: "IfStatement"; readonly test: Expression; readonly consequent: readonly Statement[]; readonly alternate: readonly Statement[] | undefined; readonly span: Span }
export interface ForStatement { readonly kind: "ForStatement"; readonly variable: string; readonly from: Expression; readonly to: Expression; readonly body: readonly Statement[]; readonly span: Span }
export interface ReturnStatement { readonly kind: "ReturnStatement"; readonly value: Expression | undefined; readonly span: Span }
export interface AssertStatement { readonly kind: "AssertStatement"; readonly test: Expression; readonly message: Expression | undefined; readonly span: Span }
export interface ExpressionStatement { readonly kind: "ExpressionStatement"; readonly expression: Expression; readonly span: Span }

export type Expression = LiteralExpression | IdentifierExpression | ListExpression | RecordExpression | UnaryExpression | BinaryExpression | CallExpression | FieldExpression | IndexExpression
export interface LiteralExpression { readonly kind: "LiteralExpression"; readonly value: string | number | boolean | null | Duration; readonly span: Span }
export interface IdentifierExpression { readonly kind: "IdentifierExpression"; readonly name: string; readonly span: Span }
export interface ListExpression { readonly kind: "ListExpression"; readonly items: readonly Expression[]; readonly span: Span }
export interface RecordExpression { readonly kind: "RecordExpression"; readonly entries: readonly RecordEntry[]; readonly span: Span }
export interface RecordEntry { readonly key: string; readonly value: Expression; readonly span: Span }
export interface UnaryExpression { readonly kind: "UnaryExpression"; readonly operator: "!" | "-"; readonly operand: Expression; readonly span: Span }
export interface BinaryExpression { readonly kind: "BinaryExpression"; readonly operator: BinaryOperator; readonly left: Expression; readonly right: Expression; readonly span: Span }
export interface CallExpression { readonly kind: "CallExpression"; readonly callee: Expression; readonly arguments: readonly Expression[]; readonly span: Span }
export interface FieldExpression { readonly kind: "FieldExpression"; readonly object: Expression; readonly field: string; readonly span: Span }
export interface IndexExpression { readonly kind: "IndexExpression"; readonly object: Expression; readonly index: Expression; readonly span: Span }

export type BinaryOperator = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/"
export interface Duration { readonly kind: "Duration"; readonly value: number; readonly unit: "ms" | "s" | "m" | "h" | "d" }

export const SpanSchema = Schema.Struct({ start: Schema.Number, end: Schema.Number, line: Schema.Number, column: Schema.Number })
export const DurationSchema = Schema.Struct({ kind: Schema.Literal("Duration"), value: Schema.Number, unit: Schema.Literal("ms", "s", "m", "h", "d") })
/** Stable runtime schemas for values shared with a future lowering layer. */
export const AstSchemas = { Span: SpanSchema, Duration: DurationSchema } as const
