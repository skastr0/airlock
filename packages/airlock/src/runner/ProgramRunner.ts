import { Crypto, Data, Effect, Layer, Result, type Schema } from "effect"
import type { AirlockFailure, GuestSurface } from "../airlock/Airlock.ts"
import { createRoleWitnessIssuer } from "../contract/RoleWitness.ts"
import type { Span } from "../language/ast.ts"
import { runChecked, type RunStop } from "../language/run.ts"
import { planGuard } from "../review/Review.ts"
import { type Reviewed, reviewSource } from "../review/Surface.ts"
import * as WebCrypto from "../WebCrypto.ts"
import { boundedJson, guestLimits, invalidSource, tooLarge } from "./Bounds.ts"
import {
  type GuestFailureReason,
  type GuestLimits,
  type GuestOutcome,
  type GuestReview,
  type GuestToolFailure,
  type GuestRun,
  GuestRunner
} from "./GuestRunner.ts"

/** Why the run stops at a tool call. It is the run's outcome, not something the program sees. */
class Stopped extends Data.TaggedError("Stopped")<{
  readonly reason: GuestFailureReason
  readonly failure?: GuestToolFailure
}> {}

/** A program names its tools; a name is cut so it cannot carry a payload into an outcome. */
const MAX_NAME = 128
const MAX_MESSAGE = 512

/**
 * A value crosses the boundary as bounded JSON text and is parsed on the other
 * side, so neither side holds a reference into the other's data.
 */
const cross = (
  value: unknown,
  maxBytes: number,
  limits: GuestLimits,
  reasons: { readonly tooLarge: GuestFailureReason; readonly notJson: GuestFailureReason }
): Effect.Effect<Schema.Json, Stopped> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(JSON.parse(boundedJson(value, maxBytes, limits)) as Schema.Json)
    } catch (error) {
      return Effect.fail(new Stopped({ reason: error === tooLarge ? reasons.tooLarge : reasons.notJson }))
    }
  })

const reasons: { readonly [Reason in RunStop["reason"]]: GuestFailureReason } = {
  "dynamic-type-error": "execution_failed",
  "host-result": "execution_failed",
  "step-limit": "step_limit",
  "loop-limit": "loop_limit",
  "call-limit": "tool_call_limit",
  "out-of-plan": "plan_mismatch",
  refinement: "plan_mismatch",
  "value-limit": "value_limit",
  arithmetic_failure: "arithmetic_failure",
  index_out_of_range: "index_out_of_range",
  range_bound: "range_bound",
  assert_failed: "assert_failed"
}

const place = (span: Span) => ({ at: { line: span.line, column: span.column } })

type Unreviewed = Omit<Extract<GuestReview, { ok: false }>, "ok">

/**
 * Checks the source against the granted contracts and reviews it against the
 * policy, with the run's own limits. The bindings cross the same way a tool's
 * result does.
 */
const reviewRun = (
  source: string,
  surface: GuestSurface,
  bound: GuestRun["bindings"],
  limits: GuestLimits
): Effect.Effect<Reviewed, Unreviewed, Crypto.Crypto> =>
  Effect.gen(function* () {
    if (invalidSource(source, limits)) return yield* Effect.fail<Unreviewed>({ reason: "invalid_code" })
    const bindings = yield* Effect.forEach(Object.entries(bound ?? {}), ([name, value]) =>
      Effect.map(
        cross(value, limits.maxToolResultBytes, limits, { tooLarge: "value_limit", notJson: "execution_failed" }),
        (copy) => [name, copy] as const
      )).pipe(
      Effect.map((entries) => Object.fromEntries(entries)),
      Effect.mapError((error): Unreviewed => ({ reason: error.reason }))
    )
    return yield* reviewSource(source, surface.review, {
      bindings,
      limits: {
        maxCalls: limits.maxToolCalls,
        maxIterations: limits.maxLoopIterations,
        maxListItems: limits.maxListItems,
        maxPlanBytes: limits.maxPlanBytes
      }
    }).pipe(Effect.mapError((error): Unreviewed => {
      if (error._tag === "DigestUnavailable") return { reason: "execution_failed" }
      const fault = error._tag === "CheckError" ? error.fault : error._tag === "DuplicateBinding" ? "duplicate-binding" as const : undefined
      return { reason: "invalid_code", ...place(error.span), ...(fault === undefined ? {} : { fault }) }
    }))
  })

const reviewProgram = ({ source, surface, bindings, limits }: Omit<GuestRun, "signal">): Effect.Effect<GuestReview, never, Crypto.Crypto> =>
  reviewRun(source, surface, bindings, guestLimits(limits)).pipe(
    Effect.match({
      onFailure: (unreviewed): GuestReview => ({ ok: false, ...unreviewed }),
      onSuccess: ({ report }): GuestReview => ({ ok: true, plan: report.plan, refusals: report.refusals, explanations: report.explanations })
    }),
    Effect.catchCause(() => Effect.succeed<GuestReview>({ ok: false, reason: "execution_failed" }))
  )

/**
 * Reviews the program, then runs it held to the reviewed Plan, with the guest
 * surface as its only way to act.
 *
 * Before anything is called:
 * - the source is parsed and checked against the granted contracts, so every
 *   call it can make is known with its bounds, and a program that does not
 *   type is `invalid_code`;
 * - the Plan is reviewed against the policy's grants and flow rules, and a
 *   refused Plan ends the run as `review_refused` with the reasons.
 *
 * While it runs, every call is checked against its node in the Plan before
 * it reaches the surface: its occurrence, fixed arguments, proofs and labels.
 * A call the Plan does not describe ends the run as `plan_mismatch`.
 *
 * What bounds a run, since it executes in the host's own process: the checked
 * call and loop bounds; a step budget counted whatever the clock does; limits
 * on strings, built values and everything held in names; and a wall-clock
 * deadline that stops the run between steps, after which nothing is called.
 */
const runProgram = ({ source, surface, bindings, limits: overrides, signal }: GuestRun): Effect.Effect<GuestOutcome, never, Crypto.Crypto> =>
  Effect.suspend(() => {
    const limits = guestLimits(overrides)
    const deadline = Date.now() + limits.wallTimeMs
    let calls = 0
    let open = true
    // A tool call's own stop, kept because the evaluator reports it only as the host's.
    let stopped: Stopped | undefined
    // Set by the Plan check for the call that `resolve` makes next.
    let covered = false
    const failed = (reason: GuestFailureReason, detail: Partial<Omit<Extract<GuestOutcome, { ok: false }>, "ok" | "reason" | "toolCalls">> = {}): GuestOutcome =>
      ({ ok: false, reason, toolCalls: calls, ...detail })
    const stop = (reason: GuestFailureReason, failure?: GuestToolFailure) => {
      stopped = new Stopped(failure === undefined ? { reason } : { reason, failure })
      return Effect.fail(stopped)
    }

    if (invalidSource(source, limits)) return Effect.succeed(failed("invalid_code"))
    if (signal?.aborted === true) return Effect.succeed(failed("aborted"))

    const evaluated = Effect.gen(function* () {
      const reviewed = yield* Effect.result(reviewRun(source, surface, bindings, limits))
      if (Result.isFailure(reviewed)) {
        const { reason, ...detail } = reviewed.failure
        return failed(reason, detail)
      }
      const { checked, report, surface: reviewSurface } = reviewed.success
      if (report.refusals.length > 0) return failed("review_refused", { refusals: report.refusals })
      if (surface.plan !== undefined && surface.plan !== report.plan.id) return failed("plan_mismatch")

      const issuer = createRoleWitnessIssuer("run")
      const guard = planGuard(report, checked, reviewSurface, issuer)
      const occurrences = new Map<string, number>()
      const ran = yield* Effect.result(runChecked(checked, {
        limits: {
          maxSteps: limits.maxSteps,
          maxStringLength: Math.max(limits.maxToolInputBytes, limits.maxOutputBytes),
          maxValueNodes: limits.maxNodes,
          maxTotalNodes: limits.maxTotalNodes,
          maxTotalStringUnits: limits.maxTotalStringUnits
        },
        roleIssuer: issuer,
        beforeCall: (call) => Effect.suspend(() => {
          const node = report.plan.nodes.find((candidate) => candidate.sourceOffset === call.span.start && candidate.tool === call.tool)
          if (node === undefined) return stop("plan_mismatch")
          const occurrence = (occurrences.get(node.id) ?? 0) + 1
          occurrences.set(node.id, occurrence)
          return guard({ planId: report.plan.id, nodeId: node.id, occurrence, tool: call.tool }, call.fields, call.pc).pipe(
            Effect.tap((held) => Effect.sync(() => { covered = surface.plan !== undefined && held.granted && node.approval === "program" })),
            Effect.catch(() => stop("plan_mismatch"))
          )
        }),
        resolve: (tool, input) => Effect.gen(function* () {
          if (!open || Date.now() >= deadline) return yield* stop("timeout")
          if (calls >= limits.maxToolCalls) return yield* stop("tool_call_limit")
          // Counted before anything is validated: a rejected call is still a call.
          calls += 1
          const copy = yield* cross(input, limits.maxToolInputBytes, limits, { tooLarge: "tool_input_limit", notJson: "tool_input_invalid" }).pipe(
            Effect.tapError((error) => Effect.sync(() => { stopped = error }))
          )
          const options = { covered }
          covered = false
          const ended = yield* Effect.result(Effect.suspend(() => surface.call(tool, copy, options)))
          if (!open || Date.now() >= deadline) return yield* stop("timeout")
          // A refusal is a receipt the program reads. What fails here is a
          // fault: the call may have acted, or the host could not answer.
          if (ended._tag === "Failure") {
            const fault: AirlockFailure = ended.failure
            // A spent session budget is the host's limit, not the tool's answer.
            if (fault.code === "budget-exceeded") return yield* stop("tool_call_limit")
            // Time ran out on the grant. The program cannot answer that, so it is not handed a receipt.
            if (fault.code === "expired") return yield* stop("grant_expired")
            return yield* stop("tool_failed", {
              tool: tool.slice(0, MAX_NAME),
              code: fault.code,
              message: fault.message.slice(0, MAX_MESSAGE)
            })
          }
          // The receipt crosses whole: its state, and its result when the call is done.
          return yield* cross(ended.success, limits.maxToolResultBytes, limits, { tooLarge: "tool_result_limit", notJson: "execution_failed" }).pipe(
            Effect.tapError((error) => Effect.sync(() => { stopped = error }))
          )
        })
      }))
      if (Result.isFailure(ran)) {
        const error = ran.failure
        if (stopped !== undefined) return failed(stopped.reason, stopped.failure === undefined ? {} : { failure: stopped.failure })
        // A host that answered wrongly is not a place in the program.
        if (error.reason === "host-result") return failed(reasons[error.reason])
        return failed(reasons[error.reason], { ...place(error.span), ...(error.fault === undefined ? {} : { fault: error.fault }) })
      }
      const output = yield* Effect.result(cross(ran.success, limits.maxOutputBytes, limits, { tooLarge: "output_limit", notJson: "execution_failed" }))
      return Result.isFailure(output) ? failed(output.failure.reason) : { ok: true as const, result: output.success, toolCalls: calls }
    })

    // One turn passes before the first step, so an abort issued right after
    // the run was started is seen before anything is called.
    const settled: Effect.Effect<GuestOutcome, never, Crypto.Crypto> = Effect.yieldNow.pipe(
      Effect.andThen(Effect.suspend(() => signal?.aborted === true ? Effect.succeed(failed("aborted")) : evaluated)),
      // A defect is the host's: a tool that threw, a stack that ran out. None of its text leaves.
      Effect.catchCause(() => Effect.succeed(failed("execution_failed")))
    )

    // Real timers, not the Effect clock: the deadline is wall time whatever clock a host installs.
    const halted = Effect.callback<GuestFailureReason>((resume) => {
      const timer = setTimeout(() => resume(Effect.succeed("timeout")), limits.wallTimeMs)
      const onAbort = () => resume(Effect.succeed("aborted"))
      signal?.addEventListener("abort", onAbort, { once: true })
      return Effect.sync(() => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      })
    })

    return Effect.raceFirst(settled, Effect.map(halted, (reason) => failed(reason))).pipe(
      Effect.map((outcome) =>
        // The evaluation may finish in the same turn the deadline or the abort lands in.
        outcome.ok && signal?.aborted === true
          ? failed("aborted")
          : outcome.ok && Date.now() >= deadline
            ? failed("timeout")
            : outcome
      ),
      // However the run ends, interrupted included, it can call nothing afterwards.
      Effect.ensuring(Effect.sync(() => { open = false }))
    )
  })

/** The GuestRunner: Airlock programs, reviewed and evaluated in process. The same on every host. */
export const programRunner: Layer.Layer<GuestRunner> = Layer.effect(GuestRunner, Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  return GuestRunner.of({
    run: (run) => Effect.provideService(runProgram(run), Crypto.Crypto, crypto),
    review: (review) => Effect.provideService(reviewProgram(review), Crypto.Crypto, crypto)
  })
})).pipe(Layer.provide(WebCrypto.layer))
