import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { WebCrypto } from "../src/core/index.ts"
import {
  ledgerConformance,
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  guestRunnerConformance,
  memoryGuestRunner,
  memoryLedger,
  memoryOutboxFaults,
  memoryOutboxStore,
  outboxConformance,
  outboxStoreConformance
} from "../src/core/testing/index.ts"

const runner = { describe, test: it.effect }

outboxStoreConformance(
  runner,
  "in-memory reference adapter",
  Effect.sync(() => {
    const state = makeMemoryOutboxState()
    return { store: memoryOutboxStore(state), ...memoryOutboxFaults(state) }
  })
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
    const state = makeMemoryOutboxState()
    return {
      store: memoryOutboxStore(state),
      ledger: memoryLedger(makeMemoryLedgerState()),
      crypto: WebCrypto.layer,
      ...memoryOutboxFaults(state)
    }
  })
)

guestRunnerConformance(
  runner,
  "in-process reference (not a sandbox)",
  Effect.sync(() => ({
    store: memoryOutboxStore(makeMemoryOutboxState()),
    ledger: memoryLedger(makeMemoryLedgerState()),
    crypto: WebCrypto.layer,
    runner: memoryGuestRunner,
    isolated: false
  }))
)
