/** Seeded source generators shared by runner attacks and language checks. */
export const seeded = (seed: number) => {
  let state = seed >>> 0
  return (limit: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % limit
  }
}

interface Expression<Value> { readonly source: string; readonly value: Value }
export interface RunnerExample {
  readonly source: string
  readonly value: string | number | boolean
  readonly calls: number
}

/** Well-shaped expressions have an independent value oracle, not just a parse oracle. */
export const runnerExamples = (seed: number, count: number): readonly RunnerExample[] => {
  const pick = seeded(seed)
  const number = (depth: number): Expression<number> => {
    if (depth === 0 || pick(3) === 0) {
      const value = pick(11) - 5
      return { source: `(${value})`, value }
    }
    const a = number(depth - 1), b = number(depth - 1), op = pick(3)
    return { source: `(${a.source} ${["+", "-", "*"][op]} ${b.source})`,
      value: op === 0 ? a.value + b.value : op === 1 ? a.value - b.value : a.value * b.value }
  }
  const string = (depth: number): Expression<string> => {
    if (depth === 0 || pick(3) === 0) {
      const value = ["", "mail", "é", "🙂", "__proto__", "line\nquote\"", "\\"][pick(7)]!
      return { source: JSON.stringify(value), value }
    }
    const a = string(depth - 1), b = string(depth - 1)
    return { source: `(${a.source} + ${b.source})`, value: a.value + b.value }
  }
  const boolean = (depth: number): Expression<boolean> => {
    if (depth === 0) { const value = pick(2) === 0; return { source: String(value), value } }
    if (pick(2) === 0) {
      const a = number(depth - 1), b = number(depth - 1), less = pick(2) === 0
      return { source: `(${a.source} ${less ? "<" : "=="} ${b.source})`, value: less ? a.value < b.value : Object.is(a.value, b.value) }
    }
    const a = boolean(depth - 1), b = boolean(depth - 1), and = pick(2) === 0
    return { source: `(!${a.source} ${and ? "&&" : "||"} ${b.source})`, value: and ? !a.value && b.value : !a.value || b.value }
  }
  return Array.from({ length: count }, () => {
    const value = [number, string, boolean][pick(3)]!(3)
    const condition = boolean(2), iterations = pick(4)
    return { source: `let v = ${value.source}
let box = { "__proto__": v, constructor: [v], toString: v }
if ${condition.source} { for n in 0..${iterations} { security.echo({ value: box.__proto__ }) } }
return box.constructor[0]`, value: value.value, calls: condition.value ? iterations : 0 }
  })
}

/** Token splicing also reaches valid but wrong-shaped evaluator operations. */
export const hostileSources = (seed: number, count: number): readonly string[] => {
  const pick = seeded(seed)
  const tokens = ["let", "if", "else", "for", "in", "return", "assert", "x", "security.echo", "true", "false", "null",
    "0", "-1", "1e309", "1ms", "\"text\"", "\"\\uD800\"", "(", ")", "[", "]", "{", "}", ".", ",", ":", ";", "=", "!", "+", "/", "==", "&&", "..", "\n", "\u0000", "💥"]
  const starts = ["return ", "let x = ", "if true { ", "for x in [0,1] { ", "security.echo(", "assert false, ", ""]
  return Array.from({ length: count }, (_, index) => {
    if (index % 3 === 0) {
      const expressions = ["[0][1]", "null.missing", "true + 1", "1 / 0", "{x:1,x:2}", "missing", "{}.constructor",
        "{\"__proto__\":1}.__proto__", "false && security.echo({})", "true || security.echo({})", "security.echo({}, {})"]
      return `return ${expressions[pick(expressions.length)]}`
    }
    return starts[pick(starts.length)] + Array.from({ length: 1 + pick(64) }, () => tokens[pick(tokens.length)]).join(" ")
  })
}
