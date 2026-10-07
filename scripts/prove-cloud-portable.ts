#!/usr/bin/env bun
/**
 * Portability proof for the cloud adapters.
 *
 * Bundles `src/cloud`, the test Worker and the example Worker the way a Workers runtime loads
 * them: a neutral platform, no Node built-ins, no `nodejs_compat`. A `node:`
 * or `bun:` import anywhere in the graph fails the build, and so does a
 * reference to a host global in the output. Running the bundle is the job of
 * `test/cloud-durable.test.ts`, which loads the same Worker into workerd.
 */
import { build } from "esbuild"
import { resolve } from "node:path"

const repository = resolve(import.meta.dir, "..")

const bundle = (entry: string) =>
  build({
    entryPoints: [resolve(repository, entry)],
    bundle: true,
    write: false,
    format: "esm",
    // `neutral` resolves no Node built-in and applies no polyfill.
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["worker", "browser", "import"],
    target: "es2022",
    // The one module the Workers runtime provides.
    external: ["cloudflare:workers"],
    // The example imports the package by name; here that is this repository.
    alias: { "@skastr0/airlock/cloud": resolve(repository, "src/cloud/index.ts") },
    logLevel: "silent"
  }).catch((failure: {
    readonly errors?: ReadonlyArray<{ readonly text: string; readonly location?: { readonly file: string } | null }>
  }) => {
    for (const error of failure.errors ?? []) {
      console.error(`${error.location?.file ?? "?"}: ${error.text}`)
    }
    console.error(`${entry} is not portable: the bundle has unresolved host imports`)
    process.exit(1)
  })

const hostReference = /\b(?:require\s*\(|process\.(?:env|versions|platform|argv)|Bun\.)/
const sizes: Record<string, number> = {}
for (const entry of ["src/cloud/index.ts", "test/cloud/worker.ts", "examples/cloudflare/src/worker.ts"]) {
  const source = (await bundle(entry)).outputFiles[0]!.text
  if (hostReference.test(source)) {
    console.error(`${entry} bundles a reference to a host global`)
    process.exit(1)
  }
  sizes[entry] = source.length
}

console.log(JSON.stringify({ proof: "airlock-cloud-portable-v1", ok: true, bundleBytes: sizes }))
