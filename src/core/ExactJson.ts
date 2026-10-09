/**
 * JSON text that parses back to exactly the value it was written from.
 *
 * `JSON.stringify` writes negative zero as `0`, so a stored value that passed
 * an exact refinement would come back as a different number. `JSON.parse`
 * reads `-0` correctly; only the writing side loses it. Everything else is
 * what `JSON.stringify` writes: strings are escaped by it (a lone surrogate
 * stays an escape, so the text is always well-formed), and keys keep the
 * order the value has.
 */
export type ExactJson = string | number | boolean | null | ReadonlyArray<ExactJson> | { readonly [key: string]: ExactJson }

export const exactJsonText = (value: ExactJson): string => {
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : JSON.stringify(value)
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(exactJsonText).join(",")}]`
  return `{${Object.keys(value).map((key) => `${JSON.stringify(key)}:${exactJsonText((value as { readonly [key: string]: ExactJson })[key]!)}`).join(",")}}`
}

/** Canonical JSON result identity retains every finite number, including -0. */
export const canonicalExactJson = (value: ExactJson): string => {
  const sorted = (value: ExactJson): ExactJson => {
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map(sorted)
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, ExactJson>)[key]!)]))
  }
  return exactJsonText(sorted(value))
}
