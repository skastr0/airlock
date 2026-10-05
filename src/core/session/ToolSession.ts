import { type Crypto, Effect, Schema } from "effect"
import {
  fittingToolGrants,
  toolDispatchDecision,
  type ToolGrantPolicy,
  validateToolGrants
} from "../admission/ToolGrant.ts"
import { canonicalJson, type DigestUnavailable, sha256Text } from "../Canonical.ts"
import type { ToolContract, ToolSummary } from "../contract/ToolContract.ts"
import type { EmissionState } from "../outbox/Lifecycle.ts"
import type { OutboxDefinition, OutboxOf, PerformError, StageError } from "../outbox/Outbox.ts"
import { DispatchProvenance, type EmissionId, IdempotencyKey } from "../outbox/Records.ts"

/** A registry made only of tool contracts, keyed by tool name. */
export type ToolContracts = { readonly [Name in string]: ToolContract<any> & { readonly tag: Name } }

/** A grant that still knows, in its type, which tool it is for. */
export type GrantFor<Name extends string> = ToolGrantPolicy & { readonly tool: Name }

// ── what a call returns ─────────────────────────────────────────────────────

/** A read that was admitted, sent, and recorded. Replays return the same value. */
export interface Performed<Output> {
  readonly _tag: "Performed"
  readonly id: EmissionId
  readonly outcome: Output
  readonly response: Uint8Array
}

/**
 * An act that was recorded and not sent: it waits for a supervisor. It carries
 * no outcome, now or on any replay, whatever the emission later becomes.
 */
export interface Staged {
  readonly _tag: "Staged"
  readonly id: EmissionId
  readonly state: EmissionState
  readonly summary: ToolSummary
}

/**
 * Only a tool whose contract says `read` can ever return an outcome through a
 * session. For every other tool the result type is `Staged` alone.
 */
export type CallResult<Contract> = ToolContract.EffectOf<Contract> extends "read"
  ? Performed<ToolContract.OutputOf<Contract>> | Staged
  : Staged

// ── errors ──────────────────────────────────────────────────────────────────

/** The grant set a session was asked to hold is not valid against its contracts. */
export class InvalidToolSession extends Schema.TaggedError<InvalidToolSession>()(
  "InvalidToolSession",
  { field: Schema.String, reason: Schema.String }
) {}

export class InvalidToolInput extends Schema.TaggedError<InvalidToolInput>()(
  "InvalidToolInput",
  { tool: Schema.String, reason: Schema.String }
) {}

/** The tool is granted, but not for these public argument values. Nothing was recorded. */
export class ToolCallNotGranted extends Schema.TaggedError<ToolCallNotGranted>()(
  "ToolCallNotGranted",
  { tool: Schema.String }
) {}

/** The session has used what it was given. Nothing was recorded for this call. */
export class SessionBudgetExceeded extends Schema.TaggedError<SessionBudgetExceeded>()(
  "SessionBudgetExceeded",
  {
    budget: Schema.Literals(["calls", "inputBytes"]),
    limit: Schema.Number
  }
) {}

export type ToolCallError =
  | SessionBudgetExceeded
  | InvalidToolInput
  | ToolCallNotGranted
  | DigestUnavailable
  | StageError
  | PerformError

// ── the session ─────────────────────────────────────────────────────────────

type Method<Contract> = (
  input: ToolContract.WireOf<Contract>
) => Effect.Effect<CallResult<Contract>, ToolCallError>

/**
 * One method per granted tool and nothing else. When the grants are typed, an
 * ungranted tool is not a member of this type; when they arrived as data, each
 * member is optional and is present only if a grant names it.
 */
export type ToolSession<Contracts extends ToolContracts, Granted extends string> =
  [string] extends [Granted]
    ? { readonly [Name in keyof Contracts & string]?: Method<Contracts[Name]> }
    : { readonly [Name in Granted & keyof Contracts & string]: Method<Contracts[Name]> }

export interface ToolSessionOptions<Granted extends string> {
  /**
   * Names one execution of a guest. A re-execution passes the same id, so each
   * call derives the key it derived before and gets the recorded result.
   */
  readonly runId: string
  /** Fixed for the life of the session. Nothing in the session can add to it. */
  readonly grants: ReadonlyArray<GrantFor<Granted>>
  readonly budget: {
    readonly maxCalls: number
    /** Total canonical input bytes across all calls. */
    readonly maxInputBytes: number
  }
  /** Hold applied to every call this session stages. */
  readonly holdMillis?: number
}

const encoder = new TextEncoder()

/**
 * Opens the call-time admission surface over one Outbox. Every method does the
 * same three things, in order: decode the input with the tool's contract,
 * decide against the grants, then either perform (an auto-committed read) or
 * stage (everything else).
 */
export const openToolSession = <Contracts extends ToolContracts, Granted extends string>(
  outbox: OutboxDefinition<Contracts>,
  options: ToolSessionOptions<Granted>
): Effect.Effect<
  ToolSession<Contracts, Granted>,
  InvalidToolSession,
  OutboxOf<Contracts> | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const contracts = outbox.kinds
    // The grant set is copied and frozen here; the session keeps no way to reach
    // the caller's array, and no method takes a grant.
    const grants: ReadonlyArray<ToolGrantPolicy> = Object.freeze([...options.grants])
    const rejection = validateToolGrants(grants, contracts)
    if (rejection !== undefined) return yield* new InvalidToolSession(rejection)
    const { maxCalls, maxInputBytes } = options.budget
    for (const [field, limit] of [["budget.maxCalls", maxCalls], ["budget.maxInputBytes", maxInputBytes]] as const) {
      if (!Number.isSafeInteger(limit) || limit < 0) {
        return yield* new InvalidToolSession({ field, reason: "must be a non-negative integer" })
      }
    }

    const service = yield* outbox.Outbox
    const crypto = yield* Effect.context<Crypto.Crypto>()
    const holdMillis = options.holdMillis ?? 0
    let calls = 0
    let inputBytes = 0

    const method = (contract: ToolContract.Any) => (wire: unknown) =>
      Effect.gen(function* () {
        // Budgets are charged before anything else and are never refunded, so a
        // call that fails for any reason still counts.
        const index = calls
        if (index >= maxCalls) {
          return yield* new SessionBudgetExceeded({ budget: "calls", limit: maxCalls })
        }
        calls += 1

        const input = yield* Schema.decodeUnknownEffect(contract.input)(wire).pipe(
          Effect.mapError((error) => new InvalidToolInput({ tool: contract.tag, reason: error.message }))
        )
        const summarized = contract.summarize(input)
        if (summarized._tag === "Failure") {
          return yield* new InvalidToolInput({ tool: contract.tag, reason: summarized.failure.reason })
        }
        const summary = summarized.success
        inputBytes += summary.inputBytes
        if (inputBytes > maxInputBytes) {
          return yield* new SessionBudgetExceeded({ budget: "inputBytes", limit: maxInputBytes })
        }

        if (fittingToolGrants(grants, summary).length === 0) {
          return yield* new ToolCallNotGranted({ tool: contract.tag })
        }

        // The key names this call of this run: same run, same position, same
        // input. A guest that diverges on re-execution gets a different key
        // and therefore a fresh, separately admitted emission.
        const encoded = yield* Schema.encodeEffect(contract.input)(input).pipe(
          Effect.mapError((error) => new InvalidToolInput({ tool: contract.tag, reason: error.message }))
        )
        const digest = yield* sha256Text(canonicalJson(encoded)).pipe(Effect.provide(crypto))
        const key = IdempotencyKey.make(
          `session:${encoder.encode(options.runId).byteLength}:${options.runId}:${index}:${contract.tag}:${digest}`
        )
        const request = { key, intent: { kind: contract.tag, dispatch: input }, holdMillis }

        const decision = toolDispatchDecision(grants, contracts, summary)
        if (decision._tag === "AutoCommit") {
          const performed = yield* service.perform(
            request,
            new DispatchProvenance({
              committedBy: "policy-auto",
              grantSelector: decision.selector,
              dispatchClass: "read",
              target: summary.target
            })
          )
          return {
            _tag: "Performed",
            id: performed.emission.id,
            outcome: performed.emission.outcome,
            response: performed.response
          } satisfies Performed<unknown>
        }
        const staged = yield* service.stage(request)
        return { _tag: "Staged", id: staged.id, state: staged.state, summary } satisfies Staged
      })

    const granted = new Set(grants.map((grant) => grant.tool))
    const session: { [name: string]: unknown } = {}
    for (const name of Object.keys(contracts)) {
      const contract = contracts[name]
      if (contract !== undefined && granted.has(name)) session[name] = method(contract)
    }
    // Built by name from the registry and the grant set; the mapped type states
    // the same correspondence, which a loop over keys cannot carry.
    return Object.freeze(session) as ToolSession<Contracts, Granted>
  })
