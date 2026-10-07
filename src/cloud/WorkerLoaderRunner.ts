import { Effect, Layer } from "effect"
import {
  type GuestBridge,
  guestLimits,
  GuestRunner,
  guestRuntimeSource,
  invalidSource,
  makeGuestBridge,
  settleGuest
} from "../core/index.ts"
import { RpcTarget, type WorkerLoader } from "./Platform.ts"

/**
 * GuestRunner over the Worker Loader binding: every run gets a fresh isolate
 * with no network (`globalOutbound: null`), no bindings, no environment and no
 * compatibility flags. The only thing passed in is an RPC object with one
 * method per granted tool.
 *
 * What this does and does not guarantee:
 * - The guest cannot reach the network, a binding, a secret or the host's
 *   memory. The conformance suite checks this in real workerd.
 * - `cpuMs` and `subRequests` are handed to the platform. Production
 *   Cloudflare enforces them; local workerd does not, so a synchronous
 *   infinite loop is stopped in production and not on a developer's machine.
 * - The wall-clock deadline makes the host stop waiting and revokes the tools,
 *   which is authoritative: nothing more can be called. It is not proof the
 *   isolate stopped running.
 * - Worker Loader requires a paid Workers plan. On a free plan the binding is
 *   refused at deploy time.
 */
export interface WorkerLoaderRunnerOptions {
  /** Compatibility date of the guest isolate. */
  readonly compatibilityDate?: string
  /** CPU milliseconds per run, enforced by production Cloudflare only. */
  readonly cpuMs?: number
  /** Subrequests per run. The guest has no network; this leaves room for its RPC calls back. */
  readonly subRequests?: number
}

const defaults = { compatibilityDate: "2026-07-08", cpuMs: 50, subRequests: 64 } as const

/**
 * An RPC object exposing exactly the bridge's tools. Workers RPC reaches only
 * prototype methods, so each tool is a method on a class made for this run:
 * there is no generic "call by name" entry a guest could aim elsewhere.
 */
const capabilityFor = (bridge: GuestBridge): object => {
  class Capability extends RpcTarget {}
  for (const tool of bridge.tools) {
    Object.defineProperty(Capability.prototype, tool, {
      enumerable: false,
      value: (input: unknown) => bridge.call(tool, input)
    })
  }
  return new (Capability as unknown as new () => object)()
}

const RUNNER_MODULE = "runner.js"
const GUEST_MODULE = "guest.js"

const runnerModule = (runtime: string) => `
import { WorkerEntrypoint } from "cloudflare:workers";
// The trusted runtime is evaluated here, before the guest module is loaded,
// so everything it captured is what the platform provided.
const run = ${runtime};
export default class extends WorkerEntrypoint {
  async run(bridge) {
    return run(bridge, async () => (await import(${JSON.stringify(GUEST_MODULE)})).default);
  }
}
`

const dispose = (handle: unknown): void => {
  try {
    const release = (handle as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]
    if (typeof release === "function") release.call(handle)
  } catch {
    // Releasing a handle is cleanup, not the security boundary.
  }
}

export const workerLoaderRunner = (
  loader: WorkerLoader,
  options: WorkerLoaderRunnerOptions = {}
): Layer.Layer<GuestRunner> =>
  Layer.succeed(
    GuestRunner,
    GuestRunner.of({
      run: ({ source, surface, limits: overrides, signal }) =>
        // Interrupting the fiber aborts the run exactly as the caller's own
        // signal does: the tools are revoked and the host stops waiting.
        Effect.promise(async (interrupted) => {
          const limits = guestLimits(overrides)
          const bridge = makeGuestBridge(surface, limits)
          if (invalidSource(source, limits)) return { ok: false, reason: "invalid_code", toolCalls: 0 } as const
          let worker: unknown
          let entrypoint: unknown
          return settleGuest({
            bridge,
            limits,
            signal: signal === undefined ? interrupted : AbortSignal.any([interrupted, signal]),
            start: async () => {
              worker = loader.load({
                compatibilityDate: options.compatibilityDate ?? defaults.compatibilityDate,
                compatibilityFlags: [],
                mainModule: RUNNER_MODULE,
                modules: {
                  [RUNNER_MODULE]: runnerModule(guestRuntimeSource(bridge.tools, limits)),
                  [GUEST_MODULE]: `export default async function(tools) {\n${source}\n}`
                },
                globalOutbound: null,
                limits: {
                  cpuMs: options.cpuMs ?? defaults.cpuMs,
                  subRequests: options.subRequests ?? defaults.subRequests
                }
              })
              entrypoint = (worker as { getEntrypoint(): unknown }).getEntrypoint()
              return (entrypoint as { run(bridge: object): Promise<unknown> }).run(capabilityFor(bridge))
            },
            stop: () => {
              dispose(entrypoint)
              dispose(worker)
            }
          })
        })
    })
  )
