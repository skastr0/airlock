import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The kernel boundary, enforced by construction.
 *
 * `packages/airlock/src` is the storage-agnostic kernel. It may depend on
 * `effect` and on itself, and on nothing that names a host: no Node or Bun
 * module, no platform package, no host global, and no file outside the kernel
 * package. A host adapter is a Layer that lives outside it.
 */
const repository = resolve(import.meta.dirname, "..")
const coreRoot = join(repository, "packages", "airlock", "src")

const coreFiles = (existsSync(coreRoot)
  ? readdirSync(coreRoot, { recursive: true, encoding: "utf8" })
  : [])
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({
    file,
    path: join(coreRoot, file),
    source: readFileSync(join(coreRoot, file), "utf8")
  }))

/** Comments cannot import or reference anything. */
const withoutComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")

/** Text inside a string literal is data: the action name "process.run" names no host. */
const withoutStrings = (source: string) =>
  withoutComments(source)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")

const moduleSpecifiers = (source: string): ReadonlyArray<string> => [
  ...withoutComments(source).matchAll(
    /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g
  ),
  ...withoutComments(source).matchAll(/\bimport\s*["']([^"']+)["']/g),
  ...withoutComments(source).matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)
].map((match) => match[1]!)

const isRelative = (specifier: string) =>
  specifier.startsWith("./") || specifier.startsWith("../")

const allowedPackage = (specifier: string) =>
  specifier === "effect" || specifier.startsWith("effect/")

describe("core kernel boundary", () => {
  it("has a kernel entry point and a conformance entry point", () => {
    expect(existsSync(join(coreRoot, "index.ts"))).toBe(true)
    expect(existsSync(join(coreRoot, "testing", "index.ts"))).toBe(true)
  })

  it("imports only effect and files inside the kernel package", () => {
    const violations = coreFiles.flatMap(({ file, path, source }) =>
      moduleSpecifiers(source).flatMap((specifier) => {
        if (isRelative(specifier)) {
          const target = resolve(dirname(path), specifier)
          return relative(coreRoot, target).startsWith("..")
            ? [{ file, specifier, reason: "leaves the kernel package" }]
            : []
        }
        return allowedPackage(specifier)
          ? []
          : [{ file, specifier, reason: "not effect" }]
      })
    )
    expect(violations).toEqual([])
  })

  it("names no host global", () => {
    const hostGlobal =
      /\b(?:process|Bun|Buffer|__dirname|__filename|require)\b(?=\s*[.(\[])|\bimport\.meta\.(?:dir|dirname|filename|path|main)\b/g
    const violations = coreFiles.flatMap(({ file, source }) =>
      [...withoutStrings(source).matchAll(hostGlobal)].map((match) => ({
        file,
        name: match[0]
      }))
    )
    expect(violations).toEqual([])
  })

  it("is exported as . and ./testing of the kernel package", () => {
    const manifest = JSON.parse(
      readFileSync(join(repository, "packages", "airlock", "package.json"), "utf8")
    ) as { readonly exports?: Record<string, string> }
    expect(manifest.exports?.["."]).toBe("./src/index.ts")
    expect(manifest.exports?.["./testing"]).toBe(
      "./src/testing/index.ts"
    )
  })
})
