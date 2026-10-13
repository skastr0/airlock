import { Schema } from "effect"
import { HeldReference } from "./ToolHost.ts"
import type { EmissionId } from "../outbox/Records.ts"

/** A refusal proves that no forward act happened; faults terminate the run. */
export const CallRefusal = Schema.Struct({ code: Schema.String, message: Schema.String })
export type CallRefusal = typeof CallRefusal.Type
export interface Done<Result> {
  readonly state: "done"
  readonly id: EmissionId
  readonly result: Result
  readonly wayBack?: HeldReference
}
export interface Staged { readonly state: "staged"; readonly id: EmissionId }
export interface Refused { readonly state: "refused"; readonly refusal: CallRefusal }

/** One boundary shape. Only a completed call exposes its decoded result. */
export const CallReceipt = Schema.Union([
  Schema.Struct({ state: Schema.Literal("done"), id: Schema.String, result: Schema.Json, wayBack: Schema.optionalKey(HeldReference) }),
  Schema.Struct({ state: Schema.Literal("staged"), id: Schema.String }),
  Schema.Struct({ state: Schema.Literal("refused"), refusal: CallRefusal })
])
export type CallReceipt = typeof CallReceipt.Type
export type GuestReceipt = typeof CallReceipt.Encoded
