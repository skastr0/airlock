import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The cloud adapters' boundary, enforced by construction. `packages/cloudflare/src`
 * may depend on `effect`, on the kernel package, on itself, and on
 * `cloudflare:workers`. It names no host: no Node or Bun module, no platform
 * package, no host global, and nothing under the file host or anywhere else in
 * the repository.
 */
const repository = resolve(import.meta.dirname, "..")
const cloudRoot = join(repository, "packages", "cloudflare", "src")
const coreRoot = join(repository, "packages", "airlock", "src")

// The runtime boundary covers the adapter itself. `alchemy/` in the source
// tree is the `./alchemy` subpath: recipe helpers that run under Node with
// `alchemy run`, never inside a Worker, so the boundary does not judge it.
const files = readdirSync(cloudRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => !file.startsWith("alchemy/"))
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
            : [{ file, specifier, reason: "leaves packages/cloudflare/src and packages/airlock/src" }]
        }
        // `cloudflare:workers` is the one module the Workers runtime itself
        // provides: the bases for RPC objects and Durable Objects. The kernel
        // enters only as its published package name.
        return specifier === "effect" || specifier.startsWith("effect/") || specifier === "cloudflare:workers" || specifier === "@skastr0/airlock"
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
