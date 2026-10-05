import { type DigestUnavailable, sha256Canonical } from "../Canonical.ts"
import { type Crypto, Effect, Schema } from "effect"
import { NativeActionName } from "../actions/index.ts"
import { AdmissionPolicy } from "./Admission.ts"

/**
 * A Box Grant is supervisor-authored authority for one Airlock binary and one
 * pinned action catalog. It is data only: decoding this document does not wire
 * it into the CLI, runtime, Hold, Outbox, or daemon.
 */

/** The complete current `airlock` command graph, plus the reserved PR5 verb. */
export const BoxGrantVerb = Schema.Literals([
  "rm",
  "write",
  "undo",
  "held",
  "reap",
  "send",
  "pending",
  "commit",
  "cancel",
  "flush",
  "doctor",
  "capabilities",
  "actions",
  "schema",
  "exec",
  "run",
  "eval",
  "ledger",
  "runs",
  "run-receipt",
  "serve"
])
export type BoxGrantVerb = typeof BoxGrantVerb.Type

/** Privileged daemon operations. The program and tool planes cannot add one. */
export const BoxGrantDaemonOp = Schema.Literals([
  "commit",
  "reap",
  "flush",
  "hold-expiry"
])
export type BoxGrantDaemonOp = typeof BoxGrantDaemonOp.Type

/** Digests are wire identities, never loose labels or platform path strings. */
export const BoxGrantSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/, {
    message: "must be sha256:<64 lowercase hex>"
  }))
)
export type BoxGrantSha256 = typeof BoxGrantSha256.Type

export class BoxGrantCatalogPin extends Schema.Class<BoxGrantCatalogPin>(
  "BoxGrantCatalogPin"
)({
  id: Schema.String,
  sha256: BoxGrantSha256
}) {}

const unique = <A>(
  values: ReadonlyArray<A>,
  identity: (value: A) => string,
  description: string
) => {
  const identities = values.map(identity)
  return new Set(identities).size === identities.length ||
    `must not contain duplicate ${description}`
}

const UniqueBoxGrantVerbs = Schema.Array(BoxGrantVerb).pipe(
  Schema.check(Schema.makeFilter((verbs) => unique(verbs, (verb) => verb, "verbs")))
)
const UniqueNativeActions = Schema.Array(NativeActionName).pipe(
  Schema.check(Schema.makeFilter((actions) => unique(actions, (action) => action, "native actions")))
)
const UniqueCatalogPins = Schema.Array(BoxGrantCatalogPin).pipe(
  Schema.check(Schema.makeFilter((pins) => unique(pins, (pin) => pin.id, "catalog ids"))),
  Schema.check(Schema.makeFilter((pins) => unique(pins, (pin) => pin.sha256, "catalog hashes")))
)
const UniqueDaemonOps = Schema.Array(BoxGrantDaemonOp).pipe(
  Schema.check(Schema.makeFilter((operations) => unique(
    operations,
    (operation) => operation,
    "daemon operations"
  )))
)

/**
 * Strict `airlock/box-grant/v1` supervisor document. All arrays have set
 * semantics and therefore reject repeated identities instead of silently
 * normalizing them. `catalog` is required even when the pinned set is empty.
 */
export class BoxGrant extends Schema.Class<BoxGrant>("BoxGrant")({
  schemaVersion: Schema.Literal("airlock/box-grant/v1"),
  admission: AdmissionPolicy,
  verbs: UniqueBoxGrantVerbs,
  nativeActions: UniqueNativeActions,
  catalog: UniqueCatalogPins,
  daemonOps: UniqueDaemonOps,
  binaryDigest: BoxGrantSha256
}) {}

/** Strictly decode an untrusted JSON value into a Box Grant. */
export const decodeBoxGrant = (input: unknown) =>
  Schema.decodeUnknownEffect(BoxGrant, { onExcessProperty: "error" })(input)

const lexical = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

const canonicalBoxGrantContent = (grant: BoxGrant) => ({
  ...grant,
  // These fields are decoded as mathematical sets. Their input order cannot
  // change the identity of the authority document.
  verbs: [...grant.verbs].sort(lexical),
  nativeActions: [...grant.nativeActions].sort(lexical),
  catalog: [...grant.catalog].sort((left, right) =>
    lexical(left.id, right.id) || lexical(left.sha256, right.sha256)
  ),
  daemonOps: [...grant.daemonOps].sort(lexical)
})

/**
 * Hash decoded semantic content, not input JSON spelling, object-key order, or
 * the order used to spell one of the grant's set-valued fields. The returned
 * digest uses the same `sha256:<64 lowercase hex>` wire format as catalog and
 * binary pins.
 */
export const hashBoxGrant = (
  grant: BoxGrant
): Effect.Effect<BoxGrantSha256, DigestUnavailable, Crypto.Crypto> =>
  sha256Canonical(canonicalBoxGrantContent(grant))

/** Decode first, then hash only the accepted semantic document. */
export const decodeAndHashBoxGrant = (input: unknown) =>
  decodeBoxGrant(input).pipe(
    Effect.flatMap((grant) =>
      Effect.map(hashBoxGrant(grant), (digest) => ({ grant, digest })))
  )
