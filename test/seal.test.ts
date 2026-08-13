import { createHash, generateKeyPairSync, sign } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeBoxGrant } from "../src/admission/BoxGrant.ts"
import { DEFAULT_TOOL_DEFINITION_MAX_BYTES } from "../src/tools/FileReader.ts"
import {
  AIRLOCK_SEAL_ENV,
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  BinarySnapshot,
  OPERATOR_PUBLIC_KEY_FILE,
  SEAL_CATALOG_DIRECTORY,
  SealVerificationFailed,
  UnsealedSeal,
  VerifiedSeal,
  boxGrantSigningPayload,
  catalogFileNameForPin,
  loadStartupSeal,
  reverifySeal
} from "../src/seal/index.ts"

const binary = new TextEncoder().encode("airlock compiled fixture v1\n")
const flippedBinary = new TextEncoder().encode("airlock compiled fixture v2\n")

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const admissionV1 = {
  schemaVersion: "airlock/admission-policy/v1" as const,
  profile: "native-contained" as const,
  principal: "agent/seal-test",
  realm: "local",
  admittedBy: "operator/seal-test",
  pathAllowlist: ["/workspace/**"],
  executableAllowlist: ["/usr/bin/true"],
  endpointAllowlist: []
}

const admissionV2 = {
  schemaVersion: "airlock/admission-policy/v2" as const,
  profile: "native-contained" as const,
  principal: "agent/seal-test",
  realm: "local",
  admittedBy: "operator/seal-test",
  pathAllowlist: ["/workspace/**"],
  executableAllowlist: ["/usr/bin/true"],
  endpointGrants: []
}

const definition = (
  id = "vendor.echo",
  schemaVersion: "airlock/tool-definition/v1" | "airlock/tool-definition/v2" =
    "airlock/tool-definition/v1"
) => new TextEncoder().encode(JSON.stringify({
  schemaVersion,
  id,
  version: "1.0.0",
  executables: [{ realm: "machine", selector: "/usr/bin/true" }],
  actions: [{
    name: "check",
    inputSchema: { type: "object" },
    args: [],
    cwd: { _tag: "Literal", value: "/tmp" },
    lowering: "invoke",
    effectFootprint: ["invoke"],
    resultDecoder: "exit-status"
  }]
}))

type Entry = {
  readonly pinId: string
  readonly rawBytes: Uint8Array
  readonly write?: boolean
}

type FixtureOptions = {
  readonly admission?: typeof admissionV1 | typeof admissionV2
  readonly entries?: ReadonlyArray<Entry>
  readonly grantOverrides?: Readonly<Record<string, unknown>>
  readonly serializeGrant?: (grant: Record<string, unknown>) => string
  readonly makeCatalog?: boolean
  readonly writeGrant?: boolean
  readonly writeSignature?: boolean
  readonly signatureBytes?: (signature: Uint8Array) => Uint8Array
}

const makeFixture = async (options: FixtureOptions = {}) => {
  const sealPath = await mkdtemp(join(tmpdir(), "airlock-seal-"))
  const catalogPath = join(sealPath, SEAL_CATALOG_DIRECTORY)
  if (options.makeCatalog !== false) await mkdir(catalogPath)

  const entries = options.entries ?? [{
    pinId: "vendor.echo",
    rawBytes: definition()
  }]
  const pins = entries.map((entry) => ({
    id: entry.pinId,
    sha256: digest(entry.rawBytes)
  }))
  const grantObject: Record<string, unknown> = {
    schemaVersion: "airlock/box-grant/v1",
    admission: options.admission ?? admissionV1,
    verbs: ["run", "actions"],
    nativeActions: ["file.read", "process.run"],
    catalog: pins,
    daemonOps: ["commit"],
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

  if (options.makeCatalog !== false) {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!
      if (entry.write === false) continue
      await writeFile(
        join(catalogPath, catalogFileNameForPin(grant.catalog[index]!)),
        entry.rawBytes
      )
    }
  }

  return {
    sealPath,
    catalogPath,
    grant,
    grantObject,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    pins
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
    const rawBytes = definition("vendor.echo", "airlock/tool-definition/v2")
    const fixture = await makeFixture({
      admission: admissionV2,
      entries: [{ pinId: "vendor.echo", rawBytes }]
    })
    const context = await load(fixture.sealPath)

    expect(context).toBeInstanceOf(VerifiedSeal)
    expect(context._tag).toBe("VerifiedSeal")
    expect(context.grant.admission.schemaVersion).toBe("airlock/admission-policy/v2")
    expect(context.grantDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(context.binaryDigest).toBe(digest(binary))
    expect(context.binaryPath).toBe("/fixture/airlock")
    expect(context.catalog).toHaveLength(1)
    expect(context.catalog[0]).toMatchObject({
      id: "vendor.echo",
      digest: digest(rawBytes)
    })
    expect(context.catalog[0]!.path).toBe(join(
      fixture.catalogPath,
      catalogFileNameForPin(fixture.grant.catalog[0]!)
    ))
    expect([...context.catalog[0]!.rawBytes]).toEqual([...rawBytes])
    expect(context.catalog[0]!.definition.schemaVersion).toBe(
      "airlock/tool-definition/v2"
    )
  })

  it("accepts either nested admission-policy version", async () => {
    for (const admission of [admissionV1, admissionV2]) {
      const fixture = await makeFixture({ admission })
      const context = await load(fixture.sealPath)
      expect(context.grant.admission.schemaVersion).toBe(admission.schemaVersion)
    }
  })

  it("uses a digest filename and never a grant id as a path fragment", () => {
    const sha256 = `sha256:${"a".repeat(64)}` as const
    expect(catalogFileNameForPin({ sha256 })).toBe(
      `sha256-${"a".repeat(64)}.airlock-tool.json`
    )
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
    const fixture = await makeFixture()
    await writeFile(join(fixture.sealPath, BOX_GRANT_FILE), JSON.stringify({
      ...fixture.grantObject,
      verbs: ["held", "actions"]
    }))

    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "signature", reason: "signature-invalid" })
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

  it("requires the catalog directory even for an empty pin set", async () => {
    const fixture = await makeFixture({ entries: [], makeCatalog: false })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "missing" })
  })

  it("accepts an empty catalog only when it has no suffix-bearing children", async () => {
    const fixture = await makeFixture({ entries: [] })
    await writeFile(join(fixture.catalogPath, "README.txt"), "ignored")
    const context = await load(fixture.sealPath)
    expect(context.catalog).toEqual([])
  })

  it("rejects an extra immediate definition suffix file", async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.catalogPath, "extra.airlock-tool.json"),
      definition("vendor.extra")
    )
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "catalog-file-extra" })
  })

  it("rejects a missing digest-named catalog file", async () => {
    const fixture = await makeFixture({
      entries: [{ pinId: "vendor.echo", rawBytes: definition(), write: false }]
    })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "catalog-file-missing" })
  })

  it("does not follow a digest-named catalog symlink", async () => {
    const rawBytes = definition()
    const fixture = await makeFixture({
      entries: [{ pinId: "vendor.echo", rawBytes, write: false }]
    })
    const outside = join(
      await mkdtemp(join(tmpdir(), "airlock-seal-outside-")),
      "definition.json"
    )
    await writeFile(outside, rawBytes)
    await symlink(
      outside,
      join(fixture.catalogPath, catalogFileNameForPin(fixture.grant.catalog[0]!))
    )

    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "symlink" })
  })

  it("rejects a nonregular digest-named catalog entry", async () => {
    const rawBytes = definition()
    const fixture = await makeFixture({
      entries: [{ pinId: "vendor.echo", rawBytes, write: false }]
    })
    await mkdir(join(
      fixture.catalogPath,
      catalogFileNameForPin(fixture.grant.catalog[0]!)
    ))
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "not-regular" })
  })

  it("enforces the current tool-definition size limit", async () => {
    const rawBytes = new Uint8Array(DEFAULT_TOOL_DEFINITION_MAX_BYTES + 1)
    const fixture = await makeFixture({
      entries: [{ pinId: "vendor.echo", rawBytes }]
    })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "too-large" })
  })

  it("rejects a byte digest mismatch before decoding the definition", async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.catalogPath, catalogFileNameForPin(fixture.grant.catalog[0]!)),
      definition("vendor.changed")
    )
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "digest-mismatch" })
  })

  it("rejects invalid definition bytes even when their pin matches", async () => {
    const fixture = await makeFixture({
      entries: [{
        pinId: "vendor.echo",
        rawBytes: new TextEncoder().encode("{not json")
      }]
    })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({
      phase: "catalog",
      reason: "invalid-tool-definition"
    })
  })

  it("requires the decoded definition id to equal the pin id", async () => {
    const fixture = await makeFixture({
      entries: [{ pinId: "vendor.expected", rawBytes: definition("vendor.actual") }]
    })
    const error = await failed(loadStartupSeal({
      sealPath: fixture.sealPath,
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "tool-id-mismatch" })
  })
})

describe("seal reverification", () => {
  it("freshly verifies an unchanged seal", async () => {
    const fixture = await makeFixture()
    const expected = await load(fixture.sealPath)
    const fresh = await Effect.runPromise(reverifySeal(expected, {
      binarySnapshotProvider: provider()
    }))
    expect(fresh.grantDigest).toBe(expected.grantDigest)
    expect([...fresh.catalog[0]!.rawBytes]).toEqual([...expected.catalog[0]!.rawBytes])
  })

  it("detects a newly valid but different grant", async () => {
    const fixture = await makeFixture()
    const expected = await load(fixture.sealPath)
    const changedObject = { ...fixture.grantObject, verbs: ["held", "actions"] }
    const changedGrant = await Effect.runPromise(decodeBoxGrant(changedObject))
    await writeFile(
      join(fixture.sealPath, BOX_GRANT_FILE),
      JSON.stringify(changedObject)
    )
    await writeFile(
      join(fixture.sealPath, BOX_GRANT_SIGNATURE_FILE),
      sign(null, boxGrantSigningPayload(changedGrant), fixture.privateKey)
    )

    const error = await failed(reverifySeal(expected, {
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "reverify", reason: "snapshot-mismatch" })
  })

  it("detects catalog bytes changed after the original capture", async () => {
    const fixture = await makeFixture()
    const expected = await load(fixture.sealPath)
    await writeFile(
      expected.catalog[0]!.path,
      definition("vendor.changed")
    )

    const error = await failed(reverifySeal(expected, {
      binarySnapshotProvider: provider()
    }))
    expect(error).toMatchObject({ phase: "catalog", reason: "digest-mismatch" })
  })

  it("detects changed binary bytes on the fresh pass", async () => {
    const fixture = await makeFixture()
    const expected = await load(fixture.sealPath)
    const error = await failed(reverifySeal(expected, {
      binarySnapshotProvider: provider(flippedBinary)
    }))
    expect(error).toMatchObject({ phase: "binary", reason: "digest-mismatch" })
  })
})
