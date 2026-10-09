/**
 * Runs this example on your machine in workerd, the runtime Cloudflare runs,
 * with no Cloudflare account:
 *
 *   bun examples/cloudflare/local.ts
 *
 * The bindings are read off `airlockBindings()`, the same recipe
 * `alchemy.run.ts` deploys with, so what runs here is what would be deployed.
 * This file is tooling for the example, not part of what a user writes.
 */
import { airlockBindings, airlockCompatibility } from "@skastr0/airlock/alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { join, resolve } from "node:path"

const example = import.meta.dirname
const repository = resolve(example, "..", "..")

export const startLocal = async (options: { readonly port?: number } = {}): Promise<Miniflare> => {
  const script = (await build({
    entryPoints: [join(example, "src", "worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["worker", "browser", "import"],
    target: "es2022",
    // The example imports the package by name; inside this repository that is this file.
    alias: { "@skastr0/airlock/cloudflare": join(repository, "src", "cloudflare", "index.ts") },
    external: ["cloudflare:workers"],
    logLevel: "silent"
  })).outputFiles[0]!.text

  const durableObjects: { [binding: string]: { className: string; useSQLite: true } } = {}
  const workerLoaders: { [binding: string]: {} } = {}
  for (const [binding, resource] of Object.entries<unknown>(airlockBindings())) {
    if (Cloudflare.isWorkerLoader(resource)) workerLoaders[binding] = {}
    // Alchemy creates every Durable Object class SQLite-backed.
    else if (Cloudflare.isDurableObjectLike(resource)) {
      durableObjects[binding] = { className: resource.className ?? resource.name, useSQLite: true }
    }
  }

  return new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: airlockCompatibility.date,
    compatibilityFlags: [...airlockCompatibility.flags],
    durableObjects,
    workerLoaders,
    bindings: { MAIL_TOKEN: "example-token" },
    ...(options.port === undefined ? {} : { host: "127.0.0.1", port: options.port })
  })
}

if (import.meta.main) {
  const workerd = await startLocal({ port: Number(process.env["PORT"] ?? 8787) })
  console.log(`Airlock example listening on ${(await workerd.ready).origin}`)
}
