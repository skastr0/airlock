#!/usr/bin/env bun
import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { createHash, createPublicKey } from "node:crypto"
import { dirname, isAbsolute, resolve } from "node:path"

const usage = "usage: bun scripts/build-box.ts --public-key ABSOLUTE_PEM --out ABSOLUTE_BINARY [--mode root-tenant|local-same-user] [--target bun-darwin-arm64|bun-darwin-x64]"
const args = process.argv.slice(2)
const option = (name: string, required = true) => {
  const index = args.indexOf(name)
  const value = index < 0 ? undefined : args[index + 1]
  if (required && value === undefined) throw new Error(`${name} is required`)
  return value
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage)
  process.exit(0)
}
const known = new Set(["--public-key", "--out", "--mode", "--target"])
for (let index = 0; index < args.length; index += 2) {
  if (!known.has(args[index]!)) throw new Error(`unknown option: ${args[index]}`)
  if (args[index + 1] === undefined) throw new Error(`${args[index]} requires a value`)
}
const publicKeyPath = option("--public-key")!
const out = option("--out")!
const mode = option("--mode", false) ?? "root-tenant"
const target = option("--target", false)
if (mode !== "root-tenant" && mode !== "local-same-user") {
  throw new Error("--mode must be root-tenant or local-same-user")
}
for (const [name, value] of [["--public-key", publicKeyPath], ["--out", out]] as const) {
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${name} must be an absolute normalized path`)
}
let handle
let publicBytes: Buffer
try {
  handle = await open(publicKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  const info = await handle.stat()
  if (!info.isFile() || info.size > 16_384) throw new Error("public key must be a bounded regular file")
  publicBytes = await handle.readFile()
} finally {
  await handle?.close()
}
const key = createPublicKey({ key: publicBytes, format: "pem", type: "spki" })
if (key.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519")
const der = key.export({ format: "der", type: "spki" })
const digest = `sha256:${createHash("sha256").update(der).digest("hex")}`
try {
  const existing = await open(out, constants.O_RDONLY | constants.O_NOFOLLOW)
  await existing.close()
  throw new Error(`refusing to replace existing artifact: ${out}`)
} catch (cause) {
  if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
    // fresh output
  } else if (cause instanceof Error && cause.message.startsWith("refusing")) {
    throw cause
  }
}
await mkdir(dirname(out), { recursive: true })
const command = [
  process.execPath, "build", "--compile", "--outfile", out,
  "--define", `AIRLOCK_OPERATOR_KEY_SHA256=${JSON.stringify(digest)}`,
  "--define", `AIRLOCK_BOX_MODE=${JSON.stringify(mode)}`,
  ...(target === undefined ? [] : ["--target", target]),
  "src/box-cli.ts"
]
const built = Bun.spawnSync({
  cmd: command,
  cwd: resolve(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit"
})
if (built.exitCode !== 0) throw new Error(`Bun compile failed with exit ${built.exitCode}`)
if (process.platform === "darwin") {
  const signed = Bun.spawnSync({ cmd: ["codesign", "--force", "--sign", "-", out], stdout: "inherit", stderr: "inherit" })
  if (signed.exitCode !== 0) throw new Error(`codesign failed with exit ${signed.exitCode}`)
}
const anchorPath = `${out}.operator-key.sha256`
const anchor = await open(
  anchorPath,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  0o444
)
try {
  await anchor.writeFile(`${digest}\n`)
  await anchor.sync()
  await anchor.chmod(0o444)
} finally {
  await anchor.close()
}
console.log(JSON.stringify({ binary: out, mode, operatorKeyDigest: digest, anchor: anchorPath }))
