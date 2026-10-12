import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { BoxGrant, BoxGrantVerb } from "../src/core/admission/index.ts"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  OPERATOR_PUBLIC_KEY_FILE,
  boxGrantDigest,
  boxGrantSigningPayload
} from "../src/seal/index.ts"
import { Sha256Digest } from "../src/core/Canonical.ts"

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
  Sha256Digest.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)

const grantFor = (fields: {
  readonly policy: unknown
  readonly verbs: ReadonlyArray<BoxGrantVerb>
  readonly binary: string
}) => Schema.decodeUnknownSync(BoxGrant)({
  schemaVersion: "airlock/box-grant/v2",
  policy: fields.policy,
  verbs: fields.verbs,
  binaryDigest: digest(readFileSync(fields.binary))
})

const writeGoodSeal = () => {
  mkdirSync(seal, { recursive: true })
  const { privateKey, publicKey } = operator
  const grant = grantFor({
    policy: {
      schemaVersion: "airlock/tool-policy/v1",
      toolGrants: [],
      resources: { path: [root] },
      budget: { maxCalls: 0, maxInputBytes: 0 }
    },
    verbs: ["doctor"],
    binary
  })
  writeFileSync(join(seal, BOX_GRANT_FILE), `${JSON.stringify(Schema.encodeSync(BoxGrant)(grant))}\n`)
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
    grantDigest: boxGrantDigest(grant),
    binaryDigest: grant.binaryDigest,
    ownershipApplied: true,
    runnable: true
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
      AIRLOCK_HOME: join(root, "attacker-home")
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

  it("keeps local readiness compile-bound away from a root tenant binary", () => {
    writeGoodSeal()
    const localGeneration = join(root, "local-marker-clone")
    const localBinary = join(localGeneration, "bin", "airlock")
    mkdirSync(join(localGeneration, "bin"), { recursive: true })
    linkSync(binary, localBinary)
    cpSync(seal, join(localGeneration, "seal"), { recursive: true })
    const rootReadiness = JSON.parse(
      readFileSync(join(generation, "SEALED"), "utf8")
    )
    writeFileSync(join(localGeneration, "SEALED"), `${JSON.stringify({
      ...rootReadiness,
      ownershipApplied: false,
      localSameUser: true,
      runnable: true
    })}
`)

    const refused = spawnSync(localBinary, ["doctor"], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        NO_COLOR: "1",
        AIRLOCK_GENERATION_MODE_INTERNAL: "local-same-user"
      }
    })
    expect(refused.status).toBe(78)
    expect(refused.stdout).toBe("")
    expect(JSON.parse(refused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed",
      reason: "installation-not-ready"
    })
    expect(existsSync(join(localGeneration, "home"))).toBe(false)
  })

  it("rejects a copied binary beside an attacker self-signed seal", () => {
    const clone = join(root, "attacker-clone")
    const cloneBinary = join(clone, "bin", "airlock")
    const cloneSeal = join(clone, "seal")
    mkdirSync(join(clone, "bin"), { recursive: true })
    mkdirSync(cloneSeal, { recursive: true })
    cpSync(binary, cloneBinary)
    const attacker = generateKeyPairSync("ed25519")
    const grant = grantFor({
      policy: {
        schemaVersion: "airlock/tool-policy/v1",
        toolGrants: [
          { id: "write", tool: "file.write", when: "now" },
          { id: "process", tool: "process.run", when: "approved" }
        ],
        resources: { path: ["/"], executable: { roots: ["/bin/sh"], edges: [] } },
        budget: { maxCalls: 1_000_000, maxInputBytes: 1_000_000_000 }
      },
      verbs: BoxGrantVerb.literals,
      binary: cloneBinary
    })
    writeFileSync(join(cloneSeal, BOX_GRANT_FILE), `${JSON.stringify(Schema.encodeSync(BoxGrant)(grant))}\n`)
    writeFileSync(
      join(cloneSeal, OPERATOR_PUBLIC_KEY_FILE),
      attacker.publicKey.export({ format: "pem", type: "spki" })
    )
    writeFileSync(
      join(cloneSeal, BOX_GRANT_SIGNATURE_FILE),
      sign(null, boxGrantSigningPayload(grant), attacker.privateKey)
    )
    const refused = spawnSync(cloneBinary, ["commit", "--help"], {
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
