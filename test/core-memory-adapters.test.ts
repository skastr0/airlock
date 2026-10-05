import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SealedDispatch, WebCrypto } from "../src/core/index.ts"
import {
  ledgerConformance,
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore,
  outboxConformance,
  outboxStoreConformance
} from "../src/core/testing/index.ts"

const runner = { describe, test: it.effect }

outboxStoreConformance(
  runner,
  "in-memory reference adapter",
  Effect.sync(() => ({ store: memoryOutboxStore(makeMemoryOutboxState()) }))
)

ledgerConformance(
  runner,
  "in-memory reference adapter",
  Effect.sync(() => ({ ledger: memoryLedger(makeMemoryLedgerState()) }))
)

outboxConformance(
  runner,
  "in-memory reference adapters",
  Effect.sync(() => {
    const outbox = makeMemoryOutboxState()
    return {
      store: memoryOutboxStore(outbox),
      ledger: memoryLedger(makeMemoryLedgerState()),
      crypto: WebCrypto.layer,
      tamperDispatch: (id) =>
        Effect.sync(() => {
          const sealed = outbox.dispatches.get(id)
          if (sealed !== undefined) {
            outbox.dispatches.set(id, new SealedDispatch({
              digest: sealed.digest,
              canonical: sealed.canonical.replace("hello", "HELLO")
            }))
          }
        })
    }
  })
)
