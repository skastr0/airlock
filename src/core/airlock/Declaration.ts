import { Schema } from "effect"
import type { ToolContract } from "../contract/ToolContract.ts"

/**
 * TypeScript declaration text and a plain description for exactly the tools a
 * session grants. A host puts the description in a model's prompt and can
 * typecheck guest code against the declaration; a tool that is not granted
 * appears in neither.
 */

type JsonSchema = { readonly [key: string]: unknown }

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const key = (name: string) => (identifier.test(name) ? name : JSON.stringify(name))

/** Prints a JSON Schema as a TypeScript type. Anything it does not recognise is `unknown`. */
const typeOf = (schema: unknown, definitions: JsonSchema): string => {
  if (!isRecord(schema)) return "unknown"
  if (typeof schema["$ref"] === "string") {
    const name = schema["$ref"].split("/").pop() ?? ""
    return Object.hasOwn(definitions, name) ? typeOf(definitions[name], definitions) : "unknown"
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
      const items = typeOf(schema["items"], definitions)
      return `ReadonlyArray<${items}>`
    }
    case "object": {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : {}
      const required = Array.isArray(schema["required"]) ? schema["required"] : []
      const fields = Object.keys(properties).map((name) =>
        `${key(name)}${required.includes(name) ? "" : "?"}: ${typeOf(properties[name], definitions)}`
      )
      const extra = isRecord(schema["additionalProperties"])
        ? [`[key: string]: ${typeOf(schema["additionalProperties"], definitions)}`]
        : []
      const all = [...fields, ...extra]
      return all.length === 0 ? "{}" : `{ ${all.join("; ")} }`
    }
    default: return "unknown"
  }
}

const typeText = (schema: Schema.Top): string => {
  const document = Schema.toJsonSchemaDocument(schema)
  return typeOf(document.schema, isRecord(document.definitions) ? document.definitions : {})
}

/** The receipt a guest gets for a call that was recorded and awaits a supervisor. */
export const STAGED_RECEIPT_TYPE =
  "{ readonly staged: true; readonly id: string; readonly state: string }"

type Tree = { [segment: string]: Tree | string }

const insert = (tree: Tree, path: ReadonlyArray<string>, leaf: string): void => {
  const [head, ...rest] = path
  if (head === undefined) return
  if (rest.length === 0) {
    tree[head] = leaf
    return
  }
  const next = tree[head]
  const branch: Tree = typeof next === "object" ? next : {}
  tree[head] = branch
  insert(branch, rest, leaf)
}

const print = (tree: Tree, indent: string): string =>
  Object.keys(tree).sort().map((segment) => {
    const node = tree[segment]!
    return typeof node === "string"
      ? `${indent}${key(segment)}${node}`
      : `${indent}readonly ${key(segment)}: {\n${print(node, `${indent}  `)}\n${indent}}`
  }).join("\n")

const effectWords = (contract: ToolContract.Any): string =>
  contract.emissionEffect === "read"
    ? "reads"
    : contract.emissionEffect === "mutate"
      ? "changes something"
      : "sends something that cannot be undone"

/**
 * `declare const tools: { ... }` for the given contracts. Dotted names nest:
 * `mail.list` is `tools.mail.list(input)`.
 */
export const guestDeclaration = (contracts: ReadonlyArray<ToolContract.Any>): string => {
  const tree: Tree = {}
  for (const contract of contracts) {
    const output = contract.emissionEffect === "read"
      ? `${typeText(contract.outcome)} | ${STAGED_RECEIPT_TYPE}`
      : STAGED_RECEIPT_TYPE
    insert(tree, contract.tag.split("."), `(input: ${typeText(contract.input)}): Promise<${output}>`)
  }
  const body = print(tree, "  ")
  return `declare const tools: {${body === "" ? "" : `\n${body}\n`}}\n`
}

/** One line per granted tool, in plain words, for a prompt. */
export const guestDescription = (contracts: ReadonlyArray<ToolContract.Any>): string =>
  contracts.length === 0
    ? "No tools are available."
    : [...contracts]
        .sort((left, right) => (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0))
        .map((contract) => {
          const answer = contract.compensate === undefined ? "" : `; can be answered by ${contract.compensate.kind}`
          const result = contract.emissionEffect === "read"
            ? "returns its result, or a staged receipt if it needs approval"
            : "is recorded for approval and returns a staged receipt, never a result"
          return `- tools.${contract.tag}(input): ${effectWords(contract)}; ${result}${answer}.`
        })
        .join("\n")
