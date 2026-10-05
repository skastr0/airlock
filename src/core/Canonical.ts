import { Crypto, Effect, Encoding, Schema } from "effect"

/**
 * Canonical encoding and digests are owned by the kernel so that every host
 * derives the same identity for the same content. Adapters store what they are
 * handed; they never re-encode and never hash.
 */

export const Sha256Digest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/, {
    message: "must be sha256:<64 lowercase hex>"
  })),
  Schema.brand("Sha256Digest")
)
export type Sha256Digest = typeof Sha256Digest.Type

export class DigestUnavailable extends Schema.TaggedError<DigestUnavailable>()(
  "DigestUnavailable",
  { reason: Schema.String }
) {}

const sortKeys = (value: Schema.Json): Schema.Json => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sortKeys)
  const record = value as Schema.JsonObject
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, sortKeys(record[key]!)])
  )
}

/** One byte sequence per JSON value: object keys sorted, no insignificant space. */
export const canonicalJson = (value: Schema.Json): string =>
  JSON.stringify(sortKeys(value))

const encoder = new TextEncoder()

export const sha256Bytes = (
  bytes: Uint8Array
): Effect.Effect<Sha256Digest, DigestUnavailable, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) => crypto.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => Sha256Digest.make(`sha256:${Encoding.encodeHex(digest)}`)),
    Effect.mapError((error) => new DigestUnavailable({ reason: error.message }))
  )

export const sha256Text = (text: string) => sha256Bytes(encoder.encode(text))

export const sha256Canonical = (value: Schema.Json) => sha256Text(canonicalJson(value))
