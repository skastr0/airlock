import { type Crypto, DateTime, Effect, Schema } from "effect"
import {
  fittingToolGrants,
  toolDispatchDecision,
  type ToolGrantPolicy,
  unmetToolGrants,
  validateToolGrants
} from "../admission/ToolGrant.ts"
import { canonicalJson, type DigestUnavailable, sha256Text } from "../Canonical.ts"
import type { ToolContract, ToolSummary } from "../contract/ToolContract.ts"
import type { TrustedDecoder } from "../contract/Decoder.ts"
import { validateFlowRules } from "../contract/FlowRules.ts"
import { portableToolHost } from "../contract/PortableToolHost.ts"
import { type ToolHost, ResourceRefused } from "../contract/ToolHost.ts"
import { loadResourcePolicy } from "../admission/ResourcePolicy.ts"
import type { EmissionState } from "../outbox/Lifecycle.ts"
import type { OutboxDefinition, OutboxOf, PerformError, StageError } from "../outbox/Outbox.ts"
import {
  DispatchProvenance,
  EmissionAdmission,
  type EmissionId,
  IdempotencyKey
} from "../outbox/Records.ts"
import { ToolPolicy, toolPolicyDigest, type ToolPolicyFor } from "./ToolPolicy.ts"

/** A registry made only of tool contracts, keyed by tool name. */
export type ToolContracts = { readonly [Name in string]: ToolContract<any> & { readonly tag: Name } }

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
 * Only a capture currently returns an outcome through a
 * session. For every other tool the result type is `Staged` alone.
 */
export type CallResult<Contract> = ToolContract.EffectOf<Contract> extends "request"
  ? Staged : Performed<ToolContract.OutputOf<Contract>> | Staged

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
  {
    tool: Schema.String,
    /** For each grant on this tool, the public field whose condition was not met. */
    unmet: Schema.Array(Schema.Struct({ grantId: Schema.String, field: Schema.String }))
  }
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
  | ResourceRefused
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
  /**
   * The supervisor's decision for this session. Its grants and budget are
   * fixed for the life of the session; nothing in the session can add to them.
   */
  readonly policy: ToolPolicyFor<Granted>
  readonly decoders?: Readonly<Record<string, TrustedDecoder.Any>>
  readonly host?: ToolHost
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
  InvalidToolSession | DigestUnavailable,
  OutboxOf<Contracts> | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const contracts = outbox.kinds
    const host = options.host ?? portableToolHost
    const runId = options.runId
    const holdMillis = options.holdMillis ?? 0
    // The policy is decoded again here, so the session holds its own validated
    // copy. The JSON round trip also detaches nested FieldMatch JSON values;
    // a schema encode/decode alone can retain the caller's objects.
    const policyCodec = Schema.fromJsonString(ToolPolicy)
    const validated = yield* Schema.decodeUnknownEffect(Schema.toType(ToolPolicy), { onExcessProperty: "error" })(options.policy).pipe(
      Effect.mapError((error) => new InvalidToolSession({ field: "policy", reason: error.message }))
    )
    const policy = yield* Schema.encodeEffect(policyCodec)(validated).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(policyCodec, { onExcessProperty: "error" })),
      Effect.mapError((error) => new InvalidToolSession({ field: "policy", reason: error.message }))
    )
    const grants: ReadonlyArray<ToolGrantPolicy> = Object.freeze([...policy.toolGrants])
    const rejection = validateToolGrants(grants, contracts, host)
    if (rejection !== undefined) return yield* new InvalidToolSession(rejection)
    const flowRejection = validateFlowRules(policy.flowRules, contracts, options.decoders ?? {})
    if (flowRejection !== undefined) return yield* new InvalidToolSession(flowRejection)
    const resourcePolicy = yield* loadResourcePolicy(policy.resources, grants, contracts, host).pipe(
      Effect.mapError((error) => new InvalidToolSession({ field: error.field, reason: error.reason }))
    )
    for (const [name, fields] of Object.entries(policy.flow)) {
      const contract = Object.hasOwn(contracts, name) ? contracts[name] : undefined
      if (contract === undefined) return yield* new InvalidToolSession({ field: `policy.flow.${name}`, reason: "must name a registered tool" })
      for (const field of Object.keys(fields)) {
        if (!contract.flow.sinks.includes(field)) {
          return yield* new InvalidToolSession({ field: `policy.flow.${name}.${field}`, reason: "must name a declared disclosure sink" })
        }
      }
    }
    const { maxCalls, maxInputBytes } = policy.budget
    const policyDigest = yield* toolPolicyDigest(policy)

    const service = yield* outbox.Outbox
    const crypto = yield* Effect.context<Crypto.Crypto>()
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

        // Own the wire data before decoding or any asynchronous admission
        // work. Schema.Json may otherwise retain caller-owned nested values
        // that can change between grant matching and staging.
        const snapshot = yield* Effect.try({
          try: () => canonicalJson(wire),
          catch: () => new InvalidToolInput({ tool: contract.tag, reason: "must be JSON matching the tool's input schema" })
        })
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(contract.input), { onExcessProperty: "error" })(snapshot).pipe(
          Effect.mapError((error) => new InvalidToolInput({ tool: contract.tag, reason: error.message }))
        )
        const summarized = contract.summarize(input)
        if (summarized._tag === "Failure") {
          return yield* new InvalidToolInput({ tool: contract.tag, reason: summarized.failure.reason })
        }
        inputBytes += summarized.success.inputBytes
        if (inputBytes > maxInputBytes) {
          return yield* new SessionBudgetExceeded({ budget: "inputBytes", limit: maxInputBytes })
        }
        const bounded = yield* resourcePolicy.bind(contract, input, summarized.success)
        const summary = bounded.summary

        const fitting = fittingToolGrants(grants, summary, bounded.match)
        if (fitting.length === 0) {
          return yield* new ToolCallNotGranted({
            tool: contract.tag,
            unmet: unmetToolGrants(grants, summary, bounded.match)
          })
        }
        const grantIds = fitting.map((grant) => grant.id)
        const decision = toolDispatchDecision(grants, contracts, summary, { host, resource: bounded.match, now: yield* DateTime.now })
        if (decision._tag === "Refused") return yield* new ToolCallNotGranted({ tool: contract.tag, unmet: [{ grantId: grantIds.join(","), field: decision.reason }] })

        // The key names this call of this run: same run, same position, same
        // input. A guest that diverges on re-execution gets a different key
        // and therefore a fresh, separately admitted emission.
        const encoded = yield* Schema.encodeEffect(contract.input)(input).pipe(
          Effect.mapError((error) => new InvalidToolInput({ tool: contract.tag, reason: error.message }))
        )
        const digest = yield* sha256Text(canonicalJson(encoded)).pipe(Effect.provide(crypto))
        const key = IdempotencyKey.make(
          `session:${encoder.encode(runId).byteLength}:${runId}:${index}:${contract.tag}:${digest}`
        )
        const request = {
          key,
          intent: { kind: contract.tag, dispatch: input },
          holdMillis,
          admission: new EmissionAdmission({ policyDigest, grantIds, execution: {
            runId, tool: contract.tag, version: contract.version, effect: contract.effect,
            when: decision._tag === "Now" ? "now" : "approved", resources: bounded.resources.map((resource) => resource.binding),
            ...(decision.host === undefined ? {} : { host: decision.host }),
            ...(decision.validUntil === undefined ? {} : { validUntil: decision.validUntil })
          } })
        }

        if (decision._tag === "Now") {
          const performed = yield* service.perform(
            request,
            new DispatchProvenance({
              committedBy: "policy-auto",
              grantId: grantIds.join(","),
              grantSelector: summary.tool,
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
