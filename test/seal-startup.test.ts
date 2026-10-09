import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { NativeActionCatalog } from "../src/core/actions/index.ts"
import { AdmissionPolicy, BoxGrant } from "../src/core/admission/index.ts"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  OPERATOR_PUBLIC_KEY_FILE,
  boxGrantDigest,
  boxGrantSigningPayload
} from "../src/seal/index.ts"
import { Sha256Digest } from "../src/core/Canonical.ts"

const repository = resolve(import.meta.dirname, "..")
const root = mkdtempSync(join(tmpdir(), "airlock-seal-startup-"))
const binary = join(root, "airlock")

beforeAll(() => {
  const built = spawnSync("bun", [
    "build",
    "--compile",
    "--outfile",
    binary,
    "src/cli.ts"
  ], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1" }
  })
  expect(built.status, built.stderr).toBe(0)
}, 60_000)

const digest = (bytes: Uint8Array) =>
  Sha256Digest.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)

const makeSeal = (name: string, options: {
  readonly wrongBinary?: boolean
  readonly missingSignature?: boolean
  readonly catalogInGrant?: boolean
} = {}) => {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const actualBinaryDigest = digest(readFileSync(binary))
  const grant = new BoxGrant({
    schemaVersion: "airlock/box-grant/v1",
    admission: new AdmissionPolicy({
      schemaVersion: "airlock/admission-policy/v2",
      profile: "compatibility",
      principal: "agent:startup-test",
      realm: "local",
      admittedBy: "operator:startup-test",
      pathAllowlist: [root],
      executableAllowlist: [],
      executableEdges: [],
      endpointGrants: []
    }),
    verbs: [
      "rm", "write", "undo", "held", "reap", "send", "pending",
      "commit", "cancel", "flush", "doctor", "capabilities", "actions",
      "schema", "exec", "run", "eval", "ledger", "runs", "run-receipt",
      "serve"
    ],
    nativeActions: NativeActionCatalog.map(({ name }) => name),
    daemonOps: [],
    binaryDigest: options.wrongBinary
      ? Sha256Digest.make(`sha256:${"0".repeat(64)}`)
      : actualBinaryDigest
  })
  // A grant in the removed shape, with a definition catalog, is not a grant.
  const written = options.catalogInGrant ? { ...grant, catalog: [] } : grant
  writeFileSync(join(directory, BOX_GRANT_FILE), `${JSON.stringify(written, null, 2)}\n`)
  writeFileSync(
    join(directory, OPERATOR_PUBLIC_KEY_FILE),
    publicKey.export({ format: "pem", type: "spki" })
  )
  if (!options.missingSignature) {
    writeFileSync(
      join(directory, BOX_GRANT_SIGNATURE_FILE),
      sign(null, boxGrantSigningPayload(grant), privateKey)
    )
  }
  expect(boxGrantDigest(grant)).toMatch(/^sha256:[0-9a-f]{64}$/)
  return directory
}

const invoke = (seal: string, home: string) =>
  spawnSync(binary, ["doctor"], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      NO_COLOR: "1",
      AIRLOCK_SEAL: seal,
      AIRLOCK_HOME: home
    }
  })

describe("sealed process startup", () => {
  it("starts a compiled runtime only after a good seal verifies", { timeout: 60_000 }, () => {
    const home = join(root, "good-home")
    const started = invoke(makeSeal("good"), home)
    expect(started.status, started.stderr).toBe(0)
    expect(JSON.parse(started.stdout)).toMatchObject({
      version: expect.any(String),
      profiles: { compatibility: { available: true } }
    })
    expect(existsSync(home)).toBe(true)
  })

  it.each([
    ["missing signature", { missingSignature: true }],
    ["wrong binary digest", { wrongBinary: true }],
    ["a grant with a definition catalog", { catalogInGrant: true }]
  ] as const)("fails before runtime state on %s", (_label, options) => {
    const name = `bad-${_label.replaceAll(" ", "-")}`
    const home = join(root, `${name}-home`)
    const refused = invoke(makeSeal(name, options), home)
    expect(refused.status).toBe(78)
    expect(refused.stdout).toBe("")
    expect(JSON.parse(refused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed"
    })
    expect(existsSync(home)).toBe(false)
  })
})
