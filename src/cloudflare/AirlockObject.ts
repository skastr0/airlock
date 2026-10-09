import { Effect, Layer, ManagedRuntime } from "effect"
import {
  type Airlock,
  AirlockFailure,
  type EmissionView,
  type GuestAction,
  type GuestLimits,
  type GuestOutcome,
  guestLimits,
  GuestRunner,
  programRunner,
  type ToolContracts,
  WebCrypto
} from "../core/index.ts"
import { durableLedger } from "./DurableLedger.ts"
import { durableOutboxStore } from "./DurableOutboxStore.ts"
import { DurableObject, type ObjectState } from "./Platform.ts"

/**
 * What crosses the Durable Object's RPC boundary: plain data either way. A
 * failure is a value, not a thrown error, because an error's class does not
 * survive RPC; `airlockClient` turns it back into one.
 */
export type Reply<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly code: AirlockFailure["code"]; readonly message: string }

/** What an agent needs to write an Airlock program for this object. */
export interface GuestDescription {
  /** The granted actions: name, input and result shapes, and whether a call runs at once or is staged. */
  readonly actions: ReadonlyArray<GuestAction>
  /** The language in a few lines and one line per action, ready for a prompt. */
  readonly description: string
}

/** The Durable Object's methods, as the trusted side calls them. */
export interface AirlockObjectApi {
  /**
   * Runs an untrusted Airlock program (.air). Every action it calls is admitted,
   * recorded and staged by this object. Replaying a run id returns recorded results.
   */
  run(request: { readonly runId: string; readonly source: string }): Promise<Reply<GuestOutcome>>
  describe(): Promise<Reply<GuestDescription>>
  pending(): Promise<Reply<ReadonlyArray<EmissionView>>>
  inspect(id: string): Promise<Reply<EmissionView>>
  commit(id: string): Promise<Reply<EmissionView>>
  cancel(id: string): Promise<Reply<EmissionView>>
  compensate(id: string, holdMillis?: number): Promise<Reply<EmissionView>>
}

export interface AirlockObjectOptions {
  /**
   * How many programs may wait while one runs. The object evaluates one
   * program at a time, so what a program can hold in memory is held once; a
   * run that finds the line full is refused as `busy` and may be retried.
   * @default 8
   */
  readonly maxWaitingPrograms?: number
  /** Limits for every program this object runs. */
  readonly limits?: Partial<GuestLimits>
  /**
   * How long after an operation starts the object asks to be woken if that
   * operation never finished. Longer than any dispatch may take.
   */
  readonly recoveryAlarmMillis?: number
}

const MAX_WAITING_PROGRAMS = 8

/** Past the kernel's 30 second dispatch timeout, with room to spare. */
const RECOVERY_ALARM_MILLIS = 60_000

/**
 * The Durable Object class for an Airlock definition. Export what this
 * returns from a Worker and bind it; that is the whole server side.
 *
 * One object is one Airlock: its own SQLite database holds its Outbox and its
 * Ledger. Implementations run here, with the Worker's bindings and secrets.
 * A program is evaluated here too, and that is safe by what the language is:
 * it has no way to name a binding, a secret or the network, only the actions
 * its session grants.
 */
export const airlockDurableObject = <Contracts extends ToolContracts, Env>(
  airlock: Airlock<Contracts, Env>,
  options: AirlockObjectOptions = {}
) => {
  const services = (state: ObjectState, env: Env) =>
    Layer.mergeAll(
      airlock.layer(env).pipe(
        Layer.provideMerge(
          Layer.mergeAll(durableOutboxStore(state.storage), durableLedger(state.storage), WebCrypto.layer)
        )
      ),
      programRunner
    )
  type Services = Layer.Success<ReturnType<typeof services>>

  return class AirlockObject extends DurableObject implements AirlockObjectApi {
    readonly #env: Env
    readonly #state: ObjectState
    /** Operations that may dispatch and have not finished. */
    #working = 0
    /** Settles when the program now running, and every one ahead in the line, has ended. */
    #lastProgram: Promise<unknown> = Promise.resolve()
    /** The program running, if any, and those waiting behind it. */
    #programs = 0
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

    /**
     * Runs `program` once every program ahead of it has ended. Supervisor
     * operations do not wait in this line.
     */
    #inTurn<Value>(program: () => Promise<Reply<Value>>): Promise<Reply<Value>> {
      // One may always run; the limit is on those behind it.
      if (this.#programs > (options.maxWaitingPrograms ?? MAX_WAITING_PROGRAMS)) {
        return Promise.resolve({
          ok: false,
          code: "busy",
          message: "this Airlock is running as many programs as it holds; try again"
        })
      }
      this.#programs += 1
      const turn = this.#lastProgram.then(program).finally(() => {
        this.#programs -= 1
      })
      // The line moves on however this program ends.
      this.#lastProgram = turn.catch(() => undefined)
      return turn
    }

    run(request: { readonly runId: string; readonly source: string }): Promise<Reply<GuestOutcome>> {
      // Copied out of the RPC argument before anything is awaited.
      const runId = String(request.runId)
      const source = String(request.source)
      const env = this.#env
      // Refused before it can wait: the line never holds a source larger than a
      // program may be. Bytes are never fewer than the string's length.
      const maxCodeBytes = guestLimits(options.limits).maxCodeBytes
      if (source.length > maxCodeBytes || new TextEncoder().encode(source).length > maxCodeBytes) {
        return Promise.resolve({ ok: true, value: { ok: false, reason: "invalid_code", toolCalls: 0 } })
      }
      return this.#inTurn(() => this.#guarded(() => this.#reply(Effect.gen(function* () {
        const surface = yield* airlock.guest({ runId, env })
        const runner = yield* GuestRunner
        return yield* runner.run({
          source,
          surface,
          ...(options.limits === undefined ? {} : { limits: options.limits })
        })
      }))))
    }

    describe(): Promise<Reply<GuestDescription>> {
      const env = this.#env
      return this.#reply(
        Effect.map(airlock.guest({ runId: "describe", env }), (surface) => ({
          actions: surface.actions,
          description: surface.description
        }))
      )
    }

    pending(): Promise<Reply<ReadonlyArray<EmissionView>>> {
      return this.#reply(Effect.flatMap(airlock.supervisor(this.#env), (supervisor) => supervisor.pending))
    }

    inspect(id: string): Promise<Reply<EmissionView>> {
      return this.#reply(Effect.flatMap(airlock.supervisor(this.#env), (supervisor) => supervisor.inspect(String(id))))
    }

    commit(id: string): Promise<Reply<EmissionView>> {
      return this.#guarded(() =>
        this.#reply(Effect.flatMap(airlock.supervisor(this.#env), (supervisor) => supervisor.commit(String(id)))))
    }

    cancel(id: string): Promise<Reply<EmissionView>> {
      return this.#reply(Effect.flatMap(airlock.supervisor(this.#env), (supervisor) => supervisor.cancel(String(id))))
    }

    compensate(id: string, holdMillis?: number): Promise<Reply<EmissionView>> {
      return this.#reply(
        Effect.flatMap(airlock.supervisor(this.#env), (supervisor) =>
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
