import { Schema } from "effect"

/**
 * What a call does to the world, as its contract declares it: `capture` reads,
 * `invoke` runs something, `apply` changes something the host can put back,
 * `request` reaches beyond the host.
 */
export const PlanEffect = Schema.Literals(["capture", "invoke", "apply", "request"])
export type PlanEffect = typeof PlanEffect.Type

/** What a call may do with one resource it names. */
export const Right = Schema.Literals([
  "read",
  "write",
  /** Authority to select this executable as the root of a process. */
  "invoke",
  /** Authority to execute this identity only as a declared descendant of a root. */
  "execute",
  "connect",
  "emit"
])
export type Right = typeof Right.Type
