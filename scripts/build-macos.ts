#!/usr/bin/env bun
/**
 * Build glue, not runtime policy. Produces one self-contained Apple-silicon
 * executable plus detached, inspectable provenance files. It never removes or
 * replaces an existing artifact: callers choose a fresh --out directory.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { AIRLOCK_VERSION } from "../src/version.ts"

const usage = `usage: bun scripts/build-macos.ts [--out <directory>] [--target <bun-target>]

Builds a self-contained Airlock executable and detached SHA-256 manifest.
Defaults: --out dist and the Bun Darwin target matching this Mac`

const args = process.argv.slice(2)
const valueAfter = (flag: string): string => {
  const index = args.indexOf(flag)
  if (index === -1 || args[index + 1] === undefined) {
    throw new Error(`${flag} requires a value`)
  }
  return args[index + 1]
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(usage)
  process.exit(0)
}

const known = new Set(["--out", "--target"])
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!
  if (!known.has(argument)) {
    throw new Error(`unknown argument: ${argument}`)
  }
  index += 1
}

const out = resolve(args.includes("--out") ? valueAfter("--out") : "dist")
const hostTarget =
  process.arch === "arm64"
    ? "bun-darwin-arm64"
    : process.arch === "x64"
      ? "bun-darwin-x64"
      : undefined
const target = args.includes("--target") ? valueAfter("--target") : hostTarget
if (target === undefined || !/^bun-darwin-(arm64|x64)$/.test(target)) {
  throw new Error(
    "macOS builds require --target bun-darwin-arm64 or bun-darwin-x64"
  )
}
const executable = resolve(out, "airlock")

const outputs = [
  executable,
  resolve(out, "airlock.sha256"),
  resolve(out, "airlock.manifest.json")
]
const existing = outputs.find(existsSync)
if (existing !== undefined) {
  throw new Error(`refusing to replace existing artifact: ${existing}`)
}

mkdirSync(out, { recursive: true })

const build = Bun.spawnSync({
  cmd: [
    process.execPath,
    "build",
    "--compile",
    "--target",
    target,
    "--outfile",
    executable,
    "./src/cli.ts"
  ],
  cwd: resolve(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit"
})

if (build.exitCode !== 0) {
  throw new Error(`Bun compile failed with exit ${build.exitCode}`)
}

const bytes = readFileSync(executable)
const sha256 = createHash("sha256").update(bytes).digest("hex")
const manifest = {
  schema_version: 1,
  product: "airlock",
  version: AIRLOCK_VERSION,
  target,
  executable: basename(executable),
  sha256,
  bytes: statSync(executable).size
}

writeFileSync(resolve(out, "airlock.sha256"), `${sha256}  airlock\n`, "utf8")
writeFileSync(
  resolve(out, "airlock.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
)
console.log(JSON.stringify(manifest, null, 2))
