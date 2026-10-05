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
  it("has exactly one wire call, in the host HTTP handler, behind a live permit", () => {
    const wire = matches(/\bfetch\s*\(/g)
    expect(wire).toHaveLength(1)
    expect(wire[0]?.file).toBe("host/HttpDispatcher.ts")
    const source = files.find(({ file }) => file === "host/HttpDispatcher.ts")!.source
    const handler = source.indexOf('Effect.fn("HttpDispatcher.dispatch")')
    const permitCheck = source.indexOf("isLivePermit(request.permit)")
    // The handler refuses a permit that is not live before it builds a request.
    expect(handler).toBeGreaterThan(-1)
    expect(permitCheck).toBeGreaterThan(handler)
    expect(wire[0]!.index).toBeGreaterThan(permitCheck)
  })

  it("keeps the kernel free of any wire call", () => {
    expect(matches(/\bfetch\s*\(/g).filter(({ file }) => file.startsWith("core/"))).toEqual([])
    const globals = matches(/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/g)
    expect(globals.filter(({ file }) => file.startsWith("core/"))).toEqual([])
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
