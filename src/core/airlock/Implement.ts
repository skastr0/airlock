import { Clock, DateTime, Effect, Result, Schema } from "effect"
import { canonicalJson } from "../Canonical.ts"
import type { ToolContract } from "../contract/ToolContract.ts"
import type { ResourceField } from "../contract/Resource.ts"
import { portableToolHost } from "../contract/PortableToolHost.ts"
import { type BoundResource, type HeldReference, type HostParameters, type ToolHost } from "../contract/ToolHost.ts"
import {
  type Delivery,
  DispatchFailed,
  type DispatchHandlers,
  DispatchRefused,
  type DispatchRequest
} from "../outbox/Dispatcher.ts"
import { enterImplementation, isLivePermit, permitAdmission, permitAuthorizes, type WireToken } from "../outbox/Outbox.ts"
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
  /** One-use host wire authority, valid only while this admitted call is live. */
  readonly wireToken: WireToken
  /** Exact fitting host authority and resources; implementations consume these bindings. */
  readonly host: HostParameters
  readonly resources: ReadonlyArray<BoundResource>
  /** Claimed durably before a reversible forward act. */
  readonly held?: HeldReference
  /** Rechecked by the host immediately before every forward act or merge. */
  readonly validUntil?: DateTime.Utc
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
  env: Env,
  host: ToolHost = portableToolHost
): DispatchHandlers<Contracts> => {
  const handler = (name: keyof Contracts & string) =>
    (request: DispatchRequest<string, unknown>): Effect.Effect<Delivery<unknown>, DispatchFailed | DispatchRefused> => Effect.gen(function* () {
      if (!isLivePermit(request.permit)) {
        return yield* new DispatchRefused({ reason: "dispatch permit is not live" })
      }
      const contract = contracts[name]
      if (contract === undefined) return yield* new DispatchRefused({ reason: "no contract is registered" })
      const invalid = () => new DispatchRefused({ reason: "dispatch does not match the tool contract" })
      const encoded = yield* Schema.encodeUnknownEffect(contract.dispatch)(request.dispatch).pipe(Effect.mapError(invalid))
      const canonical = yield* Effect.try({ try: () => canonicalJson(encoded), catch: invalid })
      if (!permitAuthorizes(request.permit, name, canonical)) return yield* new DispatchRefused({ reason: "permit does not authorize this exact dispatch" })
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(contract.dispatch))(canonical).pipe(Effect.mapError(invalid))
      const execution = permitAdmission(request.permit)?.execution
      if (execution !== undefined && (execution.tool !== name || execution.version !== contract.version || execution.effect !== contract.effect ||
        (execution.effect === "request" && execution.when === "now"))) return yield* invalid()
      if (execution === undefined && Object.keys(contract.resources).length > 0) {
        return yield* new DispatchRefused({ reason: "resource-bearing tool lacks admitted bindings" })
      }
      const grant = { tool: name, when: execution?.when ?? "approved", ...(execution?.host === undefined ? {} : { host: execution.host }) } as const
      const checked = host.validateGrant({ contract, grant })
      if (Result.isFailure(checked)) return yield* new DispatchRefused({ reason: "host cannot execute the admitted grant" })
      const resourcesByField = new Map<string, ReadonlyArray<BoundResource>>()
      const resources: BoundResource[] = []
      const evidence = execution?.resources ?? []
      const descriptors = Object.entries<ResourceField>(contract.resources)
      const ordered = [...descriptors.filter(([, descriptor]) => descriptor.kind === "executable" && descriptor.role === "root"),
        ...descriptors.filter(([, descriptor]) => !(descriptor.kind === "executable" && descriptor.role === "root"))]
      for (const [field, descriptor] of ordered) {
        const supplied = Object.hasOwn(input, field) ? input[field] : undefined
        const count = supplied === undefined ? 0 : descriptor.collection === "each" && Array.isArray(supplied) ? supplied.length : 1
        const bindings = evidence.filter((binding) => binding.field === field)
        if (bindings.length !== count) return yield* invalid()
        const bound: BoundResource[] = []
        for (let index = 0; index < count; index++) {
          const binding = bindings[index]!
          if (binding.kind !== descriptor.kind || canonicalJson(binding.rights) !== canonicalJson(descriptor.rights) ||
            binding.index !== (descriptor.collection === "each" ? index : undefined)) return yield* invalid()
          const parent = descriptor.kind === "executable" && descriptor.role === "descendant" ? resourcesByField.get(descriptor.parent)?.[0] : undefined
          if (descriptor.kind === "executable" && descriptor.role === "descendant" && parent === undefined) return yield* invalid()
          bound.push(yield* host.resources.rebind({ binding, ...(parent === undefined ? {} : { parent }) }).pipe(
            Effect.mapError(() => new DispatchRefused({ reason: "admitted resource identity no longer matches" }))
          ))
        }
        resourcesByField.set(field, bound)
      }
      for (const [field] of descriptors) resources.push(...(resourcesByField.get(field) ?? []))
      if (resources.length !== evidence.length) return yield* invalid()
      const clock = yield* Clock.Clock
      const expired = () => execution?.validUntil !== undefined && DateTime.toEpochMillis(execution.validUntil) <= clock.currentTimeMillisUnsafe()
      if (expired()) return yield* new DispatchRefused({ reason: "grant has expired" })
      const reversible = (contract.effect === "apply" || contract.effect === "invoke") && host.recovery !== undefined &&
        Result.isSuccess(host.validateGrant({ contract, grant: { ...grant, when: "now" } }))
      if (execution?.when === "now" && (contract.effect === "apply" || contract.effect === "invoke") && !reversible) {
        return yield* new DispatchRefused({ reason: "now has no durable way back" })
      }
      const held = !reversible ? undefined : execution === undefined
        ? undefined : yield* host.recovery!.prepare({
          callId: request.permit.emissionId, runId: execution.runId, tool: name, version: contract.version,
          inputDigest: request.permit.dispatchDigest, resources: evidence, host: execution.host ?? {}
        }).pipe(Effect.mapError(() => new DispatchRefused({ reason: "durable recovery could not be prepared" })))
      if (execution?.when === "now" && (contract.effect === "apply" || contract.effect === "invoke") && held === undefined) {
        return yield* new DispatchRefused({ reason: "now recovery was not durably prepared" })
      }
      // `defineAirlock` typed this record against the contracts; here it is read by name.
      const run = implement[name] as (input: unknown, context: ImplementContext<Env>) => Awaitable<unknown>
      const failed = () => new DispatchFailed({ reason: `${name} implementation failed` })
      return yield* Effect.tryPromise({
        try: (signal) =>
          Promise.resolve().then(() => {
            if (signal.aborted || !isLivePermit(request.permit)) throw refused("dispatch permit is not live")
            if (expired()) throw refused("grant has expired")
            const wireToken = enterImplementation(request.permit, name, canonical, signal, resources)
            if (wireToken === undefined) throw refused("dispatch permit does not authorize this request")
            const result = run(input, {
              env,
              signal,
              idempotencyKey: request.permit.emissionId,
              wireToken,
              host: execution?.host ?? {}, resources: Object.freeze(resources),
              ...(held === undefined ? {} : { held }),
              ...(execution?.validUntil === undefined ? {} : { validUntil: execution.validUntil })
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
    })
  const handlers: { [name: string]: unknown } = {}
  for (const name of Object.keys(contracts)) handlers[name] = handler(name)
  // One handler per registered contract, built by name; the mapped type states
  // the same correspondence, which a loop over keys cannot carry.
  return handlers as DispatchHandlers<Contracts>
}
