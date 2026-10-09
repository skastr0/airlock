import { type Effect, Result, Schema } from "effect"
import { canonicalJson, Sha256Digest } from "../Canonical.ts"
import { Right } from "../plan/Plan.ts"
import { ResourceKind } from "./Resource.ts"
import type { ToolContract } from "./ToolContract.ts"

/** Public, bounded evidence that a host can rebind in another process. */
export const ResourceBinding = Schema.Struct({
  field: Schema.String,
  index: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  kind: ResourceKind,
  rights: Schema.NonEmptyArray(Right),
  selector: Schema.String,
  identity: Schema.Json.check(Schema.makeFilter((identity) =>
    new TextEncoder().encode(canonicalJson(identity)).byteLength <= 8_192 || "resource identity exceeds 8192 bytes"
  ))
})
export type ResourceBinding = typeof ResourceBinding.Type

/** A binding's private capability belongs to the host and is never stored. */
export interface BoundResource<Capability = unknown> {
  readonly binding: ResourceBinding
  readonly capability: Capability
}

/** Policy selectors resolved once at load, including physical path roots. */
export interface BoundScope<Capability = unknown> {
  readonly kind: ResourceKind
  readonly capability: Capability
}

export class ResourceRefused extends Schema.TaggedError<ResourceRefused>()("ResourceRefused", {
  field: Schema.String,
  reason: Schema.String
}) {}

export interface ResourceBindRequest {
  readonly kind: ResourceKind
  readonly selector: string
  readonly rights: ResourceBinding["rights"]
  readonly field: string
  readonly index?: number
  /** Only executable descendants: the independently bound root, never a workspace base. */
  readonly parent?: BoundResource
}

/**
 * Physical meaning is host-owned. The same BoundResource is checked against
 * ceiling and per-tool narrowing, then consumed by the implementation.
 */
export interface ResourceResolver {
  readonly kinds: ReadonlyArray<ResourceKind>
  readonly scope: (request: {
    readonly kind: ResourceKind
    readonly selectors: ReadonlyArray<string>
  }) => Effect.Effect<BoundScope, ResourceRefused>
  readonly bind: (request: ResourceBindRequest) => Effect.Effect<BoundResource, ResourceRefused>
  readonly within: (resource: BoundResource, scope: BoundScope) => boolean
  readonly rebind: (request: {
    readonly binding: ResourceBinding
    readonly parent?: BoundResource
  }) => Effect.Effect<BoundResource, ResourceRefused>
}

export const GrantWhen = Schema.Literals(["now", "approved"])
export type GrantWhen = typeof GrantWhen.Type

/** The host validates its own parameter schema and confinement capability. */
export const HostParameters = Schema.Record(Schema.String, Schema.Json)
export type HostParameters = typeof HostParameters.Type

export interface HostGrant {
  readonly tool: string
  readonly when: GrantWhen
  readonly host?: HostParameters
}

export class HostGrantRefused extends Schema.TaggedError<HostGrantRefused>()("HostGrantRefused", {
  tool: Schema.String,
  reason: Schema.String
}) {}

/** Stable public reference; before-images and host handles stay private. */
export const HeldReference = Schema.Struct({
  callId: Schema.String,
  recoveryId: Schema.String,
  /** Independent of grant expiry: after this the host may reap the held images. */
  heldUntil: Schema.DateTimeUtcFromString
})
export type HeldReference = typeof HeldReference.Type

export const RecoveryCall = Schema.Struct({
  callId: Schema.String,
  runId: Schema.String,
  tool: Schema.String,
  version: Schema.String,
  inputDigest: Sha256Digest,
  resources: Schema.Array(ResourceBinding),
  host: HostParameters
})
export type RecoveryCall = typeof RecoveryCall.Type

export const RecoveryInspection = Schema.Union([
  Schema.Struct({ state: Schema.Literal("prepared"), reference: HeldReference }),
  Schema.Struct({ state: Schema.Literal("done"), reference: HeldReference }),
  Schema.Struct({ state: Schema.Literal("refused"), reference: HeldReference, reason: Schema.String }),
  Schema.Struct({ state: Schema.Literal("uncertain"), reference: HeldReference, reason: Schema.String }),
  Schema.Struct({ state: Schema.Literal("no-longer-held"), reference: HeldReference })
])
export type RecoveryInspection = typeof RecoveryInspection.Type

export const RecoveryRestoration = Schema.Union([
  Schema.Struct({ state: Schema.Literal("restored"), reference: HeldReference }),
  Schema.Struct({ state: Schema.Literal("no-longer-held"), reference: HeldReference }),
  Schema.Struct({ state: Schema.Literal("conflict"), reference: HeldReference, reason: Schema.String }),
  Schema.Struct({ state: Schema.Literal("uncertain"), reference: HeldReference, reason: Schema.String })
])
export type RecoveryRestoration = typeof RecoveryRestoration.Type

export class RecoveryFailed extends Schema.TaggedError<RecoveryFailed>()("RecoveryFailed", {
  callId: Schema.String,
  reason: Schema.String
}) {}

/**
 * A reference owns ordered acts. Claim exact call content durably before any
 * forward act, never retry an uncertain act, and check installed state before
 * restoring. Recovery does not consult the expired forward grant.
 */
export interface HostRecovery {
  readonly prepare: (call: RecoveryCall) => Effect.Effect<HeldReference, RecoveryFailed>
  readonly inspect: (reference: HeldReference) => Effect.Effect<RecoveryInspection, RecoveryFailed>
  readonly restore: (reference: HeldReference) => Effect.Effect<RecoveryRestoration, RecoveryFailed>
}

export interface ToolHost {
  readonly resources: ResourceResolver
  /** Pure at policy load; no profile ranking or platform fallback in the kernel. */
  readonly validateGrant: (request: {
    readonly contract: ToolContract.Any
    readonly grant: HostGrant
  }) => Result.Result<void, HostGrantRefused>
  readonly recovery?: HostRecovery
  /** Opaque body ids are resolved to content digests before a request is staged. */
  readonly wireBodyDigest?: (artifactId: string) => Effect.Effect<Sha256Digest, ResourceRefused>
}
