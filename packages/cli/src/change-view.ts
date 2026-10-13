import type { ContentPage, Inventory, Review } from "./change/Change.ts"

/** Candidate bytes and names are data, never terminal control sequences. */
const quoted = (value: string) => JSON.stringify(value).replace(
  /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
)
const textLine = (value: string) => value.replace(
  /[\\\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
  character => character === "\\" ? "\\\\" : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
)
const mode = (value: number) => `0${value.toString(8).padStart(3, "0")}`

export const formatReview = (review: Review): string => {
  const p = review.proposal
  const lines = [
    `Proposal ${quoted(review.id)}`,
    `Target: ${quoted(p.target)}`,
    `Approval digest: ${review.proposalDigest}`,
    `Replacement: ${p.candidate.kind}; ${p.candidate.bytes} candidate bytes`,
    p.candidate.kind === "directory"
      ? "WHOLE DIRECTORY REPLACEMENT: omitted paths leave the live tree."
      : "Single-file replacement; siblings are outside this proposal.",
    "Stop readers and writers. Two renames are not an atomic swap.",
    "This is a frozen review, not a live-target attestation.",
    ""
  ]
  if (review.diff.length === 0) lines.push("No byte, kind, or mode differences.")
  for (const entry of review.diff) {
    lines.push(`${entry.change.toUpperCase()} ${quoted(entry.path || "(root)")}`)
    for (const [label, metadata, preview, prefix] of [
      ["before", entry.before, entry.beforeText, "-"],
      ["after", entry.after, entry.afterText, "+"]
    ] as const) {
      if (metadata === undefined) { lines.push(`  ${label}: absent`); continue }
      lines.push(`  ${label}: ${metadata.kind} mode=${mode(metadata.mode)} bytes=${metadata.bytes} sha256=${metadata.digest}`)
      if (preview?.binary) lines.push(`  ${label}: BINARY — use content to inspect encoded bytes.`)
      if (preview?.text !== undefined) {
        for (const line of preview.text.split("\n")) lines.push(`  ${prefix} ${textLine(line)}`)
      }
      if (preview?.truncated) lines.push(`  ${label}: TRUNCATED — this preview is NOT the complete file.`)
    }
  }
  lines.push("", "Inspect any omitted bytes: airlock change content ID --side before|after --path PATH --offset N --human")
  return lines.join("\n")
}

export const formatInventory = (inventory: Inventory): string => {
  const lines = [
    "Airlock review inbox — historical state; live target NOT CHECKED",
    `${inventory.totals.rows} proposals; ${inventory.totals.active}/${inventory.limits.proposals} active; snapshot/private-stage reserved ${inventory.totals.reservedBytes}/${inventory.limits.storage} bytes`,
    "World recovery payloads and historical metadata consume additional disk.",
    ""
  ]
  if (inventory.rows.length === 0) lines.push("No proposals. Prepare with Bash/Python, then airlock-agent change stage.")
  for (const row of inventory.rows) {
    lines.push(`${quoted(row.id)}  workflow=${row.workflowState}  snapshots=${row.snapshots.state}`)
    lines.push(`  apply=${row.applyState}  undo=${row.undoState}  reserved=${row.reservationBytes} bytes`)
    if (row.target !== undefined) lines.push(`  target: ${quoted(row.target)}`)
    if (row.proposalDigest !== undefined) lines.push(`  approval digest: ${row.proposalDigest}`)
    if (row.retirementDigest !== undefined) lines.push(`  retirement digest (NOT approval): ${row.retirementDigest}`)
    for (const error of row.errors) lines.push(`  ERROR ${quoted(error.operation)}: ${quoted(error.reason)}`)
  }
  lines.push("", "Review: airlock change review ID --human", "Approve: airlock change approve ID")
  return lines.join("\n")
}

export const formatContent = (page: ContentPage): string => {
  const lines = [
    `Frozen ${page.side} ${quoted(page.path || "(root)")} of ${quoted(page.id)}`,
    `Proposal digest: ${page.proposalDigest}`,
    `File sha256: ${page.fileDigest}`,
    `Bytes ${page.offset}..${page.offset + page.bytes} of ${page.totalBytes}; EOF=${page.eof}`
  ]
  const bytes = Buffer.from(page.dataBase64, "base64")
  let text: string | undefined
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { /* preserve raw page below */ }
  if (text === undefined || bytes.includes(0)) {
    lines.push("Binary or split UTF-8 page; exact bytes (base64):", page.dataBase64)
  } else {
    lines.push(...text.split("\n").map(textLine))
  }
  if (page.nextOffset !== null) lines.push(`MORE CONTENT: repeat with --offset ${page.nextOffset}. This page is not the entire file.`)
  return lines.join("\n")
}
