import { Effect, Schema } from "effect"
import { BoxGrantSha256 } from "../admission/BoxGrant.ts"

/** The complete request vocabulary. There is intentionally one fixed query. */
export class DaemonHealthRequest extends Schema.Class<DaemonHealthRequest>(
  "DaemonHealthRequest"
)({
  request: Schema.Literal("health")
}) {}

/** Health proves which sealed authority is alive; it conveys no authority. */
export class DaemonHealthResponse extends Schema.Class<DaemonHealthResponse>(
  "DaemonHealthResponse"
)({
  grantDigest: BoxGrantSha256,
  ready: Schema.Boolean
}) {}

export interface DaemonHealthState {
  readonly grantDigest: BoxGrantSha256
  readonly ready: boolean
}

export class DaemonProtocolRejected
  extends Schema.TaggedError<DaemonProtocolRejected>()(
    "DaemonProtocolRejected",
    {
      direction: Schema.Literal("request", "response"),
      reason: Schema.Literal("invalid-message")
    }
  ) {}

export class DaemonHealthCheckFailed
  extends Schema.TaggedError<DaemonHealthCheckFailed>()(
    "DaemonHealthCheckFailed",
    {
      reason: Schema.Literal("not-ready", "grant-digest-mismatch"),
      expectedGrantDigest: BoxGrantSha256,
      actualGrantDigest: BoxGrantSha256
    }
  ) {}

const decodeHealthRequest = Schema.decodeUnknown(DaemonHealthRequest, {
  onExcessProperty: "error"
})
const decodeHealthResponse = Schema.decodeUnknown(DaemonHealthResponse, {
  onExcessProperty: "error"
})

/** Strict decoders are exported so stream framing glue cannot loosen them. */
export const decodeDaemonHealthRequest = (input: unknown) =>
  decodeHealthRequest(input).pipe(
    Effect.mapError(() => new DaemonProtocolRejected({
      direction: "request",
      reason: "invalid-message"
    }))
  )

export const decodeDaemonHealthResponse = (input: unknown) =>
  decodeHealthResponse(input).pipe(
    Effect.mapError(() => new DaemonProtocolRejected({
      direction: "response",
      reason: "invalid-message"
    }))
  )

/**
 * Pure in-process server handler. Socket path ownership, framing, and launchd
 * descriptors stay in integration glue; this boundary can answer only health.
 */
export const handleDaemonRequest = (
  input: unknown,
  state: DaemonHealthState
): Effect.Effect<DaemonHealthResponse, DaemonProtocolRejected> =>
  decodeDaemonHealthRequest(input).pipe(
    Effect.as(new DaemonHealthResponse({
      grantDigest: state.grantDigest,
      ready: state.ready
    }))
  )

/**
 * Validate a response from the agent side. A mismatch is a refusal, never a
 * reason to execute the requested work in the local process.
 */
export const requireDaemonHealth = (
  input: unknown,
  expectedGrantDigest: BoxGrantSha256
): Effect.Effect<
  DaemonHealthResponse,
  DaemonProtocolRejected | DaemonHealthCheckFailed
> =>
  decodeDaemonHealthResponse(input).pipe(
    Effect.flatMap((response) => {
      if (response.grantDigest !== expectedGrantDigest) {
        return Effect.fail(new DaemonHealthCheckFailed({
          reason: "grant-digest-mismatch",
          expectedGrantDigest,
          actualGrantDigest: response.grantDigest
        }))
      }
      if (!response.ready) {
        return Effect.fail(new DaemonHealthCheckFailed({
          reason: "not-ready",
          expectedGrantDigest,
          actualGrantDigest: response.grantDigest
        }))
      }
      return Effect.succeed(response)
    })
  )

/** Transport is request/response only; it owns no terminal fallback callback. */
export interface DaemonHealthTransport<E, R = never> {
  readonly request: (
    request: DaemonHealthRequest
  ) => Effect.Effect<unknown, E, R>
}

/** Send the single fixed query and require a ready daemon under the same seal. */
export const checkDaemonLiveness = <E, R>(
  transport: DaemonHealthTransport<E, R>,
  expectedGrantDigest: BoxGrantSha256
): Effect.Effect<
  DaemonHealthResponse,
  E | DaemonProtocolRejected | DaemonHealthCheckFailed,
  R
> =>
  transport.request(new DaemonHealthRequest({ request: "health" })).pipe(
    Effect.flatMap((response) =>
      requireDaemonHealth(response, expectedGrantDigest)
    )
  )
