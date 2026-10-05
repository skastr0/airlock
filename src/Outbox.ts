import { Layer } from "effect"
import {
  defineOutbox,
  type Emission,
  HttpIntent,
  type OutboxOf,
  type OutboxService as CoreOutboxService
} from "./core/index.ts"
import * as FileLedger from "./host/FileLedger.ts"
import * as FileOutboxStore from "./host/FileOutboxStore.ts"
import { dispatchHttp } from "./host/HttpDispatcher.ts"

/**
 * This host's Outbox: the core kernel over the intent kinds Airlock stages
 * here. The kernel decides when a dispatch may happen and mints the permit;
 * the Layers below supply the durable store, the ledger and the wire.
 */
export const AirlockOutbox = defineOutbox({ http: HttpIntent })

export type IntentKinds = typeof AirlockOutbox.kinds
export const Outbox = AirlockOutbox.Outbox
export type Outbox = OutboxOf<IntentKinds>
export type OutboxService = CoreOutboxService<IntentKinds>
export const Dispatcher = AirlockOutbox.Dispatcher
export type OutboxEmission = Emission<IntentKinds>

/** One handler per intent kind; a kind without one does not compile. */
export const DispatcherLive = Layer.succeed(Dispatcher, Dispatcher.of({ http: dispatchHttp }))

/** The kernel over this host's file store, file ledger and HTTP wire. */
export const OutboxLive = AirlockOutbox.layer.pipe(
  Layer.provide(DispatcherLive),
  Layer.provide(FileOutboxStore.layer),
  Layer.provide(FileLedger.ledgerLayer)
)
