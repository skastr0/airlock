import { Data, Effect, Layer } from "effect"
import type { AirlockFailure, GuestSurface } from "../airlock/Airlock.ts"
import { type ActionResolver, evaluate, type EvaluationError, type LanguageValue } from "../language/evaluator.ts"
import { LanguageDiagnostic, parseSync, type Program, resolveDottedActions } from "../language/index.ts"
import { boundedJson, guestLimits, invalidSource, tooLarge } from "./Bounds.ts"
import {
  type GuestFailureReason,
  type GuestFault,
  type GuestLimits,
  type GuestOutcome,
  type GuestRefusal,
  type GuestRun,
  GuestRunner
} from "./GuestRunner.ts"

/** Why the run stops at a tool call. It is the run's outcome, not something the program sees. */
class Stopped extends Data.TaggedError("Stopped")<{
  readonly reason: GuestFailureReason
  readonly refusal?: GuestRefusal
}> {}

const stop = (reason: GuestFailureReason, refusal?: GuestRefusal) =>
  Effect.fail(new Stopped(refusal === undefined ? { reason } : { reason, refusal }))

/** A program names its tools; a name is cut so it cannot carry a payload into a refusal. */
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
): Effect.Effect<unknown, Stopped> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(JSON.parse(boundedJson(value, maxBytes, limits)) as unknown)
    } catch (error) {
      return stop(error === tooLarge ? reasons.tooLarge : reasons.notJson)
    }
  })

const faults: { readonly [Tag in EvaluationError["_tag"]]?: GuestFault } = {
  UnboundIdentifier: "unbound-name",
  InvalidLanguageOperation: "invalid-operation",
  InvalidCallTarget: "invalid-call",
  MissingRecordField: "missing-field",
  InvalidIndex: "invalid-index",
  DuplicateRecordField: "duplicate-field",
  DuplicateBinding: "duplicate-binding"
}

const reasons: { readonly [Tag in EvaluationError["_tag"]]?: GuestFailureReason } = {
  AssertionFailed: "assert_failed",
  LoopLimitExceeded: "loop_limit",
  ValueLimitExceeded: "value_limit"
}

/**
 * Evaluates the program with the guest surface as its only action resolver.
 *
 * What bounds a run, since it executes in the host's own process:
 * - the language has no loop but `for`, and every iteration of every loop is
 *   charged to one budget, so a program cannot run forever;
 * - no string and no list or record may grow past a limit, so a short program
 *   cannot describe a value too large to hold or to walk;
 * - the wall-clock deadline stops the run between steps and nothing is called
 *   after it.
 * Neither is a CPU quota. A program can still spend its whole loop budget on
 * arithmetic; the deadline is what ends that.
 */
const runProgram = ({ source, surface, bindings: bound, limits: overrides, signal }: GuestRun): Effect.Effect<GuestOutcome> =>
  Effect.suspend(() => {
    const limits = guestLimits(overrides)
    const deadline = Date.now() + limits.wallTimeMs
    let calls = 0
    let open = true
    const failed = (
      reason: GuestFailureReason,
      detail: { readonly at?: { line: number; column: number }; readonly fault?: GuestFault; readonly refusal?: GuestRefusal } = {}
    ): GuestOutcome => ({ ok: false, reason, toolCalls: calls, ...detail })

    if (invalidSource(source, limits)) return Effect.succeed(failed("invalid_code"))
    if (signal?.aborted === true) return Effect.succeed(failed("aborted"))
    let program: Program
    try {
      // Every dotted call names a tool. Whether it is granted is decided when it is called.
      program = resolveDottedActions(parseSync(source), () => true)
    } catch (error) {
      return Effect.succeed(failed(
        "invalid_code",
        error instanceof LanguageDiagnostic ? { at: { line: error.span.line, column: error.span.column } } : {}
      ))
    }

    const granted = new Set(surface.tools)
    const resolver: ActionResolver<never, Stopped> = {
      resolve: (action, args) =>
        Effect.gen(function* () {
          if (!open || Date.now() >= deadline) return yield* stop("timeout")
          if (calls >= limits.maxToolCalls) return yield* stop("tool_call_limit")
          // Counted before anything is validated: a rejected call is still a call.
          calls += 1
          const tool = action.slice(0, MAX_NAME)
          if (!granted.has(action)) {
            return yield* stop("tool_refused", {
              tool,
              code: "unknown-tool",
              message: `${tool} is not a tool this session grants`
            })
          }
          if (args.length !== 1) return yield* stop("tool_input_invalid")
          const input = yield* cross(args[0], limits.maxToolInputBytes, limits, {
            tooLarge: "tool_input_limit",
            notJson: "tool_input_invalid"
          })
          const ended = yield* Effect.result(Effect.suspend(() => surface.call(action, input)))
          if (!open || Date.now() >= deadline) return yield* stop("timeout")
          if (ended._tag === "Failure") {
            const refusal: AirlockFailure = ended.failure
            // A spent session budget is the host's limit, not the tool's answer.
            if (refusal.code === "budget-exceeded") return yield* stop("tool_call_limit")
            return yield* stop("tool_refused", {
              tool,
              code: refusal.code,
              message: refusal.message.slice(0, MAX_MESSAGE)
            })
          }
          return (yield* cross(ended.success, limits.maxToolResultBytes, limits, {
            tooLarge: "tool_result_limit",
            notJson: "execution_failed"
          })) as LanguageValue
        })
    }

    // What the host binds crosses the same way a tool's result does.
    const bindings = Effect.forEach(Object.entries(bound ?? {}), ([name, value]) =>
      Effect.map(
        cross(value, limits.maxToolResultBytes, limits, { tooLarge: "value_limit", notJson: "execution_failed" }),
        (copy) => [name, copy as LanguageValue] as const
      )).pipe(Effect.map((entries) => Object.fromEntries(entries)))

    // One turn passes before the first step, so an abort issued right after
    // the run was started is seen before anything is called.
    const settled: Effect.Effect<GuestOutcome> = Effect.yieldNow.pipe(
      Effect.andThen(Effect.suspend(() =>
        signal?.aborted === true
          ? stop("aborted")
          : Effect.flatMap(bindings, (names) =>
              evaluate(program, resolver, {
                maxLoopIterations: limits.maxLoopIterations,
                maxStringLength: Math.max(limits.maxToolInputBytes, limits.maxOutputBytes),
                maxValueNodes: limits.maxNodes,
                bindings: names
              })))),
      Effect.flatMap((evaluation) =>
        cross(evaluation.returned ? evaluation.value : null, limits.maxOutputBytes, limits, {
          tooLarge: "output_limit",
          notJson: "execution_failed"
        })),
      Effect.map((result): GuestOutcome => ({ ok: true, result: result as never, toolCalls: calls })),
      Effect.catch((error) =>
        Effect.succeed(
          error._tag === "Stopped"
            ? failed(error.reason, error.refusal === undefined ? {} : { refusal: error.refusal })
            : failed(reasons[error._tag] ?? "execution_failed", {
                at: { line: error.span.line, column: error.span.column },
                ...(faults[error._tag] === undefined ? {} : { fault: faults[error._tag]! })
              })
        )),
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

/** The GuestRunner: Airlock programs, evaluated in process. The same on every host. */
export const programRunner: Layer.Layer<GuestRunner> = Layer.succeed(GuestRunner, GuestRunner.of({ run: runProgram }))
