import { type Crypto, Effect, Layer, Option, Schema } from "effect"
import type { ToolContract } from "../contract/ToolContract.ts"
import type { Ledger } from "../ledger/Ledger.ts"
import type { ClosedUnderCompensation } from "../outbox/Intent.ts"
import { defineOutbox, type OutboxDefinition, type OutboxOf } from "../outbox/Outbox.ts"
import type { OutboxStore } from "../outbox/OutboxStore.ts"
import {
  DispatchProvenance,
  EmissionId,
  EmissionRecord,
  type OutboxStateCorrupt,
  type OutboxStoreFailed
} from "../outbox/Records.ts"
import type { ToolPolicy } from "../session/ToolPolicy.ts"
import { openToolSession, type ToolContracts } from "../session/ToolSession.ts"
import { guestDeclaration, guestDescription } from "./Declaration.ts"
import { handlersFor, type Implementations } from "./Implement.ts"

// ── what a user and a guest see ─────────────────────────────────────────────

/** Contracts given as a list, keyed by their own names. */
export type ByName<List extends ReadonlyArray<ToolContract.Any>> = {
  readonly [Contract in List[number] as Contract["tag"]]: Contract
}

/** Why a call or an operation did not happen, as a code and a sentence. */
export class AirlockFailure extends Schema.TaggedError<AirlockFailure>()("AirlockFailure", {
  code: Schema.Literals([
    "unknown-tool",
    "invalid-input",
    "not-allowed",
    "budget-exceeded",
    "refused",
    "uncertain",
    "conflict",
    "not-pending",
    "not-found",
    "not-compensable",
    "invalid-policy",
    "unavailable"
  ]),
  message: Schema.String
}) {}

/** The receipt for a call that was recorded and now waits for a supervisor. */
export interface StagedReceipt {
  readonly staged: true
  readonly id: string
  readonly state: string
}

/** An emission as plain data: the stored record's JSON form. */
export type EmissionView = typeof EmissionRecord.Encoded

/** What a guest is handed: the granted tools, by name, and text describing them. */
export interface GuestSurface {
  /** Granted tool names, sorted. Nothing else can be called. */
  readonly tools: ReadonlyArray<string>
  /**
   * Calls one granted tool with its JSON input. A read that is pre-authorized
   * returns its result; anything else returns a staged receipt.
   */
  readonly call: (tool: string, input: unknown) => Effect.Effect<Schema.Json | StagedReceipt, AirlockFailure>
  /** TypeScript declaration of `tools` for exactly these tools. */
  readonly declaration: string
  /** One plain line per tool, for a prompt. */
  readonly description: string
}

/** The trusted side: what a supervisor can see and do. Results are plain data. */
export interface Supervisor {
  readonly pending: Effect.Effect<ReadonlyArray<EmissionView>, AirlockFailure>
  readonly inspect: (id: string) => Effect.Effect<EmissionView, AirlockFailure>
  readonly commit: (id: string) => Effect.Effect<EmissionView, AirlockFailure>
  readonly cancel: (id: string) => Effect.Effect<EmissionView, AirlockFailure>
  /** Stages the act that answers a committed call, if its contract declares one. */
  readonly compensate: (id: string, holdMillis?: number) => Effect.Effect<EmissionView, AirlockFailure>
}

export interface Airlock<Contracts extends ToolContracts, Env> {
  readonly contracts: Contracts
  /** The kernel underneath, for adapter authors. Users do not need it. */
  readonly outbox: OutboxDefinition<Contracts>
  readonly policy: (env: Env) => ToolPolicy
  /**
   * The Outbox with this definition's implementations as its handlers. A host
   * provides the store, the ledger and Crypto.
   */
  readonly layer: (env: Env) => Layer.Layer<
    OutboxOf<Contracts>,
    OutboxStoreFailed | OutboxStateCorrupt,
    OutboxStore | Ledger | Crypto.Crypto
  >
  /** Opens a guest's view for one run. Replaying a run id returns recorded results. */
  readonly guest: (options: {
    readonly runId: string
    readonly env: Env
  }) => Effect.Effect<GuestSurface, AirlockFailure, OutboxOf<Contracts> | Crypto.Crypto>
  readonly supervisor: Effect.Effect<Supervisor, never, OutboxOf<Contracts>>
}

// ── plain words for kernel errors ───────────────────────────────────────────

const failure = (code: AirlockFailure["code"], message: string) => new AirlockFailure({ code, message })

type Tagged = { readonly _tag: string }

const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback)

/** Every kernel error a user can meet, said in terms of their tool and their field. */
const explain = (subject: string) => (tagged: Tagged): AirlockFailure => {
  // Read by field name: the errors are a wide union of tagged classes.
  const error = tagged as Tagged & { readonly [field: string]: unknown }
  switch (error._tag) {
    case "AirlockFailure":
      return failure(error["code"] as AirlockFailure["code"], text(error["message"], subject))
    case "InvalidToolInput":
      return failure("invalid-input", `${subject} was given an invalid input: ${text(error["reason"], "it does not match the contract")}`)
    case "InvalidIntent":
      return failure("invalid-input", `${subject} was given an invalid ${text(error["field"], "input")}: ${text(error["reason"], "it does not match the contract")}`)
    case "ToolCallNotGranted": {
      const unmet = Array.isArray(error["unmet"]) ? error["unmet"] as ReadonlyArray<{ grantId: string; field: string }> : []
      return failure(
        "not-allowed",
        unmet.length === 0
          ? `${subject} is not allowed: no grant covers this call`
          : `${subject} is not allowed: ` +
            unmet.map((miss) => `\`${miss.field}\` is not allowed by grant "${miss.grantId}"`).join("; ")
      )
    }
    case "SessionBudgetExceeded":
      return failure(
        "budget-exceeded",
        error["budget"] === "calls"
          ? `${subject} was not run: this session has used its ${String(error["limit"])} calls`
          : `${subject} was not run: this session has used its ${String(error["limit"])} bytes of input`
      )
    case "EmissionRefused":
      return failure("refused", `${subject} was refused and nothing was sent: ${text(error["reason"], "no reason given")}`)
    case "EmissionDispatchUncertain":
      return failure("uncertain", `${subject} may or may not have happened (${text(error["reason"], "unknown")}); it will not be retried`)
    case "IdempotencyConflict":
      return failure("conflict", `${subject} was already recorded under this key with different content`)
    case "EmissionNotPending":
      return failure("not-pending", `${subject} is ${text(error["state"], "settled")} and can no longer be changed`)
    case "UnknownEmission":
      return failure("not-found", `${subject} does not exist`)
    case "NotCompensable":
      return failure(
        "not-compensable",
        error["reason"] === "irreversible"
          ? `${subject} cannot be answered: its contract declares no compensation`
          : `${subject} cannot be answered: it is ${text(error["state"], "not committed")}, not committed`
      )
    case "InvalidToolSession":
      return failure("invalid-policy", `the policy is not valid: ${text(error["field"], "policy")} ${text(error["reason"], "")}`.trim())
    default:
      return failure("unavailable", `${subject} could not be completed (${error._tag})`)
  }
}

const encodeRecord = Schema.encodeSync(EmissionRecord)

/**
 * The whole of a user's integration: their contracts, one ordinary function
 * per contract, and a policy. Everything else (the durable Outbox and Ledger,
 * sessions, the guest's tools, the supervisor's operations) is derived from it.
 */
export const defineAirlock = <const List extends ReadonlyArray<ToolContract.Any>, Env = unknown>(definition: {
  readonly contracts: List
  readonly implement: Implementations<ByName<List>, Env>
  readonly policy: ToolPolicy | ((env: Env) => ToolPolicy)
} & (ByName<List> extends infer Kinds extends ToolContracts ? { readonly __closed?: ClosedUnderCompensation<Kinds> } : never)): Airlock<ByName<List> & ToolContracts, Env> => {
  type Contracts = ByName<List> & ToolContracts
  const byName: { [name: string]: ToolContract.Any } = {}
  for (const contract of definition.contracts) {
    if (Object.hasOwn(byName, contract.tag)) {
      throw new TypeError(`two contracts are named ${contract.tag}`)
    }
    byName[contract.tag] = contract
  }
  // Keyed by each contract's own name; the mapped type says the same thing.
  const contracts = byName as Contracts
  const outbox = defineOutbox(contracts as Contracts & ClosedUnderCompensation<Contracts>)
  // The same definition, seen without the per-contract types: the facade works
  // by tool name and returns plain data, so it has no use for them.
  const kernel = outbox as unknown as OutboxDefinition<ToolContracts>
  const policy = (env: Env): ToolPolicy =>
    typeof definition.policy === "function" ? definition.policy(env) : definition.policy
  const bySupervisor = new DispatchProvenance({ committedBy: "supervisor" })

  const layer: Airlock<Contracts, Env>["layer"] = (env) =>
    outbox.layer.pipe(
      Layer.provide(Layer.succeed(outbox.Dispatcher, handlersFor(contracts, definition.implement, env)))
    )

  // `kernel` and `outbox` are one definition, so an effect that needs the
  // kernel's Outbox needs this definition's. Only the identifier type differs.
  const forThisDefinition = <A, E>(
    effect: Effect.Effect<A, E, OutboxOf<ToolContracts> | Crypto.Crypto>
  ) => effect as unknown as Effect.Effect<A, E, OutboxOf<Contracts> | Crypto.Crypto>

  const guest: Airlock<Contracts, Env>["guest"] = ({ runId, env }) =>
    forThisDefinition(Effect.gen(function* () {
      const opened = yield* openToolSession(kernel, { runId, policy: policy(env) }).pipe(
        Effect.mapError(explain("this session"))
      )
      const session: {
        readonly [name: string]: ((input: never) => Effect.Effect<unknown, Tagged>) | undefined
      } = opened
      const tools = Object.keys(session).sort()
      const granted = tools.flatMap((name) => {
        const contract = byName[name]
        return contract === undefined ? [] : [contract]
      })
      return {
        tools,
        declaration: guestDeclaration(granted),
        description: guestDescription(granted),
        call: (tool, input) => {
          const method = Object.hasOwn(session, tool) ? session[tool] : undefined
          if (method === undefined) {
            return Effect.fail(failure("unknown-tool", `${tool} is not a tool this session grants`))
          }
          return method(input as never).pipe(
            Effect.mapError(explain(tool)),
            Effect.map((result): Schema.Json | StagedReceipt => {
              const settled = result as
                | { readonly _tag: "Performed"; readonly outcome: unknown }
                | { readonly _tag: "Staged"; readonly id: string; readonly state: string }
              if (settled._tag === "Staged") return { staged: true, id: settled.id, state: settled.state }
              const contract = byName[tool]
              // A read's result leaves as the contract's encoded output: plain JSON.
              return contract === undefined
                ? null
                : Schema.encodeUnknownSync(contract.outcome)(settled.outcome)
            })
          )
        }
      } satisfies GuestSurface
    }))

  const supervisorOf: Effect.Effect<Supervisor, never, OutboxOf<ToolContracts>> = Effect.gen(function* () {
    const service = yield* kernel.Outbox
    const view = (emission: Parameters<typeof kernel.toRecord>[0], subject: string) =>
      kernel.toRecord(emission).pipe(
        Effect.map((record) => encodeRecord(record)),
        Effect.mapError(explain(subject))
      )
    const idOf = (id: string) =>
      Option.match(Schema.decodeUnknownOption(EmissionId)(id), {
        onNone: () => Effect.fail(failure("not-found", `${id} is not an emission id`)),
        onSome: (decoded) => Effect.succeed(decoded)
      })
    return {
      pending: service.pending.pipe(
        Effect.mapError(explain("the pending list")),
        Effect.flatMap(Effect.forEach((emission) => view(emission, emission.id)))
      ),
      inspect: (id) =>
        Effect.flatMap(idOf(id), (decoded) =>
          service.inspect(decoded).pipe(
            Effect.mapError(explain(id)),
            Effect.flatMap((emission) => view(emission, id))
          )),
      commit: (id) =>
        Effect.flatMap(idOf(id), (decoded) =>
          service.commit(decoded, bySupervisor).pipe(
            Effect.mapError(explain(id)),
            Effect.flatMap((emission) => view(emission, id))
          )),
      cancel: (id) =>
        Effect.flatMap(idOf(id), (decoded) =>
          service.cancel(decoded).pipe(
            Effect.mapError(explain(id)),
            Effect.flatMap((emission) => view(emission, id))
          )),
      compensate: (id, holdMillis = 0) =>
        Effect.flatMap(idOf(id), (decoded) =>
          service.inspect(decoded).pipe(
            Effect.flatMap((emission) =>
              // The kernel re-reads and re-checks the record; a call that is not
              // committed or not answerable is refused there.
              service.compensate(emission as Parameters<typeof service.compensate>[0], { holdMillis })
            ),
            Effect.mapError(explain(id)),
            Effect.flatMap((emission) => view(emission, id))
          ))
    }
  })

  const supervisor = forThisDefinition(supervisorOf) as Airlock<Contracts, Env>["supervisor"]

  return { contracts, outbox, policy, layer, guest, supervisor }
}
