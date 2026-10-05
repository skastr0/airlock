import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  ledgerConformance,
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore,
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
