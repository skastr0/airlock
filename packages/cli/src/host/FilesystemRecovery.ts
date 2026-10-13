import { DateTime, Effect } from "effect"
import {
  type HeldReference,
  type HostRecovery,
  RecoveryFailed
} from "@skastr0/airlock"
import type { HeldActReport, HeldCallReference, HeldCalls } from "./HeldCalls.ts"

/**
 * The kernel's recovery port, answered by Hold through `HeldCalls`. Plain
 * glue: it renames fields and folds this host's finer answers into the
 * port's. Where an answer is folded, the reason says what was folded.
 */

/** The kernel's reference, as `HeldCalls` names it. */
export const heldCallReference = (reference: HeldReference): HeldCallReference => ({
  callId: reference.callId,
  recoveryId: reference.recoveryId,
  heldUntil: DateTime.formatIso(reference.heldUntil)
})

const perAct = (acts: ReadonlyArray<HeldActReport>) =>
  acts.map((act, index) => `${index}:${act.status}`).join(",")

export const filesystemRecovery = (calls: HeldCalls["Service"]): HostRecovery => {
  const failed = (callId: string) => (error: { readonly _tag: string }) =>
    new RecoveryFailed({ callId, reason: error._tag })
  return {
    prepare: (call) =>
      calls.prepare({
        callId: call.callId,
        runId: call.runId,
        tool: call.tool,
        version: call.version,
        inputDigest: call.inputDigest,
        resources: { bindings: call.resources, host: call.host }
      }).pipe(
        Effect.map((reference) => ({
          callId: reference.callId,
          recoveryId: reference.recoveryId,
          heldUntil: DateTime.makeUnsafe(reference.heldUntil)
        })),
        Effect.mapError(failed(call.callId))
      ),
    inspect: (reference) =>
      calls.inspect(heldCallReference(reference)).pipe(
        Effect.map((state) => {
          switch (state.state) {
            case "prepared":
            case "done":
            case "no-longer-held":
              return { state: state.state, reference }
            case "refused":
              return { state: "refused" as const, reference, reason: state.reason ?? "refused" }
            // Put back: the call is not in effect, and nothing is held for it.
            case "restored":
              return { state: "refused" as const, reference, reason: "restored" }
            case "uncertain":
              return { state: "uncertain" as const, reference, reason: `acts ${perAct(state.acts)}` }
          }
        }),
        Effect.mapError(failed(reference.callId))
      ),
    restore: (reference) =>
      calls.restore(heldCallReference(reference)).pipe(
        Effect.map((restored) => {
          switch (restored.state) {
            case "restored":
            case "no-longer-held":
              return { state: restored.state, reference }
            case "conflict":
              return { state: "conflict" as const, reference, reason: `acts ${perAct(restored.acts)}` }
            // Nothing was changed, because there is no finished call to put back.
            case "not-done":
              return { state: "conflict" as const, reference, reason: "call is not done" }
            case "partial":
              return { state: "uncertain" as const, reference, reason: `partial restore, acts ${perAct(restored.acts)}` }
          }
        }),
        Effect.mapError(failed(reference.callId))
      )
  }
}
