import { Schema } from "effect"

/**
 * Derived, never random: `emi_` plus the first 32 hex digits of the SHA-256 of
 * the caller's idempotency key. Staging the same key always names the same
 * emission, on any host.
 */
export const EmissionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^emi_[0-9a-f]{32}$/)),
  Schema.brand("EmissionId")
)
export type EmissionId = typeof EmissionId.Type

/** Chosen by the caller; names one logical external act across replays. */
export const IdempotencyKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  Schema.brand("IdempotencyKey")
)
export type IdempotencyKey = typeof IdempotencyKey.Type

