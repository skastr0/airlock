import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { programRunner, WebCrypto } from "../src/core/index.ts"
import {
  ledgerConformance,
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  guestRunnerConformance,
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
    const ledger = makeMemoryLedgerState()
    return { store: memoryOutboxStore(state, ledger), ledger: memoryLedger(ledger), ...memoryOutboxFaults(state) }
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
    const ledger = makeMemoryLedgerState()
    return {
      store: memoryOutboxStore(state, ledger),
      ledger: memoryLedger(ledger),
      crypto: WebCrypto.layer,
      ...memoryOutboxFaults(state)
    }
  })
)

guestRunnerConformance(
  runner,
  "Airlock programs over in-memory adapters",
  Effect.sync(() => {
    const ledger = makeMemoryLedgerState()
    return {
    store: memoryOutboxStore(makeMemoryOutboxState(), ledger),
    ledger: memoryLedger(ledger),
    crypto: WebCrypto.layer,
    runner: programRunner
    }
  })
)
