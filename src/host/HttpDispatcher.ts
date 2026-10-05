import { Effect } from "effect"
import {
  type Delivery,
  DispatchFailed,
  type DispatchRequest,
  type HttpDispatch,
  type HttpOutcome,
  isLivePermit
} from "../core/index.ts"

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
 * The wire: this host's handler for the `http` intent kind, and the only
 * place in Airlock that calls the network.
 *
 * It acts only on a permit the kernel minted after the emission durably
 * became `committing` and has not yet settled; a forged, replayed or settled
 * permit is refused before any request is built. Redirects are never
 * followed: the staged target is the only address a dispatch may reach.
 */
export const dispatchHttp = Effect.fn("HttpDispatcher.dispatch")(function* (
  request: DispatchRequest<"http", HttpDispatch>
): Effect.fn.Return<Delivery<HttpOutcome>, DispatchFailed> {
  if (!isLivePermit(request.permit)) {
    return yield* new DispatchFailed({ reason: "dispatch permit is not live" })
  }
  const { dispatch, responseLimitBytes } = request
  return yield* Effect.tryPromise({
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
})
