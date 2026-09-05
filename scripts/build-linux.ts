#!/usr/bin/env bun
/**
 * Linux release glue. Produces two standalone Bun executables and the native
 * Landlock/seccomp launcher. It never replaces an existing artifact.
 *
 * The launcher is compiled for the build host, so this builder deliberately
 * rejects cross-architecture targets. Build once on each supported
 * architecture instead of publishing an untested mixed-architecture bundle.
 */
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs"
import { basename, resolve } from "node:path"
import { AIRLOCK_VERSION } from "../src/version.ts"

const usage = `usage: bun scripts/build-linux.ts [--out <directory>] [--target <bun-target>]

Builds standalone Airlock supervisor and agent executables, the native Linux
policy launcher, a SHA-256 list, and a JSON manifest.
Defaults: --out dist and the glibc Bun Linux target matching this host.
Supported targets: bun-linux-x64, bun-linux-arm64 (host architecture only).`

const args = process.argv.slice(2)
let outputArgument = "dist"
let targetArgument: string | undefined
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!
  if (argument === "--help" || argument === "-h") {
    console.log(usage)
    process.exit(0)
  }
  if (argument !== "--out" && argument !== "--target") {
    throw new Error(`unknown argument: ${argument}`)
  }
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${argument} requires a value`)
  if (argument === "--out") outputArgument = value
  else targetArgument = value
  index += 1
}

if (process.platform !== "linux") {
  throw new Error("Linux artifacts must be built on Linux")
}
const hostTarget = process.arch === "x64"
  ? "bun-linux-x64"
  : process.arch === "arm64"
    ? "bun-linux-arm64"
    : undefined
if (hostTarget === undefined) {
  throw new Error(`unsupported Linux build architecture: ${process.arch}`)
}
const target = targetArgument ?? hostTarget
if (target !== hostTarget) {
  throw new Error(
    `the native launcher is a host build (${hostTarget}); refusing mixed-architecture target ${target}`
  )
}

const repository = resolve(import.meta.dir, "..")
const out = resolve(outputArgument)
const executables = [
  { name: "airlock", source: "./src/cli.ts", path: resolve(out, "airlock") },
  {
    name: "airlock-agent",
    source: "./src/agent-cli.ts",
    path: resolve(out, "airlock-agent")
  }
] as const
const launcher = resolve(out, "airlock-linux-launcher")
const checksum = resolve(out, "airlock.sha256")
const manifestPath = resolve(out, "airlock.manifest.json")
const outputs = [
  ...executables.map(({ path }) => path),
  launcher,
  checksum,
  manifestPath
]
const existing = outputs.find(existsSync)
if (existing !== undefined) {
  throw new Error(`refusing to replace existing artifact: ${existing}`)
}
mkdirSync(out, { recursive: true })

const launcherBuild = Bun.spawnSync({
  cmd: ["/bin/sh", "scripts/build-linux-launcher.sh", launcher],
  cwd: repository,
  stdout: "inherit",
  stderr: "inherit"
})
if (launcherBuild.exitCode !== 0) {
  throw new Error(`native launcher build failed with exit ${launcherBuild.exitCode}`)
}

for (const executable of executables) {
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--target",
      target,
      "--outfile",
      executable.path,
      executable.source
    ],
    cwd: repository,
    stdout: "inherit",
    stderr: "inherit"
  })
  if (build.exitCode !== 0) {
    throw new Error(
      `Bun compile failed for ${executable.name} with exit ${build.exitCode}`
    )
  }
  const probe = Bun.spawnSync({
    cmd: [executable.path, "--version"],
    env: {},
    stdout: "pipe",
    stderr: "pipe"
  })
  if (probe.exitCode !== 0) {
    throw new Error(`${executable.name} version probe failed with exit ${probe.exitCode}`)
  }
}

const launcherProbe = Bun.spawnSync({
  cmd: [launcher, "--probe"],
  env: {},
  stdout: "pipe",
  stderr: "pipe"
})
const probeOutput = new TextDecoder().decode(launcherProbe.stdout).trim()
const probe = /^airlock-linux-launcher-v1 landlock-abi=(\d+) seccomp=1$/.exec(
  probeOutput
)
if (launcherProbe.exitCode !== 0 || probe === null) {
  throw new Error(
    `native launcher probe failed: ${new TextDecoder().decode(launcherProbe.stderr) || probeOutput}`
  )
}

const built = [...executables.map(({ path }) => path), launcher].map((path) => {
  const status = statSync(path)
  if (!status.isFile() || (status.mode & 0o111) === 0 || (status.mode & 0o6000) !== 0) {
    throw new Error(`unsafe executable metadata: ${path}`)
  }
  const bytes = readFileSync(path)
  return {
    name: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: status.size
  }
})
const manifest = {
  schema_version: 1,
  product: "airlock",
  version: AIRLOCK_VERSION,
  platform: "linux",
  architecture: process.arch,
  target,
  executables: built,
  runtime_requirements: {
    bubblewrap: ">=0.12.0, regular non-setuid executable without file capabilities",
    landlock_abi: ">=2",
    libseccomp: "launcher runtime library (normally libseccomp.so.2)",
    file_capability_inspection: "libcap getcap utility",
    user_namespaces: "unprivileged user and mount namespace creation",
    libc: "glibc"
  },
  build_probe: {
    launcher: "airlock-linux-launcher-v1",
    landlock_abi: Number(probe[1]),
    seccomp: true
  }
}

writeFileSync(
  checksum,
  built.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n") + "\n",
  "utf8"
)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
console.log(JSON.stringify(manifest, null, 2))
