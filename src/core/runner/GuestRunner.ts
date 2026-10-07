import { Context, type Effect, Schema } from "effect"
import type { GuestSurface } from "../airlock/Airlock.ts"

/**
 * Runs untrusted guest code against a guest surface. The guest can do one
 * thing: call the tools that surface grants. This port says what a run is and
 * how it ends; an adapter supplies the isolation (a fresh Worker isolate on
 * Cloudflare, something else on another cloud).
 */

/** Bounds on one run. Every one fails the run closed when it is passed. */
export const GuestLimits = Schema.Struct({
  /** UTF-8 bytes of guest source. */
  maxCodeBytes: Schema.Int,
  /** Tool calls the guest may attempt, counted on both sides of the boundary. */
  maxToolCalls: Schema.Int,
  /** UTF-8 bytes of one tool call's JSON input. */
  maxToolInputBytes: Schema.Int,
  /** UTF-8 bytes of one tool call's JSON result as handed back to the guest. */
  maxToolResultBytes: Schema.Int,
  /** UTF-8 bytes of the run's JSON result. */
  maxOutputBytes: Schema.Int,
  /** Nesting depth and total nodes of any value crossing the boundary. */
  maxDepth: Schema.Int,
  maxNodes: Schema.Int,
  /** Wall-clock milliseconds before the host stops waiting and revokes the tools. */
  wallTimeMs: Schema.Int
})
export type GuestLimits = typeof GuestLimits.Type

export const defaultGuestLimits: GuestLimits = {
  maxCodeBytes: 16_384,
  maxToolCalls: 16,
  maxToolInputBytes: 8_192,
  maxToolResultBytes: 65_536,
  maxOutputBytes: 16_384,
  maxDepth: 16,
  maxNodes: 2_048,
  wallTimeMs: 30_000
}

/**
 * Why a run did not produce a result. The set is fixed: a guest's own error
 * text never crosses the boundary, so it cannot be used as an output channel.
 */
export const GuestFailureReason = Schema.Literals([
  "invalid_code",
  "tool_call_limit",
  "tool_input_limit",
  "tool_input_invalid",
  "tool_result_limit",
  "output_limit",
  "invalid_output",
  "timeout",
  "aborted",
  "execution_failed"
])
export type GuestFailureReason = typeof GuestFailureReason.Type

/** How a run ended. `toolCalls` is the host's count, not the guest's claim. */
export const GuestOutcome = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Json, toolCalls: Schema.Int }),
  Schema.Struct({ ok: Schema.Literal(false), reason: GuestFailureReason, toolCalls: Schema.Int })
])
export type GuestOutcome = typeof GuestOutcome.Type

export interface GuestRun {
  /** The body of an async function that receives `tools` and returns a JSON value. */
  readonly source: string
  readonly surface: GuestSurface
  readonly limits?: Partial<GuestLimits>
  readonly signal?: AbortSignal
}

/**
 * A run always ends in an outcome; it does not fail. Whatever the guest does,
 * the caller gets a bounded result or one of the fixed reasons.
 */
export class GuestRunner extends Context.Service<
  GuestRunner,
  { readonly run: (run: GuestRun) => Effect.Effect<GuestOutcome> }
>()("airlock/core/GuestRunner") {}
