#!/usr/bin/env bun
/**
 * Operator glue for creating, checking, and installing sealed Airlock box
 * bundles and fresh same-user local generations. A bundle contains:
 *
 *   BUNDLE/bin/airlock
 *   BUNDLE/seal/{box-grant.json,box-grant.ed25519,operator-ed25519.pub.pem}
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
  realpath,
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
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from "node:path"
import { Effect, Schema } from "effect"
import { BoxGrant, decodeBoxGrant } from "../src/core/admission/BoxGrant.ts"
import { toolGrant } from "../src/core/admission/ToolGrant.ts"
import { ToolPolicy, toolPolicy } from "../src/core/session/ToolPolicy.ts"
import { FileGlob, FileInspect, FileList, FileRead, FileStat } from "../src/native/index.ts"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  BinarySnapshot,
  OPERATOR_PUBLIC_KEY_FILE,
  boxGrantSigningPayload,
  verifySealAtPath
} from "../src/seal/index.ts"

const usage = `usage: bun scripts/seal-box.ts <command> [options]

Commands:
  keygen --private-key PATH --public-key PATH
  create --binary FILE --policy FILE [--verb V ...] --private-key FILE
         --public-key FILE --out FRESH_DIR
  verify --bundle DIR
  local --workspace DIR --out FRESH_DIR --private-key FILE --public-key FILE
        [--policy FILE]
  install --bundle DIR --root DIR --box ID --workspace DIR
          [--agent-user NAME --agent-uid N --agent-group NAME --agent-gid N]
          [--apply-ownership]

--policy names a strict airlock/tool-policy/v1 document: every program the box
runs is held to it. create emits BUNDLE/bin/airlock plus BUNDLE/seal/. local
builds and publishes one same-user generation. install publishes one fresh root
tenant generation. Nothing here starts a process that outlives it: a person
commits a waiting call with \`airlock commit <id>\`.`

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
      "--binary", "--policy", "--private-key", "--public-key", "--out"
    ]),
    repeated: new Set(["--verb"]),
    boolean: new Set<string>()
  },
  verify: {
    single: new Set(["--bundle"]),
    repeated: new Set<string>(),
    boolean: new Set<string>()
  },
  local: {
    single: new Set([
      "--workspace", "--out", "--private-key", "--public-key", "--policy"
    ]),
    repeated: new Set<string>(),
    boolean: new Set<string>()
  },
  install: {
    single: new Set([
      "--bundle", "--root", "--box", "--workspace",
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

/** Physical local-generation paths make /tmp and /private/tmp the same scope. */
const canonicalLocalDirectory = async (
  flag: string,
  path: string
): Promise<string> => {
  try {
    const inspected = await lstat(path)
    if (inspected.isSymbolicLink()) fail(`${flag} must not be a symlink`, 66)
    if (!inspected.isDirectory()) fail(`${flag} must be a directory`, 66)
    return await realpath(path)
  } catch (cause) {
    if (cause instanceof CliError) throw cause
    if (osCode(cause) === "ENOENT" || osCode(cause) === "ENOTDIR") {
      return fail(`${flag} does not exist as a directory`, 66)
    }
    return fail(`${flag} cannot be resolved as a physical directory`, 66)
  }
}

const canonicalLocalFile = async (
  flag: string,
  path: string,
  requireSingleLink = false
): Promise<string> => {
  try {
    const inspected = await lstat(path)
    if (inspected.isSymbolicLink()) fail(`${flag} must not be a symlink`, 66)
    if (!inspected.isFile()) fail(`${flag} must be a regular file`, 66)
    if (requireSingleLink && inspected.nlink !== 1) {
      fail(`${flag} must have exactly one filesystem link for a local generation`, 65)
    }
    return await realpath(path)
  } catch (cause) {
    if (cause instanceof CliError) throw cause
    if (osCode(cause) === "ENOENT" || osCode(cause) === "ENOTDIR") {
      return fail(`${flag} does not exist as a regular file`, 66)
    }
    return fail(`${flag} cannot be resolved as a physical regular file`, 66)
  }
}

const canonicalFreshLocalOutput = async (path: string): Promise<string> => {
  if (await exists(path)) fail(`destination already exists: ${path}`, 73)
  const parent = dirname(path)
  let physicalParent: string
  try {
    physicalParent = await realpath(parent)
    const inspected = await lstat(physicalParent)
    if (inspected.isSymbolicLink() || !inspected.isDirectory()) {
      fail("--out parent must resolve to a physical directory", 66)
    }
  } catch (cause) {
    if (cause instanceof CliError) throw cause
    return fail("--out parent must already exist as a physical directory", 66)
  }
  const output = join(physicalParent, basename(path))
  if (await exists(output)) fail(`destination already exists: ${output}`, 73)
  return output
}

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

const operatorKeyDigest = (key: KeyObject): `sha256:${string}` =>
  `sha256:${createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex")}`

const requireBinaryOperatorAnchor = async (
  binaryPath: string,
  publicKey: KeyObject
): Promise<string> => {
  const anchorPath = `${binaryPath}.operator-key.sha256`
  const anchorBytes = await readRegularNoSymlink(
    "binary operator-key anchor",
    anchorPath,
    { maxBytes: 128 }
  )
  if (
    decodeUtf8("binary operator-key anchor", anchorBytes).trim() !==
    operatorKeyDigest(publicKey)
  ) {
    fail("binary operator-key anchor does not match supplied public key", 65)
  }
  return anchorPath
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

const decodePolicy = async (path: string): Promise<ToolPolicy> => {
  const bytes = await readRegularNoSymlink("--policy", path, {
    maxBytes: 256 * 1024
  })
  const parsed = decodeJson("--policy", decodeUtf8("--policy", bytes))
  let decoded: ToolPolicy
  try {
    decoded = Schema.decodeUnknownSync(ToolPolicy, { onExcessProperty: "error" })(parsed)
  } catch {
    return fail("--policy is not a strict ToolPolicy", 65)
  }
  // Flow rules are checked as they are composed, exactly as an unsealed policy file is.
  try {
    return toolPolicy(decoded)
  } catch {
    return fail("--policy has invalid flow rules", 65)
  }
}

const sortedUnique = (flag: string, values: ReadonlyArray<string>): Array<string> => {
  const sorted = [...values].sort()
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] === sorted[index - 1]) fail(`${flag} must not contain duplicates`)
  }
  return sorted
}

const signedGrant = async (
  policy: ToolPolicy,
  requestedVerbs: ReadonlyArray<string>,
  binary: Uint8Array,
  privateKey: KeyObject
) => {
  const verbs = sortedUnique("--verb", requestedVerbs)
  let grant: BoxGrant
  try {
    grant = await Effect.runPromise(decodeBoxGrant({
      schemaVersion: "airlock/box-grant/v2",
      policy: Schema.encodeSync(ToolPolicy)(policy),
      verbs,
      binaryDigest: sha256(binary)
    }))
  } catch {
    return fail("grant options contain an invalid literal or combination", 65)
  }
  const signature = new Uint8Array(sign(null, boxGrantSigningPayload(grant), privateKey))
  if (signature.byteLength !== 64) fail("Ed25519 produced an invalid signature size", 70)
  return { grant, signature }
}

const writeSeal = async (
  sealPath: string,
  signed: { readonly grant: BoxGrant; readonly signature: Uint8Array },
  publicKey: Uint8Array
): Promise<void> => {
  await mkdirFresh(sealPath)
  await writeExclusive(
    join(sealPath, BOX_GRANT_FILE),
    `${JSON.stringify(Schema.encodeSync(BoxGrant)(signed.grant), null, 2)}\n`,
    0o444
  )
  await writeExclusive(join(sealPath, BOX_GRANT_SIGNATURE_FILE), signed.signature, 0o444)
  await writeExclusive(join(sealPath, OPERATOR_PUBLIC_KEY_FILE), publicKey, 0o444)
}

/** The state directories each component expects; components create the rest on first use. */
const makeHome = async (home: string): Promise<void> => {
  await mkdirFresh(home, 0o700)
  for (const directory of ["hold", "outbox", "hold-locks", "outbox-locks"]) {
    await mkdirFresh(join(home, directory), 0o700)
  }
  await writeExclusive(join(home, "ledger.jsonl"), "", 0o600)
  await writeExclusive(join(home, "hold-locks", "active"), "", 0o600)
  await writeExclusive(join(home, "outbox-locks", "active"), "", 0o600)
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
  const policyPath = requireAbsolute("--policy", required(options, "--policy"))
  const privatePath = requireAbsolute("--private-key", required(options, "--private-key"))
  const publicPath = requireAbsolute("--public-key", required(options, "--public-key"))
  const out = requireAbsolute("--out", required(options, "--out"))

  const allInputs = [binaryPath, policyPath, privatePath, publicPath]
  if (allInputs.some((path) => pathInside(out, path) || pathInside(path, out))) {
    fail("--out must be disjoint from every input path")
  }
  await refuseSymlinkAncestors("--out", dirname(out))
  if (await exists(out)) fail(`destination already exists: ${out}`, 73)

  const binary = await readRegularNoSymlink("--binary", binaryPath, { executable: true })
  const policy = await decodePolicy(policyPath)
  const privateKey = await privateKeyFrom(privatePath)
  const suppliedPublic = await publicKeyFrom(publicPath)
  if (!samePublicKey(createPublicKey(privateKey), suppliedPublic.key)) {
    fail("supplied public key does not match private key", 65)
  }
  await requireBinaryOperatorAnchor(binaryPath, suppliedPublic.key)
  const signed = await signedGrant(policy, options.repeated.get("--verb") ?? [], binary, privateKey)

  await mkdirFresh(out)
  const binPath = join(out, "bin")
  const sealPath = join(out, "seal")
  await mkdirFresh(binPath)
  await writeExclusive(join(binPath, "airlock"), binary, 0o555)
  await writeExclusive(join(binPath, "airlock-agent"), binary, 0o555)
  await writeSeal(sealPath, signed, suppliedPublic.bytes)
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
    binaryDigest: verified.binaryDigest
  }))
}


/** What a same-user local box answers: programs and what they left waiting, never a decision. */
const LOCAL_VERBS = [
  "capabilities", "describe", "doctor", "eval", "inspect", "pending", "review", "run"
] as const

/** With no policy file, a local box reads its workspace and changes nothing. */
const observationPolicy = (workspace: string) => toolPolicy({
  toolGrants: [FileGlob, FileInspect, FileList, FileRead, FileStat].map((contract) =>
    toolGrant(contract, { id: contract.tag, when: "now" })),
  resources: { path: [workspace] },
  budget: { maxCalls: 256, maxInputBytes: 4_194_304 }
})

const shellQuote = (value: string): string =>
  `'${value.split("'").join(`'"'"'`)}'`

const local = async (): Promise<void> => {
  const options = parseOptions("local")
  if (process.platform !== "darwin") {
    fail("local sealed generations require macOS", 69)
  }

  const requestedWorkspace = requireAbsolute(
    "--workspace",
    required(options, "--workspace")
  )
  const requestedOut = requireAbsolute("--out", required(options, "--out"))
  const requestedPrivate = requireAbsolute(
    "--private-key",
    required(options, "--private-key")
  )
  const requestedPublic = requireAbsolute(
    "--public-key",
    required(options, "--public-key")
  )
  const requestedPolicy = options.single.get("--policy")

  // Resolve every authority-bearing input before claiming the fresh output.
  // In particular, /tmp and /private/tmp must compare as one physical scope.
  const workspace = await canonicalLocalDirectory("--workspace", requestedWorkspace)
  if (workspace === parse(workspace).root) {
    fail("--workspace must not be the filesystem root")
  }
  const out = await canonicalFreshLocalOutput(requestedOut)
  const privatePath = await canonicalLocalFile(
    "--private-key",
    requestedPrivate,
    true
  )
  const publicPath = await canonicalLocalFile("--public-key", requestedPublic)
  if (privatePath === publicPath) fail("private and public key paths must differ")
  const policyPath = requestedPolicy === undefined
    ? undefined
    : await canonicalLocalFile(
        "--policy",
        requireAbsolute("--policy", requestedPolicy)
      )
  if (pathsOverlap(out, workspace)) {
    fail("--out and --workspace must be physically disjoint")
  }
  if (pathInside(workspace, privatePath)) {
    fail("--private-key must be physically outside the readable workspace", 65)
  }
  const allInputs = [
    privatePath,
    publicPath,
    ...(policyPath === undefined ? [] : [policyPath])
  ]
  if (allInputs.some((path) => pathsOverlap(out, path))) {
    fail("--out must be physically disjoint from every input path")
  }

  const privateKey = await privateKeyFrom(privatePath)
  const suppliedPublic = await publicKeyFrom(publicPath)
  if (!samePublicKey(createPublicKey(privateKey), suppliedPublic.key)) {
    fail("supplied public key does not match private key", 65)
  }
  const policy = policyPath === undefined
    ? observationPolicy(workspace)
    : await decodePolicy(policyPath)

  // mkdir is the no-replace ownership boundary. Every failure before SEALED
  // leaves an inspectable but inert generation, and retries conservatively fail.
  await mkdirFresh(out, 0o700)
  const binPath = join(out, "bin")
  const binaryPath = join(binPath, "airlock")
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      join(import.meta.dir, "build-box.ts"),
      "--public-key", publicPath,
      "--out", binaryPath,
      "--mode", "local-same-user"
    ],
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe"
  })
  if (build.exitCode !== 0) {
    const detail = Buffer.from(build.stderr).toString("utf8").trim()
    fail(`local box build failed${detail.length === 0 ? "" : `: ${detail}`}`, 70)
  }
  await chmodExact(binPath, 0o755)
  await chmodExact(binaryPath, 0o555)
  const binary = await readRegularNoSymlink(
    "local box binary",
    binaryPath,
    { executable: true }
  )
  const anchorPath = await requireBinaryOperatorAnchor(
    binaryPath,
    suppliedPublic.key
  )
  const signed = await signedGrant(policy, LOCAL_VERBS, binary, privateKey)

  await writeExclusive(join(binPath, "airlock-agent"), binary, 0o555)
  const sealPath = join(out, "seal")
  await writeSeal(sealPath, signed, suppliedPublic.bytes)
  const home = join(out, "home")
  await makeHome(home)

  const verified = await verifyBundle(out)
  const readiness = join(out, "SEALED")
  await writeExclusive(
    readiness,
    `${JSON.stringify({
      schemaVersion: "airlock/installed-generation/v1",
      grantDigest: verified.grantDigest,
      binaryDigest: verified.binaryDigest,
      ownershipApplied: false,
      localSameUser: true,
      runnable: true
    })}\n`,
    0o444
  )

  // The compiled box finds its seal and home beside itself; the recipe needs neither.
  const recipe = `${shellQuote(binaryPath)} eval --workspace ${shellQuote(workspace)} ` +
    `--source ${shellQuote('return file.stat({ path: "ok.txt" })')}`

  console.log(JSON.stringify({
    generation: out,
    binary: binaryPath,
    agentBinary: join(binPath, "airlock-agent"),
    seal: sealPath,
    home,
    readiness,
    operatorKeyAnchor: anchorPath,
    grantDigest: verified.grantDigest,
    binaryDigest: verified.binaryDigest,
    verbs: verified.grant.verbs,
    localSameUser: true,
    runnable: true,
    recipe
  }))
  console.error(`# Airlock local sealed recipe (copy and paste)\n${recipe}`)
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
  const binOut = join(generation, "bin")
  const sealOut = join(generation, "seal")
  await mkdirFresh(binOut)
  await mkdirFresh(sealOut)
  await writeExclusive(join(binOut, "airlock"), binary, 0o555)
  await writeExclusive(join(binOut, "airlock-agent"), binary, 0o555)
  await writeExclusive(join(sealOut, BOX_GRANT_FILE), grant, 0o444)
  await writeExclusive(join(sealOut, BOX_GRANT_SIGNATURE_FILE), signature, 0o444)
  await writeExclusive(join(sealOut, OPERATOR_PUBLIC_KEY_FILE), publicKey, 0o444)
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

  // The generation, its binary and its seal belong to root; the agent owns
  // only its home. An agent that were root could rewrite the seal it runs under.
  const agentUser = principal("--agent-user", options.single.get("--agent-user"), "_airlock_agent")
  const agentGroup = principal("--agent-group", options.single.get("--agent-group"), "_airlock_agent")
  const agentUid = numericId("--agent-uid", options.single.get("--agent-uid"), 500)
  const agentGid = numericId("--agent-gid", options.single.get("--agent-gid"), 500)
  if (agentUid === 0 || agentUser === "root") fail("the agent principal must not be root")
  if (agentGid === 0 || agentGroup === "wheel") fail("the agent group must not be root's group")
  const applyOwnership = options.boolean.has("--apply-ownership")
  if (
    applyOwnership &&
    (typeof process.getuid !== "function" || process.getuid() !== 0)
  ) {
    fail("--apply-ownership requires root", 77)
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
  await makeHome(home)
  const agentLaunchPath = join(destination, "agent-launch.json")
  await writeExclusive(
    agentLaunchPath,
    `${JSON.stringify({
      schemaVersion: "airlock/agent-launch/v1",
      executable: join(destination, "bin", "airlock-agent"),
      user: agentUser,
      uid: agentUid,
      group: agentGroup,
      gid: agentGid,
      environment: { AIRLOCK_AGENT_SURFACE: "1" },
      note: "launch from the tenant harness; this file is inert"
    }, null, 2)}\n`,
    0o444
  )
  const principalsPath = join(destination, "principals.json")
  await writeExclusive(
    principalsPath,
    `${JSON.stringify({
      agent: { user: agentUser, uid: agentUid, group: agentGroup, gid: agentGid },
      ownershipApplied: applyOwnership,
      ownershipRequired: {
        generationOwner: { uid: 0, gid: 0 },
        agentHome: { path: home, uid: agentUid, gid: agentGid, mode: "0700" },
        note: applyOwnership
          ? "ownership plan applied"
          : "rerun is intentionally refused; inspect this plan and apply ownership before use"
      }
    }, null, 2)}
`,
    0o444
  )
  await verifyBundle(destination)

  if (applyOwnership) {
    // Only the agent's home receives non-root ownership. Seal, binary,
    // metadata, and the generation root stay immutable root-owned artifacts.
    await chown(home, agentUid, agentGid)
    await chmod(home, 0o700)
    for (const directory of ["hold", "outbox", "hold-locks", "outbox-locks"]) {
      await chown(join(home, directory), agentUid, agentGid)
      await chmodExact(join(home, directory), 0o700)
    }
    for (const file of [
      "ledger.jsonl", "hold-locks/active", "outbox-locks/active"
    ]) {
      await chown(join(home, file), agentUid, agentGid)
      await chmodExact(join(home, file), 0o600)
    }
    await chown(destination, 0, 0)
    await chown(join(destination, "bin"), 0, 0)
    await chown(join(destination, "bin", "airlock"), 0, 0)
    await chown(join(destination, "bin", "airlock-agent"), 0, 0)
    await chown(join(destination, "seal"), 0, 0)
    await chown(agentLaunchPath, 0, 0)
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
      runnable: applyOwnership
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
    agentLaunch: agentLaunchPath
  }))
}

try {
  switch (command) {
    case "keygen": await keygen(); break
    case "create": await create(); break
    case "verify": await verify(); break
    case "local": await local(); break
    case "install": await install(); break
    default: fail(`unknown command: ${command}`)
  }
} catch (cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  console.error(`seal-box: ${error.message}`)
  process.exitCode = cause instanceof CliError ? cause.exitCode : 70
}
