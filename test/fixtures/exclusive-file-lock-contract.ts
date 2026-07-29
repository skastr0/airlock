import { Schema } from "effect"

export const LockContenderPhase = Schema.Literal("enter", "exit")
export type LockContenderPhase = typeof LockContenderPhase.Type

export class LockContenderEvent extends Schema.Class<LockContenderEvent>(
  "LockContenderEvent"
)({
  contenderId: Schema.String,
  pid: Schema.Number,
  phase: LockContenderPhase,
  atMillis: Schema.Number
}) {}

export class LockContenderCompleted extends Schema.TaggedClass<LockContenderCompleted>(
  "LockContenderCompleted"
)("Completed", {
  contenderId: Schema.String,
  pid: Schema.Number,
  waitedMillis: Schema.Number,
  heldMillis: Schema.Number
}) {}

export class LockContenderFailed extends Schema.TaggedClass<LockContenderFailed>(
  "LockContenderFailed"
)("Failed", {
  contenderId: Schema.String,
  pid: Schema.Number,
  errorTag: Schema.String,
  reason: Schema.String
}) {}

export const LockContenderResult = Schema.Union(
  LockContenderCompleted,
  LockContenderFailed
)
export type LockContenderResult = typeof LockContenderResult.Type
