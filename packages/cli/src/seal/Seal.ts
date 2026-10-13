import {
  constants,
  type Stats
} from "node:fs"
import { lstat, open } from "node:fs/promises"
import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto"
import { isAbsolute, join } from "node:path"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import {
  BoxGrant,
  decodeBoxGrant,
  hashBoxGrant
} from "@skastr0/airlock"
import { Sha256Digest } from "@skastr0/airlock"

/** The environment variable that opts startup into sealed operation. */
export const AIRLOCK_SEAL_ENV = "AIRLOCK_SEAL"

/** The fixed, supervisor-installed seal layout. */
export const BOX_GRANT_FILE = "box-grant.json"
export const BOX_GRANT_SIGNATURE_FILE = "box-grant.ed25519"
export const OPERATOR_PUBLIC_KEY_FILE = "operator-ed25519.pub.pem"

/**
 * Grant signatures bind decoded authority, rather than a particular spelling
 * of its JSON. PR6's signer and this verifier deliberately share this helper.
 */
export const BOX_GRANT_SIGNATURE_DOMAIN =
  "airlock/box-grant/signature/v1\0"

/**
 * The kernel's canonical grant digest, computed with this host's Crypto. Bun
 * hashes synchronously and cannot be unavailable here, so signers and
 * fixtures get a plain value.
 */
export const boxGrantDigest = (grant: BoxGrant): Sha256Digest =>
  Effect.runSync(hashBoxGrant(grant).pipe(Effect.provide(BunCrypto.layer)))

export const boxGrantSigningPayload = (grant: BoxGrant): Uint8Array =>
  new TextEncoder().encode(`${BOX_GRANT_SIGNATURE_DOMAIN}${boxGrantDigest(grant)}`)

export class BinarySnapshot extends Schema.Class<BinarySnapshot>(
  "BinarySnapshot"
)({
  path: Schema.String,
  rawBytes: Schema.Uint8Array
}) {}

export class UnsealedSeal extends Schema.TaggedClass<UnsealedSeal>()(
  "UnsealedSeal",
  {}
) {}

/**
 * Startup verification produces data only. In particular, this value contains
 * no filesystem reader, binary provider, process handle, Layer, or other
 * ambient authority that could silently observe a different seal later.
 */
export class VerifiedSeal extends Schema.TaggedClass<VerifiedSeal>()(
  "VerifiedSeal",
  {
    sealPath: Schema.String,
    grant: BoxGrant,
    grantDigest: Sha256Digest,
    binaryPath: Schema.String,
    binaryDigest: Sha256Digest
  }
) {}

export const SealContext = Schema.Union([UnsealedSeal, VerifiedSeal])
export type SealContext = typeof SealContext.Type

export const SealVerificationPhase = Schema.Literals([
  "environment",
  "seal",
  "identity",
  "binary",
  "grant",
  "key",
  "signature"
])
export type SealVerificationPhase = typeof SealVerificationPhase.Type

/** Fixed machine-readable reasons; raw OS/parser/crypto errors never escape. */
export const SealVerificationReason = Schema.Literals([
  "seal-path-blank",
  "seal-path-invalid",
  "source-mode",
  "binary-provider-failed",
  "binary-snapshot-invalid",
  "missing",
  "symlink",
  "not-a-directory",
  "not-regular",
  "too-large",
  "changed-during-read",
  "read-failed",
  "invalid-utf8",
  "invalid-json",
  "invalid-grant",
  "signature-size",
  "invalid-public-key",
  "public-key-not-ed25519",
  "operator-key-mismatch",
  "signature-invalid",
  "signature-verification-failed",
  "digest-mismatch",
  "installation-not-ready"
])
export type SealVerificationReason = typeof SealVerificationReason.Type

export class SealVerificationFailed
  extends Schema.TaggedError<SealVerificationFailed>()(
    "SealVerificationFailed",
    {
      phase: SealVerificationPhase,
      path: Schema.String,
      reason: SealVerificationReason
    }
  ) {}

export type BinarySnapshotProvider = () => Effect.Effect<
  BinarySnapshot,
  SealVerificationFailed
>

export interface SealVerificationOptions {
  readonly binarySnapshotProvider?: BinarySnapshotProvider
  /** Compiled tenant trust anchor: SHA-256 of the operator Ed25519 SPKI DER. */
  readonly expectedOperatorKeyDigest?: Sha256Digest
}

export interface LoadStartupSealOptions extends SealVerificationOptions {
  /** An exact path override, primarily for integrations and tests. */
  readonly sealPath?: string
  /** Supplying an empty object models a truly unset environment in tests. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const failure = (
  phase: SealVerificationPhase,
  path: string,
  reason: SealVerificationReason
) => new SealVerificationFailed({ phase, path, reason })

const sha256 = (bytes: Uint8Array): Sha256Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest

const osCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause &&
      typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : undefined

const inspectReason = (cause: unknown): SealVerificationReason => {
  const code = osCode(cause)
  if (code === "ENOENT" || code === "ENOTDIR") return "missing"
  if (code === "ELOOP" || code === "EMLINK") return "symlink"
  return "read-failed"
}

const inspectDirectory = (
  path: string,
  phase: SealVerificationPhase
): Effect.Effect<void, SealVerificationFailed> =>
  Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => failure(phase, path, inspectReason(cause))
  }).pipe(
    Effect.flatMap((info) => {
      if (info.isSymbolicLink()) {
        return Effect.fail(failure(phase, path, "symlink"))
      }
      if (!info.isDirectory()) {
        return Effect.fail(failure(phase, path, "not-a-directory"))
      }
      return Effect.void
    })
  )

class ReadSentinel extends Error {
  constructor(readonly reason: SealVerificationReason) {
    super(reason)
  }
}

const sameOpenedFile = (before: Stats, after: Stats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs

/**
 * Capture one exact regular-file snapshot. The lstat avoids blocking on an
 * obvious FIFO; O_NONBLOCK protects the remaining race, O_NOFOLLOW refuses a
 * raced symlink, and both fstats describe the handle actually read.
 */
const readRegularFile = (
  path: string,
  phase: SealVerificationPhase,
  maxBytes?: number
): Effect.Effect<Uint8Array, SealVerificationFailed> =>
  Effect.tryPromise({
    try: async () => {
      const inspected = await lstat(path)
      if (inspected.isSymbolicLink()) throw new ReadSentinel("symlink")
      if (!inspected.isFile()) throw new ReadSentinel("not-regular")

      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const before = await handle.stat()
        if (!before.isFile()) throw new ReadSentinel("not-regular")
        if (!Number.isSafeInteger(before.size) || before.size < 0) {
          throw new ReadSentinel("read-failed")
        }
        if (maxBytes !== undefined && before.size > maxBytes) {
          throw new ReadSentinel("too-large")
        }
        const captured = await handle.readFile()
        const after = await handle.stat()
        if (!sameOpenedFile(before, after) || captured.byteLength !== after.size) {
          throw new ReadSentinel("changed-during-read")
        }
        if (maxBytes !== undefined && captured.byteLength > maxBytes) {
          throw new ReadSentinel("too-large")
        }
        // Detach the retained snapshot from Buffer pooling and the file handle.
        return new Uint8Array(captured)
      } finally {
        await handle.close()
      }
    },
    catch: (cause) => failure(
      phase,
      path,
      cause instanceof ReadSentinel ? cause.reason : inspectReason(cause)
    )
  })

const decodeUtf8 = (
  bytes: Uint8Array,
  phase: SealVerificationPhase,
  path: string
): Effect.Effect<string, SealVerificationFailed> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => failure(phase, path, "invalid-utf8")
  })

const metadataMaxBytes = 256 * 1024
const keyMaxBytes = 16 * 1024
const signatureMaxBytes = 16 * 1024

const readGrant = (
  sealPath: string
): Effect.Effect<
  { readonly grant: BoxGrant; readonly grantDigest: Sha256Digest },
  SealVerificationFailed
> => {
  const path = join(sealPath, BOX_GRANT_FILE)
  return readRegularFile(path, "grant", metadataMaxBytes).pipe(
    Effect.flatMap((bytes) => decodeUtf8(bytes, "grant", path)),
    Effect.flatMap((json) => Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: () => failure("grant", path, "invalid-json")
    })),
    Effect.flatMap((parsed) => decodeBoxGrant(parsed).pipe(
      Effect.mapError(() => failure("grant", path, "invalid-grant"))
    )),
    Effect.map((grant) => ({ grant, grantDigest: boxGrantDigest(grant) }))
  )
}

const readOperatorPublicKey = (sealPath: string) => {
  const path = join(sealPath, OPERATOR_PUBLIC_KEY_FILE)
  return readRegularFile(path, "key", keyMaxBytes).pipe(
    Effect.flatMap((bytes) => decodeUtf8(bytes, "key", path)),
    Effect.flatMap((pem) => {
      // Anchor the one SPKI PEM envelope so createPublicKey cannot accept one
      // key while silently ignoring another block or trailing material.
      if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----(?:\r?\n)?$/.test(pem)) {
        return Effect.fail(failure("key", path, "invalid-public-key"))
      }
      return Effect.try({
        try: () => createPublicKey({
          key: Buffer.from(pem, "utf8"),
          format: "pem",
          type: "spki"
        }),
        catch: () => failure("key", path, "invalid-public-key")
      })
    }),
    Effect.flatMap((key) => key.asymmetricKeyType === "ed25519"
      ? Effect.succeed(key)
      : Effect.fail(failure("key", path, "public-key-not-ed25519")))
  )
}

const verifyGrantSignature = (
  sealPath: string,
  grant: BoxGrant,
  expectedOperatorKeyDigest?: Sha256Digest
): Effect.Effect<void, SealVerificationFailed> => {
  const path = join(sealPath, BOX_GRANT_SIGNATURE_FILE)
  return Effect.all({
    key: readOperatorPublicKey(sealPath),
    signature: readRegularFile(path, "signature", signatureMaxBytes)
  }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ key, signature }) => {
      if (expectedOperatorKeyDigest !== undefined) {
        const der = key.export({ format: "der", type: "spki" })
        if (sha256(new Uint8Array(der)) !== expectedOperatorKeyDigest) {
          return Effect.fail(failure("key", join(sealPath, OPERATOR_PUBLIC_KEY_FILE), "operator-key-mismatch"))
        }
      }
      if (signature.byteLength !== 64) {
        return Effect.fail(failure("signature", path, "signature-size"))
      }
      return Effect.try({
        try: () => verifySignature(
          null,
          boxGrantSigningPayload(grant),
          key,
          signature
        ),
        catch: () => failure("signature", path, "signature-verification-failed")
      }).pipe(
        Effect.flatMap((verified) => verified
          ? Effect.void
          : Effect.fail(failure("signature", path, "signature-invalid")))
      )
    })
  )
}

const bunMain = (): string | undefined => {
  const candidate = (globalThis as {
    readonly Bun?: { readonly main?: unknown }
  }).Bun?.main
  return typeof candidate === "string" ? candidate : undefined
}

/**
 * The production identity is deliberately unavailable to `bun run`, vitest,
 * Node, tsx, or another source loader. Only Bun's compiled filesystem marker
 * authorizes reading the exact executable named by process.execPath.
 */
export const currentBinarySnapshot: BinarySnapshotProvider = () =>
  Effect.gen(function* () {
    const main = bunMain()
    if (main === undefined || !main.startsWith("/$bunfs/")) {
      return yield* failure("identity", "Bun.main", "source-mode")
    }
    if (!isAbsolute(process.execPath)) {
      return yield* failure(
        "identity",
        process.execPath,
        "binary-snapshot-invalid"
      )
    }
    const rawBytes = yield* readRegularFile(process.execPath, "binary")
    return new BinarySnapshot({ path: process.execPath, rawBytes })
  })

const acquireBinarySnapshot = (
  provider: BinarySnapshotProvider
): Effect.Effect<BinarySnapshot, SealVerificationFailed> =>
  Effect.try({
    try: provider,
    catch: () => failure("binary", process.execPath, "binary-provider-failed")
  }).pipe(
    Effect.flatten,
    Effect.flatMap((snapshot) => {
      if (
        typeof snapshot !== "object" || snapshot === null ||
        typeof snapshot.path !== "string" || snapshot.path.length === 0 ||
        !(snapshot.rawBytes instanceof Uint8Array)
      ) {
        return Effect.fail(failure(
          "binary",
          process.execPath,
          "binary-snapshot-invalid"
        ))
      }
      return Effect.succeed(snapshot)
    })
  )

/** Verify one explicit seal directory without consulting the environment. */
export const verifySealAtPath = (
  sealPath: string,
  options: SealVerificationOptions = {}
): Effect.Effect<VerifiedSeal, SealVerificationFailed> =>
  Effect.gen(function* () {
    if (typeof sealPath !== "string") {
      return yield* failure("environment", AIRLOCK_SEAL_ENV, "seal-path-invalid")
    }
    if (sealPath.trim().length === 0) {
      return yield* failure("environment", AIRLOCK_SEAL_ENV, "seal-path-blank")
    }
    if (!isAbsolute(sealPath)) {
      return yield* failure("environment", AIRLOCK_SEAL_ENV, "seal-path-invalid")
    }

    yield* inspectDirectory(sealPath, "seal")
    const { grant, grantDigest } = yield* readGrant(sealPath)
    yield* verifyGrantSignature(
      sealPath,
      grant,
      options.expectedOperatorKeyDigest
    )

    const binary = yield* acquireBinarySnapshot(
      options.binarySnapshotProvider ?? currentBinarySnapshot
    )
    const binaryDigest = sha256(binary.rawBytes)
    if (binaryDigest !== grant.binaryDigest) {
      return yield* failure("binary", binary.path, "digest-mismatch")
    }

    return new VerifiedSeal({
      sealPath,
      grant,
      grantDigest,
      binaryPath: binary.path,
      binaryDigest
    })
  })

/**
 * AIRLOCK_SEAL is opt-in. Only `undefined` short-circuits to UnsealedSeal;
 * every present value, including an empty one, enters the typed failure path.
 */
export const loadStartupSeal = (
  options: LoadStartupSealOptions = {}
): Effect.Effect<SealContext, SealVerificationFailed> =>
  Effect.gen(function* () {
    const sealPath = yield* Effect.try({
      try: () => options.sealPath !== undefined
        ? options.sealPath
        : (options.env ?? process.env)[AIRLOCK_SEAL_ENV],
      catch: () => failure("environment", AIRLOCK_SEAL_ENV, "seal-path-invalid")
    })
    if (sealPath === undefined) return new UnsealedSeal({})
    if (typeof sealPath !== "string") {
      return yield* failure("environment", AIRLOCK_SEAL_ENV, "seal-path-invalid")
    }
    return yield* verifySealAtPath(sealPath, options)
  })


export const InstalledGenerationMode = Schema.Literals([
  "root-tenant",
  "local-same-user"
])
export type InstalledGenerationMode = typeof InstalledGenerationMode.Type

/** Required sealed entrypoints accept only their compile-bound publication mode. */
export const verifyInstalledReadiness = (
  seal: VerifiedSeal,
  readinessPath: string,
  expectedMode: string | undefined
): Effect.Effect<void, SealVerificationFailed> =>
  readRegularFile(readinessPath, "seal", 4_096).pipe(
    Effect.flatMap((bytes) => decodeUtf8(bytes, "seal", readinessPath)),
    Effect.flatMap((json) => Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: () => failure("seal", readinessPath, "installation-not-ready")
    })),
    Effect.flatMap((document) => {
      const fields = typeof document === "object" && document !== null
        ? document as Record<string, unknown>
        : undefined
      const localMarker = fields?.["localSameUser"]
      const modeReady = expectedMode === "root-tenant"
        ? fields?.["ownershipApplied"] === true &&
          (localMarker === undefined || localMarker === false)
        : expectedMode === "local-same-user"
          ? fields?.["ownershipApplied"] === false && localMarker === true
          : false
      if (
        fields === undefined ||
        fields["schemaVersion"] !== "airlock/installed-generation/v1" ||
        fields["grantDigest"] !== seal.grantDigest ||
        fields["binaryDigest"] !== seal.binaryDigest ||
        fields["runnable"] !== true ||
        !modeReady
      ) {
        return Effect.fail(failure("seal", readinessPath, "installation-not-ready"))
      }
      return Effect.void
    }),
    Effect.mapError((error) => error.reason === "installation-not-ready"
      ? error
      : failure("seal", readinessPath, "installation-not-ready"))
  )
