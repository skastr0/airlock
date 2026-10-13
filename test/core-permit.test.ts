import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Wire authority is a value only the Outbox kernel can create. These are
 * construction properties of the source: a second mint site, an exported
 * constructor, or a second handler call fails here before any behaviour does.
 */
const packages = ["airlock", "cli", "cloudflare"]
const kernel = join("airlock", "src", "outbox", "Outbox.ts")

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

const sources = packages.flatMap((pkg) => {
  const root = resolve(import.meta.dirname, "..", "packages", pkg, "src")
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file: join(pkg, "src", file), source: withoutComments(readFileSync(join(root, file), "utf8")) }))
})

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
    // One definition and one use: the private dispatch entry shared by both admitted paths.
    expect(occurrences(/\bmintPermit\s*\(/g)).toEqual([kernel])
    expect(occurrences(/export\s+(?:const|function|let|var)\s+(?:mintPermit|livePermits)\b/g)).toEqual([])
    expect(occurrences(/export\s*\{[^}]*\b(?:mintPermit|livePermits)\b/g)).toEqual([])
  })

  it("revokes every minted permit after the single handler entry settles", () => {
    const source = sources.find(({ file }) => file === kernel)!.source
    const dispatch = source.indexOf("const dispatchOnce =")
    const minted = source.indexOf("mintPermit(tag")
    const call = source.indexOf("handlers[")
    const revoked = source.indexOf("livePermits.delete(permit)")
    const commit = source.indexOf('Effect.fn("Outbox.commit")')
    expect(dispatch).toBeGreaterThan(-1)
    expect(minted).toBeGreaterThan(dispatch)
    expect(call).toBeGreaterThan(minted)
    expect(revoked).toBeGreaterThan(call)
    expect(revoked).toBeLessThan(commit)
    expect(source.slice(call, revoked)).toContain("Effect.ensuring")
  })

  it("has one private handler entry reached only by durable commit or exact capture-now", () => {
    const source = sources.find(({ file }) => file === kernel)!.source
    expect([...source.matchAll(/\bhandlers\s*\[/g)]).toHaveLength(1)
    expect(source).not.toMatch(/export\s+(?:const|function)\s+dispatchOnce\b/)
    const dispatch = source.indexOf("const dispatchOnce =")
    const commit = source.indexOf('Effect.fn("Outbox.commit")')
    const capture = source.indexOf('const capture: OutboxService<Kinds>["capture"]')
    const cancel = source.indexOf('Effect.fn("Outbox.cancel")')
    const calls = [...source.matchAll(/\bdispatchOnce\(/g)].map((match) => match.index)
    expect(calls).toHaveLength(2)
    expect(source.indexOf("handlers[")).toBeGreaterThan(dispatch)
    expect(source.indexOf("handlers[")).toBeLessThan(commit)
    const persisted = source.indexOf('store.transition(id, "staged", {', commit)
    expect(persisted).toBeGreaterThan(commit)
    expect(source.slice(persisted, calls[0])).toContain('state: "committing"')
    expect(calls[0]).toBeGreaterThan(persisted)
    expect(calls[0]).toBeLessThan(capture)
    const capturePath = source.slice(capture, calls[1])
    expect(capturePath).toContain('Schema.toType(CaptureAdmission)')
    expect(capturePath).toContain('registered.value.effect !== "capture"')
    expect(capturePath).toContain('checked.success.execution.tool !== kind.tag')
    expect(capturePath).toContain('checked.success.execution.version !== kind.version')
    expect(calls[1]).toBeGreaterThan(capture)
    expect(calls[1]).toBeLessThan(cancel)
    const admission = sources.find(({ file }) => file === "airlock/src/outbox/Capture.ts")!.source
    expect(admission).toContain('effect: Schema.Literal("capture")')
    expect(admission).toContain('when: Schema.Literal("now")')
  })
})
