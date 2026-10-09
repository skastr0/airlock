import { type Crypto, Effect, Result, Schema } from "effect"
import { canonicalJson, type DigestUnavailable, Sha256Digest, sha256Canonical } from "../Canonical.ts"
import { type BoundResource, ResourceBinding, ResourceRefused, type ToolHost } from "./ToolHost.ts"
import type { ToolContract } from "./ToolContract.ts"

/** A pure declaration over admitted input, never a request supplied by an implementation. */
export const WireSpec = Schema.Struct({
  endpoint: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optionalKey(Schema.String),
  bodyArtifact: Schema.optionalKey(Schema.String)
})
export type WireSpec = typeof WireSpec.Type

/** Public proof of the exact private request; header values and body text stay sealed. */
export const WireAuthority = Schema.Struct({
  digest: Sha256Digest,
  bodyArtifactDigest: Schema.optionalKey(Sha256Digest)
})
export type WireAuthority = typeof WireAuthority.Type

export interface WireMaterial {
  readonly endpoint: ResourceBinding
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly bodyArtifact?: string
  readonly bodyArtifactDigest?: Sha256Digest
}
export interface WireRequest extends Omit<WireMaterial, "endpoint"> { readonly endpoint: BoundResource }

const reject = (reason: string) => new ResourceRefused({ field: "wire", reason })

/** Snapshot and normalize the declaration, with an exact admitted scalar endpoint. */
export const describeWire = (contract: ToolContract.Any, input: unknown,
  resources: ReadonlyArray<ResourceBinding>, artifactDigest?: Sha256Digest
): Result.Result<WireMaterial | undefined, ResourceRefused> => {
  if (contract.wire === undefined) return artifactDigest === undefined ? Result.succeed(undefined) : Result.fail(reject("unexpected artifact wire authority"))
  try {
    const parsed = Schema.decodeUnknownResult(WireSpec, { onExcessProperty: "error" })(contract.wire(input))
    if (Result.isFailure(parsed)) return Result.fail(reject("wire declaration returned an invalid request"))
    const spec = parsed.success
    if (!/^[A-Z]+$/.test(spec.method) || (spec.body !== undefined && spec.bodyArtifact !== undefined) ||
      ((spec.method === "GET" || spec.method === "HEAD") && (spec.body !== undefined || spec.bodyArtifact !== undefined))) {
      return Result.fail(reject("wire method or body combination is invalid"))
    }
    const descriptor = Object.hasOwn(contract.resources, spec.endpoint) ? contract.resources[spec.endpoint] : undefined
    const endpoints = resources.filter((binding) => binding.field === spec.endpoint)
    if (descriptor?.kind !== "endpoint" || descriptor.collection !== undefined || endpoints.length !== 1 || endpoints[0]!.kind !== "endpoint") {
      return Result.fail(reject("wire endpoint must name one admitted scalar endpoint operand"))
    }
    if ((spec.bodyArtifact === undefined) !== (artifactDigest === undefined)) {
      return Result.fail(reject("artifact request lacks its exact staged content digest"))
    }
    const headers: Record<string, string> = Object.create(null)
    for (const [name, value] of Object.entries(spec.headers)) {
      const normalized = name.toLowerCase()
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) || /[\r\n\u0000]/.test(value) || Object.hasOwn(headers, normalized)) {
        return Result.fail(reject("wire headers contain invalid or repeated names or values"))
      }
      headers[normalized] = value.trim()
    }
    const endpoint = Schema.decodeUnknownSync(ResourceBinding, { onExcessProperty: "error" })(endpoints[0])
    const identity = JSON.parse(canonicalJson(endpoint.identity)) as Schema.Json
    const freeze = (value: unknown): void => {
      if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
    }
    const material: WireMaterial = { endpoint: { ...endpoint, rights: [...endpoint.rights] as ResourceBinding["rights"], identity },
      method: spec.method, headers, ...(spec.body === undefined ? {} : { body: spec.body }),
      ...(spec.bodyArtifact === undefined ? {} : { bodyArtifact: spec.bodyArtifact, bodyArtifactDigest: artifactDigest! }) }
    freeze(material)
    return Result.succeed(material)
  } catch { return Result.fail(reject("wire declaration failed")) }
}

/** At staging, an opaque artifact id needs its host's content digest. */
export const prepareWire = (contract: ToolContract.Any, input: unknown, resources: ReadonlyArray<ResourceBinding>, host: ToolHost):
  Effect.Effect<WireAuthority | undefined, ResourceRefused | DigestUnavailable, Crypto.Crypto> => Effect.gen(function* () {
  if (contract.wire === undefined) return undefined
  const declared = yield* Effect.try({ try: () => Schema.decodeUnknownSync(WireSpec, { onExcessProperty: "error" })(contract.wire!(input)), catch: () => reject("wire declaration failed") })
  let artifactDigest: Sha256Digest | undefined
  if (declared.bodyArtifact !== undefined) {
    const id = declared.bodyArtifact
    const addressed = Schema.decodeUnknownResult(Sha256Digest)(id)
    const digest = Result.isSuccess(addressed) ? addressed.success : host.wireBodyDigest === undefined
      ? yield* reject("opaque artifact bodies require a host content digest at staging") : yield* host.wireBodyDigest(id)
    artifactDigest = digest
  }
  const described = describeWire(contract, input, resources, artifactDigest)
  if (Result.isFailure(described)) return yield* described.failure
  if (described.success === undefined) return yield* reject("wire declaration disappeared during staging")
  const digest = yield* sha256Canonical(described.success)
  return { digest, ...(artifactDigest === undefined ? {} : { bodyArtifactDigest: artifactDigest }) }
})
