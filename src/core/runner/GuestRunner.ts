import { Context, type Effect, Schema } from "effect"
import type { GuestSurface } from "../airlock/Airlock.ts"
import { FlowExplanation } from "../review/Flow.ts"
import { ReviewedPlan, ReviewRefusal } from "../review/Review.ts"

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
  /** Items review assumes a result list may hold when its contract names no maximum. */
  maxListItems: Schema.Int,
  /** UTF-8 bytes of the reviewed Plan. */
  maxPlanBytes: Schema.Int,
  /** Statements and expressions evaluated across the whole run: the bound on computing, whatever the clock does. */
  maxSteps: Schema.Int,
  /** Nodes of everything the program holds in names at one time. */
  maxTotalNodes: Schema.Int,
  /** String units of everything the program holds in names at one time. */
  maxTotalStringUnits: Schema.Int,
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
  maxListItems: 64,
  maxPlanBytes: 262_144,
  maxSteps: 100_000,
  maxTotalNodes: 16_384,
  maxTotalStringUnits: 262_144,
  wallTimeMs: 30_000
}

/**
 * Why a run did not produce a result. The set is fixed: text a program wrote
 * (an assert's message, a name it used) never becomes part of a failure, so a
 * failure cannot be used as an output channel.
 */
export const GuestFailureReason = Schema.Literals([
  "invalid_code",
  "review_refused",
  "plan_mismatch",
  "tool_call_limit",
  "tool_input_limit",
  "tool_input_invalid",
  "tool_result_limit",
  "tool_failed",
  "grant_expired",
  "output_limit",
  "loop_limit",
  "step_limit",
  "value_limit",
  "assert_failed",
  "arithmetic_failure",
  "index_out_of_range",
  "range_bound",
  "timeout",
  "aborted",
  "execution_failed"
])
export type GuestFailureReason = typeof GuestFailureReason.Type

/**
 * What the program did wrong, as a fixed word: which mistake when the reason
 * is `execution_failed`, and `zero` or `overflow` when it is
 * `arithmetic_failure`.
 */
export const GuestFault = Schema.Literals([
  "unbound-name",
  "invalid-operation",
  "invalid-call",
  "missing-field",
  "invalid-index",
  "duplicate-field",
  "duplicate-binding",
  "zero",
  "overflow"
])
export type GuestFault = typeof GuestFault.Type

/**
 * A tool call that ended the run. A call Airlock refuses does not: the program
 * gets a receipt whose state is `refused` and decides what to do. What ends a
 * run is a fault, where the call may have acted or the host could not answer:
 * an uncertain result, an unavailable host. The message is Airlock's own
 * sentence. A grant that ran out has its own reason, `grant_expired`: nothing
 * is wrong with the call, and only a new grant will let it run.
 */
export const GuestToolFailure = Schema.Struct({
  tool: Schema.String,
  code: Schema.String,
  message: Schema.String
})
export type GuestToolFailure = typeof GuestToolFailure.Type

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
    failure: Schema.optionalKey(GuestToolFailure),
    /** Why review refused the program: which call, which argument, which rule. */
    refusals: Schema.optionalKey(Schema.Array(ReviewRefusal))
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
 * What review found, before anything runs: the Plan a supervisor approves,
 * with any refusals and the flow behind each argument; or why the program
 * could not be reviewed, in the same fixed words a run uses.
 */
export const GuestReview = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    plan: ReviewedPlan,
    refusals: Schema.Array(ReviewRefusal),
    explanations: Schema.Array(FlowExplanation)
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: GuestFailureReason,
    at: Schema.optionalKey(Schema.Struct({ line: Schema.Int, column: Schema.Int })),
    fault: Schema.optionalKey(GuestFault)
  })
])
export type GuestReview = typeof GuestReview.Type

/**
 * A run always ends in an outcome and a review always ends in a review; they
 * do not fail. A run under an approved Plan (the surface names it) is held to
 * that Plan: a program that reviews to any other ends as `plan_mismatch`.
 * Review and run share their limits, so the Plan a review shows is the Plan
 * the same run is held to.
 */
export class GuestRunner extends Context.Service<
  GuestRunner,
  {
    readonly run: (run: GuestRun) => Effect.Effect<GuestOutcome>
    readonly review: (review: Omit<GuestRun, "signal">) => Effect.Effect<GuestReview>
  }
>()("airlock/core/GuestRunner") {}
