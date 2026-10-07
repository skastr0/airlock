import { Effect, Layer } from "effect"
import { guestLimits, invalidSource, makeGuestBridge, settleGuest } from "../runner/GuestHost.ts"
import { GuestRunner } from "../runner/GuestRunner.ts"
import { guestRuntimeSource } from "../runner/GuestRuntime.ts"

type Runtime = (
  bridge: { readonly [tool: string]: (input: string) => Promise<string> },
  loadGuest: () => Promise<(tools: unknown) => Promise<unknown>>
) => Promise<string>

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: Array<string>
) => (tools: unknown) => Promise<unknown>

/**
 * Reference GuestRunner. It runs the guest IN THIS PROCESS: it is not a sandbox
 * and must never be given untrusted code outside a test. It exists to state,
 * executably, what a run means (the same trusted runtime, the same bridge, the
 * same outcomes), so that an isolating adapter can be checked against it.
 */
export const memoryGuestRunner: Layer.Layer<GuestRunner> = Layer.succeed(
  GuestRunner,
  GuestRunner.of({
    run: ({ source, surface, limits: overrides, signal }) =>
      Effect.promise(async () => {
        const limits = guestLimits(overrides)
        const bridge = makeGuestBridge(surface, limits)
        if (invalidSource(source, limits)) return { ok: false, reason: "invalid_code", toolCalls: 0 } as const
        const methods: { [tool: string]: (input: string) => Promise<string> } = {}
        for (const tool of bridge.tools) methods[tool] = (input) => bridge.call(tool, input)
        return settleGuest({
          bridge,
          limits,
          ...(signal === undefined ? {} : { signal }),
          start: async () => {
            const runtime = new Function(`return ${guestRuntimeSource(bridge.tools, limits, false)}`)() as Runtime
            return runtime(methods, async () => new AsyncFunction("tools", source))
          }
        })
      })
  })
)
