import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import {
  Canonical,
  consumePermit,
  type Delivery,
  DispatchFailed,
  DispatchRefused,
  type DispatchRequest,
  HttpDispatch,
  type HttpOutcome,
  isLivePermit
} from "../core/index.ts"
import { HttpMethod } from "../core/outbox/HttpIntent.ts"
import { takeWireRequest, type WireToken } from "../core/outbox/Outbox.ts"

/**
 * Reads at most `limit` bytes of a response and then cancels it. The body is
 * attacker-controlled content: it is never buffered unbounded, and reaching
 * the bound is reported rather than hidden.
 */
const readBounded = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  if (body === null) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  let truncated = false
  try {
    while (total <= limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      chunks.push(value)
      total += value.byteLength
      if (total > limit) {
        truncated = true
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const retained = Math.min(total, limit)
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= retained) break
    const take = Math.min(chunk.byteLength, retained - offset)
    bytes.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return { bytes, truncated }
}

/**
 * This file is the only place in Airlock that calls the network. This is the
 * handler for the `http` intent kind.
 *
 * It acts only on a permit the kernel minted after the emission durably
 * became `committing` and has not yet settled; a forged, replayed or settled
 * permit is refused before any request is built. Redirects are never
 * followed: the staged target is the only address a dispatch may reach.
 */
export const dispatchHttp = Effect.fn("HttpDispatcher.dispatch")(function* (
  request: DispatchRequest<"http", HttpDispatch>
): Effect.fn.Return<Delivery<HttpOutcome>, DispatchFailed | DispatchRefused> {
  if (!isLivePermit(request.permit)) {
    return yield* new DispatchRefused({ reason: "dispatch permit is not live" })
  }
  // Encode and detach before consuming: the bytes checked against the permit
  // must be the same bytes the request below uses, even if the caller mutates.
  const { dispatch, canonical } = yield* Effect.try({
    try: () => {
      const canonical = Canonical.canonicalJson(Schema.encodeSync(HttpDispatch)(request.dispatch))
      return {
        canonical,
        dispatch: Schema.decodeUnknownSync(Schema.fromJsonString(HttpDispatch))(canonical)
      }
    },
    catch: () => new DispatchRefused({ reason: "dispatch does not match the HTTP contract" })
  })
  if (!consumePermit(request.permit, "http", canonical)) {
    return yield* new DispatchRefused({ reason: "dispatch permit does not authorize this request" })
  }
  return yield* onWire(dispatch, request.responseLimitBytes)
})

/**
 * The wire for a tool implementation. It is handed nothing to send: the
 * kernel evaluated the contract's own declaration on the admitted input,
 * bound the result to the call's wire token, and this takes it out, once,
 * while the call is live. The address is the endpoint admission bound.
 *
 * A body that is an artifact is read here, from the host's store, and sent
 * only if its bytes hash to the digest the request was approved with. The
 * digest covers the bytes that leave: no body is decoded and re-encoded.
 */
export const sendHttp = Effect.fn("HttpDispatcher.send")(function* (
  token: WireToken,
  responseLimitBytes: number,
  readArtifact: (id: string) => Effect.Effect<Uint8Array, unknown>
): Effect.fn.Return<Delivery<HttpOutcome>, DispatchFailed | DispatchRefused> {
  const request = takeWireRequest(token)
  if (request === undefined) {
    return yield* new DispatchRefused({ reason: "wire token is not live or carries no request" })
  }
  if (request.endpoint.binding.kind !== "endpoint" || !isHttpMethod(request.method)) {
    return yield* new DispatchRefused({ reason: "the admitted request is not an HTTP request to an endpoint" })
  }
  // A text body is encoded here, once. A string that is not well-formed
  // UTF-16 has no exact encoding (it would be silently repaired), so it is
  // refused rather than altered.
  if (request.body !== undefined && loneSurrogate.test(request.body)) {
    return yield* new DispatchRefused({ reason: "the body text cannot be encoded exactly" })
  }
  let body: Uint8Array | undefined = request.body === undefined ? undefined : new TextEncoder().encode(request.body)
  if (request.bodyArtifact !== undefined) {
    const bytes = yield* readArtifact(request.bodyArtifact).pipe(
      Effect.mapError(() => new DispatchRefused({ reason: "the body artifact could not be read" }))
    )
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    if (request.bodyArtifactDigest === undefined || digest !== request.bodyArtifactDigest) {
      return yield* new DispatchRefused({ reason: "the body artifact is not the content that was approved" })
    }
    // Never decoded and re-encoded on the way out: the bytes that were just
    // verified are the bytes that leave, whatever they are.
    body = bytes
  }
  return yield* onWire(
    {
      url: request.endpoint.binding.selector,
      method: request.method,
      headers: { ...request.headers },
      ...(body === undefined ? {} : { body })
    },
    responseLimitBytes
  )
})

const isHttpMethod = Schema.is(HttpMethod)
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Not exported, and reached only from the two functions above, each after
 * its authority check. Redirects are never followed.
 */
const onWire = (
  // A string body is the stored intent's; a tool call's body arrives as the exact bytes to send.
  dispatch: Omit<HttpDispatch, "body"> & { readonly body?: string | Uint8Array },
  responseLimitBytes: number
): Effect.Effect<Delivery<HttpOutcome>, DispatchFailed> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(dispatch.url, {
        method: dispatch.method,
        headers: dispatch.headers,
        redirect: "manual",
        signal,
        ...(dispatch.body === undefined ? {} : { body: dispatch.body })
      })
      const captured = await readBounded(response.body, responseLimitBytes)
      const contentType = response.headers.get("content-type")
      return {
        outcome: {
          status: response.status,
          ...(contentType === null ? {} : { contentType })
        },
        response: captured.bytes,
        truncated: captured.truncated
      }
    },
    // The cause may quote the URL, which can carry credentials.
    catch: (cause) =>
      new DispatchFailed({
        reason: cause instanceof Error ? cause.name : "transport-failed"
      })
  })
