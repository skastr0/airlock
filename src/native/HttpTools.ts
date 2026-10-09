import { Effect, Schema } from "effect"
import { type Refused, refused } from "../core/airlock/Implement.ts"
import type { ToolContract } from "../core/contract/ToolContract.ts"
import type { WireToken } from "../core/outbox/Outbox.ts"
import { sendHttp } from "../host/HttpDispatcher.ts"
import { ArtifactId, type ArtifactStore, artifactsOf } from "./Artifacts.ts"
import type { HttpGet, HttpStage } from "./HttpContracts.ts"

/**
 * The local implementations of `http.get` and `http.stage`. Neither builds a
 * request: the contract declares it, the kernel binds it to the call's wire
 * token, and the host's one wire function sends exactly that. What is left
 * here is shaping the response. When each runs is the kernel's business: a
 * get when it is called, a staged request only once a person has committed it.
 */

/** The call's wire token, from the kernel. */
export interface HttpToolContext {
  readonly wireToken: WireToken
}

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
  readonly artifacts: ArtifactStore
}) => {
  const artifacts = artifactsOf(services.artifacts)
  const isArtifactId = Schema.is(ArtifactId)
  /** A request the wire refused was not sent; one that failed in transit may have been. */
  const send = <Output>(
    tool: string,
    context: HttpToolContext,
    shape: (delivery: Effect.Success<ReturnType<typeof sendHttp>>) => Effect.Effect<Output, unknown>
  ): Effect.Effect<Output | Refused, unknown> =>
    Effect.matchEffect(
      sendHttp(
        context.wireToken,
        services.responseLimitBytes,
        (id) => isArtifactId(id) ? services.artifacts.read(id) : Effect.fail("an artifact is named by its digest")
      ),
      {
        onFailure: (error): Effect.Effect<Output | Refused, unknown> =>
          error._tag === "DispatchRefused"
            ? Effect.succeed(refused(`${tool} sent nothing: ${error.reason}`))
            : Effect.fail(error),
        onSuccess: shape
      }
    )
  return {
    "http.get": (
      _input: ToolContract.ShapeOf<typeof HttpGet>["input"],
      context: HttpToolContext
    ): Effect.Effect<ToolContract.OutputOf<typeof HttpGet> | Refused, unknown> =>
      send("http.get", context, (delivery) =>
        Effect.succeed({
          status: delivery.outcome.status,
          content_type: delivery.outcome.contentType ?? null,
          bytes: delivery.response.byteLength,
          truncated: delivery.truncated,
          body: delivery.truncated ? null : text(delivery.response)
        })),
    "http.stage": (
      _input: ToolContract.ShapeOf<typeof HttpStage>["input"],
      context: HttpToolContext
    ): Effect.Effect<ToolContract.OutputOf<typeof HttpStage> | Refused, unknown> =>
      send("http.stage", context, (delivery) => Effect.gen(function* () {
        const kept = delivery.response.byteLength === 0
          ? null
          : yield* artifacts.keep(delivery.response, delivery.outcome.contentType ?? "application/octet-stream")
        return {
          status: delivery.outcome.status,
          content_type: delivery.outcome.contentType ?? null,
          bytes: delivery.response.byteLength,
          truncated: delivery.truncated,
          response_artifact: kept?.id ?? null
        }
      }))
  }
}
