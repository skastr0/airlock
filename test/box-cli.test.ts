import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { AdmissionPolicy, BoxGrant, hashBoxGrant } from "../src/admission/index.ts"
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
const operator = generateKeyPairSync("ed25519")
const operatorKeyDigest = `sha256:${createHash("sha256")
  .update(operator.publicKey.export({ format: "der", type: "spki" }))
  .digest("hex")}`
const operatorPublicPath = join(root, "operator.pub.pem")

beforeAll(() => {
  mkdirSync(join(generation, "bin"), { recursive: true })
  writeFileSync(
    operatorPublicPath,
    operator.publicKey.export({ format: "pem", type: "spki" })
  )
  const built = spawnSync("bun", [
    "scripts/build-box.ts",
    "--public-key", operatorPublicPath,
    "--out", binary
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
  const { privateKey, publicKey } = operator
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
  writeFileSync(join(generation, "SEALED"), `${JSON.stringify({
    schemaVersion: "airlock/installed-generation/v1",
    grantDigest: hashBoxGrant(grant),
    binaryDigest: grant.binaryDigest,
    ownershipApplied: true,
    runnable: true,
    activated: false
  })}\n`)
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

  it("rejects a copied binary beside an attacker self-signed seal", () => {
    const clone = join(root, "attacker-clone")
    const cloneBinary = join(clone, "bin", "airlock")
    const cloneSeal = join(clone, "seal")
    mkdirSync(join(clone, "bin"), { recursive: true })
    mkdirSync(join(cloneSeal, SEAL_CATALOG_DIRECTORY), { recursive: true })
    cpSync(binary, cloneBinary)
    const attacker = generateKeyPairSync("ed25519")
    const grant = new BoxGrant({
      schemaVersion: "airlock/box-grant/v1",
      admission: new AdmissionPolicy({
        schemaVersion: "airlock/admission-policy/v1",
        profile: "compatibility",
        principal: "agent:attacker",
        realm: "local",
        admittedBy: "attacker",
        pathAllowlist: ["/"],
        executableAllowlist: ["/bin/sh"],
        endpointAllowlist: ["https://"]
      }),
      verbs: ["exec", "serve"],
      nativeActions: ["process.run"],
      catalog: [],
      daemonOps: ["commit"],
      binaryDigest: digest(readFileSync(cloneBinary))
    })
    writeFileSync(join(cloneSeal, BOX_GRANT_FILE), `${JSON.stringify(grant)}\n`)
    writeFileSync(
      join(cloneSeal, OPERATOR_PUBLIC_KEY_FILE),
      attacker.publicKey.export({ format: "pem", type: "spki" })
    )
    writeFileSync(
      join(cloneSeal, BOX_GRANT_SIGNATURE_FILE),
      sign(null, boxGrantSigningPayload(grant), attacker.privateKey)
    )
    const refused = spawnSync(cloneBinary, ["exec", "--help"], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1" }
    })
    expect(refused.status).toBe(78)
    expect(JSON.parse(refused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed",
      phase: "key",
      reason: "operator-key-mismatch"
    })
  })

})
