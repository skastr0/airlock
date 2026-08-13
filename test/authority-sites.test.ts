import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const sourceRoot = resolve(import.meta.dirname, "..", "src")
const files = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, source: readFileSync(join(sourceRoot, file), "utf8") }))

const matches = (pattern: RegExp) => files.flatMap(({ file, source }) =>
  [...source.matchAll(pattern)].map((match) => ({ file, index: match.index }))
)

describe("terminal authority construction sites", () => {
  it("has exactly one wire call and it remains in Outbox.commit", () => {
    const wire = matches(/\bfetch\s*\(/g)
    expect(wire).toHaveLength(1)
    expect(wire[0]?.file).toBe("Outbox.ts")
    expect(files.find(({ file }) => file === "Outbox.ts")?.source)
      .toContain('const commit = Effect.fn("Outbox.commit")')
  })

  it("has exactly one physical deletion and it remains in Hold.reap", () => {
    const effectRemoves = matches(/\bfs\s*\.\s*remove\s*\(/gs)
    const nodeDeletes = matches(/\b(?:unlink|unlinkSync|rm|rmSync)\s*\(/g)
    const bunDeletes = matches(/\bBun\s*\.\s*file\([^)]*\)\s*\.\s*delete\s*\(/gs)
    expect(effectRemoves).toHaveLength(1)
    expect(effectRemoves[0]?.file).toBe("Hold.ts")
    expect(nodeDeletes).toEqual([])
    expect(bunDeletes).toEqual([])
    expect(files.find(({ file }) => file === "Hold.ts")?.source)
      .toContain("const reap = Effect.fn(\"Hold.reap\")")
  })
})
