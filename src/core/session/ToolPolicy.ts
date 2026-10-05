import { type Crypto, type Effect, Schema } from "effect"
import { type ToolGrantPolicy as Grant, ToolGrantPolicy } from "../admission/ToolGrant.ts"
import { type DigestUnavailable, type Sha256Digest, sha256Canonical } from "../Canonical.ts"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Everything a supervisor decides about one guest session, and nothing about
 * any host: which tools, under which conditions, within which budget. It is a
 * document, so it can be stored, sealed, and named by its digest.
 */
export class ToolPolicy extends Schema.Class<ToolPolicy>("ToolPolicy")({
  schemaVersion: Schema.tag("airlock/tool-policy/v1"),
  toolGrants: Schema.Array(ToolGrantPolicy),
  budget: Schema.Struct({
    maxCalls: Count,
    /** Total canonical input bytes across all calls of a session. */
    maxInputBytes: Count
  })
}) {}

/** A policy written in code keeps, in its type, which tools it grants. */
export type ToolPolicyFor<Granted extends string> = ToolPolicy & {
  readonly toolGrants: ReadonlyArray<Grant & { readonly tool: Granted }>
}

export const toolPolicy = <Granted extends string>(policy: {
  readonly toolGrants: ReadonlyArray<Grant & { readonly tool: Granted }>
  readonly budget: ToolPolicy["budget"]
}): ToolPolicyFor<Granted> =>
  // The class instance holds the same grants it was given; the type keeps their tool names.
  new ToolPolicy(policy) as ToolPolicyFor<Granted>

const encodePolicy = Schema.encodeSync(ToolPolicy)

/** The policy's identity: the digest of its canonical encoded form. */
export const toolPolicyDigest = (
  policy: ToolPolicy
): Effect.Effect<Sha256Digest, DigestUnavailable, Crypto.Crypto> => sha256Canonical(encodePolicy(policy))
