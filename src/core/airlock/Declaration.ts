import { Schema } from "effect"
import type { ToolContract } from "../contract/ToolContract.ts"
import type { PlanEffect } from "../plan/Plan.ts"

/**
 * What an agent needs to write an Airlock program (.air) for one session: the
 * actions it may call, the shape each takes and returns, and whether a call
 * runs at once or is recorded for approval. An action that is not granted does
 * not appear.
 */

type JsonSchema = { readonly [key: string]: unknown }

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/
const key = (name: string) => (identifier.test(name) ? name : JSON.stringify(name))

/**
 * Prints a JSON Schema as a shape in the language's own record and list
 * notation. Anything it does not recognise is `any`.
 */
const typeOf = (schema: unknown, definitions: JsonSchema): string => {
  if (!isRecord(schema)) return "any"
  if (typeof schema["$ref"] === "string") {
    const name = schema["$ref"].split("/").pop() ?? ""
    return Object.hasOwn(definitions, name) ? typeOf(definitions[name], definitions) : "any"
  }
  if (Array.isArray(schema["enum"])) {
    return schema["enum"].map((value) => JSON.stringify(value)).join(" | ") || "never"
  }
  if ("const" in schema) return JSON.stringify(schema["const"])
  for (const union of ["anyOf", "oneOf"] as const) {
    const members = schema[union]
    if (Array.isArray(members)) {
      return members.map((member) => typeOf(member, definitions)).join(" | ") || "never"
    }
  }
  switch (schema["type"]) {
    case "string": return "string"
    case "number":
    case "integer": return "number"
    case "boolean": return "boolean"
    case "null": return "null"
    case "array": {
      return `[${typeOf(schema["items"], definitions)}]`
    }
    case "object": {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : {}
      const required = Array.isArray(schema["required"]) ? schema["required"] : []
      const fields = Object.keys(properties).map((name) =>
        `${key(name)}${required.includes(name) ? "" : "?"}: ${typeOf(properties[name], definitions)}`
      )
      const extra = isRecord(schema["additionalProperties"])
        ? [`...: ${typeOf(schema["additionalProperties"], definitions)}`]
        : []
      const all = [...fields, ...extra]
      return all.length === 0 ? "{}" : `{ ${all.join(", ")} }`
    }
    default: return "any"
  }
}

const typeText = (schema: Schema.Top): string => {
  const document = Schema.toJsonSchemaDocument(schema)
  return typeOf(document.schema, isRecord(document.definitions) ? document.definitions : {})
}

/** The receipt a program gets for a call that was recorded and awaits a supervisor. */
export const STAGED_RECEIPT_SHAPE = "{ state: \"staged\", id: string }"
/** The receipt for a call Airlock refused: nothing happened, and it says why. */
export const REFUSED_RECEIPT_SHAPE = "{ state: \"refused\", refusal: { code: string, message: string } }"
const doneShape = (result: string): string => `{ state: "done", id: string, result: ${result} }`

/** One action a session grants, as an agent needs to know it. */
export interface GuestAction {
  /** What the program writes to call it, e.g. `mail.send`. */
  readonly name: string
  /** Shape of the one record the action takes. */
  readonly input: string
  /** Shape of what the action itself answers, once it has run. */
  readonly result: string
  /**
   * What a granted call hands back to the program: a done receipt carrying
   * the action's result at once, a staged receipt because the call waits for
   * a supervisor, or either, depending on which grant the call fits. Any call
   * may instead hand back a refused receipt.
   */
  readonly returns: "result" | "staged" | "result-or-staged"
  readonly effect: PlanEffect
  /** Capture-now replay retention; mixed narrowed grants are resolved per call. */
  readonly resultRetention?: "digest" | "keep" | "by-grant"
  /** The action that answers this one, if its contract declares a compensation. */
  readonly answeredBy?: string
}

/**
 * The action for one granted contract. `immediate` says how the session's
 * grants for it commit: every one pre-authorizes a read, none does, or some do.
 */
export const guestAction = (contract: ToolContract.Any, immediate: "all" | "none" | "some", resultRetention?: GuestAction["resultRetention"]): GuestAction => ({
  name: contract.tag,
  input: typeText(contract.input),
  result: typeText(contract.outcome),
  returns: immediate === "all" ? "result" : immediate === "none" ? "staged" : "result-or-staged",
  effect: contract.effect,
  ...(resultRetention === undefined ? {} : { resultRetention }),
  ...(contract.compensate === undefined ? {} : { answeredBy: contract.compensate.kind })
})

const effectWords: { readonly [Effect in GuestAction["effect"]]: string } = {
  capture: "Captures a value",
  invoke: "Runs a computation",
  apply: "Changes something the host can put back",
  request: "Makes an external request"
}

const returnWords: { readonly [Returns in GuestAction["returns"]]: string } = {
  result: "runs at once and returns a done receipt with its result",
  staged: "is recorded for approval and returns a staged receipt, never a result; nothing happens until a supervisor commits it",
  "result-or-staged": "returns a done receipt with its result, or a staged receipt when the call needs approval"
}

/** The language in a few lines, for an agent that has not seen it. One text for every host. */
export const LANGUAGE_PRIMER = [
  "An Airlock program (.air) is a list of statements, one per line.",
  "Statements: `let name = value`, `if test { ... } else { ... }`, `for item in list { ... }`,",
  "`for i in 0..3 { ... }`, `assert test, \"message\"`, `return value`.",
  "Values: strings in double quotes, numbers, true, false, null, lists `[a, b]`, records `{ key: value }`.",
  "Read a record with `record.key` and a list with `list[0]`. Operators: `+ - * /`, `== != < <= > >=`, `&& || !`;",
  "`+` also joins two strings. Conditions must be booleans. Comments start with `#`.",
  "There are no functions, no reassignment and no way to catch an error: a name is bound once by `let`,",
  "and a `let` inside a block ends with the block.",
  "An action is called with exactly one record, e.g. `mail.list({ mailbox: \"inbox\" })`.",
  "Every call returns a receipt. Check `receipt.state` before reading anything else:",
  "\"done\" has `receipt.result`; \"staged\" was recorded for a person to approve and has no result;",
  `"refused" did nothing and says why: ${REFUSED_RECEIPT_SHAPE}.`,
  "`receipt.result` is readable only where the state is known to be \"done\":",
  "inside `if receipt.state == \"done\" { ... }` or after `assert receipt.state == \"done\", \"...\"`.",
  "The whole program is checked before anything runs: an unknown name, field or action, or a value of the",
  "wrong type, is reported with its line and column, and nothing happens.",
  "Every call the program could make is counted before it runs. A `for` over a list counts that list's",
  "declared maximum length; a range counts its literal ends, or the whole loop budget if they are not literal.",
  "A program that could exceed its call or loop budget is refused, as is one that would pass data to an",
  "action that may not receive it; the refusal names the call and field.",
  "The program's result is what it returns."
].join("\n")

/** The primer, then one line per granted action, in plain words, for a prompt. */
export const guestDescription = (actions: ReadonlyArray<GuestAction>): string =>
  [
    LANGUAGE_PRIMER,
    "",
    actions.length === 0
      ? "No actions are available."
      : actions.map((action) => {
          const shape = action.returns === "result"
            ? doneShape(action.result)
            : action.returns === "staged"
              ? STAGED_RECEIPT_SHAPE
              : `${doneShape(action.result)} or ${STAGED_RECEIPT_SHAPE}`
          const answer = action.answeredBy === undefined ? "" : ` Can be answered by ${action.answeredBy}.`
          const retention = action.resultRetention === undefined ? "" : action.resultRetention === "keep"
            ? " Keeps the result privately; replay returns it without reading again."
            : action.resultRetention === "digest"
              ? " Keeps only the result digest; replay reads again and stops if the result changed."
              : " Keeps the result only when every fitting grant explicitly keeps it; otherwise replay reads again and checks the digest."
          return `- ${action.name}(${action.input}) -> ${shape}. ${effectWords[action.effect]}; ${returnWords[action.returns]}.${retention}${answer}`
        }).join("\n")
  ].join("\n")
