import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The cloud adapters' boundary, enforced by construction. `src/cloud` may
 * depend on `effect`, on the kernel, on itself, and on `cloudflare:workers`. It names no host: no Node
 * or Bun module, no platform package, no host global, and nothing under
 * `src/host` or anywhere else in the repository.
 */
const repository = resolve(import.meta.dirname, "..")
const cloudRoot = join(repository, "src", "cloud")
const coreRoot = join(repository, "src", "core")

const files = readdirSync(cloudRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, path: join(cloudRoot, file), source: readFileSync(join(cloudRoot, file), "utf8") }))

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")

const specifiers = (source: string): ReadonlyArray<string> => [
  ...code(source).matchAll(/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g),
  ...code(source).matchAll(/\bimport\s*["']([^"']+)["']/g),
  ...code(source).matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)
].map((match) => match[1]!)

const inside = (root: string, target: string) => !relative(root, target).startsWith("..")

describe("cloud adapter boundary", () => {
  it("has an entry point", () => {
    expect(existsSync(join(cloudRoot, "index.ts"))).toBe(true)
    expect(files.length).toBeGreaterThan(2)
  })

  it("imports only effect, the kernel and itself", () => {
    const violations = files.flatMap(({ file, path, source }) =>
      specifiers(source).flatMap((specifier) => {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          const target = resolve(dirname(path), specifier)
          return inside(cloudRoot, target) || inside(coreRoot, target)
            ? []
            : [{ file, specifier, reason: "leaves src/cloud and src/core" }]
        }
        // `cloudflare:workers` is the one module the Workers runtime itself
        // provides: the bases for RPC objects and Durable Objects.
        return specifier === "effect" || specifier.startsWith("effect/") || specifier === "cloudflare:workers"
          ? []
          : [{ file, specifier, reason: "not effect or the Workers runtime module" }]
      })
    )
    expect(violations).toEqual([])
  })

  it("does not import the file host", () => {
    const hostImports = files.filter(({ source }) => /["'][^"']*\/host\/[^"']*["']/.test(code(source)))
    expect(hostImports.map(({ file }) => file)).toEqual([])
  })

  it("names no host global", () => {
    const withoutStrings = (source: string) =>
      code(source).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "\"\"")
    const hostGlobal =
      /\b(?:process|Bun|Buffer|__dirname|__filename|require)\b(?=\s*[.(\[])|\bimport\.meta\.(?:dir|dirname|filename|path|main)\b/g
    const violations = files.flatMap(({ file, source }) =>
      [...withoutStrings(source).matchAll(hostGlobal)].map((match) => ({ file, name: match[0] }))
    )
    expect(violations).toEqual([])
  })
})
