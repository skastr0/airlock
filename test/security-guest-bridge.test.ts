import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AirlockFailure, type GuestSurface } from "../src/core/airlock/Airlock.ts"
import { guestLimits, makeGuestBridge, settleGuest } from "../src/core/runner/GuestHost.ts"

const surface = (call: GuestSurface["call"]): GuestSurface => ({
  tools: ["security.read"], declaration: "", description: "", call
})

describe("security: guest bridge enforces the host boundary", () => {
  it("keeps unexpected host exception text out of guest errors", async () => {
    const bridge = makeGuestBridge(surface(() => Effect.die(new Error("host-canary-secret"))), guestLimits())
    const visible = await bridge.call("security.read", "{}").then(() => "unexpected success", (error) => String(error.message))
    expect(visible).not.toContain("host-canary-secret")
    expect(bridge.failure()).toBe("execution_failed")
  })

  it("also redacts exceptions thrown before the tool returns an Effect", async () => {
    const bridge = makeGuestBridge(surface(() => { throw new Error("host-canary-secret") }), guestLimits())
    const visible = await bridge.call("security.read", "{}").catch((error) => String(error.message))
    expect(visible).toBe("guest run failed")
    expect(bridge.failure()).toBe("execution_failed")
  })

  it("leaves an ordinary tool refusal catchable without exposing its cause", async () => {
    const bridge = makeGuestBridge(surface(() => Effect.fail(new AirlockFailure({
      code: "refused", message: "This call is refused."
    }))), guestLimits())
    const visible = await bridge.call("security.read", "{}").catch((error) => ({ name: error.name, message: error.message }))
    expect(visible).toEqual({ name: "ToolRefused", message: "This call is refused." })
    expect(bridge.failure()).toBeUndefined()
    bridge.close()
  })

  it("never invokes a getter on a host result", async () => {
    let reads = 0
    const result = Object.defineProperty({}, "private", {
      enumerable: true, get: () => { reads += 1; throw new Error("host-canary-secret") }
    })
    const bridge = makeGuestBridge(surface(() => Effect.succeed(result)), guestLimits())
    const visible = await bridge.call("security.read", "{}").catch((error) => String(error.message))
    expect({ visible, reads, failure: bridge.failure() }).toEqual({
      visible: "guest run failed", reads: 0, failure: "execution_failed"
    })
  })

  it("serializes host data without invoking a toJSON hook", async () => {
    let hooks = 0
    const result = Object.defineProperty({ answer: 42 }, "toJSON", {
      value: () => { hooks += 1; throw new Error("host-canary-secret") }
    })
    const bridge = makeGuestBridge(surface(() => Effect.succeed(result)), guestLimits())
    expect(await bridge.call("security.read", "{}")).toBe('{"answer":42}')
    expect(hooks).toBe(0)
    bridge.close()
  })

  it("interrupts an admitted call when the bridge closes before staging", async () => {
    let unblock!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { unblock = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let emissions = 0
    const bridge = makeGuestBridge(surface(() => {
      entered()
      return Effect.promise(() => waiting).pipe(Effect.andThen(Effect.sync(() => {
        emissions += 1
        return null
      })))
    }), guestLimits())
    const pending = bridge.call("security.read", "{}").catch(() => undefined)
    await started
    bridge.close()
    unblock()
    await pending
    expect(emissions).toBe(0)
  })

  it("closes a pre-aborted run without starting it", async () => {
    let calls = 0
    const limits = guestLimits()
    const bridge = makeGuestBridge(surface(() => Effect.sync(() => { calls += 1; return null })), limits)
    const controller = new AbortController()
    controller.abort()
    let stopped = 0
    const outcome = await settleGuest({
      bridge, limits, signal: controller.signal,
      start: async () => { throw new Error("an aborted run must not start") },
      stop: () => { stopped += 1 }
    })
    expect(outcome).toEqual({ ok: false, reason: "aborted", toolCalls: 0 })
    const accepted = await bridge.call("security.read", "{}").then(() => true, () => false)
    expect({ accepted, calls, stopped }).toEqual({ accepted: false, calls: 0, stopped: 1 })
  })

  it("does not start if aborted before the startup microtask", async () => {
    const controller = new AbortController()
    const limits = guestLimits()
    const bridge = makeGuestBridge(surface(() => Effect.succeed(null)), limits)
    let started = 0
    const pending = settleGuest({ bridge, limits, signal: controller.signal, start: async () => {
      started += 1
      return '{"ok":true,"result":null}'
    } })
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: "aborted", toolCalls: 0 })
    expect(started).toBe(0)
  })

  it("settles synchronous startup and cleanup exceptions without host text", async () => {
    const limits = guestLimits()
    const bridge = makeGuestBridge(surface(() => Effect.succeed(null)), limits)
    const outcome = await settleGuest({ bridge, limits,
      start: () => { throw new Error("host-canary-secret") },
      stop: () => { throw new Error("host-cleanup-canary-secret") }
    })
    expect(outcome).toEqual({ ok: false, reason: "execution_failed", toolCalls: 0 })
    expect(await bridge.call("security.read", "{}").then(() => true, () => false)).toBe(false)
  })

  it("independently rejects excessive JSON depth on the host", async () => {
    let calls = 0
    const bridge = makeGuestBridge(surface(() => Effect.sync(() => { calls += 1; return null })), guestLimits({ maxDepth: 1 }))
    const accepted = await bridge.call("security.read", '{"nested":{"deeper":{"leaf":1}}}').then(() => true, () => false)
    expect({ accepted, calls, failure: bridge.failure() }).toEqual({ accepted: false, calls: 0, failure: "tool_input_limit" })
  })

  it("independently rejects excessive JSON node counts on the host", async () => {
    let calls = 0
    const bridge = makeGuestBridge(surface(() => Effect.sync(() => { calls += 1; return null })), guestLimits({ maxNodes: 2 }))
    const accepted = await bridge.call("security.read", '{"a":1,"b":2}').then(() => true, () => false)
    expect({ accepted, calls, failure: bridge.failure() }).toEqual({ accepted: false, calls: 0, failure: "tool_input_limit" })
  })

  it.each([
    [{ maxDepth: 1 }, { nested: { deeper: { leaf: 1 } } }],
    [{ maxNodes: 2 }, { a: 1, b: 2 }],
    [{ maxToolResultBytes: 4 }, "éé"]
  ])("bounds host tool results independently (%j)", async (overrides, result) => {
    const bridge = makeGuestBridge(surface(() => Effect.succeed(result)), guestLimits(overrides))
    expect(await bridge.call("security.read", "{}").then(() => true, () => false)).toBe(false)
    expect(bridge.failure()).toBe("tool_result_limit")
  })

  it("checks the guest's final result node count on the host", async () => {
    const limits = guestLimits({ maxNodes: 2 })
    const bridge = makeGuestBridge(surface(() => Effect.succeed(null)), limits)
    const outcome = await settleGuest({ bridge, limits, start: async () => '{"ok":true,"result":{"a":1,"b":2}}' })
    expect(outcome).toEqual({ ok: false, reason: "output_limit", toolCalls: 0 })
  })
})
