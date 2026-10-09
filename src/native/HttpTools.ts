import { Effect } from "effect"
import { type Refused, refused } from "../core/airlock/Implement.ts"
import type { ToolContract } from "../core/contract/ToolContract.ts"
import type { BoundResource } from "../core/contract/ToolHost.ts"
import type { WireToken } from "../core/outbox/Outbox.ts"
import { sendHttp } from "../host/HttpDispatcher.ts"
import type { HttpGet, HttpStage } from "./HttpContracts.ts"

/**
 * The local implementations of `http.get` and `http.stage`. Both reach the
 * network through the host's one wire function, with the wire token of the
 * call they are answering. When each runs is the kernel's business: a get
 * when it is called, a staged request only once a person has committed it.
 */

/** The call's wire token and its admitted resources, from the kernel. */
export interface HttpToolContext {
  readonly wireToken: WireToken
  readonly resources: ReadonlyArray<BoundResource>
}

const endpointOf = (context: HttpToolContext) =>
  context.resources.find((resource) => resource.binding.field === "endpoint")

type Kept = { readonly id: string }

const text = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export const httpTools = (services: {
  /** Response bytes kept beyond this are dropped and reported as truncated. */
  readonly responseLimitBytes: number
  readonly artifact: (id: string) => Effect.Effect<Uint8Array, unknown>
  /** Keeps bytes as an artifact of this run. */
  readonly keep: (bytes: Uint8Array, mediaType: string) => Effect.Effect<Kept, unknown>
}) => ({
  "http.get": (
    input: ToolContract.ShapeOf<typeof HttpGet>["input"],
    context: HttpToolContext
  ): Effect.Effect<ToolContract.OutputOf<typeof HttpGet> | Refused, unknown> => {
    const endpoint = endpointOf(context)
    if (endpoint === undefined) return Effect.succeed(refused("http.get asked nothing: the call has no admitted endpoint"))
    return sendHttp(context.wireToken, endpoint, { method: "GET", headers: { accept: input.accept } }, services.responseLimitBytes).pipe(
      Effect.map((delivery) => ({
        status: delivery.outcome.status,
        content_type: delivery.outcome.contentType ?? null,
        bytes: delivery.response.byteLength,
        truncated: delivery.truncated,
        body: delivery.truncated ? null : text(delivery.response)
      }))
    )
  },
  "http.stage": (
    input: ToolContract.ShapeOf<typeof HttpStage>["input"],
    context: HttpToolContext
  ): Effect.Effect<ToolContract.OutputOf<typeof HttpStage> | Refused, unknown> =>
    Effect.gen(function* () {
      const endpoint = endpointOf(context)
      if (endpoint === undefined) return refused("http.stage sent nothing: the call has no admitted endpoint")
      let body = input.body
      if (input.bodyArtifact !== undefined) {
        const decoded = text(yield* services.artifact(input.bodyArtifact))
        // Refused before the token is used: nothing was sent.
        if (decoded === null) return refused("http.stage sent nothing: the body artifact is not text")
        body = decoded
      }
      const delivery = yield* sendHttp(
        context.wireToken,
        endpoint,
        { method: input.method, headers: input.headers, ...(body === undefined ? {} : { body }) },
        services.responseLimitBytes
      )
      const kept = delivery.response.byteLength === 0
        ? null
        : yield* services.keep(delivery.response, delivery.outcome.contentType ?? "application/octet-stream")
      return {
        status: delivery.outcome.status,
        content_type: delivery.outcome.contentType ?? null,
        bytes: delivery.response.byteLength,
        truncated: delivery.truncated,
        response_artifact: kept?.id ?? null
      }
    })
})
