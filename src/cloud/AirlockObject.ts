import { Effect, Layer, ManagedRuntime } from "effect"
import {
  type Airlock,
  AirlockFailure,
  type EmissionView,
  type GuestLimits,
  type GuestOutcome,
  GuestRunner,
  type ToolContracts,
  WebCrypto
} from "../core/index.ts"
import { durableLedger } from "./DurableLedger.ts"
import { durableOutboxStore } from "./DurableOutboxStore.ts"
import { DurableObject, type ObjectState, type WorkerLoader } from "./Platform.ts"
import { workerLoaderRunner, type WorkerLoaderRunnerOptions } from "./WorkerLoaderRunner.ts"

/**
 * What crosses the Durable Object's RPC boundary: plain data either way. A
 * failure is a value, not a thrown error, because an error's class does not
 * survive RPC; `airlockClient` turns it back into one.
 */
export type Reply<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly code: AirlockFailure["code"]; readonly message: string }

/** What the guest is told it can do: for a prompt, and for typechecking guest code. */
export interface GuestDescription {
  readonly tools: ReadonlyArray<string>
  readonly declaration: string
  readonly description: string
}

/** The Durable Object's methods, as the trusted side calls them. */
export interface AirlockObjectApi {
  /** Runs untrusted guest source in a fresh isolate. Replaying a run id returns recorded results. */
  run(request: { readonly runId: string; readonly source: string }): Promise<Reply<GuestOutcome>>
  describe(): Promise<Reply<GuestDescription>>
  pending(): Promise<Reply<ReadonlyArray<EmissionView>>>
  inspect(id: string): Promise<Reply<EmissionView>>
  commit(id: string): Promise<Reply<EmissionView>>
  cancel(id: string): Promise<Reply<EmissionView>>
  compensate(id: string, holdMillis?: number): Promise<Reply<EmissionView>>
}

export interface AirlockObjectOptions<Env> {
  /** The Worker Loader binding, e.g. `(env) => env.LOADER`. */
  readonly loader: (env: Env) => WorkerLoader
  readonly runner?: WorkerLoaderRunnerOptions
  /** Limits for every guest run of this object. */
  readonly limits?: Partial<GuestLimits>
  /**
   * How long after an operation starts the object asks to be woken if that
   * operation never finished. Longer than any dispatch may take.
   */
  readonly recoveryAlarmMillis?: number
}

/** Past the kernel's 30 second dispatch timeout, with room to spare. */
const RECOVERY_ALARM_MILLIS = 60_000

/**
 * The Durable Object class for an Airlock definition. Export what this
 * returns from a Worker and bind it; that is the whole server side.
 *
 * One object is one Airlock: its own SQLite database holds its Outbox and its
 * Ledger. Implementations run here, with the Worker's bindings and secrets;
 * a guest runs in a separate isolate and is given none of them.
 */
export const airlockDurableObject = <Contracts extends ToolContracts, Env>(
  airlock: Airlock<Contracts, Env>,
  options: AirlockObjectOptions<Env>
) => {
  const services = (state: ObjectState, env: Env) =>
    Layer.mergeAll(
      airlock.layer(env).pipe(
        Layer.provideMerge(
          Layer.mergeAll(durableOutboxStore(state.storage), durableLedger(state.storage), WebCrypto.layer)
        )
      ),
      workerLoaderRunner(options.loader(env), options.runner)
    )
  type Services = Layer.Success<ReturnType<typeof services>>

  return class AirlockObject extends DurableObject implements AirlockObjectApi {
    readonly #env: Env
    readonly #state: ObjectState
    /** Operations that may dispatch and have not finished. */
    #working = 0
    /** Built on first use; building it runs the kernel's startup recovery. */
    readonly #runtime: ManagedRuntime.ManagedRuntime<Services, unknown>

    constructor(state: ObjectState, env: Env) {
      super(state, env as never)
      this.#env = env
      this.#state = state
      this.#runtime = ManagedRuntime.make(services(state, env))
    }

    #reply<Value>(effect: Effect.Effect<Value, AirlockFailure, Services>): Promise<Reply<Value>> {
      return this.#runtime.runPromise(
        effect.pipe(
          Effect.map((value): Reply<Value> => ({ ok: true, value })),
          Effect.catch((failure): Effect.Effect<Reply<Value>> =>
            Effect.succeed({ ok: false, code: failure.code, message: failure.message }))
        )
      ).catch((): Reply<Value> => ({
        // Storage could not be opened or read. Nothing about it is the caller's to see.
        ok: false,
        code: "unavailable",
        message: "this Airlock is unavailable"
      }))
    }

    /**
     * Runs an operation that may dispatch under a recovery alarm. If the
     * object dies while a dispatch is in flight, nobody may call it again for
     * a long time; the alarm wakes it so the interrupted emission is settled
     * as uncertain and its receipts are written. Finishing normally removes
     * the alarm.
     */
    async #guarded<Value>(operation: () => Promise<Reply<Value>>): Promise<Reply<Value>> {
      this.#working += 1
      try {
        await this.#state.storage.setAlarm(Date.now() + (options.recoveryAlarmMillis ?? RECOVERY_ALARM_MILLIS))
        return await operation()
      } catch {
        return { ok: false, code: "unavailable", message: "this Airlock is unavailable" }
      } finally {
        this.#working -= 1
        if (this.#working === 0) await this.#state.storage.deleteAlarm().catch(() => undefined)
      }
    }

    /**
     * The platform's wake-up. Opening the Airlock is what recovers it: the
     * kernel settles interrupted emissions and owed receipts on startup. An
     * alarm never commits anything: a staged write waits for a supervisor.
     */
    async alarm(): Promise<void> {
      await this.#runtime.runPromise(Effect.void).catch(() => undefined)
    }

    run(request: { readonly runId: string; readonly source: string }): Promise<Reply<GuestOutcome>> {
      // Copied out of the RPC argument before anything is awaited.
      const runId = String(request.runId)
      const source = String(request.source)
      const env = this.#env
      return this.#guarded(() => this.#reply(Effect.gen(function* () {
        const surface = yield* airlock.guest({ runId, env })
        const runner = yield* GuestRunner
        return yield* runner.run({
          source,
          surface,
          ...(options.limits === undefined ? {} : { limits: options.limits })
        })
      })))
    }

    describe(): Promise<Reply<GuestDescription>> {
      const env = this.#env
      return this.#reply(
        Effect.map(airlock.guest({ runId: "describe", env }), (surface) => ({
          tools: surface.tools,
          declaration: surface.declaration,
          description: surface.description
        }))
      )
    }

    pending(): Promise<Reply<ReadonlyArray<EmissionView>>> {
      return this.#reply(Effect.flatMap(airlock.supervisor, (supervisor) => supervisor.pending))
    }

    inspect(id: string): Promise<Reply<EmissionView>> {
      return this.#reply(Effect.flatMap(airlock.supervisor, (supervisor) => supervisor.inspect(String(id))))
    }

    commit(id: string): Promise<Reply<EmissionView>> {
      return this.#guarded(() =>
        this.#reply(Effect.flatMap(airlock.supervisor, (supervisor) => supervisor.commit(String(id)))))
    }

    cancel(id: string): Promise<Reply<EmissionView>> {
      return this.#reply(Effect.flatMap(airlock.supervisor, (supervisor) => supervisor.cancel(String(id))))
    }

    compensate(id: string, holdMillis?: number): Promise<Reply<EmissionView>> {
      return this.#reply(
        Effect.flatMap(airlock.supervisor, (supervisor) =>
          supervisor.compensate(String(id), typeof holdMillis === "number" ? holdMillis : 0))
      )
    }
  }
}

/** A failed Airlock operation, as the trusted side sees it. */
export class AirlockError extends Error {
  override readonly name = "AirlockError"
  constructor(readonly code: AirlockFailure["code"], message: string) {
    super(message)
  }
}

const unwrap = async <Value>(reply: Promise<Reply<Value>>): Promise<Value> => {
  const settled = await reply
  if (settled.ok) return settled.value
  throw new AirlockError(settled.code, settled.message)
}

/** A Durable Object namespace binding, as far as the client needs it. */
export interface AirlockNamespace {
  idFromName(name: string): unknown
  get(id: unknown): unknown
}

/**
 * The trusted side's view of one Airlock object: the same operations,
 * returning plain data and throwing `AirlockError` with a code and a sentence.
 */
export const airlockClient = (namespace: AirlockNamespace, name: string) => {
  const stub = namespace.get(namespace.idFromName(name)) as AirlockObjectApi
  return {
    run: (request: { readonly runId: string; readonly source: string }) => unwrap(stub.run(request)),
    describe: () => unwrap(stub.describe()),
    pending: () => unwrap(stub.pending()),
    inspect: (id: string) => unwrap(stub.inspect(id)),
    commit: (id: string) => unwrap(stub.commit(id)),
    cancel: (id: string) => unwrap(stub.cancel(id)),
    compensate: (id: string, holdMillis?: number) => unwrap(stub.compensate(id, holdMillis))
  }
}
