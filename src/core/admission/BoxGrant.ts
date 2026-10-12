import { type DigestUnavailable, Sha256Digest, sha256Canonical } from "../Canonical.ts"
import { type Crypto, Effect, Schema } from "effect"
import { ToolPolicy } from "../session/ToolPolicy.ts"

/**
 * A Box Grant is supervisor-authored authority for one Airlock binary: the
 * commands it answers and the policy every program it runs is held to. It is
 * data only; the seal verifies it before any command is built.
 */

/** Every command a sealed `airlock` can be granted. */
export const BoxGrantVerb = Schema.Literals([
  "describe",
  "review",
  "run",
  "eval",
  "approve-plan",
  "pending",
  "inspect",
  "commit",
  "cancel",
  "undo",
  "reap",
  "ledger",
  "doctor",
  "capabilities"
])
export type BoxGrantVerb = typeof BoxGrantVerb.Type

const UniqueBoxGrantVerbs = Schema.Array(BoxGrantVerb).pipe(
  Schema.check(Schema.makeFilter((verbs) => new Set(verbs).size === verbs.length || "must not contain duplicate verbs"))
)

/**
 * Strict `airlock/box-grant/v2` supervisor document. `verbs` has set
 * semantics and rejects a repeated verb instead of silently normalizing it.
 */
export class BoxGrant extends Schema.Class<BoxGrant>("BoxGrant")({
  schemaVersion: Schema.Literal("airlock/box-grant/v2"),
  policy: ToolPolicy,
  verbs: UniqueBoxGrantVerbs,
  binaryDigest: Sha256Digest
}) {}

/** Strictly decode an untrusted JSON value into a Box Grant. */
export const decodeBoxGrant = (input: unknown) =>
  Schema.decodeUnknownEffect(BoxGrant, { onExcessProperty: "error" })(input)

const lexical = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

const encodeBoxGrant = Schema.encodeSync(BoxGrant)

/**
 * Hash decoded semantic content, not input JSON spelling, object-key order, or
 * the order the verbs were listed in. The returned digest uses the same
 * `sha256:<64 lowercase hex>` wire format as the binary pin.
 */
export const hashBoxGrant = (
  grant: BoxGrant
): Effect.Effect<Sha256Digest, DigestUnavailable, Crypto.Crypto> => {
  const encoded = encodeBoxGrant(grant)
  return sha256Canonical({ ...encoded, verbs: [...encoded.verbs].sort(lexical) })
}

/** Decode first, then hash only the accepted semantic document. */
export const decodeAndHashBoxGrant = (input: unknown) =>
  decodeBoxGrant(input).pipe(
    Effect.flatMap((grant) =>
      Effect.map(hashBoxGrant(grant), (digest) => ({ grant, digest })))
  )
