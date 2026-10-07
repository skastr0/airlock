import { Effect, Schema } from "effect"
import type { GuestSurface } from "../airlock/Airlock.ts"
import {
  defaultGuestLimits,
  GuestFailureReason,
  type GuestLimits,
  type GuestOutcome
} from "./GuestRunner.ts"

/**
 * The host's half of a guest run, the same on every cloud. An adapter gives the
 * bridge to its isolate (as an RPC object, a message port, whatever it has) and
 * asks `settleGuest` to wait for the reply. Nothing here trusts the guest's
 * half: every limit the guest-side runtime checks is checked again.
 */

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).byteLength

export const guestLimits = (overrides: Partial<GuestLimits> = {}): GuestLimits => ({
  ...defaultGuestLimits,
  ...overrides
})

/** Why the source cannot be run at all, before any isolate exists. */
export const invalidSource = (source: string, limits: GuestLimits): boolean =>
  source.length === 0 || source.length > limits.maxCodeBytes || bytes(source) > limits.maxCodeBytes

/** A tool refusal the guest may catch. It carries Airlock's sentence and nothing else. */
class ToolRefused extends Error {
  override readonly name = "ToolRefused"
}

export interface GuestBridge {
  /** Granted tool names. An adapter exposes exactly one method per name. */
  readonly tools: ReadonlyArray<string>
  /**
   * One tool call: a JSON string in, a JSON string out. A host-policy
   * violation revokes the bridge and fails the run even if the guest catches
   * the error; a tool's own refusal is an ordinary error the guest may handle.
   */
  readonly call: (tool: string, input: unknown) => Promise<string>
  /** Revokes the bridge. Every later call fails. */
  readonly close: () => void
  readonly calls: () => number
  readonly failure: () => GuestFailureReason | undefined
}

export const makeGuestBridge = (surface: GuestSurface, limits: GuestLimits): GuestBridge => {
  const granted = new Set(surface.tools)
  const deadline = Date.now() + limits.wallTimeMs
  let active = true
  let calls = 0
  let failed: GuestFailureReason | undefined
  const deny = (reason: GuestFailureReason): never => {
    failed ??= reason
    active = false
    // The reason is read from the bridge, not from this error's text.
    throw new Error("guest run failed")
  }
  return {
    tools: [...granted].sort(),
    close: () => {
      active = false
    },
    calls: () => calls,
    failure: () => failed,
    call: async (tool, input) => {
      if (!active || Date.now() >= deadline) return deny("timeout")
      if (calls >= limits.maxToolCalls) return deny("tool_call_limit")
      // Counted before anything is validated: a rejected call is still a call.
      calls += 1
      if (!granted.has(tool)) return deny("execution_failed")
      if (typeof input !== "string") return deny("tool_input_invalid")
      if (input.length > limits.maxToolInputBytes || bytes(input) > limits.maxToolInputBytes) {
        return deny("tool_input_limit")
      }
      let decoded: unknown
      try {
        // The host parses its own copy; the guest holds no reference to it.
        decoded = JSON.parse(input)
      } catch {
        return deny("tool_input_invalid")
      }
      const ended = await Effect.runPromise(Effect.result(surface.call(tool, decoded)))
      if (!active) return deny("timeout")
      if (ended._tag === "Failure") {
        // A spent session budget is the host's limit, not the tool's answer.
        if (ended.failure.code === "budget-exceeded") return deny("tool_call_limit")
        throw new ToolRefused(ended.failure.message.slice(0, 512))
      }
      const reply = JSON.stringify(ended.success)
      if (reply.length > limits.maxToolResultBytes || bytes(reply) > limits.maxToolResultBytes) {
        return deny("tool_result_limit")
      }
      return reply
    }
  }
}

const Reply = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), result: Schema.Json }),
    Schema.Struct({ ok: Schema.Literal(false), error: GuestFailureReason })
  ])
)
const decodeReply = Schema.decodeUnknownOption(Reply)

/**
 * Waits for the isolate's reply under the wall-clock deadline and turns it into
 * an outcome. `start` begins the run and resolves with whatever the isolate
 * returned; `stop` is called once, however the run ends.
 *
 * Passing the deadline revokes the bridge, which is authoritative: the guest
 * can call nothing more. It is not proof the isolate stopped running; ending
 * its CPU use is the platform's job.
 */
export const settleGuest = async (options: {
  readonly bridge: GuestBridge
  readonly limits: GuestLimits
  readonly signal?: AbortSignal
  readonly start: () => Promise<unknown>
  readonly stop?: () => void
}): Promise<GuestOutcome> => {
  const { bridge, limits, signal } = options
  const fail = (reason: GuestFailureReason): GuestOutcome => ({ ok: false, reason, toolCalls: bridge.calls() })
  if (signal?.aborted === true) return fail("aborted")
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stopped = new Promise<GuestFailureReason>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limits.wallTimeMs)
    onAbort = () => resolve("aborted")
    signal?.addEventListener("abort", onAbort, { once: true })
  })
  try {
    const raced = await Promise.race([
      options.start().then((raw) => ({ raw }), () => ({ raw: undefined })),
      stopped.then((reason) => ({ reason }))
    ])
    if ("reason" in raced) {
      bridge.close()
      return fail(raced.reason)
    }
    const violated = bridge.failure()
    if (violated !== undefined) return fail(violated)
    const { raw } = raced
    if (typeof raw !== "string") return fail("execution_failed")
    if (raw.length > limits.maxOutputBytes || bytes(raw) > limits.maxOutputBytes) return fail("output_limit")
    const reply = decodeReply(raw)
    if (reply._tag === "None") return fail("invalid_output")
    return reply.value.ok
      ? { ok: true, result: reply.value.result, toolCalls: bridge.calls() }
      : fail(reply.value.error)
  } finally {
    bridge.close()
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
    options.stop?.()
  }
}
