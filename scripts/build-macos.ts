#!/usr/bin/env bun
/**
 * Build glue, not runtime policy. Produces one self-contained Apple-silicon
 * supervisor and agent-only executables plus detached, inspectable provenance
 * files. It never removes or replaces an existing artifact: callers choose a
 * fresh --out directory.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { AIRLOCK_VERSION } from "../src/version.ts"

const usage = `usage: bun scripts/build-macos.ts [--out <directory>] [--target <bun-target>]

Builds self-contained Airlock supervisor and agent executables plus a detached
SHA-256 manifest.
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
const executables = [
  { name: "airlock", source: "./src/cli.ts", path: resolve(out, "airlock") },
  { name: "airlock-agent", source: "./src/agent-cli.ts", path: resolve(out, "airlock-agent") }
] as const

const outputs = [
  ...executables.map((entry) => entry.path),
  resolve(out, "airlock.sha256"),
  resolve(out, "airlock.manifest.json")
]
const existing = outputs.find(existsSync)
if (existing !== undefined) {
  throw new Error(`refusing to replace existing artifact: ${existing}`)
}

mkdirSync(out, { recursive: true })

for (const executable of executables) {
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      "--compile",
      "--target",
      target,
      "--outfile",
      executable.path,
      executable.source
    ],
    cwd: resolve(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit"
  })

  if (build.exitCode !== 0) {
    throw new Error(`Bun compile failed for ${executable.name} with exit ${build.exitCode}`)
  }
}

const built = executables.map((executable) => {
  const bytes = readFileSync(executable.path)
  return {
    name: basename(executable.path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: statSync(executable.path).size
  }
})
const manifest = {
  schema_version: 1,
  product: "airlock",
  version: AIRLOCK_VERSION,
  target,
  executables: built
}

writeFileSync(
  resolve(out, "airlock.sha256"),
  built.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n") + "\n",
  "utf8"
)
writeFileSync(
  resolve(out, "airlock.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
)
console.log(JSON.stringify(manifest, null, 2))
