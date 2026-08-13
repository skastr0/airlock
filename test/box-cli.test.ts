import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { AdmissionPolicy, BoxGrant } from "../src/admission/index.ts"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  OPERATOR_PUBLIC_KEY_FILE,
  SEAL_CATALOG_DIRECTORY,
  boxGrantSigningPayload
} from "../src/seal/index.ts"

const repository = resolve(import.meta.dirname, "..")
const root = mkdtempSync(join(tmpdir(), "airlock-required-seal-"))
const generation = join(root, "generation")
const binary = join(generation, "bin", "airlock")
const seal = join(generation, "seal")

beforeAll(() => {
  mkdirSync(join(generation, "bin"), { recursive: true })
  const built = spawnSync("bun", [
    "build", "--compile", "--outfile", binary, "src/box-cli.ts"
  ], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1" }
  })
  expect(built.status, built.stderr).toBe(0)
}, 60_000)

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const

const writeGoodSeal = () => {
  mkdirSync(join(seal, SEAL_CATALOG_DIRECTORY), { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const grant = new BoxGrant({
    schemaVersion: "airlock/box-grant/v1",
    admission: new AdmissionPolicy({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "compatibility",
      principal: "agent:required-seal-test",
      realm: "local",
      admittedBy: "operator:required-seal-test",
      pathAllowlist: [root],
      executableAllowlist: [],
      endpointAllowlist: []
    }),
    verbs: ["doctor"],
    nativeActions: [],
    catalog: [],
    daemonOps: [],
    binaryDigest: digest(readFileSync(binary))
  })
  writeFileSync(join(seal, BOX_GRANT_FILE), `${JSON.stringify(grant)}\n`)
  writeFileSync(
    join(seal, OPERATOR_PUBLIC_KEY_FILE),
    publicKey.export({ format: "pem", type: "spki" })
  )
  writeFileSync(
    join(seal, BOX_GRANT_SIGNATURE_FILE),
    sign(null, boxGrantSigningPayload(grant), privateKey)
  )
}

const invoke = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  spawnSync(binary, [...args], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      NO_COLOR: "1",
      ...env
    }
  })

describe("required-seal tenant entrypoint", () => {
  it("ignores an environment-selected alternate seal and fails without its relative seal", () => {
    const alternate = join(root, "attacker-seal")
    mkdirSync(alternate, { recursive: true })
    const refused = invoke(["doctor"], {
      AIRLOCK_SEAL: alternate,
      AIRLOCK_HOME: join(root, "attacker-home"),
      AIRLOCK_DAEMON_SOCKET: join(root, "attacker.sock")
    })
    expect(refused.status).toBe(78)
    expect(refused.stdout).toBe("")
    expect(JSON.parse(refused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed",
      path: expect.stringContaining("generation/seal")
    })
    expect(existsSync(join(root, "attacker-home"))).toBe(false)
    expect(existsSync(join(generation, "home"))).toBe(false)
  })

  it("starts only from the signed seal beside the compiled executable", () => {
    writeGoodSeal()
    const started = invoke(["doctor"], {
      AIRLOCK_SEAL: join(root, "attacker-seal"),
      AIRLOCK_HOME: join(root, "attacker-home")
    })
    expect(started.status, started.stderr).toBe(0)
    expect(JSON.parse(started.stdout)).toMatchObject({ version: expect.any(String) })
    expect(existsSync(join(generation, "home"))).toBe(true)
    expect(existsSync(join(root, "attacker-home"))).toBe(false)
  })
})
