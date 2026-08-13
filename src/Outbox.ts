import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import {
  EmissionId,
  EmissionNotPending,
  EmissionRequest,
  LedgerEntry,
  UnknownEmission
} from "./domain.ts"
import { Ledger, type LedgerError } from "./Ledger.ts"
import {
  DispatchProvenance,
  EmissionDispatchUncertain,
  ExternalCommandIntent,
  type ExternalIntent,
  HttpExternalIntent,
  HttpIntentSummary,
  InvalidHoldDuration,
  InvalidOutboxIntent,
  OutboxEmission,
  OutboxOutcome,
  type OutboxState,
  OutboxStateCorrupt,
  OutboxStorageFailed,
  PersistedOutboxManifest,
  PersistedOutboxOutcome,
  PrivateHttpDispatch,
  RedactedDispatchResponse,
  RedactedEmissionRequest,
  StagedDispatchAuthorization,
  type StagedDispatchSealDigest,
  UnsupportedExternalIntent
} from "./outbox/Contract.ts"
import {
  makeFileOutboxStore,
  type StoredEmission
} from "./outbox/FileOutboxStore.ts"

export {
  CanonicalDispatchEndpoint,
  CommitAuthority,
  DispatchProvenance,
  EmissionDispatchUncertain,
  ExternalCommandIntent,
  HttpExternalIntent,
  InvalidHoldDuration,
  InvalidOutboxIntent,
  OutboxEmission,
  OutboxOutcome,
  OutboxStateCorrupt,
  OutboxStorageFailed,
  RedactedDispatchResponse,
  StagedDispatchAuthorization,
  StagedDispatchSealDigest,
  UnsupportedExternalIntent
} from "./outbox/Contract.ts"

/**
 * The bound on a captured response body. It is a construction constant, not a
 * policy knob: an endpoint cannot enlarge it, and a program cannot request
 * more. Anything beyond the bound is discarded and the receipt says so.
 */
export const DISPATCH_RESPONSE_LIMIT_BYTES = 65_536

type StageInput = EmissionRequest | ExternalIntent

type StageError =
  | InvalidHoldDuration
  | InvalidOutboxIntent
  | UnsupportedExternalIntent
  | OutboxStorageFailed
  | OutboxStateCorrupt
  | OutboxRecoveryRequired

type ReadError =
  | UnknownEmission
  | OutboxStorageFailed
  | OutboxStateCorrupt

type TransitionError =
  | UnknownEmission
  | EmissionNotPending
  | OutboxStorageFailed
  | OutboxStateCorrupt

type CommitError =
  | ReadError
  | TransitionError
  | EmissionDispatchUncertain
  | OutboxRecoveryRequired

type CancelError =
  | TransitionError
  | OutboxStateCorrupt
  | OutboxRecoveryRequired

export class OutboxRecoveryRequired extends Schema.TaggedError<OutboxRecoveryRequired>()(
  "OutboxRecoveryRequired",
  {
    id: EmissionId,
    phase: Schema.Literal(
      "ledger-after-stage",
      "ledger-after-commit",
      "ledger-after-cancel"
    ),
    status: Schema.Literal("staged", "committed", "cancelled"),
    emission: OutboxEmission,
    reason: Schema.String
  }
) {}

export class Outbox extends Context.Tag("airlock/Outbox")<
  Outbox,
  {
    readonly stage: (
      request: StageInput,
      holdMillis: number,
      authorization?: StagedDispatchAuthorization
    ) => Effect.Effect<OutboxEmission, StageError>
    readonly inspect: (
      id: EmissionId
    ) => Effect.Effect<OutboxEmission, ReadError>
    /**
     * The only wire-capable operation. `provenance` is recorded, never
     * interpreted: a caller acting on a supervisor grant supplies the grant
     * identity and effective class, and omitting it records a bare manual
     * supervisor commit exactly as before.
     */
    readonly commit: (
      id: EmissionId,
      provenance?: DispatchProvenance
    ) => Effect.Effect<OutboxEmission, CommitError>
    readonly cancel: (
      id: EmissionId
    ) => Effect.Effect<OutboxEmission, CancelError>
    /**
     * The bounded response capture for a completed dispatch. Bytes never enter
     * a manifest, listing, or receipt; this is the single owner-side read that
     * lets the trusted runtime turn them into an artifact.
     */
    readonly response: (
      id: EmissionId
    ) => Effect.Effect<Uint8Array | undefined, ReadError>
    readonly pending: Effect.Effect<
      ReadonlyArray<OutboxEmission>,
      OutboxStorageFailed | OutboxStateCorrupt
    >
    /**
     * Discover only inert staged evidence bound to the current supervisor
     * seal. This reads redacted manifests and neither dispatches nor commits.
     */
    readonly pendingAuthorized: (
      sealDigest: StagedDispatchSealDigest
    ) => Effect.Effect<
      ReadonlyArray<OutboxEmission>,
      OutboxStorageFailed | OutboxStateCorrupt
    >
    readonly flush: Effect.Effect<
      {
        readonly committed: ReadonlyArray<OutboxEmission>
        readonly failed: ReadonlyArray<string>
        readonly waiting: number
      },
      OutboxStorageFailed | OutboxStateCorrupt | OutboxRecoveryRequired
    >
  }
>() {
  /** Keep handwritten pre-authorization service fixtures source-compatible. */
  static of(
    service: Omit<typeof Outbox.Service, "pendingAuthorized"> & {
      readonly pendingAuthorized?:
        typeof Outbox.Service["pendingAuthorized"]
    }
  ): typeof Outbox.Service
  static of(service: typeof Outbox.Service): typeof Outbox.Service
  static of(
    service: Omit<typeof Outbox.Service, "pendingAuthorized"> & {
      readonly pendingAuthorized?:
        typeof Outbox.Service["pendingAuthorized"]
    }
  ): typeof Outbox.Service {
    return {
      ...service,
      pendingAuthorized: service.pendingAuthorized ?? ((sealDigest) =>
        service.pending.pipe(
          Effect.map((emissions) =>
            emissions.filter(
              (emission) =>
                emission.authorization?.dispatchClass === "read" &&
                emission.authorization.sealDigest === sealDigest
            )
          )
        ))
    }
  }
}

const encodeManifest = Schema.encode(
  Schema.parseJson(PersistedOutboxManifest)
)
const decodeManifest = Schema.decode(
  Schema.parseJson(PersistedOutboxManifest),
  { onExcessProperty: "error" }
)
const encodeDispatch = Schema.encode(Schema.parseJson(PrivateHttpDispatch))
const decodeDispatch = Schema.decode(Schema.parseJson(PrivateHttpDispatch))
const encodeOutcome = Schema.encode(
  Schema.parseJson(PersistedOutboxOutcome)
)
const decodeOutcome = Schema.decode(
  Schema.parseJson(PersistedOutboxOutcome)
)

const textEncoder = new TextEncoder()

const ledgerFailureReason = (error: LedgerError) =>
  `${error._tag}: ${error.reason}`

const newEmissionId = () =>
  EmissionId.make(`emi_${crypto.randomUUID().slice(0, 13)}`)

const parseFailure = (
  id: string,
  document: string
): OutboxStateCorrupt =>
  new OutboxStateCorrupt({ id, document })

/**
 * Read at most `DISPATCH_RESPONSE_LIMIT_BYTES` from a response stream, then
 * cancel it. Reaching the bound is reported, never hidden: a truncated capture
 * is a fact the receipt carries rather than a silently shortened body.
 */
const readBounded = async (
  body: ReadableStream<Uint8Array> | null
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  if (body === null) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  let truncated = false
  try {
    while (total <= DISPATCH_RESPONSE_LIMIT_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      chunks.push(value)
      total += value.byteLength
      if (total > DISPATCH_RESPONSE_LIMIT_BYTES) {
        truncated = true
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const retained = Math.min(total, DISPATCH_RESPONSE_LIMIT_BYTES)
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= retained) break
    const take = Math.min(chunk.byteLength, retained - offset)
    bytes.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return { bytes, truncated }
}

const redactUrl = (raw: string) => {
  const url = new URL(raw)
  url.username = ""
  url.password = ""
  for (const key of new Set(url.searchParams.keys())) {
    url.searchParams.set(key, "[redacted]")
  }
  url.hash = ""
  return url.toString()
}

/** The actual normalized scheme/host/path fetch will address. */
const canonicalDispatchEndpoint = (raw: string) => {
  const url = new URL(raw)
  return `${url.protocol}//${url.host}${url.pathname}`
}

const manifestAuthorizationMatches = (
  manifest: PersistedOutboxManifest
): boolean => {
  if (manifest.authorization === undefined) return true
  try {
    return manifest.authorization.endpoint ===
      canonicalDispatchEndpoint(manifest.intent.endpoint)
  } catch {
    return false
  }
}

const asHttpIntent = (
  request: StageInput
): Effect.Effect<
  HttpExternalIntent,
  InvalidOutboxIntent | UnsupportedExternalIntent
> =>
  Effect.gen(function* () {
    if ("_tag" in request) {
      if (request._tag === "ExternalCommandIntent") {
        return yield* new UnsupportedExternalIntent({
          kind: "external-command",
          reason:
            "external commands require an admitted Cell execution closure"
        })
      }
      return request
    }
    return new HttpExternalIntent({
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body })
    })
  })

const validateHttpIntent = (intent: HttpExternalIntent) =>
  Effect.try({
    try: () => {
      const url = new URL(intent.url)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("only http and https endpoints are supported")
      }
      return intent
    },
    catch: () =>
      new InvalidOutboxIntent({
        field: "url",
        reason: "expected an absolute http or https URL"
      })
  })

const summarize = (intent: HttpExternalIntent) => {
  const headerNames = Object.keys(intent.headers).sort((a, b) =>
    a.localeCompare(b)
  )
  const bodyBytes =
    intent.body === undefined
      ? 0
      : textEncoder.encode(intent.body).byteLength
  const endpoint = redactUrl(intent.url)
  const redactedHeaders = Object.fromEntries(
    headerNames.map((name) => [name, "[redacted]"])
  )
  return {
    intent: new HttpIntentSummary({
      kind: "http",
      method: intent.method,
      endpoint,
      headerNames,
      bodyBytes
    }),
    request: new RedactedEmissionRequest({
      method: intent.method,
      url: endpoint,
      headers: redactedHeaders,
      ...(intent.body === undefined
        ? {}
        : { body: `[redacted:${bodyBytes} bytes]` })
    }),
    dispatch: new PrivateHttpDispatch({
      schemaVersion: "airlock/http-dispatch/v1",
      url: intent.url,
      method: intent.method,
      headers: intent.headers,
      ...(intent.body === undefined ? {} : { body: intent.body })
    })
  }
}

const toEmission = (
  manifest: PersistedOutboxManifest,
  status: OutboxState,
  outcome?: OutboxOutcome
) =>
  new OutboxEmission({
    id: manifest.id,
    status,
    intent: manifest.intent,
    request: manifest.request,
    stagedAt: manifest.stagedAt,
    holdUntil: manifest.holdUntil,
    ...(manifest.authorization === undefined
      ? {}
      : { authorization: manifest.authorization }),
    ...(outcome === undefined ? {} : { outcome })
  })

const make = Effect.gen(function* () {
  const store = yield* makeFileOutboxStore
  const ledger = yield* Ledger

  // A durable `committing` directory means dispatch might have begun before a
  // prior runtime stopped. Recovery can only tell the truth: uncertain.
  yield* store.withExclusive(store.recoverCommitting)

  const decodeStoredManifest = (
    id: string,
    manifestJson: string
  ): Effect.Effect<PersistedOutboxManifest, OutboxStateCorrupt> =>
    Effect.gen(function* () {
      const manifest = yield* decodeManifest(manifestJson).pipe(
        Effect.mapError(() => parseFailure(id, "manifest.json"))
      )
      if (!manifestAuthorizationMatches(manifest)) {
        return yield* parseFailure(id, "manifest.json")
      }
      return manifest
    })

  const decodeStored = (
    stored: StoredEmission
  ): Effect.Effect<OutboxEmission, OutboxStateCorrupt> =>
    Effect.gen(function* () {
      const manifest = yield* decodeStoredManifest(
        stored.id,
        stored.manifestJson
      )
      const outcome =
        stored.outcomeJson === undefined
          ? undefined
          : (yield* decodeOutcome(stored.outcomeJson).pipe(
              Effect.mapError(() =>
                parseFailure(stored.id, "outcome.json")
              )
            )).outcome
      return toEmission(manifest, stored.state, outcome)
    })

  const inspect = Effect.fn("Outbox.inspect")(function* (id: EmissionId) {
    const state = yield* store.findState(id)
    if (state === undefined) {
      return yield* new UnknownEmission({ id })
    }
    return yield* store.read(id, state).pipe(Effect.flatMap(decodeStored))
  })

  const transition = Effect.fn("Outbox.transition")(function* (
    id: EmissionId,
    from: OutboxState,
    to: OutboxState
  ) {
    const moved = yield* store.transition(id, from, to).pipe(Effect.either)
    if (moved._tag === "Right") return

    const state = yield* store.findState(id)
    if (state === undefined) {
      return yield* new UnknownEmission({ id })
    }
    if (state !== from) {
      return yield* new EmissionNotPending({ id, status: state })
    }
    return yield* moved.left
  })

  const markUncertainIfCommitting = (id: EmissionId) =>
    store.findState(id).pipe(
      Effect.flatMap((state) =>
        state === "committing"
          ? store.transition(id, "committing", "uncertain")
          : Effect.void
      ),
      Effect.ignore
    )

  const stage = Effect.fn("Outbox.stage")(function* (
    request: StageInput,
    holdMillis: number,
    authorization?: StagedDispatchAuthorization
  ) {
    if (
      !Number.isFinite(holdMillis) ||
      !Number.isInteger(holdMillis) ||
      holdMillis < 0
    ) {
      return yield* new InvalidHoldDuration({ holdMillis })
    }

    const http = yield* asHttpIntent(request).pipe(
      Effect.flatMap(validateHttpIntent)
    )
    const summary = summarize(http)
    if (
      authorization !== undefined &&
      authorization.endpoint !== canonicalDispatchEndpoint(http.url)
    ) {
      return yield* new InvalidOutboxIntent({
        field: "authorization.endpoint",
        reason: "must equal the staged request's canonical endpoint"
      })
    }
    const stagedAt = yield* DateTime.now
    const id = newEmissionId()
    const manifest = new PersistedOutboxManifest({
      schemaVersion: "airlock/outbox-manifest/v1",
      id,
      intent: summary.intent,
      request: summary.request,
      stagedAt,
      holdUntil: DateTime.add(stagedAt, { millis: holdMillis }),
      ...(authorization === undefined ? {} : { authorization })
    })
    const manifestJson = yield* encodeManifest(manifest).pipe(
      Effect.mapError(() => parseFailure(id, "manifest-encode"))
    )
    const dispatchJson = yield* encodeDispatch(summary.dispatch).pipe(
      Effect.mapError(() => parseFailure(id, "dispatch-encode"))
    )
    const staged = toEmission(manifest, "staged")
    const stageRecovery = (reason: string) =>
      new OutboxRecoveryRequired({
        id,
        phase: "ledger-after-stage",
        status: "staged",
        emission: staged,
        reason
      })
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Publishing the staged directory and publishing its caller-visible
        // recovery receipt are one cancellation boundary. Filesystem work is
        // deliberately small; only the fallible Ledger append is restored.
        yield* store.create(id, manifestJson, dispatchJson)
        const recorded = yield* restore(
          ledger.record(
            new LedgerEntry({
              at: stagedAt,
              effect: "emission",
              act: "stage",
              ref: id,
              detail: `${http.method} ${summary.intent.endpoint}`
            })
          ).pipe(
            Effect.mapError((error) =>
              stageRecovery(ledgerFailureReason(error))
            )
          )
        ).pipe(Effect.exit)
        if (Exit.isFailure(recorded)) {
          return yield* Cause.isInterruptedOnly(recorded.cause)
            ? stageRecovery("ledger append interrupted after durable stage")
            : Effect.failCause(recorded.cause)
        }
      })
    )
    return staged
  })

  // The point of no return. This lexical body contains the only wire-capable
  // call in Outbox; all other methods manipulate inert durable state.
  const commit = Effect.fn("Outbox.commit")(function* (
    id: EmissionId,
    provenance: DispatchProvenance = new DispatchProvenance({
      committedBy: "supervisor"
    })
  ) {
    return yield* store.withExclusive(Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
      yield* transition(id, "staged", "committing")
      const stored = yield* store.read(id, "committing")
      const manifest = yield* decodeStoredManifest(id, stored.manifestJson)
      const dispatchJson = yield* store.readDispatch(id, "committing")
      const dispatch = yield* decodeDispatch(dispatchJson).pipe(
        Effect.mapError(() => parseFailure(id, "dispatch.json"))
      )

      // Dispatch is the interruptible portion. Once dispatch has begun,
      // interruption is an honest uncertain outcome rather than a bare fiber
      // interruption that erases the caller's operation receipt.
      const deliveredExit = yield* restore(
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(dispatch.url, {
              method: dispatch.method,
              headers: dispatch.headers,
              redirect: "manual",
              signal,
              ...(dispatch.body === undefined
                ? {}
                : { body: dispatch.body })
            })
            // The response body is attacker-controlled content, so it is read
            // under a construction bound and then cancelled: the reader stops
            // at the first chunk that crosses the limit and never buffers an
            // unbounded stream. Bytes leave here only for the owner-only
            // emission directory.
            const captured = await readBounded(response.body)
            return {
              status: response.status,
              contentType: response.headers.get("content-type") ?? undefined,
              bytes: captured.bytes,
              truncated: captured.truncated
            }
          },
          catch: () =>
            new EmissionDispatchUncertain({
              id,
              reason: "transport-failed"
            })
        }).pipe(Effect.either)
      ).pipe(Effect.exit)

      if (Exit.isFailure(deliveredExit)) {
        yield* markUncertainIfCommitting(id)
        return yield* Cause.isInterruptedOnly(deliveredExit.cause)
          ? new EmissionDispatchUncertain({
              id,
              reason: "interrupted"
            })
          : Effect.failCause(deliveredExit.cause)
      }
      const delivered = deliveredExit.value

      if (delivered._tag === "Left") {
        yield* markUncertainIfCommitting(id)
        return yield* delivered.left
      }

      const completedAt = yield* DateTime.now
      const outcome = new OutboxOutcome({
        status: delivered.right.status,
        responseBytes: delivered.right.bytes.byteLength,
        response: new RedactedDispatchResponse({
          status: delivered.right.status,
          ...(delivered.right.contentType === undefined
            ? {}
            : { contentType: delivered.right.contentType }),
          retainedBytes: delivered.right.bytes.byteLength,
          truncated: delivered.right.truncated,
          limitBytes: DISPATCH_RESPONSE_LIMIT_BYTES
        }),
        provenance,
        completedAt
      })
      const outcomeJson = yield* encodeOutcome(
        new PersistedOutboxOutcome({
          schemaVersion: "airlock/outbox-outcome/v1",
          outcome
        })
      ).pipe(
        Effect.mapError(
          () =>
            new EmissionDispatchUncertain({
              id,
              reason: "persistence-failed-after-dispatch"
            })
        )
      )

      const finalized = yield* store
        .writeResponse(id, "committing", delivered.right.bytes)
        .pipe(
          Effect.zipRight(store.writeOutcome(id, "committing", outcomeJson)),
          Effect.zipRight(
            store.transition(id, "committing", "committed")
          ),
          Effect.either
        )
      if (finalized._tag === "Left") {
        yield* markUncertainIfCommitting(id)
        return yield* new EmissionDispatchUncertain({
          id,
          reason: "persistence-failed-after-dispatch"
        })
      }

      const committed = toEmission(manifest, "committed", outcome)
      const commitRecovery = (reason: string) =>
        new OutboxRecoveryRequired({
          id,
          phase: "ledger-after-commit",
          status: "committed",
          emission: committed,
          reason
        })
      const recorded = yield* restore(
        ledger.record(
          new LedgerEntry({
            at: completedAt,
            effect: "emission",
            act: "commit",
            ref: id,
            // The Ledger line is the human-readable receipt: it names the
            // committing authority and the grant that authorized the wire, not
            // just the transport result.
            detail:
              `${manifest.intent.method} ${manifest.intent.endpoint} -> ${outcome.status}` +
              ` [by=${provenance.committedBy}` +
              `${provenance.dispatchClass === undefined ? "" : ` class=${provenance.dispatchClass}`}` +
              `${provenance.grantId === undefined ? "" : ` grant=${provenance.grantId}`}` +
              `${provenance.grantSelector === undefined ? "" : ` selector=${provenance.grantSelector}`}]`
          })
        ).pipe(
          Effect.mapError((error) =>
            commitRecovery(ledgerFailureReason(error))
          )
        )
      ).pipe(Effect.exit)
      if (Exit.isFailure(recorded)) {
        return yield* Cause.isInterruptedOnly(recorded.cause)
          ? commitRecovery("ledger append interrupted after durable commit")
          : Effect.failCause(recorded.cause)
      }
      return committed
    })
    ).pipe(Effect.ensuring(markUncertainIfCommitting(id))))
  })

  const cancel = Effect.fn("Outbox.cancel")(function* (id: EmissionId) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* transition(id, "staged", "cancelled")
        const cancelled = yield* inspect(id)
        const at = yield* DateTime.now
        const cancelRecovery = (reason: string) =>
          new OutboxRecoveryRequired({
            id,
            phase: "ledger-after-cancel",
            status: "cancelled",
            emission: cancelled,
            reason
          })
        const recorded = yield* restore(
          ledger.record(
            new LedgerEntry({
              at,
              effect: "emission",
              act: "cancel",
              ref: id,
              detail: `${cancelled.intent.method} ${cancelled.intent.endpoint}`
            })
          ).pipe(
            Effect.mapError((error) =>
              cancelRecovery(ledgerFailureReason(error))
            )
          )
        ).pipe(Effect.exit)
        if (Exit.isFailure(recorded)) {
          return yield* Cause.isInterruptedOnly(recorded.cause)
            ? cancelRecovery("ledger append interrupted after durable cancel")
            : Effect.failCause(recorded.cause)
        }
        return cancelled
      })
    )
  })

  const response = Effect.fn("Outbox.response")(function* (id: EmissionId) {
    const state = yield* store.findState(id)
    if (state === undefined) {
      return yield* new UnknownEmission({ id })
    }
    return yield* store.readResponse(id, state)
  })

  const pending = store.list("staged").pipe(
    Effect.flatMap((stored) =>
      Effect.forEach(stored, decodeStored, { concurrency: 1 })
    ),
    Effect.map((emissions) =>
      emissions.sort(
        (a, b) =>
          DateTime.toEpochMillis(a.stagedAt) -
          DateTime.toEpochMillis(b.stagedAt)
      )
    )
  )

  const pendingAuthorized = (
    sealDigest: StagedDispatchSealDigest
  ) => pending.pipe(
    Effect.map((emissions) =>
      emissions.filter(
        (emission) =>
          emission.authorization?.dispatchClass === "read" &&
          emission.authorization.sealDigest === sealDigest
      )
    )
  )

  const flush = Effect.gen(function* () {
    const now = yield* DateTime.now
    const staged = yield* pending
    const due = staged.filter((emission) =>
      DateTime.lessThanOrEqualTo(emission.holdUntil, now)
    )
    const committed: Array<OutboxEmission> = []
    const failed: Array<string> = []
    for (const emission of due) {
      const result = yield* commit(emission.id).pipe(Effect.either)
      if (result._tag === "Right") {
        committed.push(result.right)
      } else if (result.left._tag === "OutboxRecoveryRequired") {
        return yield* result.left
      } else {
        failed.push(emission.id)
      }
    }
    return {
      committed,
      failed,
      waiting: staged.length - due.length
    }
  })

  return Outbox.of({
    stage,
    inspect,
    commit,
    cancel,
    response,
    pending,
    pendingAuthorized,
    flush
  })
})

export const OutboxLive = Layer.effect(Outbox, make)
