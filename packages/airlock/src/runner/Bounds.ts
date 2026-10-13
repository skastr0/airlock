import { exactJsonText } from "../ExactJson.ts"
import { defaultGuestLimits, type GuestLimits } from "./GuestRunner.ts"

/**
 * The bounds on every value that crosses between a program and its host: a
 * tool's input, a tool's result, the run's result. A value crosses only as
 * JSON text this module wrote, so what arrives on the other side is a copy
 * that shares nothing with the original. The copy is exact: every string and
 * number token is written by the core's one exact writer, so negative zero
 * arrives as negative zero.
 */

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).byteLength

/** Thrown by `boundedJson` when the value passes a size, depth or node limit. */
export const tooLarge = Symbol("guest value limit")
/** Thrown by `boundedJson` when the value is not plain JSON data. */
export const notJson = Symbol("invalid guest value")

/**
 * Own JSON data only, bounded before allocating the complete encoded value.
 * No getter and no `toJSON` is invoked; anything that is not plain data is
 * refused.
 */
export const boundedJson = (value: unknown, maxBytes: number, limits: GuestLimits): string => {
  let text = ""
  let size = 0
  let nodes = 0
  const append = (token: string) => {
    if (token.length > maxBytes) throw tooLarge
    size += bytes(token)
    if (size > maxBytes) throw tooLarge
    text += token
  }
  const string = (value: string) => {
    if (value.length > maxBytes) throw tooLarge
    append(exactJsonText(value))
  }
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw tooLarge
    if (item === null) return append("null")
    if (typeof item === "boolean") return append(item ? "true" : "false")
    if (typeof item === "string") return string(item)
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw notJson
      // A value that passed an exact refinement must arrive as the same number.
      return append(exactJsonText(item))
    }
    if (typeof item !== "object") throw notJson
    if (Array.isArray(item)) {
      const length = Object.getOwnPropertyDescriptor(item, "length")?.value
      if (typeof length !== "number" || length > limits.maxNodes) throw tooLarge
      append("[")
      for (let index = 0; index < length; index++) {
        if (index > 0) append(",")
        const descriptor = Object.getOwnPropertyDescriptor(item, index)
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw notJson
        visit(descriptor.value, depth + 1)
      }
      return append("]")
    }
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) throw notJson
    const names = Object.keys(item)
    if (names.length > limits.maxNodes) throw tooLarge
    append("{")
    let written = 0
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(item, name)
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw notJson
      if (descriptor.value === undefined) continue
      if (written++ > 0) append(",")
      string(name)
      append(":")
      visit(descriptor.value, depth + 1)
    }
    append("}")
  }
  visit(value, 0)
  return text
}

export const guestLimits = (overrides: Partial<GuestLimits> = {}): GuestLimits => ({
  ...defaultGuestLimits,
  ...overrides
})

/** Why the source cannot be run at all, before it is parsed. */
export const invalidSource = (source: string, limits: GuestLimits): boolean =>
  source.length === 0 || source.length > limits.maxCodeBytes || bytes(source) > limits.maxCodeBytes
