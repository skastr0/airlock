import { type Effect, Schema } from "effect"
import type { IntentKind, IntentKinds } from "./Intent.ts"
import type { DispatchPermit } from "./Outbox.ts"

/** What a handler returns for a dispatch that completed. */
export interface Delivery<Outcome> {
  readonly outcome: Outcome
  /** At most `responseLimitBytes`; more is a contract violation. */
  readonly response: Uint8Array
  /** True when the far side sent more than the limit allowed. */
  readonly truncated: boolean
}

/**
 * Any failure once a permit exists. The kernel records the emission as
 * uncertain and never retries, because the wire may have been reached.
 */
export class DispatchFailed extends Schema.TaggedError<DispatchFailed>()("DispatchFailed", {
  reason: Schema.String
}) {}

/**
 * The handler proves the wire was never reached: the broker rejected the
 * request before executing it, a connection that must exist does not, the
 * permit was not live. The kernel records the emission as `refused`.
 *
 * The burden of proof is on the handler. Returning this when the far side may
 * have seen the request is a bug that turns a possible duplicate send into a
 * claim that nothing happened; when in doubt, fail with `DispatchFailed`.
 * `reason` is stored and shown: it must carry no dispatch values.
 */
export class DispatchRefused extends Schema.TaggedError<DispatchRefused>()("DispatchRefused", {
  reason: Schema.String
}) {}

export interface DispatchRequest<Tag extends string, Dispatch> {
  readonly permit: DispatchPermit<Tag>
  readonly dispatch: Dispatch
  /** The handler must retain no more than this many response bytes. */
  readonly responseLimitBytes: number
}

/**
 * The wire, as a total record of handlers over the intent kinds: one handler
 * per kind, and a missing or extra key is a compile error.
 */
export type DispatchHandlers<Kinds extends IntentKinds> = {
  readonly [Tag in keyof Kinds & string]: (
    request: DispatchRequest<Tag, IntentKind.DispatchOf<Kinds[Tag]>>
  ) => Effect.Effect<Delivery<IntentKind.OutcomeOf<Kinds[Tag]>>, DispatchFailed | DispatchRefused>
}
