import { createHash, generateKeyPairSync, sign } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  rename,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeBoxGrant } from "../src/core/admission/BoxGrant.ts"
import {
  AIRLOCK_SEAL_ENV,
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  BinarySnapshot,
  OPERATOR_PUBLIC_KEY_FILE,
  SealVerificationFailed,
  UnsealedSeal,
  VerifiedSeal,
  boxGrantSigningPayload,
  loadStartupSeal
} from "../src/seal/index.ts"
import { Sha256Digest } from "../src/core/Canonical.ts"
import { ToolPolicy } from "../src/core/session/ToolPolicy.ts"

const binary = new TextEncoder().encode("airlock compiled fixture v1\n")
const flippedBinary = new TextEncoder().encode("airlock compiled fixture v2\n")

const digest = (bytes: Uint8Array) =>
  Sha256Digest.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)

const policy = {
  schemaVersion: "airlock/tool-policy/v1" as const,
  toolGrants: [{ id: "read", tool: "file.read", when: "now" }],
  resources: { path: ["/workspace"] },
  budget: { maxCalls: 16, maxInputBytes: 65_536 }
}

type FixtureOptions = {
  readonly grantOverrides?: Readonly<Record<string, unknown>>
  readonly serializeGrant?: (grant: Record<string, unknown>) => string
  readonly writeGrant?: boolean
  readonly writeSignature?: boolean
  readonly signatureBytes?: (signature: Uint8Array) => Uint8Array
}

const makeFixture = async (options: FixtureOptions = {}) => {
  const sealPath = await mkdtemp(join(tmpdir(), "airlock-seal-"))
  const grantObject: Record<string, unknown> = {
    schemaVersion: "airlock/box-grant/v2",
    policy,
    verbs: ["run", "describe"],
    binaryDigest: digest(binary),
    ...options.grantOverrides
  }
  const grant = await Effect.runPromise(decodeBoxGrant(grantObject))
  const keys = generateKeyPairSync("ed25519")
  const publicPem = keys.publicKey.export({ format: "pem", type: "spki" })
  await writeFile(join(sealPath, OPERATOR_PUBLIC_KEY_FILE), publicPem)

  const grantJson = (options.serializeGrant ?? JSON.stringify)(grantObject)
  if (options.writeGrant !== false) {
    await writeFile(join(sealPath, BOX_GRANT_FILE), grantJson)
  }
  const signed = new Uint8Array(sign(
    null,
    boxGrantSigningPayload(grant),
    keys.privateKey
  ))
  const signature = options.signatureBytes?.(signed) ?? signed
  if (options.writeSignature !== false) {
    await writeFile(join(sealPath, BOX_GRANT_SIGNATURE_FILE), signature)
  }

  return {
    sealPath,
    grant,
    grantObject
  }
}

const provider = (rawBytes: Uint8Array = binary, path = "/fixture/airlock") =>
  () => Effect.succeed(new BinarySnapshot({ path, rawBytes }))

const load = async (
  sealPath: string,
  rawBytes: Uint8Array = binary
): Promise<VerifiedSeal> => {
  const context = await Effect.runPromise(loadStartupSeal({
    sealPath,
    binarySnapshotProvider: provider(rawBytes)
  }))
  if (!(context instanceof VerifiedSeal)) throw new Error("expected verified fixture")
  return context
}

const failed = async <A>(effect: Effect.Effect<A, SealVerificationFailed>) => {
  const error = await Effect.runPromise(effect.pipe(Effect.flip))
  expect(error).toBeInstanceOf(SealVerificationFailed)
  return error
}

const reverseObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)])
  )
}

describe("startup seal verification", () => {
  it("short-circuits a truly unset AIRLOCK_SEAL before touching the binary", async () => {
    let binaryTouched = false
    const context = await Effect.runPromise(loadStartupSeal({
      env: {},
      binarySnapshotProvider: () => {
        binaryTouched = true
        return Effect.die("must not run")
      }
    }))

    expect(context).toBeInstanceOf(UnsealedSeal)
    expect(context._tag).toBe("UnsealedSeal")
    expect(binaryTouched).toBe(false)
  })

  it("treats empty and whitespace AIRLOCK_SEAL values as typed failures", async () => {
    for (const value of ["", " ", "\t\n"]) {
      const error = await failed(loadStartupSeal({
        env: { [AIRLOCK_SEAL_ENV]: value },
        binarySnapshotProvider: provider()
      }))
      expect(error).toMatchObject({
        phase: "environment",
        path: AIRLOCK_SEAL_ENV,
        reason: "seal-path-blank"
      })
    }
  })

  it("requires AIRLOCK_SEAL to name an absolute trust root", async () => {
    const error = await failed(loadStartupSeal({
      env: { [AIRLOCK_SEAL_ENV]: "relative/seal" },
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({
      phase: "environment",
      path: AIRLOCK_SEAL_ENV,
      reason: "seal-path-invalid"
    })
  })

  it("verifies generated Ed25519 authority and retains exact inert snapshots", async () => {
    const fixture = await makeFixture()
    const context = await load(fixture.sealPath)

    expect(context).toBeInstanceOf(VerifiedSeal)
    expect(context._tag).toBe("VerifiedSeal")
    expect(context.grant.schemaVersion).toBe("airlock/box-grant/v2")
    expect(context.grant.policy).toBeInstanceOf(ToolPolicy)
    expect(context.grant.policy.toolGrants.map(({ tool }) => tool)).toEqual(["file.read"])
    expect(context.grant.verbs).toEqual(["run", "describe"])
    expect(context.grantDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(context.binaryDigest).toBe(digest(binary))
    expect(context.binaryPath).toBe("/fixture/airlock")
  })

  it("refuses a grant that still pins a definition catalog", async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.sealPath, BOX_GRANT_FILE),
      JSON.stringify({ ...fixture.grantObject, catalog: [] })
    )
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "grant", reason: "invalid-grant" })
  })

  it("refuses a grant in the v1 shape before reading its signature", async () => {
    const fixture = await makeFixture()
    await writeFile(join(fixture.sealPath, BOX_GRANT_FILE), JSON.stringify({
      schemaVersion: "airlock/box-grant/v1",
      admission: {
        schemaVersion: "airlock/admission-policy/v2",
        profile: "native-contained",
        principal: "agent/seal-test",
        realm: "local",
        admittedBy: "operator/seal-test",
        pathAllowlist: ["/workspace/**"],
        executableAllowlist: [],
        executableEdges: [],
        endpointGrants: []
      },
      verbs: ["run"],
      nativeActions: ["file.read"],
      daemonOps: [],
      binaryDigest: digest(binary)
    }))
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "grant", reason: "invalid-grant" })
  })

  it("verifies whitespace and object-key reordered JSON against semantic grant identity", async () => {
    const fixture = await makeFixture({
      serializeGrant: (grant) =>
        `\n  ${JSON.stringify(reverseObjectKeys(grant), null, 4)}  \n`
    })
    const context = await load(fixture.sealPath)
    expect(context).toBeInstanceOf(VerifiedSeal)
  })

  it("rejects a semantic grant change under the original signature", async () => {
    for (const widened of [
      { verbs: ["run", "describe", "ledger"] },
      { policy: { ...policy, toolGrants: [...policy.toolGrants, { id: "rm", tool: "file.remove", when: "now" }] } },
      { policy: { ...policy, resources: { path: ["/"] } } }
    ]) {
      const fixture = await makeFixture()
      await writeFile(join(fixture.sealPath, BOX_GRANT_FILE), JSON.stringify({
        ...fixture.grantObject,
        ...widened
      }))

      const error = await failed(loadStartupSeal({
        sealPath: fixture.sealPath,
        binarySnapshotProvider: provider()
      }))
      expect(error).toMatchObject({ phase: "signature", reason: "signature-invalid" })
    }
  })

  it("rejects a missing grant without falling back to unsealed", async () => {
    const fixture = await makeFixture({ writeGrant: false })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "grant", reason: "missing" })
  })

  it("rejects a missing detached signature", async () => {
    const fixture = await makeFixture({ writeSignature: false })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "signature", reason: "missing" })
  })

  it("requires a detached signature of exactly 64 raw bytes", async () => {
    for (const signatureBytes of [
      (signature: Uint8Array) => signature.slice(0, 63),
      (signature: Uint8Array) => new Uint8Array([...signature, 0])
    ]) {
      const fixture = await makeFixture({ signatureBytes })
      const error = await failed(loadStartupSeal({
        sealPath: fixture.sealPath,
        binarySnapshotProvider: provider()
      }))
      expect(error).toMatchObject({ phase: "signature", reason: "signature-size" })
    }
  })

  it("rejects a corrupt 64-byte signature", async () => {
    const fixture = await makeFixture({
      signatureBytes: () => new Uint8Array(64)
    })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "signature", reason: "signature-invalid" })
  })

  it("rejects a signature made by a different Ed25519 key", async () => {
    const fixture = await makeFixture()
    const other = generateKeyPairSync("ed25519")
    await writeFile(
      join(fixture.sealPath, OPERATOR_PUBLIC_KEY_FILE),
      other.publicKey.export({ format: "pem", type: "spki" })
    )
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "signature", reason: "signature-invalid" })
  })

  it("requires an Ed25519 SPKI public key", async () => {
    const fixture = await makeFixture()
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(
      join(fixture.sealPath, OPERATOR_PUBLIC_KEY_FILE),
      rsa.publicKey.export({ format: "pem", type: "spki" })
    )
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({
      phase: "key",
      reason: "public-key-not-ed25519"
    })
  })

  it("rejects a non-SPKI or malformed public key", async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.sealPath, OPERATOR_PUBLIC_KEY_FILE),
      "-----BEGIN PUBLIC KEY-----\nnot base64\n-----END PUBLIC KEY-----\n"
    )
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "key", reason: "invalid-public-key" })
  })

  it("rejects a correctly signed grant whose binary digest is wrong", async () => {
    const fixture = await makeFixture({
      grantOverrides: { binaryDigest: digest(flippedBinary) }
    })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider(binary)
    }))
    expect(error).toMatchObject({ phase: "binary", reason: "digest-mismatch" })
  })

  it("rejects flipped current-binary bytes", async () => {
    const fixture = await makeFixture()
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider(flippedBinary)
    }))
    expect(error).toMatchObject({ phase: "binary", reason: "digest-mismatch" })
  })

  it("explicitly refuses source-mode production identity", async () => {
    const fixture = await makeFixture()
    const error = await failed(loadStartupSeal({ sealPath: fixture.sealPath }))
    expect(error).toMatchObject({ phase: "identity", reason: "source-mode" })
  })

  it("does not read a grant through a symlink, even to identical signed bytes", async () => {
    const fixture = await makeFixture()
    const outside = join(
      await mkdtemp(join(tmpdir(), "airlock-seal-outside-")),
      "box-grant.json"
    )
    await rename(join(fixture.sealPath, BOX_GRANT_FILE), outside)
    await symlink(outside, join(fixture.sealPath, BOX_GRANT_FILE))

    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "grant", reason: "symlink" })
  })

  it("does not read a signature or an operator key through a symlink", async () => {
    for (const [file, phase] of [
      [BOX_GRANT_SIGNATURE_FILE, "signature"],
      [OPERATOR_PUBLIC_KEY_FILE, "key"]
    ] as const) {
      const fixture = await makeFixture()
      const outside = join(await mkdtemp(join(tmpdir(), "airlock-seal-outside-")), file)
      await rename(join(fixture.sealPath, file), outside)
      await symlink(outside, join(fixture.sealPath, file))

      const error = await failed(loadStartupSeal({
        sealPath: fixture.sealPath,
        binarySnapshotProvider: provider()
      }))
      expect(error, file).toMatchObject({ phase, reason: "symlink" })
    }
  })

  it("rejects a grant that is not a regular file", async () => {
    const fixture = await makeFixture({ writeGrant: false })
    await mkdir(join(fixture.sealPath, BOX_GRANT_FILE))
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "grant", reason: "not-regular" })
  })

  it("enforces the grant size limit before decoding", async () => {
    const fixture = await makeFixture()
    await writeFile(join(fixture.sealPath, BOX_GRANT_FILE), new Uint8Array(256 * 1024 + 1))
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "grant", reason: "too-large" })
  })
})
