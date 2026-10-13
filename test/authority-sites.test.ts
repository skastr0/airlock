import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const packages = ["airlock", "cli", "cloudflare"]
const files = packages.flatMap((pkg) => {
  const root = resolve(import.meta.dirname, "..", "packages", pkg, "src")
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file: join(pkg, "src", file), source: readFileSync(join(root, file), "utf8") }))
})

const matches = (pattern: RegExp) => files.flatMap(({ file, source }) =>
  [...source.matchAll(pattern)].map((match) => ({ file, index: match.index }))
)

describe("terminal authority construction sites", () => {
  it("has exactly one wire call, in the host HTTP handler, behind a live permit", () => {
    const wire = matches(/\bfetch\s*\(/g)
    expect(wire).toHaveLength(1)
    expect(wire[0]?.file).toBe(join("cli", "src", "host", "HttpDispatcher.ts"))
    const source = files.find(({ file }) => file === join("cli", "src", "host", "HttpDispatcher.ts"))!.source
    const handler = source.indexOf('Effect.fn("HttpDispatcher.dispatch")')
    const permitCheck = source.indexOf("isLivePermit(request.permit)")
    // The handler refuses a permit that is not live before it builds a request.
    expect(handler).toBeGreaterThan(-1)
    expect(permitCheck).toBeGreaterThan(handler)
    expect(wire[0]!.index).toBeGreaterThan(permitCheck)
    // A tool implementation's entry takes the request the kernel bound to
    // the call's wire token, once, and refuses without it, also before the
    // request. It has no parameter through which a request could be given.
    const toolEntry = source.indexOf('Effect.fn("HttpDispatcher.send")')
    const tokenCheck = source.indexOf("takeWireRequest(token)")
    expect(toolEntry).toBeGreaterThan(-1)
    expect(tokenCheck).toBeGreaterThan(toolEntry)
    expect(wire[0]!.index).toBeGreaterThan(tokenCheck)
    const signature = source.slice(toolEntry, tokenCheck)
    expect(signature).not.toMatch(/\b(?:url|endpoint|method|headers|body|dispatch)\s*[:?]/)
    // The function that holds the request is private to the file and is
    // reached from those two entries only, each after its check.
    expect(source).not.toMatch(/export\s+(?:const|function)\s+onWire\b/)
    const reached = [...source.matchAll(/\bonWire\(/g)].map((match) => match.index)
    expect(reached).toHaveLength(2)
    expect(reached[0]).toBeGreaterThan(permitCheck)
    expect(reached[0]).toBeLessThan(toolEntry)
    expect(reached[1]).toBeGreaterThan(tokenCheck)
    expect(reached[1]).toBeLessThan(wire[0]!.index)
  })

  it("keeps the kernel free of any wire call", () => {
    expect(matches(/\bfetch\s*\(/g).filter(({ file }) => file.startsWith(join("airlock", "src")))).toEqual([])
    const globals = matches(/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/g)
    expect(globals.filter(({ file }) => file.startsWith(join("airlock", "src")))).toEqual([])
  })

  it("has exactly one physical deletion and it remains in Hold.reap", () => {
    const effectRemoves = matches(/\bfs\s*\.\s*remove\s*\(/gs)
    const nodeDeletes = matches(/\b(?:unlink|unlinkSync|rm|rmSync)\s*\(/g)
    const bunDeletes = matches(/\bBun\s*\.\s*file\([^)]*\)\s*\.\s*delete\s*\(/gs)
    expect(effectRemoves).toHaveLength(1)
    expect(effectRemoves[0]?.file).toBe(join("cli", "src", "Hold.ts"))
    expect(nodeDeletes).toEqual([])
    expect(bunDeletes).toEqual([])
    expect(files.find(({ file }) => file === join("cli", "src", "Hold.ts"))?.source)
      .toContain("const reap = Effect.fn(\"Hold.reap\")")
  })
})
