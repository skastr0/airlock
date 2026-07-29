import { Schema } from "effect"
import { SpanSchema, type Span } from "./ast.ts"

export type TokenKind = "eof" | "newline" | "identifier" | "number" | "duration" | "string" | "punctuation" | "operator" | "keyword"
export interface Token { readonly kind: TokenKind; readonly text: string; readonly span: Span }

const keywords = new Set(["let", "if", "else", "for", "in", "return", "assert", "true", "false", "null"])
const punctuation = new Set(["(", ")", "{", "}", "[", "]", ",", ";", ".", ":"])
const twoCharacterOperators = new Set(["==", "!=", "<=", ">=", "&&", "||", ".."])
const oneCharacterOperators = new Set(["=", "!", "<", ">", "+", "-", "*", "/"])

export class LanguageDiagnostic extends Schema.TaggedError<LanguageDiagnostic>()(
  "LanguageDiagnostic",
  { detail: Schema.String, span: SpanSchema, source: Schema.String }
) {}

export const tokenize = (source: string): readonly Token[] => {
  const tokens: Token[] = []
  let offset = 0, line = 1, column = 1
  const span = (start: number, startLine: number, startColumn: number): Span => ({ start, end: offset, line: startLine, column: startColumn })
  const advance = () => { const char = source[offset++]!; if (char === "\n") { line++; column = 1 } else column++; return char }
  const fail = (detail: string, start = offset, startLine = line, startColumn = column): never => {
    throw new LanguageDiagnostic({ detail, span: { start, end: offset + 1, line: startLine, column: startColumn }, source })
  }
  while (offset < source.length) {
    const char = source[offset]!
    if (char === " " || char === "\t" || char === "\r") { advance(); continue }
    const start = offset, startLine = line, startColumn = column
    if (char === "\n") { advance(); tokens.push({ kind: "newline", text: "\n", span: span(start, startLine, startColumn) }); continue }
    if (char === "#" || (char === "/" && source[offset + 1] === "/")) { while (offset < source.length && source[offset] !== "\n") advance(); continue }
    if (/[A-Za-z_]/.test(char)) {
      let text = ""; while (offset < source.length && /[A-Za-z0-9_]/.test(source[offset]!)) text += advance()
      tokens.push({ kind: keywords.has(text) ? "keyword" : "identifier", text, span: span(start, startLine, startColumn) }); continue
    }
    if (/[0-9]/.test(char)) {
      let text = ""; while (offset < source.length && /[0-9]/.test(source[offset]!)) text += advance()
      if (source[offset] === "." && source[offset + 1] !== "." && /[0-9]/.test(source[offset + 1] ?? "")) { text += advance(); while (offset < source.length && /[0-9]/.test(source[offset]!)) text += advance() }
      let unit = ""; while (offset < source.length && /[A-Za-z]/.test(source[offset]!)) unit += advance()
      if (unit !== "" && !["ms", "s", "m", "h", "d"].includes(unit)) fail(`unknown duration unit '${unit}'`, start, startLine, startColumn)
      tokens.push({ kind: unit ? "duration" : "number", text: text + unit, span: span(start, startLine, startColumn) }); continue
    }
    if (char === '"') {
      advance(); let value = ""
      while (offset < source.length && source[offset] !== '"') {
        if (source[offset] === "\n") fail("unterminated string", start, startLine, startColumn)
        if (source[offset] === "\\") { advance(); const escaped = advance(); const decoded: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" }; if (decoded[escaped] === undefined) fail(`unsupported escape '\\${escaped}'`, start, startLine, startColumn); value += decoded[escaped]! } else value += advance()
      }
      if (offset >= source.length) fail("unterminated string", start, startLine, startColumn)
      advance(); tokens.push({ kind: "string", text: value, span: span(start, startLine, startColumn) }); continue
    }
    const pair = source.slice(offset, offset + 2)
    if (twoCharacterOperators.has(pair)) { advance(); advance(); tokens.push({ kind: "operator", text: pair, span: span(start, startLine, startColumn) }); continue }
    if (punctuation.has(char)) { advance(); tokens.push({ kind: "punctuation", text: char, span: span(start, startLine, startColumn) }); continue }
    if (oneCharacterOperators.has(char)) { advance(); tokens.push({ kind: "operator", text: char, span: span(start, startLine, startColumn) }); continue }
    fail(char === "$" || char === "`" ? "shell interpolation is not part of the Airlock language" : `unexpected character '${char}'`)
  }
  tokens.push({ kind: "eof", text: "", span: { start: offset, end: offset, line, column } })
  return tokens
}
