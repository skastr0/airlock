import { Effect, Layer } from "effect"
import {
  Canonical,
  type DispatchAuthorization,
  type EmissionId,
  HttpIntent,
  type HttpMethod,
  IdempotencyKey,
  StagedEmission,
  WebCrypto
} from "../../src/core/index.ts"
import {
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore
} from "../../src/core/testing/index.ts"
import { AirlockOutbox, Dispatcher, Outbox } from "../../src/Outbox.ts"

/**
 * The real Outbox kernel over the core's in-memory adapters, with a wire that
 * refuses to be reached. Staging, replay and authorization checks are the
 * kernel's own; a test that expects no dispatch gets a defect if one happens.
 */
export const stagingOnlyOutbox = (observe: {
  readonly staged?: (request: {
    readonly url: string
    readonly authorization: DispatchAuthorization | undefined
  }) => void
  readonly committed?: (id: EmissionId) => void
} = {}): Layer.Layer<Outbox> => {
  const kernel = AirlockOutbox.layer.pipe(
    Layer.provide(Layer.succeed(Dispatcher, Dispatcher.of({
      http: () => Effect.die("this test Outbox must never reach the wire")
    }))),
    Layer.provide(memoryOutboxStore(makeMemoryOutboxState())),
    Layer.provide(memoryLedger(makeMemoryLedgerState())),
    Layer.provide(WebCrypto.layer),
    Layer.orDie
  )
  return Layer.effect(
    Outbox,
    Effect.map(Effect.service(Outbox), (outbox) => Outbox.of({
      ...outbox,
      stage: (request) => {
        observe.staged?.({
          url: request.intent.dispatch.url,
          authorization: request.authorization
        })
        return outbox.stage(request)
      },
      commit: (id) => {
        observe.committed?.(id)
        return Effect.die("this test Outbox must never commit")
      }
    }))
  ).pipe(Layer.provide(kernel))
}

const sampleDigest = Canonical.Sha256Digest.make(`sha256:${"c".repeat(64)}`)

/** A staged HTTP record as the kernel would store it, for artifact fixtures. */
export const stagedHttpRecord = (input: {
  readonly id: EmissionId
  readonly url: string
  readonly method: HttpMethod
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly stagedAt: StagedEmission["stagedAt"]
  readonly holdUntil: StagedEmission["holdUntil"]
}): StagedEmission => {
  const summary = HttpIntent.summarize({
    url: input.url,
    method: input.method,
    headers: input.headers,
    ...(input.body === undefined ? {} : { body: input.body })
  })
  if (summary._tag === "Failure") throw new Error(`invalid fixture url ${input.url}`)
  return new StagedEmission({
    id: input.id,
    key: IdempotencyKey.make(`fixture:${input.id}`),
    kind: "http",
    dispatchDigest: sampleDigest,
    requestDigest: sampleDigest,
    summary: summary.success,
    ledgered: ["stage"],
    stagedAt: input.stagedAt,
    holdUntil: input.holdUntil
  })
}
