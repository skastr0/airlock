import { Context, type Effect, Schema } from "effect"
import type { GuestSurface } from "../airlock/Airlock.ts"

/**
 * Runs an untrusted Airlock program (.air) against a guest surface. The
 * program can do one thing to the world: call the tools that surface grants.
 * The language has no other effect, so a run needs no isolate and is the same
 * on every host.
 */

/** Bounds on one run. Every one fails the run closed when it is passed. */
export const GuestLimits = Schema.Struct({
  /** UTF-8 bytes of program source. */
  maxCodeBytes: Schema.Int,
  /** Tool calls the program may attempt. */
  maxToolCalls: Schema.Int,
  /** UTF-8 bytes of one tool call's JSON input. */
  maxToolInputBytes: Schema.Int,
  /** UTF-8 bytes of one tool call's JSON result as handed back to the program. */
  maxToolResultBytes: Schema.Int,
  /** UTF-8 bytes of the run's JSON result. */
  maxOutputBytes: Schema.Int,
  /** Nesting depth of any value crossing the boundary. */
  maxDepth: Schema.Int,
  /** Total nodes of any value crossing the boundary, and of any value the program builds. */
  maxNodes: Schema.Int,
  /** Loop iterations across the whole run; the language has no other way to repeat. */
  maxLoopIterations: Schema.Int,
  /** Wall-clock milliseconds before the run is stopped and can call nothing more. */
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
  maxLoopIterations: 1_000,
  wallTimeMs: 30_000
}

/**
 * Why a run did not produce a result. The set is fixed: text a program wrote
 * (an assert's message, a name it used) never becomes part of a failure, so a
 * failure cannot be used as an output channel.
 */
export const GuestFailureReason = Schema.Literals([
  "invalid_code",
  "tool_call_limit",
  "tool_input_limit",
  "tool_input_invalid",
  "tool_result_limit",
  "tool_refused",
  "output_limit",
  "loop_limit",
  "value_limit",
  "assert_failed",
  "timeout",
  "aborted",
  "execution_failed"
])
export type GuestFailureReason = typeof GuestFailureReason.Type

/** What the program did wrong when the reason is `execution_failed`, as a fixed word. */
export const GuestFault = Schema.Literals([
  "unbound-name",
  "invalid-operation",
  "invalid-call",
  "missing-field",
  "invalid-index",
  "duplicate-field"
])
export type GuestFault = typeof GuestFault.Type

/**
 * A tool call Airlock refused. A refusal ends the run: the language has no way
 * to catch it. The message is Airlock's own sentence naming the tool, the
 * field and the grant.
 */
export const GuestRefusal = Schema.Struct({
  tool: Schema.String,
  code: Schema.String,
  message: Schema.String
})
export type GuestRefusal = typeof GuestRefusal.Type

/** How a run ended. `toolCalls` counts every call attempted, refused ones included. */
export const GuestOutcome = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Json, toolCalls: Schema.Int }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: GuestFailureReason,
    toolCalls: Schema.Int,
    /** Where in the source the program stopped, when the failure has a place. */
    at: Schema.optionalKey(Schema.Struct({ line: Schema.Int, column: Schema.Int })),
    fault: Schema.optionalKey(GuestFault),
    refusal: Schema.optionalKey(GuestRefusal)
  })
])
export type GuestOutcome = typeof GuestOutcome.Type

export interface GuestRun {
  /** Airlock program source. Its result is what it returns, or null. */
  readonly source: string
  readonly surface: GuestSurface
  /**
   * Names the host binds for this run, as plain JSON. The program reads them
   * like any name; each is a copy, bounded like a tool's result, and grants
   * nothing.
   */
  readonly bindings?: { readonly [name: string]: unknown }
  readonly limits?: Partial<GuestLimits>
  readonly signal?: AbortSignal
}

/**
 * A run always ends in an outcome; it does not fail. Whatever the program
 * does, the caller gets a bounded result or one of the fixed reasons.
 */
export class GuestRunner extends Context.Service<
  GuestRunner,
  { readonly run: (run: GuestRun) => Effect.Effect<GuestOutcome> }
>()("airlock/core/GuestRunner") {}
