import { Effect } from "effect"
import type { ToolContract } from "../contract/ToolContract.ts"
import {
  type Delivery,
  DispatchFailed,
  type DispatchHandlers,
  DispatchRefused,
  type DispatchRequest
} from "../outbox/Dispatcher.ts"
import { isLivePermit } from "../outbox/Outbox.ts"
import type { ToolContracts } from "../session/ToolSession.ts"

const RefusedTypeId: unique symbol = Symbol.for("airlock/Refused")

/**
 * What an implementation returns, or throws, to say "I did not send this, and
 * I can prove it": a connection that is not configured, a request rejected
 * before the remote API executed it. Airlock records the call as refused, which
 * is final and means nothing happened.
 *
 * Anything else that goes wrong (a thrown error, a rejected promise, a
 * timeout) is recorded as uncertain, because the remote side may have acted.
 * Only say refused when it truly cannot have.
 */
export class Refused {
  readonly [RefusedTypeId] = true
  constructor(
    /** Stored and shown to whoever reviews the call. Do not put input values or credentials in it. */
    readonly reason: string
  ) {}
}

export const refused = (reason: string): Refused => new Refused(reason)

const isRefused = (value: unknown): value is Refused =>
  typeof value === "object" && value !== null && RefusedTypeId in value

/** What an implementation is handed besides its input. */
export interface ImplementContext<Env> {
  /** The host's bindings and secrets. This is where credentials come from. */
  readonly env: Env
  /** Aborted when Airlock gives up on the call; pass it to `fetch`. */
  readonly signal: AbortSignal
  /**
   * Names this one call, and is the same if Airlock is ever asked about it
   * again. Forward it to a remote API that accepts an idempotency key.
   */
  readonly idempotencyKey: string
}

type Awaitable<Value> = Value | Promise<Value> | Effect.Effect<Value, unknown>

/**
 * One ordinary function per contract: the decoded, typed input in, the typed
 * output out. It may return a value, a Promise or an Effect. A missing or
 * extra key, or a wrong input or output type, does not compile.
 */
export type Implementations<Contracts extends { readonly [name: string]: ToolContract.Any }, Env> = {
  readonly [Name in keyof Contracts & string]: (
    input: ToolContract.ShapeOf<Contracts[Name]>["input"],
    context: ImplementContext<Env>
  ) => Awaitable<ToolContract.OutputOf<Contracts[Name]> | Refused>
}

const encoder = new TextEncoder()

/**
 * Turns implementations into the kernel's dispatch handlers. Each handler
 * refuses a permit that is not live, runs the implementation, and maps its
 * ending: a value is delivered, `Refused` is a refusal, anything else thrown
 * is a failure the kernel records as uncertain.
 */
export const handlersFor = <Contracts extends ToolContracts, Env>(
  contracts: Contracts,
  implement: { readonly [name: string]: unknown },
  env: Env
): DispatchHandlers<Contracts> => {
  const handler = (name: keyof Contracts & string) =>
    (request: DispatchRequest<string, unknown>): Effect.Effect<Delivery<unknown>, DispatchFailed | DispatchRefused> => {
      if (!isLivePermit(request.permit)) {
        return Effect.fail(new DispatchRefused({ reason: "dispatch permit is not live" }))
      }
      // `defineAirlock` typed this record against the contracts; here it is read by name.
      const run = implement[name] as (input: unknown, context: ImplementContext<Env>) => Awaitable<unknown>
      const failed = () => new DispatchFailed({ reason: `${name} implementation failed` })
      return Effect.tryPromise({
        try: (signal) =>
          Promise.resolve().then(() => {
            const result = run(request.dispatch, {
              env,
              signal,
              idempotencyKey: request.permit.emissionId
            })
            if (!Effect.isEffect(result)) return result
            // An Effect's typed failure is handled like a thrown value.
            return Effect.runPromise(Effect.result(result as Effect.Effect<unknown, unknown>), { signal })
              .then((ended) => ended._tag === "Success" ? ended.success : Promise.reject(ended.failure))
          }),
        // The error's text is not recorded: it may quote the input or a credential.
        catch: (cause) => (isRefused(cause) ? new DispatchRefused({ reason: cause.reason }) : failed())
      }).pipe(
        Effect.flatMap((result) =>
          isRefused(result)
            ? Effect.fail(new DispatchRefused({ reason: result.reason }))
            : Effect.succeed({ outcome: result, response: encoder.encode(""), truncated: false })
        )
      )
    }
  const handlers: { [name: string]: unknown } = {}
  for (const name of Object.keys(contracts)) handlers[name] = handler(name)
  // One handler per registered contract, built by name; the mapped type states
  // the same correspondence, which a loop over keys cannot carry.
  return handlers as DispatchHandlers<Contracts>
}
