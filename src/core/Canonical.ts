import { canonicalExactJson } from "./ExactJson.ts"
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

/** Optional encoded fields are omitted; no toJSON conversion changes a tool value. */
const encodedJson = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : encodedJson(item))
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, encodedJson(item)]))
}

/** One exact JSON byte sequence per encoded value, with recursively sorted keys. */
export const canonicalJson = (value: unknown): string =>
  canonicalExactJson(Schema.decodeUnknownSync(Schema.Json)(encodedJson(value)))

const encoder = new TextEncoder()

export const sha256Bytes = (
  bytes: Uint8Array
): Effect.Effect<Sha256Digest, DigestUnavailable, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) => crypto.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => Sha256Digest.make(`sha256:${Encoding.encodeHex(digest)}`)),
    Effect.mapError((error) => new DigestUnavailable({ reason: error.message }))
  )

export const sha256Text = (text: string) => sha256Bytes(encoder.encode(text))

export const sha256Canonical = (value: unknown) => sha256Text(canonicalJson(value))
