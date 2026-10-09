import { Effect, Schema } from "effect"
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
import type { BoundResource } from "../core/contract/ToolHost.ts"
import { consumeWireToken, type WireToken } from "../core/outbox/Outbox.ts"

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
 * The wire for a tool implementation. The kernel mints a wire token when it
 * hands an admitted call to its implementation; the token is good for one
 * request and only while that call is live. Without it nothing is sent.
 *
 * The address is not a string the implementation chooses: it is the endpoint
 * resource admission bound and matched against the grant for this call.
 */
export const sendHttp = Effect.fn("HttpDispatcher.send")(function* (
  token: WireToken,
  endpoint: BoundResource,
  request: Omit<HttpDispatch, "url">,
  responseLimitBytes: number
): Effect.fn.Return<Delivery<HttpOutcome>, DispatchFailed | DispatchRefused> {
  if (endpoint.binding.kind !== "endpoint") {
    return yield* new DispatchRefused({ reason: "the bound resource is not an endpoint" })
  }
  if (!consumeWireToken(token)) {
    return yield* new DispatchRefused({ reason: "wire token is not live" })
  }
  return yield* onWire({ ...request, url: endpoint.binding.selector }, responseLimitBytes)
})

/**
 * Not exported, and reached only from the two functions above, each after
 * its authority check. Redirects are never followed.
 */
const onWire = (
  dispatch: HttpDispatch,
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
