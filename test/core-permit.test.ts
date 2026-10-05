import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Wire authority is a value only the Outbox kernel can create. These are
 * construction properties of the source: a second mint site, an exported
 * constructor, or a second handler call fails here before any behaviour does.
 */
const root = resolve(import.meta.dirname, "..", "src")
const kernel = "core/outbox/Outbox.ts"

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, source: withoutComments(readFileSync(join(root, file), "utf8")) }))

const occurrences = (pattern: RegExp) =>
  sources.flatMap(({ file, source }) => [...source.matchAll(pattern)].map(() => file))

describe("core: the dispatch permit has one origin", () => {
  it("is branded by a symbol that never leaves the kernel module", () => {
    expect(occurrences(/\bPermitTypeId\b\s*:\s*unique symbol\s*=/g)).toEqual([kernel])
    expect(occurrences(/export\s+(?:const|\{)[^\n]*\bPermitTypeId\b/g)).toEqual([])
    const elsewhere = sources
      .filter(({ file, source }) => file !== kernel && /\bPermitTypeId\b/.test(source))
      .map(({ file }) => file)
    expect(elsewhere).toEqual([])
  })

  it("is made live in exactly one place and constructed by exactly one call", () => {
    expect(occurrences(/\blivePermits\s*\.\s*add\s*\(/g)).toEqual([kernel])
    expect(occurrences(/\bconst\s+mintPermit\b/g)).toEqual([kernel])
    // One definition and one use: the commit path, after `staged → committing`.
    expect(occurrences(/\bmintPermit\s*\(/g)).toEqual([kernel])
    expect(occurrences(/export\s+(?:const|function|let|var)\s+(?:mintPermit|livePermits)\b/g)).toEqual([])
    expect(occurrences(/export\s*\{[^}]*\b(?:mintPermit|livePermits)\b/g)).toEqual([])
  })

  it("is minted only after the committing transition is persisted, and revoked after", () => {
    const source = sources.find(({ file }) => file === kernel)!.source
    const persisted = source.indexOf("state: \"committing\"")
    const minted = source.indexOf("mintPermit(tag")
    const revoked = source.indexOf("livePermits.delete(permit)")
    expect(persisted).toBeGreaterThan(-1)
    expect(minted).toBeGreaterThan(persisted)
    expect(revoked).toBeGreaterThan(minted)
  })

  it("has one handler call in the kernel, inside commit", () => {
    const source = sources.find(({ file }) => file === kernel)!.source
    expect([...source.matchAll(/\bhandlers\s*\[/g)]).toHaveLength(1)
    const commit = source.indexOf("Effect.fn(\"Outbox.commit\")")
    const cancel = source.indexOf("Effect.fn(\"Outbox.cancel\")")
    const call = source.indexOf("handlers[")
    expect(call).toBeGreaterThan(commit)
    expect(call).toBeLessThan(cancel)
  })
})
