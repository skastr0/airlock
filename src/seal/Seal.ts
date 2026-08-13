import {
  constants,
  type Stats
} from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto"
import { isAbsolute, join } from "node:path"
import { Effect, Schema } from "effect"
import {
  BoxGrant,
  BoxGrantCatalogPin,
  BoxGrantSha256,
  decodeBoxGrant,
  hashBoxGrant
} from "../admission/BoxGrant.ts"
import {
  AnyToolDefinition,
  ToolDefinitionDocument,
  ToolDefinitionLocation,
  decodeToolDefinition
} from "../tools/Definitions.ts"
import {
  DEFAULT_TOOL_DEFINITION_MAX_BYTES,
  TOOL_DEFINITION_FILE_SUFFIX
} from "../tools/FileReader.ts"

/** The environment variable that opts startup into sealed operation. */
export const AIRLOCK_SEAL_ENV = "AIRLOCK_SEAL"

/** The fixed, supervisor-installed seal layout. */
export const BOX_GRANT_FILE = "box-grant.json"
export const BOX_GRANT_SIGNATURE_FILE = "box-grant.ed25519"
export const OPERATOR_PUBLIC_KEY_FILE = "operator-ed25519.pub.pem"
export const SEAL_CATALOG_DIRECTORY = "catalog"

/**
 * Grant signatures bind decoded authority, rather than a particular spelling
 * of its JSON. PR6's signer and this verifier deliberately share this helper.
 */
export const BOX_GRANT_SIGNATURE_DOMAIN =
  "airlock/box-grant/signature/v1\0"

export const boxGrantSigningPayload = (grant: BoxGrant): Uint8Array =>
  new TextEncoder().encode(`${BOX_GRANT_SIGNATURE_DOMAIN}${hashBoxGrant(grant)}`)

/**
 * Catalog ids are authority strings, not path fragments. A pin's digest is the
 * complete deterministic filename input and therefore cannot traverse out of
 * the catalog directory.
 */
export const catalogFileNameForPin = (
  pin: Pick<BoxGrantCatalogPin, "sha256">
): string =>
  `sha256-${pin.sha256.slice("sha256:".length)}${TOOL_DEFINITION_FILE_SUFFIX}`

export class BinarySnapshot extends Schema.Class<BinarySnapshot>(
  "BinarySnapshot"
)({
  path: Schema.String,
  rawBytes: Schema.Uint8Array
}) {}

/** A catalog document whose exact verified bytes are retained for later use. */
export class VerifiedCatalogDocument
  extends Schema.Class<VerifiedCatalogDocument>("VerifiedCatalogDocument")({
    id: Schema.String,
    path: Schema.String,
    digest: BoxGrantSha256,
    rawBytes: Schema.Uint8Array,
    definition: AnyToolDefinition
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
    grantDigest: BoxGrantSha256,
    binaryPath: Schema.String,
    binaryDigest: BoxGrantSha256,
    catalog: Schema.Array(VerifiedCatalogDocument)
  }
) {}

export const SealContext = Schema.Union(UnsealedSeal, VerifiedSeal)
export type SealContext = typeof SealContext.Type

export const SealVerificationPhase = Schema.Literal(
  "environment",
  "seal",
  "identity",
  "binary",
  "grant",
  "key",
  "signature",
  "catalog",
  "reverify"
)
export type SealVerificationPhase = typeof SealVerificationPhase.Type

/** Fixed machine-readable reasons; raw OS/parser/crypto errors never escape. */
export const SealVerificationReason = Schema.Literal(
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
  "list-failed",
  "invalid-utf8",
  "invalid-json",
  "invalid-grant",
  "signature-size",
  "invalid-public-key",
  "public-key-not-ed25519",
  "signature-invalid",
  "signature-verification-failed",
  "digest-mismatch",
  "catalog-file-missing",
  "catalog-file-extra",
  "catalog-changed",
  "invalid-tool-definition",
  "tool-id-mismatch",
  "snapshot-mismatch"
)
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

const sha256 = (bytes: Uint8Array): BoxGrantSha256 =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as BoxGrantSha256

const lexical = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

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

const metadataMaxBytes = DEFAULT_TOOL_DEFINITION_MAX_BYTES
const keyMaxBytes = 16 * 1024
const signatureMaxBytes = 16 * 1024

const readGrant = (
  sealPath: string
): Effect.Effect<
  { readonly grant: BoxGrant; readonly grantDigest: BoxGrantSha256 },
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
    Effect.map((grant) => ({ grant, grantDigest: hashBoxGrant(grant) }))
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
  grant: BoxGrant
): Effect.Effect<void, SealVerificationFailed> => {
  const path = join(sealPath, BOX_GRANT_SIGNATURE_FILE)
  return Effect.all({
    key: readOperatorPublicKey(sealPath),
    signature: readRegularFile(path, "signature", signatureMaxBytes)
  }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ key, signature }) => {
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

const listCatalogNames = (
  catalogPath: string
): Effect.Effect<ReadonlyArray<string>, SealVerificationFailed> =>
  Effect.tryPromise({
    try: () => readdir(catalogPath, { withFileTypes: true }),
    catch: () => failure("catalog", catalogPath, "list-failed")
  }).pipe(
    Effect.map((entries) => entries
      // Entry kind is intentionally not filtered: a suffix-bearing symlink,
      // FIFO, or directory participates in the exact set and is then refused.
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(TOOL_DEFINITION_FILE_SUFFIX))
      .sort(lexical))
  )

const requireExactCatalogSet = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  catalogPath: string
): Effect.Effect<void, SealVerificationFailed> => {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.find((name) => !actualSet.has(name))
  if (missing !== undefined) {
    return Effect.fail(failure(
      "catalog",
      join(catalogPath, missing),
      "catalog-file-missing"
    ))
  }
  const extra = actual.find((name) => !expectedSet.has(name))
  if (extra !== undefined) {
    return Effect.fail(failure(
      "catalog",
      join(catalogPath, extra),
      "catalog-file-extra"
    ))
  }
  return Effect.void
}

const decodeCatalogDocument = (
  pin: BoxGrantCatalogPin,
  path: string,
  rawBytes: Uint8Array,
  catalogPath: string
): Effect.Effect<VerifiedCatalogDocument, SealVerificationFailed> =>
  Effect.gen(function* () {
    const digest = sha256(rawBytes)
    if (digest !== pin.sha256) {
      return yield* failure("catalog", path, "digest-mismatch")
    }
    const json = yield* decodeUtf8(rawBytes, "catalog", path)
    const document = new ToolDefinitionDocument({
      location: new ToolDefinitionLocation({
        // The current definition vocabulary has no authority-bearing "sealed"
        // discovery tier. This value is only an input required by the current
        // decoder; VerifiedCatalogDocument retains the authoritative path.
        kind: "installed",
        directory: catalogPath
      }),
      file: path,
      json
    })
    const loaded = yield* decodeToolDefinition(document).pipe(
      Effect.mapError(() => failure("catalog", path, "invalid-tool-definition"))
    )
    if (loaded.definition.id !== pin.id) {
      return yield* failure("catalog", path, "tool-id-mismatch")
    }
    return new VerifiedCatalogDocument({
      id: pin.id,
      path,
      digest,
      rawBytes,
      definition: loaded.definition
    })
  })

const readCatalog = (
  sealPath: string,
  pins: ReadonlyArray<BoxGrantCatalogPin>
): Effect.Effect<ReadonlyArray<VerifiedCatalogDocument>, SealVerificationFailed> => {
  const catalogPath = join(sealPath, SEAL_CATALOG_DIRECTORY)
  const orderedPins = [...pins].sort((left, right) =>
    lexical(catalogFileNameForPin(left), catalogFileNameForPin(right))
  )
  const expectedNames = orderedPins.map(catalogFileNameForPin)

  return inspectDirectory(catalogPath, "catalog").pipe(
    Effect.flatMap(() => listCatalogNames(catalogPath)),
    Effect.tap((names) => requireExactCatalogSet(names, expectedNames, catalogPath)),
    Effect.flatMap(() => Effect.forEach(
      orderedPins,
      (pin) => {
        const path = join(catalogPath, catalogFileNameForPin(pin))
        return readRegularFile(
          path,
          "catalog",
          DEFAULT_TOOL_DEFINITION_MAX_BYTES
        ).pipe(
          Effect.flatMap((rawBytes) =>
            decodeCatalogDocument(pin, path, rawBytes, catalogPath)
          )
        )
      },
      { concurrency: 1 }
    )),
    Effect.tap(() => listCatalogNames(catalogPath).pipe(
      Effect.flatMap((names) => {
        const unchanged = names.length === expectedNames.length &&
          names.every((name, index) => name === expectedNames[index])
        return unchanged
          ? Effect.void
          : Effect.fail(failure("catalog", catalogPath, "catalog-changed"))
      })
    ))
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
    yield* verifyGrantSignature(sealPath, grant)

    const binary = yield* acquireBinarySnapshot(
      options.binarySnapshotProvider ?? currentBinarySnapshot
    )
    const binaryDigest = sha256(binary.rawBytes)
    if (binaryDigest !== grant.binaryDigest) {
      return yield* failure("binary", binary.path, "digest-mismatch")
    }

    const catalog = yield* readCatalog(sealPath, grant.catalog)
    return new VerifiedSeal({
      sealPath,
      grant,
      grantDigest,
      binaryPath: binary.path,
      binaryDigest,
      catalog: [...catalog]
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

const sameBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const sameCatalogSnapshot = (
  left: ReadonlyArray<VerifiedCatalogDocument>,
  right: ReadonlyArray<VerifiedCatalogDocument>
) => left.length === right.length && left.every((document, index) => {
  const candidate = right[index]
  return candidate !== undefined &&
    document.id === candidate.id &&
    document.path === candidate.path &&
    document.digest === candidate.digest &&
    sameBytes(document.rawBytes, candidate.rawBytes)
})

/**
 * Perform all filesystem, signature, binary, and catalog checks again, then
 * require identity with the originally verified immutable-by-convention data.
 */
export const reverifySeal = (
  expected: VerifiedSeal,
  options: SealVerificationOptions = {}
): Effect.Effect<VerifiedSeal, SealVerificationFailed> =>
  verifySealAtPath(expected.sealPath, options).pipe(
    Effect.flatMap((fresh) => {
      if (fresh.grantDigest !== expected.grantDigest) {
        return Effect.fail(failure(
          "reverify",
          join(expected.sealPath, BOX_GRANT_FILE),
          "snapshot-mismatch"
        ))
      }
      if (
        fresh.binaryPath !== expected.binaryPath ||
        fresh.binaryDigest !== expected.binaryDigest
      ) {
        return Effect.fail(failure(
          "reverify",
          expected.binaryPath,
          "snapshot-mismatch"
        ))
      }
      if (!sameCatalogSnapshot(fresh.catalog, expected.catalog)) {
        return Effect.fail(failure(
          "reverify",
          join(expected.sealPath, SEAL_CATALOG_DIRECTORY),
          "snapshot-mismatch"
        ))
      }
      return Effect.succeed(fresh)
    })
  )
