import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { WebCrypto } from "../src/core/index.ts"
import {
  expectedTranscript,
  makeMemoryLedgerState,
  makeMemoryOutboxState,
  memoryLedger,
  memoryOutboxStore,
  runWorkedExample
} from "../src/core/testing/index.ts"

describe("core: the worked example", () => {
  it.effect("plays the hosted-guest path end to end on the in-memory adapters", () =>
    Effect.gen(function* () {
      const transcript = yield* runWorkedExample({
        store: memoryOutboxStore(makeMemoryOutboxState()),
        ledger: memoryLedger(makeMemoryLedgerState()),
        crypto: WebCrypto.layer
      })
      expect(transcript).toEqual(expectedTranscript)
      // Four tools were reached, each exactly once, across two executions of the guest.
      expect(new Set(transcript.dispatched).size).toBe(transcript.dispatched.length)
    }))
})
