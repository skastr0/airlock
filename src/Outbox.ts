import { Context, DateTime, Effect, Layer, Schema } from "effect"
import {
  EmissionId,
  EmissionNotPending,
  EmissionRequest,
  LedgerEntry,
  UnknownEmission
} from "./domain.ts"
import { Ledger, type LedgerError } from "./Ledger.ts"
import {
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
  RedactedEmissionRequest,
  UnsupportedExternalIntent
} from "./outbox/Contract.ts"
import {
  makeFileOutboxStore,
  type StoredEmission
} from "./outbox/FileOutboxStore.ts"

export {
  EmissionDispatchUncertain,
  ExternalCommandIntent,
  HttpExternalIntent,
  InvalidHoldDuration,
  InvalidOutboxIntent,
  OutboxEmission,
  OutboxStateCorrupt,
  OutboxStorageFailed,
  UnsupportedExternalIntent
} from "./outbox/Contract.ts"

type StageInput = EmissionRequest | ExternalIntent

type StageError =
  | InvalidHoldDuration
  | InvalidOutboxIntent
  | UnsupportedExternalIntent
  | OutboxStorageFailed
  | OutboxStateCorrupt
  | LedgerError

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
  | LedgerError

type CancelError = TransitionError | OutboxStateCorrupt | LedgerError

export class Outbox extends Context.Tag("airlock/Outbox")<
  Outbox,
  {
    readonly stage: (
      request: StageInput,
      holdMillis: number
    ) => Effect.Effect<OutboxEmission, StageError>
    readonly inspect: (
      id: EmissionId
    ) => Effect.Effect<OutboxEmission, ReadError>
    readonly commit: (
      id: EmissionId
    ) => Effect.Effect<OutboxEmission, CommitError>
    readonly cancel: (
      id: EmissionId
    ) => Effect.Effect<OutboxEmission, CancelError>
    readonly pending: Effect.Effect<
      ReadonlyArray<OutboxEmission>,
      OutboxStorageFailed | OutboxStateCorrupt
    >
    readonly flush: Effect.Effect<
      {
        readonly committed: ReadonlyArray<OutboxEmission>
        readonly failed: ReadonlyArray<string>
        readonly waiting: number
      },
      OutboxStorageFailed | OutboxStateCorrupt | LedgerError
    >
  }
>() {}

const encodeManifest = Schema.encode(
  Schema.parseJson(PersistedOutboxManifest)
)
const decodeManifest = Schema.decode(
  Schema.parseJson(PersistedOutboxManifest)
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

const newEmissionId = () =>
  EmissionId.make(`emi_${crypto.randomUUID().slice(0, 13)}`)

const parseFailure = (
  id: string,
  document: string
): OutboxStateCorrupt =>
  new OutboxStateCorrupt({ id, document })

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
    ...(outcome === undefined ? {} : { outcome })
  })

const make = Effect.gen(function* () {
  const store = yield* makeFileOutboxStore
  const ledger = yield* Ledger

  // A durable `committing` directory means dispatch might have begun before a
  // prior runtime stopped. Recovery can only tell the truth: uncertain.
  yield* store.withExclusive(store.recoverCommitting)

  const decodeStored = (
    stored: StoredEmission
  ): Effect.Effect<OutboxEmission, OutboxStateCorrupt> =>
    Effect.gen(function* () {
      const manifest = yield* decodeManifest(stored.manifestJson).pipe(
        Effect.mapError(() =>
          parseFailure(stored.id, "manifest.json")
        )
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
    holdMillis: number
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
    const stagedAt = yield* DateTime.now
    const id = newEmissionId()
    const summary = summarize(http)
    const manifest = new PersistedOutboxManifest({
      schemaVersion: "airlock/outbox-manifest/v1",
      id,
      intent: summary.intent,
      request: summary.request,
      stagedAt,
      holdUntil: DateTime.add(stagedAt, { millis: holdMillis })
    })
    const manifestJson = yield* encodeManifest(manifest).pipe(
      Effect.mapError(() => parseFailure(id, "manifest-encode"))
    )
    const dispatchJson = yield* encodeDispatch(summary.dispatch).pipe(
      Effect.mapError(() => parseFailure(id, "dispatch-encode"))
    )
    yield* store.create(id, manifestJson, dispatchJson)
    yield* ledger.record(
      new LedgerEntry({
        at: stagedAt,
        effect: "emission",
        act: "stage",
        ref: id,
        detail: `${http.method} ${summary.intent.endpoint}`
      })
    )
    return toEmission(manifest, "staged")
  })

  // The point of no return. This lexical body contains the only wire-capable
  // call in Outbox; all other methods manipulate inert durable state.
  const commit = Effect.fn("Outbox.commit")(function* (id: EmissionId) {
    return yield* store.withExclusive(Effect.gen(function* () {
      yield* transition(id, "staged", "committing")
      const stored = yield* store.read(id, "committing")
      const manifest = yield* decodeManifest(stored.manifestJson).pipe(
        Effect.mapError(() => parseFailure(id, "manifest.json"))
      )
      const dispatchJson = yield* store.readDispatch(id, "committing")
      const dispatch = yield* decodeDispatch(dispatchJson).pipe(
        Effect.mapError(() => parseFailure(id, "dispatch.json"))
      )

      const delivered = yield* Effect.tryPromise({
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
          // Response content will become a bounded Capture artifact. Outbox v1
          // needs only dispatch status, so it cancels rather than buffering an
          // attacker-controlled body.
          await response.body?.cancel()
          return {
            status: response.status
          }
        },
        catch: () =>
          new EmissionDispatchUncertain({
            id,
            reason: "transport-failed"
          })
      }).pipe(Effect.either)

      if (delivered._tag === "Left") {
        yield* markUncertainIfCommitting(id)
        return yield* delivered.left
      }

      const completedAt = yield* DateTime.now
      const outcome = new OutboxOutcome({
        ...delivered.right,
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
        .writeOutcome(id, "committing", outcomeJson)
        .pipe(
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

      yield* ledger.record(
        new LedgerEntry({
          at: completedAt,
          effect: "emission",
          act: "commit",
          ref: id,
          detail: `${manifest.intent.method} ${manifest.intent.endpoint} -> ${outcome.status}`
        })
      )
      return toEmission(manifest, "committed", outcome)
    }).pipe(Effect.ensuring(markUncertainIfCommitting(id))))
  })

  const cancel = Effect.fn("Outbox.cancel")(function* (id: EmissionId) {
    yield* transition(id, "staged", "cancelled")
    const cancelled = yield* inspect(id)
    const at = yield* DateTime.now
    yield* ledger.record(
      new LedgerEntry({
        at,
        effect: "emission",
        act: "cancel",
        ref: id,
        detail: `${cancelled.intent.method} ${cancelled.intent.endpoint}`
      })
    )
    return cancelled
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
      } else if (
        result.left._tag === "LedgerFilesystemError" ||
        result.left._tag === "LedgerDecodeError"
      ) {
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

  return Outbox.of({ stage, inspect, commit, cancel, pending, flush })
})

export const OutboxLive = Layer.effect(Outbox, make)
