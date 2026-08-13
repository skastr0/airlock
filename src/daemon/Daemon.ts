import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { policyDispatchDecision } from "../admission/Admission.ts"
import { type BoxGrantDaemonOp } from "../admission/BoxGrant.ts"
import { ActId, EmissionId } from "../domain.ts"
import {
  Hold,
  HoldFilesystemError,
  HoldReapRecoveryRequired
} from "../Hold.ts"
import {
  DispatchProvenance,
  Outbox,
  OutboxEmission,
  OutboxStateCorrupt,
  OutboxStorageFailed
} from "../Outbox.ts"
import {
  type VerifiedSeal,
  SealVerificationFailed,
  reverifySeal
} from "../seal/Seal.ts"

/**
 * A supervisor-supplied revalidation seam. Production uses the complete seal
 * verifier; tests may inject an Effect with the same fail-closed contract.
 */
export type DaemonReverify = (
  seal: VerifiedSeal
) => Effect.Effect<unknown, SealVerificationFailed>

/** Configuration shared by one tick and the persistent loop. */
export interface DaemonTickConfig {
  readonly seal: VerifiedSeal
  /**
   * Retention is deliberately a launch-time supervisor choice. Absence means
   * that a grant containing `reap` still performs no irreversible work.
   */
  readonly reapOlderThanMillis?: number
  readonly reverify?: DaemonReverify
}

export interface DaemonRunConfig extends DaemonTickConfig {
  /** A positive whole number of milliseconds between completed ticks. */
  readonly intervalMillis: number
}

export class DaemonConfigurationInvalid
  extends Schema.TaggedError<DaemonConfigurationInvalid>()(
    "DaemonConfigurationInvalid",
    {
      field: Schema.Literal("intervalMillis", "reapOlderThanMillis"),
      reason: Schema.String
    }
  ) {}

/** A terminal commit failure retained without serializing private request data. */
export class DaemonDispatchFailure
  extends Schema.TaggedClass<DaemonDispatchFailure>()(
    "DaemonDispatchFailure",
    {
      id: EmissionId,
      errorTag: Schema.String
    }
  ) {}

/**
 * Reserved grant vocabulary that this component intentionally does not turn
 * into an additional terminal authority path.
 */
export class DaemonOperationSkipped
  extends Schema.TaggedClass<DaemonOperationSkipped>()(
    "DaemonOperationSkipped",
    {
      operation: Schema.Literal("reap", "hold-expiry"),
      reason: Schema.Literal(
        "reap-retention-not-configured",
        "no-independent-terminal-authority"
      )
    }
  ) {}

/**
 * One auditable supervisor pass. Id arrays, rather than only counters, make a
 * failed dispatch distinguishable from evidence that was merely waiting.
 */
export class DaemonTickReport extends Schema.Class<DaemonTickReport>(
  "DaemonTickReport"
)({
  attempted: Schema.Array(EmissionId),
  committed: Schema.Array(EmissionId),
  failed: Schema.Array(DaemonDispatchFailure),
  waiting: Schema.NonNegativeInt,
  reaped: Schema.Array(ActId),
  skipped: Schema.optionalWith(Schema.Array(DaemonOperationSkipped), {
    default: () => []
  })
}) {}

export type DaemonTickError =
  | DaemonConfigurationInvalid
  | SealVerificationFailed
  | OutboxStorageFailed
  | OutboxStateCorrupt
  | HoldFilesystemError
  | HoldReapRecoveryRequired

type OutboxService = Context.Tag.Service<typeof Outbox>
type HoldService = Context.Tag.Service<typeof Hold>

type TickState = {
  readonly attempted: Array<EmissionId>
  readonly committed: Array<EmissionId>
  readonly failed: Array<DaemonDispatchFailure>
  waiting: number
  readonly reaped: Array<ActId>
  readonly skipped: Array<DaemonOperationSkipped>
}

const wholeNonNegative = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

const validateTickConfig = (
  config: DaemonTickConfig
): Effect.Effect<void, DaemonConfigurationInvalid> => {
  if (
    config.reapOlderThanMillis !== undefined &&
    !wholeNonNegative(config.reapOlderThanMillis)
  ) {
    return Effect.fail(new DaemonConfigurationInvalid({
      field: "reapOlderThanMillis",
      reason: "must be a nonnegative safe integer"
    }))
  }
  return Effect.void
}

const validateRunConfig = (
  config: DaemonRunConfig
): Effect.Effect<void, DaemonConfigurationInvalid> =>
  validateTickConfig(config).pipe(
    Effect.zipRight(
      Number.isSafeInteger(config.intervalMillis) && config.intervalMillis > 0
        ? Effect.void
        : Effect.fail(new DaemonConfigurationInvalid({
          field: "intervalMillis",
          reason: "must be a positive safe integer"
        }))
    )
  )

const terminalErrorTag = (error: object): string =>
  "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : "UnknownTerminalFailure"

const hasDaemonOp = (
  config: DaemonTickConfig,
  operation: BoxGrantDaemonOp
): boolean => config.seal.grant.daemonOps.includes(operation)

/**
 * Defense in depth around the Outbox discovery contract. A fixture or future
 * store cannot cause this component to classify manual, wider, mismatched, or
 * non-pending evidence as an unattended read dispatch. The tick separately
 * re-derives eligibility from the signed admission policy below; a copied seal
 * digest is not itself dispatch authority.
 */
const isAuthorizedReadEvidence = (
  emission: OutboxEmission
): boolean => {
  const authorization = emission.authorization
  return emission.status === "staged" &&
    authorization !== undefined &&
    authorization.dispatchClass === "read" &&
    authorization.sealDigest.length > 0 &&
    authorization.endpoint === emission.intent.endpoint
}

const tickWithServices = (
  config: DaemonTickConfig,
  outbox: OutboxService,
  hold: HoldService
): Effect.Effect<DaemonTickReport, DaemonTickError> =>
  Effect.gen(function* () {
    yield* validateTickConfig(config)

    const state: TickState = {
      attempted: [],
      committed: [],
      failed: [],
      waiting: 0,
      reaped: [],
      skipped: []
    }
    const verify = config.reverify ?? reverifySeal

    const commitImmediately = hasDaemonOp(config, "commit")
    const scheduleDue = !commitImmediately && hasDaemonOp(config, "flush")

    if (commitImmediately || scheduleDue) {
      const discovered = yield* outbox.pendingAuthorized(
        config.seal.grantDigest
      )
      const seen = new Set<string>()
      const authorized = discovered.filter((emission) => {
        if (!isAuthorizedReadEvidence(emission)) return false
        const authorization = emission.authorization
        if (authorization?.sealDigest !== config.seal.grantDigest) return false
        const decision = policyDispatchDecision(
          config.seal.grant.admission,
          {
            url: emission.intent.endpoint,
            method: emission.intent.method
          }
        )
        if (
          decision._tag !== "AutoCommit" ||
          decision.effectiveClass !== "read" ||
          decision.selector !== authorization.grantSelector
        ) return false
        if (seen.has(emission.id)) return false
        seen.add(emission.id)
        return true
      })

      // `commit` means an immediate scan: read-class automatic dispatch does
      // not require the cancellation delay to elapse. `flush` is deliberately
      // narrower than the legacy blanket method: it schedules only matching
      // authorized evidence whose existing hold deadline is due, and every
      // selected item still uses the ordinary single-item commit authority.
      let selected = authorized
      if (scheduleDue) {
        const now = yield* DateTime.now
        selected = authorized.filter((emission) =>
          DateTime.lessThanOrEqualTo(emission.holdUntil, now)
        )
      }
      state.waiting = authorized.length - selected.length

      for (const emission of selected) {
        const authorization = emission.authorization
        // The predicate above establishes this; retain a fail-closed guard so
        // later refactors cannot turn optional evidence into manual provenance.
        if (authorization === undefined) {
          state.waiting += 1
          continue
        }
        const provenance = new DispatchProvenance({
          committedBy: "policy-auto",
          grantId: authorization.grantId,
          grantSelector: authorization.grantSelector,
          dispatchClass: "read",
          endpoint: authorization.endpoint
        })

        // Do not construct the terminal Effect before revalidation: a service
        // implementation is not entitled to perform eager work at method-call
        // time. There is no yielded operation between this check and commit.
        state.attempted.push(emission.id)
        yield* verify(config.seal)
        const result = yield* outbox
          .commit(emission.id, provenance)
          .pipe(Effect.either)
        if (result._tag === "Right") {
          state.committed.push(emission.id)
        } else {
          state.failed.push(new DaemonDispatchFailure({
            id: emission.id,
            errorTag: terminalErrorTag(result.left)
          }))
        }
      }
    }

    if (hasDaemonOp(config, "reap")) {
      if (config.reapOlderThanMillis === undefined) {
        state.skipped.push(new DaemonOperationSkipped({
          operation: "reap",
          reason: "reap-retention-not-configured"
        }))
      } else {
        // Hold.reap remains the sole irreversible path. Reverify is immediately
        // adjacent to that terminal call just as it is for every commit.
        yield* verify(config.seal)
        const report = yield* hold.reap(config.reapOlderThanMillis)
        state.reaped.push(...report.reaped)
      }
    }

    if (hasDaemonOp(config, "hold-expiry")) {
      // The grant word is reserved, but it does not mint a scheduler-owned
      // discard primitive. A future semantic requires a separate design cut.
      state.skipped.push(new DaemonOperationSkipped({
        operation: "hold-expiry",
        reason: "no-independent-terminal-authority"
      }))
    }

    return new DaemonTickReport(state)
  })

/** Execute one pass using the already-composed Outbox and Hold services. */
export const daemonTick = (
  config: DaemonTickConfig
): Effect.Effect<DaemonTickReport, DaemonTickError, Outbox | Hold> =>
  Effect.gen(function* () {
    const outbox = yield* Outbox
    const hold = yield* Hold
    return yield* tickWithServices(config, outbox, hold)
  })

const runWithServices = (
  config: DaemonRunConfig,
  outbox: OutboxService,
  hold: HoldService
): Effect.Effect<never, DaemonTickError> =>
  validateRunConfig(config).pipe(
    Effect.zipRight(
      tickWithServices(config, outbox, hold).pipe(
        Effect.zipRight(Effect.sleep(config.intervalMillis)),
        Effect.forever
      )
    )
  )

/**
 * Run until interrupted. A tick failure (especially seal revalidation) exits
 * the loop; it is never converted into a delay-and-retry cycle.
 */
export const runDaemon = (
  config: DaemonRunConfig
): Effect.Effect<never, DaemonTickError, Outbox | Hold> =>
  Effect.gen(function* () {
    const outbox = yield* Outbox
    const hold = yield* Hold
    return yield* runWithServices(config, outbox, hold)
  })

/** Fork the loop in the caller's scope; closing that scope is daemon shutdown. */
export const startDaemon = (config: DaemonRunConfig) =>
  Effect.forkScoped(runDaemon(config))

/** A reusable in-process service for integrations that already own one Layer. */
export class Daemon extends Context.Tag("airlock/Daemon")<
  Daemon,
  {
    readonly tick: (
      config: DaemonTickConfig
    ) => Effect.Effect<DaemonTickReport, DaemonTickError>
    readonly run: (
      config: DaemonRunConfig
    ) => Effect.Effect<never, DaemonTickError>
  }
>() {}

const makeDaemon = Effect.gen(function* () {
  const outbox = yield* Outbox
  const hold = yield* Hold
  return Daemon.of({
    tick: (config) => tickWithServices(config, outbox, hold),
    run: (config) => runWithServices(config, outbox, hold)
  })
})

export const DaemonLive = Layer.effect(Daemon, makeDaemon)
