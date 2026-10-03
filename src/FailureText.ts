/**
 * Text for a failure that is carried into a receipt, a report, or another
 * error's `reason`.
 *
 * A Schema tagged error has no derived `message`: its evidence is its fields.
 * Both renderings include those fields so a reason is never silently empty.
 */

const taggedFields = (cause: unknown): readonly [string, string] | undefined => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) {
    return undefined
  }
  const { _tag, ...fields } = cause as Record<string, unknown>
  if (typeof _tag !== "string") return undefined
  return [_tag, Object.keys(fields).length === 0 ? "" : JSON.stringify(fields)]
}

/** The failure's own words: its message, or its fields when it has none. */
export const reasonOf = (cause: unknown): string => {
  if (typeof cause === "string") return cause
  if (cause instanceof Error && cause.message !== "") return cause.message
  const tagged = taggedFields(cause)
  if (tagged === undefined) return String(cause)
  return tagged[1] === "" ? tagged[0] : tagged[1]
}

/** The failure named by kind: `Tag: fields` for tagged errors, `String` otherwise. */
export const describeFailure = (cause: unknown): string => {
  if (cause instanceof Error && cause.message !== "") return String(cause)
  const tagged = taggedFields(cause)
  if (tagged === undefined) return String(cause)
  return tagged[1] === "" ? tagged[0] : `${tagged[0]}: ${tagged[1]}`
}
