#!/usr/bin/env bun
/**
 * Off-box operator glue for creating, checking, and installing sealed Airlock
 * box bundles. A bundle is always:
 *
 *   BUNDLE/bin/airlock
 *   BUNDLE/seal/{box-grant.json,box-grant.ed25519,operator-ed25519.pub.pem,catalog/}
 *
 * This tool never removes or replaces an artifact. Installation exclusively
 * owns a fresh generation directory, builds in place, and publishes readiness
 * only by creating its readonly SEALED marker with O_EXCL.
 */
import {
  constants,
  type Stats
} from "node:fs"
import {
  chmod,
  chown,
  mkdir,
  open,
  lstat,
  readdir,
  stat
} from "node:fs/promises"
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto"
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from "node:path"
import { Effect, Schema } from "effect"
import { decodeBoxGrant } from "../src/admission/BoxGrant.ts"
import { AdmissionPolicyDocument } from "../src/admission/Admission.ts"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  BinarySnapshot,
  OPERATOR_PUBLIC_KEY_FILE,
  SEAL_CATALOG_DIRECTORY,
  boxGrantSigningPayload,
  catalogFileNameForPin,
  verifySealAtPath
} from "../src/seal/index.ts"
import {
  ToolDefinitionDocument,
  ToolDefinitionLocation,
  decodeToolDefinition
} from "../src/tools/Definitions.ts"
import { DEFAULT_TOOL_DEFINITION_MAX_BYTES } from "../src/tools/FileReader.ts"

const usage = `usage: bun scripts/seal-box.ts <command> [options]

Commands:
  keygen --private-key PATH --public-key PATH
  create --binary FILE --admission FILE [--verb V ...] [--native-action A ...]
         [--definition FILE ...] [--daemon-op O ...] --private-key FILE
         --public-key FILE --out FRESH_DIR [--allow-sealed-compatibility]
  verify --bundle DIR
  install --bundle DIR --root DIR --box ID --workspace DIR
          [--daemon-user NAME --daemon-uid N --daemon-group NAME --daemon-gid N]
          [--agent-user NAME --agent-uid N --agent-group NAME --agent-gid N]
          [--apply-ownership]

create emits BUNDLE/bin/airlock plus BUNDLE/seal/. install publishes one fresh
root/Library/Airlock/boxes/BOX/GRANT_HEX generation and does not run launchctl.`

class CliError extends Error {
  constructor(message: string, readonly exitCode = 64) {
    super(message)
  }
}

const fail = (message: string, exitCode = 64): never => {
  throw new CliError(message, exitCode)
}

const args = process.argv.slice(2)
const command = args.shift()

if (command === undefined || command === "--help" || command === "-h") {
  console.log(usage)
  process.exit(command === undefined ? 64 : 0)
}

const optionSpecification = {
  keygen: {
    single: new Set(["--private-key", "--public-key"]),
    repeated: new Set<string>(),
    boolean: new Set<string>()
  },
  create: {
    single: new Set([
      "--binary", "--admission", "--private-key", "--public-key", "--out"
    ]),
    repeated: new Set([
      "--verb", "--native-action", "--definition", "--daemon-op"
    ]),
    boolean: new Set(["--allow-sealed-compatibility"])
  },
  verify: {
    single: new Set(["--bundle"]),
    repeated: new Set<string>(),
    boolean: new Set<string>()
  },
  install: {
    single: new Set([
      "--bundle", "--root", "--box", "--workspace",
      "--daemon-user", "--daemon-uid", "--daemon-group", "--daemon-gid",
      "--agent-user", "--agent-uid", "--agent-group", "--agent-gid"
    ]),
    repeated: new Set<string>(),
    boolean: new Set(["--apply-ownership"])
  }
} as const

type ParsedOptions = {
  readonly single: ReadonlyMap<string, string>
  readonly repeated: ReadonlyMap<string, ReadonlyArray<string>>
  readonly boolean: ReadonlySet<string>
}

const parseOptions = (name: keyof typeof optionSpecification): ParsedOptions => {
  const specification = optionSpecification[name]
  const single = new Map<string, string>()
  const repeated = new Map<string, Array<string>>()
  const boolean = new Set<string>()

  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (!flag.startsWith("--")) fail(`unexpected positional argument: ${flag}`)
    if (specification.boolean.has(flag as never)) {
      if (boolean.has(flag)) fail(`duplicate option: ${flag}`)
      boolean.add(flag)
      continue
    }
    if (
      !specification.single.has(flag as never) &&
      !specification.repeated.has(flag as never)
    ) {
      fail(`unknown option for ${name}: ${flag}`)
    }
    const value = args[++index]
    if (value === undefined || value.startsWith("--")) {
      fail(`${flag} requires a value`)
    }
    if (specification.single.has(flag as never)) {
      if (single.has(flag)) fail(`duplicate option: ${flag}`)
      single.set(flag, value)
    } else {
      const values = repeated.get(flag) ?? []
      values.push(value)
      repeated.set(flag, values)
    }
  }
  return { single, repeated, boolean }
}

const required = (options: ParsedOptions, flag: string): string => {
  const value = options.single.get(flag)
  return value === undefined || value.length === 0
    ? fail(`${flag} is required`)
    : value
}

const requireAbsolute = (flag: string, value: string): string => {
  if (!isAbsolute(value)) fail(`${flag} must be an absolute path`)
  if (value.includes("\0")) fail(`${flag} must not contain NUL`)
  const resolved = resolve(value)
  const spelledWithoutTrailingSeparator =
    value.length > parse(value).root.length && value.endsWith(sep)
      ? value.slice(0, -1)
      : value
  if (spelledWithoutTrailingSeparator !== resolved) {
    fail(`${flag} must be an absolute normalized path without traversal`)
  }
  return resolved
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (cause) {
    if (osCode(cause) === "ENOENT" || osCode(cause) === "ENOTDIR") return false
    throw cause
  }
}

const osCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause &&
      typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : undefined

class ReadRefusal extends Error {}

const sameOpenedFile = (before: Stats, after: Stats) =>
  before.dev === after.dev && before.ino === after.ino &&
  before.size === after.size && before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs

const readRegularNoSymlink = async (
  flag: string,
  path: string,
  options: { readonly maxBytes?: number; readonly executable?: boolean } = {}
): Promise<Uint8Array> => {
  let handle
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const before = await handle.stat()
    if (!before.isFile()) throw new ReadRefusal(`${flag} must be a regular file`)
    if (options.executable && (before.mode & 0o111) === 0) {
      throw new ReadRefusal(`${flag} must be executable`)
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new ReadRefusal(`${flag} has an invalid size`)
    }
    if (options.maxBytes !== undefined && before.size > options.maxBytes) {
      throw new ReadRefusal(`${flag} exceeds ${options.maxBytes} bytes`)
    }
    const bytes = new Uint8Array(await handle.readFile())
    const after = await handle.stat()
    if (!sameOpenedFile(before, after) || bytes.byteLength !== after.size) {
      throw new ReadRefusal(`${flag} changed during read`)
    }
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
      throw new ReadRefusal(`${flag} exceeds ${options.maxBytes} bytes`)
    }
    return bytes
  } catch (cause) {
    if (cause instanceof ReadRefusal) fail(cause.message, 66)
    const code = osCode(cause)
    if (code === "ELOOP") fail(`${flag} must not be a symlink`, 66)
    if (code === "ENOENT" || code === "ENOTDIR") fail(`${flag} does not exist`, 66)
    return fail(`${flag} cannot be read as a regular nonsymlink file`, 66)
  } finally {
    await handle?.close()
  }
}

const decodeUtf8 = (flag: string, bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return fail(`${flag} must be valid UTF-8`, 65)
  }
}

const decodeJson = (flag: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fail(`${flag} must contain valid JSON`, 65)
  }
}

const sha256 = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const writeExclusive = async (
  path: string,
  bytes: string | Uint8Array,
  mode: number
): Promise<void> => {
  let handle
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.chmod(mode)
  } catch (cause) {
    if (osCode(cause) === "EEXIST") fail(`refusing to replace existing artifact: ${path}`, 73)
    throw cause
  } finally {
    await handle?.close()
  }
}

const chmodExact = async (path: string, mode: number): Promise<void> => {
  await chmod(path, mode)
  if ((mode & 0o7000) !== 0 && ((await stat(path)).mode & 0o7777) !== mode) {
    // Bun's Darwin fs.chmod currently drops special mode bits. Invoke the
    // fixed system chmod directly (never a shell or PATH lookup), then verify.
    const adjusted = Bun.spawnSync({
      cmd: ["/bin/chmod", mode.toString(8), path],
      stdout: "ignore",
      stderr: "pipe"
    })
    if (adjusted.exitCode !== 0 || ((await stat(path)).mode & 0o7777) !== mode) {
      fail(`could not set exact mode ${mode.toString(8)} on ${path}`, 74)
    }
  }
}

const mkdirFresh = async (path: string, mode = 0o755): Promise<void> => {
  try {
    await mkdir(path, { mode })
    await chmodExact(path, mode)
  } catch (cause) {
    if (osCode(cause) === "EEXIST") fail(`destination already exists: ${path}`, 73)
    throw cause
  }
}

const ensureDirectory = async (path: string, mode = 0o755): Promise<void> => {
  try {
    await mkdir(path, { mode })
    // Correct only the directory this call created; never chmod an ancestor
    // that was already installed or supplied by the operator.
    await chmod(path, mode)
  } catch (cause) {
    if (osCode(cause) !== "EEXIST") throw cause
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`required directory is not a nonsymlink directory: ${path}`, 73)
    }
  }
}

const pathInside = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate)
  return difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
}

const pathsOverlap = (left: string, right: string): boolean =>
  pathInside(left, right) || pathInside(right, left)

const inspectDirectoryInput = async (
  flag: string,
  path: string,
  required: boolean
): Promise<void> => {
  try {
    const inspected = await lstat(path)
    if (inspected.isSymbolicLink()) fail(`${flag} must not be a symlink`, 66)
    if (!inspected.isDirectory()) fail(`${flag} must be a directory`, 66)
  } catch (cause) {
    if (cause instanceof CliError) throw cause
    if (!required && (osCode(cause) === "ENOENT" || osCode(cause) === "ENOTDIR")) return
    if (osCode(cause) === "ENOENT" || osCode(cause) === "ENOTDIR") {
      fail(`${flag} does not exist as a directory`, 66)
    }
    throw cause
  }
}

/* Existing ancestors are opened directly below; no realpath-based widening. */

const refuseSymlinkAncestors = async (flag: string, path: string): Promise<void> => {
  const root = parse(path).root
  const segments = relative(root, path).split(sep).filter(Boolean)
  let cursor = root
  for (const segment of segments) {
    cursor = join(cursor, segment)
    try {
      const present = await Bun.file(cursor).exists()
      if (!present) return
      const handle = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = await handle.stat()
      await handle.close()
      if (!opened.isDirectory() && cursor !== path) {
        fail(`${flag} ancestor is not a directory: ${cursor}`)
      }
    } catch (cause) {
      if (cause instanceof CliError) throw cause
      if (osCode(cause) === "ELOOP") fail(`${flag} must not traverse symlink: ${cursor}`)
      if (osCode(cause) === "ENOENT" || osCode(cause) === "ENOTDIR") return
      throw cause
    }
  }
}

const privateKeyFrom = async (path: string): Promise<KeyObject> => {
  let handle
  let bytes = new Uint8Array()
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat()
    if (!before.isFile()) fail("--private-key must be a regular file", 66)
    if ((before.mode & 0o077) !== 0) {
      fail("--private-key must have no group or other permissions", 65)
    }
    if (before.size > 16 * 1024) fail("--private-key is too large", 65)
    bytes = new Uint8Array(await handle.readFile())
    const after = await handle.stat()
    if (!sameOpenedFile(before, after) || bytes.byteLength !== after.size) {
      fail("--private-key changed during read", 65)
    }
  } catch (cause) {
    if (cause instanceof CliError) throw cause
    if (osCode(cause) === "ELOOP") fail("--private-key must not be a symlink", 66)
    fail("--private-key cannot be read", 66)
  } finally {
    await handle?.close()
  }
  let key: KeyObject
  try {
    key = createPrivateKey({ key: Buffer.from(bytes), format: "pem", type: "pkcs8" })
  } catch {
    return fail("--private-key is not a PKCS8 PEM private key", 65)
  }
  if (key.asymmetricKeyType !== "ed25519") fail("--private-key must be Ed25519", 65)
  return key
}

const publicKeyFrom = async (path: string): Promise<{ readonly key: KeyObject; readonly bytes: Uint8Array }> => {
  const bytes = await readRegularNoSymlink("--public-key", path, { maxBytes: 16 * 1024 })
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(bytes), format: "pem", type: "spki" })
  } catch {
    return fail("--public-key is not an SPKI PEM public key", 65)
  }
  if (key.asymmetricKeyType !== "ed25519") fail("--public-key must be Ed25519", 65)
  return { key, bytes }
}

const samePublicKey = (left: KeyObject, right: KeyObject): boolean => {
  const leftDer = left.export({ format: "der", type: "spki" })
  const rightDer = right.export({ format: "der", type: "spki" })
  return Buffer.from(leftDer).equals(Buffer.from(rightDer))
}

const keygen = async (): Promise<void> => {
  const options = parseOptions("keygen")
  const privatePath = requireAbsolute("--private-key", required(options, "--private-key"))
  const publicPath = requireAbsolute("--public-key", required(options, "--public-key"))
  if (privatePath === publicPath) fail("private and public key paths must differ")
  await refuseSymlinkAncestors("--private-key", dirname(privatePath))
  await refuseSymlinkAncestors("--public-key", dirname(publicPath))
  if (await exists(privatePath)) fail(`refusing to replace existing artifact: ${privatePath}`, 73)
  if (await exists(publicPath)) fail(`refusing to replace existing artifact: ${publicPath}`, 73)

  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" })
  const publicPem = publicKey.export({ format: "pem", type: "spki" })

  // Private first: a later public-key collision leaves no disclosed key bytes.
  await writeExclusive(privatePath, privatePem, 0o600)
  await writeExclusive(publicPath, publicPem, 0o444)
  console.log(JSON.stringify({ privateKey: privatePath, publicKey: publicPath }))
}

type DefinitionSnapshot = {
  readonly id: string
  readonly rawBytes: Uint8Array
  readonly digest: `sha256:${string}`
}

const decodeAdmission = async (path: string): Promise<typeof AdmissionPolicyDocument.Type> => {
  const bytes = await readRegularNoSymlink("--admission", path, {
    maxBytes: DEFAULT_TOOL_DEFINITION_MAX_BYTES
  })
  const parsed = decodeJson("--admission", decodeUtf8("--admission", bytes))
  try {
    return await Effect.runPromise(
      Schema.decodeUnknown(AdmissionPolicyDocument, { onExcessProperty: "error" })(parsed)
    )
  } catch {
    return fail("--admission is not a strict AdmissionPolicyDocument", 65)
  }
}

const decodeDefinition = async (path: string): Promise<DefinitionSnapshot> => {
  const rawBytes = await readRegularNoSymlink("--definition", path, {
    maxBytes: DEFAULT_TOOL_DEFINITION_MAX_BYTES
  })
  const json = decodeUtf8("--definition", rawBytes)
  const location = new ToolDefinitionLocation({
    kind: "installed",
    directory: dirname(path)
  })
  try {
    const loaded = await Effect.runPromise(decodeToolDefinition(
      new ToolDefinitionDocument({ location, file: path, json })
    ))
    return { id: loaded.definition.id, rawBytes, digest: sha256(rawBytes) }
  } catch {
    return fail(`invalid tool definition: ${path}`, 65)
  }
}

const sortedUnique = (flag: string, values: ReadonlyArray<string>): Array<string> => {
  const sorted = [...values].sort()
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] === sorted[index - 1]) fail(`${flag} must not contain duplicates`)
  }
  return sorted
}

const verifyBundle = async (bundlePath: string) => {
  const bundle = requireAbsolute("--bundle", bundlePath)
  await refuseSymlinkAncestors("--bundle", dirname(bundle))
  const info = await lstat(bundle)
  if (info.isSymbolicLink()) fail("--bundle must not be a symlink", 66)
  if (!info.isDirectory()) fail("--bundle must be a directory", 66)
  const binaryPath = join(bundle, "bin", "airlock")
  const binary = await readRegularNoSymlink("bundle binary", binaryPath, { executable: true })
  const sealPath = join(bundle, "seal")
  const seal = await Effect.runPromise(verifySealAtPath(sealPath, {
    binarySnapshotProvider: () => Effect.succeed(new BinarySnapshot({
      path: binaryPath,
      rawBytes: binary
    }))
  }))
  const forbidden: Array<string> = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) fail(`bundle must not contain symlinks: ${path}`, 65)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile()) {
        if (/private/i.test(entry.name) || /\.key$/i.test(entry.name)) {
          forbidden.push(path)
          continue
        }
        const bytes = await readRegularNoSymlink("bundle file", path)
        const privatePemMarkers = [
          "-----BEGIN PRIVATE KEY-----",
          "-----BEGIN ENCRYPTED PRIVATE KEY-----",
          "-----BEGIN RSA PRIVATE KEY-----",
          "-----BEGIN EC PRIVATE KEY-----",
          "-----BEGIN DSA PRIVATE KEY-----",
          "-----BEGIN OPENSSH PRIVATE KEY-----"
        ]
        if (privatePemMarkers.some((marker) =>
          Buffer.from(bytes).includes(Buffer.from(marker, "ascii"))
        )) forbidden.push(path)
      } else {
        fail(`bundle contains a nonregular entry: ${path}`, 65)
      }
    }
  }
  await walk(bundle)
  if (forbidden.length > 0) fail(`bundle contains private-key material: ${forbidden[0]}`, 65)
  return seal
}

const create = async (): Promise<void> => {
  const options = parseOptions("create")
  const binaryPath = requireAbsolute("--binary", required(options, "--binary"))
  const admissionPath = requireAbsolute("--admission", required(options, "--admission"))
  const privatePath = requireAbsolute("--private-key", required(options, "--private-key"))
  const publicPath = requireAbsolute("--public-key", required(options, "--public-key"))
  const out = requireAbsolute("--out", required(options, "--out"))
  const definitionPaths = (options.repeated.get("--definition") ?? [])
    .map((path) => requireAbsolute("--definition", path))

  const allInputs = [binaryPath, admissionPath, privatePath, publicPath, ...definitionPaths]
  if (allInputs.some((path) => pathInside(out, path) || pathInside(path, out))) {
    fail("--out must be disjoint from every input path")
  }
  await refuseSymlinkAncestors("--out", dirname(out))
  if (await exists(out)) fail(`destination already exists: ${out}`, 73)

  const binary = await readRegularNoSymlink("--binary", binaryPath, { executable: true })
  const admission = await decodeAdmission(admissionPath)
  if (
    admission.profile === "compatibility" &&
    !options.boolean.has("--allow-sealed-compatibility")
  ) {
    fail("sealed compatibility policy requires --allow-sealed-compatibility", 65)
  }
  const definitions: Array<DefinitionSnapshot> = []
  for (const path of definitionPaths) definitions.push(await decodeDefinition(path))
  const definitionIds = new Set<string>()
  const definitionDigests = new Set<string>()
  for (const definition of definitions) {
    if (definitionIds.has(definition.id)) fail(`duplicate definition id: ${definition.id}`, 65)
    if (definitionDigests.has(definition.digest)) fail(`duplicate definition digest: ${definition.digest}`, 65)
    definitionIds.add(definition.id)
    definitionDigests.add(definition.digest)
  }

  const privateKey = await privateKeyFrom(privatePath)
  const suppliedPublic = await publicKeyFrom(publicPath)
  if (!samePublicKey(createPublicKey(privateKey), suppliedPublic.key)) {
    fail("supplied public key does not match private key", 65)
  }

  const grantInput = {
    schemaVersion: "airlock/box-grant/v1" as const,
    admission,
    verbs: sortedUnique("--verb", options.repeated.get("--verb") ?? []),
    nativeActions: sortedUnique(
      "--native-action",
      options.repeated.get("--native-action") ?? []
    ),
    catalog: definitions
      .map((definition) => ({ id: definition.id, sha256: definition.digest }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.sha256.localeCompare(right.sha256)),
    daemonOps: sortedUnique("--daemon-op", options.repeated.get("--daemon-op") ?? []),
    binaryDigest: sha256(binary)
  }
  let grant
  try {
    grant = await Effect.runPromise(decodeBoxGrant(grantInput))
  } catch {
    return fail("grant options contain an invalid literal or combination", 65)
  }
  const signature = new Uint8Array(sign(null, boxGrantSigningPayload(grant), privateKey))
  if (signature.byteLength !== 64) fail("Ed25519 produced an invalid signature size", 70)

  await mkdirFresh(out)
  const binPath = join(out, "bin")
  const sealPath = join(out, "seal")
  const catalogPath = join(sealPath, SEAL_CATALOG_DIRECTORY)
  await mkdirFresh(binPath)
  await mkdirFresh(sealPath)
  await mkdirFresh(catalogPath)
  await writeExclusive(join(binPath, "airlock"), binary, 0o555)
  await writeExclusive(
    join(sealPath, BOX_GRANT_FILE),
    `${JSON.stringify(grant, null, 2)}\n`,
    0o444
  )
  await writeExclusive(join(sealPath, BOX_GRANT_SIGNATURE_FILE), signature, 0o444)
  await writeExclusive(join(sealPath, OPERATOR_PUBLIC_KEY_FILE), suppliedPublic.bytes, 0o444)
  for (const definition of definitions) {
    await writeExclusive(
      join(catalogPath, catalogFileNameForPin({ sha256: definition.digest })),
      definition.rawBytes,
      0o444
    )
  }
  const verified = await verifyBundle(out)
  console.log(JSON.stringify({
    bundle: out,
    seal: sealPath,
    grantDigest: verified.grantDigest,
    binaryDigest: verified.binaryDigest
  }))
}

const verify = async (): Promise<void> => {
  const options = parseOptions("verify")
  const bundle = requireAbsolute("--bundle", required(options, "--bundle"))
  const verified = await verifyBundle(bundle)
  console.log(JSON.stringify({
    bundle,
    grantDigest: verified.grantDigest,
    binaryDigest: verified.binaryDigest,
    definitions: verified.catalog.map((entry) => entry.id)
  }))
}

const safeBox = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    fail("--box must be a safe 1-128 character identifier")
  }
  return value
}

const numericId = (flag: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) fail(`${flag} must be a non-negative integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    fail(`${flag} must be a 31-bit non-negative integer`)
  }
  return value
}

const principal = (flag: string, raw: string | undefined, fallback: string): string => {
  const value = raw ?? fallback
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail(`${flag} must be a safe account name`)
  }
  return value
}

const plistEscape = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;")

const launchdPlist = (fields: {
  readonly box: string
  readonly binary: string
  readonly seal: string
  readonly home: string
  readonly workspace: string
  readonly daemonUser: string
  readonly daemonGroup: string
  readonly agentUser: string
  readonly agentGroup: string
  readonly ipcDirectory: string
}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistEscape(`com.airlock.box.${fields.box}`)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistEscape(fields.binary)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIRLOCK_SEAL</key>
    <string>${plistEscape(fields.seal)}</string>
    <key>AIRLOCK_HOME</key>
    <string>${plistEscape(fields.home)}</string>
    <key>AIRLOCK_WORKSPACE</key>
    <string>${plistEscape(fields.workspace)}</string>
    <key>AIRLOCK_IPC_DIRECTORY</key>
    <string>${plistEscape(fields.ipcDirectory)}</string>
    <key>AIRLOCK_AGENT_USER</key>
    <string>${plistEscape(fields.agentUser)}</string>
    <key>AIRLOCK_AGENT_GROUP</key>
    <string>${plistEscape(fields.agentGroup)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${plistEscape(fields.workspace)}</string>
  <key>UserName</key>
  <string>${plistEscape(fields.daemonUser)}</string>
  <key>GroupName</key>
  <string>${plistEscape(fields.daemonGroup)}</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`

const copyBundleInto = async (bundle: string, generation: string): Promise<void> => {
  const binary = await readRegularNoSymlink(
    "bundle binary",
    join(bundle, "bin", "airlock"),
    { executable: true }
  )
  const seal = join(bundle, "seal")
  const grant = await readRegularNoSymlink("bundle grant", join(seal, BOX_GRANT_FILE))
  const signature = await readRegularNoSymlink("bundle signature", join(seal, BOX_GRANT_SIGNATURE_FILE))
  const publicKey = await readRegularNoSymlink("bundle public key", join(seal, OPERATOR_PUBLIC_KEY_FILE))
  const catalogNames = (await readdir(join(seal, SEAL_CATALOG_DIRECTORY), { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) fail("bundle catalog must contain regular files only", 65)
      return entry.name
    })
    .sort()
  const catalog = [] as Array<{ readonly name: string; readonly bytes: Uint8Array }>
  for (const name of catalogNames) {
    catalog.push({
      name,
      bytes: await readRegularNoSymlink("bundle catalog", join(seal, SEAL_CATALOG_DIRECTORY, name), {
        maxBytes: DEFAULT_TOOL_DEFINITION_MAX_BYTES
      })
    })
  }

  const binOut = join(generation, "bin")
  const sealOut = join(generation, "seal")
  const catalogOut = join(sealOut, SEAL_CATALOG_DIRECTORY)
  await mkdirFresh(binOut)
  await mkdirFresh(sealOut)
  await mkdirFresh(catalogOut)
  await writeExclusive(join(binOut, "airlock"), binary, 0o555)
  await writeExclusive(join(sealOut, BOX_GRANT_FILE), grant, 0o444)
  await writeExclusive(join(sealOut, BOX_GRANT_SIGNATURE_FILE), signature, 0o444)
  await writeExclusive(join(sealOut, OPERATOR_PUBLIC_KEY_FILE), publicKey, 0o444)
  for (const entry of catalog) {
    await writeExclusive(join(catalogOut, entry.name), entry.bytes, 0o444)
  }
}

const install = async (): Promise<void> => {
  const options = parseOptions("install")
  const bundle = requireAbsolute("--bundle", required(options, "--bundle"))
  const root = requireAbsolute("--root", required(options, "--root"))
  const workspace = requireAbsolute("--workspace", required(options, "--workspace"))
  const box = safeBox(required(options, "--box"))
  if (workspace === parse(workspace).root) fail("--workspace must not be the filesystem root")
  const installRoot = join(root, "Library", "Airlock")
  // --root / is the production spelling. Scope checks apply to the actual
  // Airlock subtree rather than rejecting every workspace merely because it
  // is contained by the filesystem root.
  if (pathsOverlap(installRoot, workspace)) {
    fail("root/Library/Airlock and --workspace must be disjoint")
  }
  if (pathsOverlap(installRoot, bundle)) {
    fail("root/Library/Airlock and --bundle must be disjoint")
  }
  if (pathsOverlap(bundle, workspace)) fail("--bundle and --workspace must be disjoint")
  await refuseSymlinkAncestors("--root", root)
  await refuseSymlinkAncestors("--workspace", workspace)
  await inspectDirectoryInput("--root", root, false)
  await inspectDirectoryInput("--workspace", workspace, true)
  const verified = await verifyBundle(bundle)
  if (verified.grant.admission.profile === "compatibility") {
    // Creation required a loud flag; installation keeps the fact visible but
    // accepts an already signed operator decision rather than inventing one.
  }

  // v1 defaults terminal authority to root because Hold/Outbox state is
  // owner-private; merely spelling two non-root names in a plist would not
  // make that state mutually accessible. Custom principals are emitted as an
  // ownership plan only—this portable generator never claims to chown them.
  const daemonUser = principal("--daemon-user", options.single.get("--daemon-user"), "root")
  const daemonGroup = principal("--daemon-group", options.single.get("--daemon-group"), "wheel")
  const agentUser = principal("--agent-user", options.single.get("--agent-user"), "_airlock_agent")
  const agentGroup = principal("--agent-group", options.single.get("--agent-group"), "_airlock_agent")
  const daemonUid = numericId("--daemon-uid", options.single.get("--daemon-uid"), 0)
  const daemonGid = numericId("--daemon-gid", options.single.get("--daemon-gid"), 0)
  const agentUid = numericId("--agent-uid", options.single.get("--agent-uid"), 500)
  const agentGid = numericId("--agent-gid", options.single.get("--agent-gid"), 500)
  if (daemonUid === agentUid) fail("daemon and agent UIDs must differ")
  if (daemonGid === agentGid) fail("daemon and agent GIDs must differ")
  if (daemonUser === agentUser) fail("daemon and agent users must differ")
  if (daemonGroup === agentGroup) fail("daemon and agent groups must differ")
  const applyOwnership = options.boolean.has("--apply-ownership")
  if (
    applyOwnership &&
    (typeof process.getuid !== "function" || process.getuid() !== 0)
  ) {
    fail("--apply-ownership requires root", 77)
  }
  if (applyOwnership && (daemonUser !== "root" || daemonUid !== 0)) {
    fail("--apply-ownership requires the v1 root daemon principal", 64)
  }

  const boxesRoot = join(installRoot, "boxes")
  const boxRoot = join(boxesRoot, box)
  const generationName = verified.grantDigest.slice("sha256:".length)
  const destination = join(boxRoot, generationName)
  const home = join(destination, "home")
  if (pathsOverlap(home, workspace) || pathsOverlap(destination, workspace)) {
    fail("installed generation and AIRLOCK_HOME must be outside workspace")
  }
  if (root !== parse(root).root) await ensureDirectory(root)
  await ensureDirectory(join(root, "Library"))
  await ensureDirectory(installRoot)
  await ensureDirectory(boxesRoot)
  await ensureDirectory(boxRoot)

  // mkdir is the portable atomic no-replace ownership boundary for the
  // generation itself. We never rename over a raced directory. A crash or
  // later failure leaves an inspectable unsealed generation, and all retries
  // conservatively refuse it rather than replacing or removing any bytes.
  await mkdirFresh(destination)
  await copyBundleInto(bundle, destination)
  await mkdirFresh(join(destination, "home"), 0o700)
  await mkdirFresh(join(destination, "run"), 0o2750)
  await mkdirFresh(join(destination, "ipc"), 0o750)
  await mkdirFresh(join(destination, "launchd"))
  await writeExclusive(
    join(destination, "launchd", `com.airlock.box.${box}.plist`),
    launchdPlist({
      box,
      binary: join(destination, "bin", "airlock"),
      seal: join(destination, "seal"),
      home,
      workspace,
      daemonUser,
      daemonGroup,
      agentUser,
      agentGroup,
      ipcDirectory: join(destination, "ipc")
    }),
    0o444
  )
  const principalsPath = join(destination, "principals.json")
  await writeExclusive(
    principalsPath,
    `${JSON.stringify({
      daemon: {
        user: daemonUser,
        uid: daemonUid,
        group: daemonGroup,
        gid: daemonGid,
        terminalAuthority: true
      },
      agent: { user: agentUser, uid: agentUid, group: agentGroup, gid: agentGid },
      ownershipApplied: applyOwnership,
      ownershipRequired: {
        generationOwner: { uid: 0, gid: 0 },
        agentHome: { path: home, uid: agentUid, gid: agentGid, mode: "0700" },
        run: {
          path: join(destination, "run"),
          uid: 0,
          gid: agentGid,
          mode: "02750"
        },
        ipc: {
          path: join(destination, "ipc"),
          uid: daemonUid,
          gid: agentGid,
          mode: "02750"
        },
        note: applyOwnership
          ? "ownership plan applied; launchctl activation remains separate"
          : "rerun is intentionally refused; inspect this plan and apply ownership before activation"
      },
      ipc: {
        directory: join(destination, "ipc"),
        owner: daemonUser,
        client: agentUser,
        sharedGroup: agentGroup,
        activation: "not-activated"
      }
    }, null, 2)}
`,
    0o444
  )
  await verifyBundle(destination)

  if (applyOwnership) {
    // Only paths deliberately writable by a principal receive non-root
    // ownership. Seal, binary, plist, metadata, and the generation root stay
    // immutable root-owned artifacts.
    await chown(home, agentUid, agentGid)
    await chmod(home, 0o700)
    await chown(join(destination, "run"), 0, agentGid)
    await chmodExact(join(destination, "run"), 0o2750)
    await chown(join(destination, "ipc"), daemonUid, agentGid)
    await chmodExact(join(destination, "ipc"), 0o2750)
    await chown(destination, 0, 0)
    await chown(join(destination, "bin"), 0, 0)
    await chown(join(destination, "bin", "airlock"), 0, 0)
    await chown(join(destination, "seal"), 0, 0)
    await chown(join(destination, "launchd"), 0, 0)
    await chown(principalsPath, 0, 0)
  }

  // Readiness is a final O_EXCL file creation, never a replacing rename. A
  // consumer must require SEALED; partially built directories are inert.
  const readiness = join(destination, "SEALED")
  await writeExclusive(
    readiness,
    `${JSON.stringify({
      schemaVersion: "airlock/installed-generation/v1",
      grantDigest: verified.grantDigest,
      binaryDigest: verified.binaryDigest,
      ownershipApplied: applyOwnership,
      runnable: applyOwnership,
      activated: false
    })}
`,
    0o444
  )
  console.log(JSON.stringify({
    generation: destination,
    readiness,
    grantDigest: verified.grantDigest,
    ownershipApplied: applyOwnership,
    runnable: applyOwnership,
    launchd: join(destination, "launchd", `com.airlock.box.${box}.plist`),
    activated: false
  }))
}

try {
  switch (command) {
    case "keygen": await keygen(); break
    case "create": await create(); break
    case "verify": await verify(); break
    case "install": await install(); break
    default: fail(`unknown command: ${command}`)
  }
} catch (cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  console.error(`seal-box: ${error.message}`)
  process.exitCode = cause instanceof CliError ? cause.exitCode : 70
}
