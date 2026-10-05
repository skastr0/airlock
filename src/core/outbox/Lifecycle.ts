import { Schema } from "effect"

/**
 * The emission lifecycle. This one table is the whole truth about which moves
 * exist: the store signature is typed by it and the runtime check reads it.
 *
 *   staged ──▶ committing ──▶ committed
 *      │            ├───────▶ uncertain
 *      │            └───────▶ refused
 *      └──────▶ cancelled
 *
 * `uncertain` is terminal on purpose: a dispatch that may have reached the
 * wire is never retried by Airlock. `refused` is the opposite proof: the
 * handler showed the wire was never reached, so nothing happened and nothing
 * will. A caller that still wants the act stages it again under a new key.
 */
export const transitions = {
  staged: ["committing", "cancelled"],
  committing: ["committed", "uncertain", "refused"],
  committed: [],
  uncertain: [],
  refused: [],
  cancelled: []
} as const

export type EmissionState = keyof typeof transitions
export const EmissionState: Schema.Codec<EmissionState> = Schema.Literals([
  "staged",
  "committing",
  "committed",
  "uncertain",
  "refused",
  "cancelled"
])

/** The states a given state may move to. `never` for a terminal state. */
export type Next<From extends EmissionState> = (typeof transitions)[From][number]

/** States that have somewhere to go. */
export type ActiveState = {
  [State in EmissionState]: Next<State> extends never ? never : State
}[EmissionState]

export type TerminalState = Exclude<EmissionState, ActiveState>

export const isLegalTransition = (from: EmissionState, to: EmissionState): boolean =>
  (transitions[from] as ReadonlyArray<EmissionState>).includes(to)

export const isTerminal = (state: EmissionState): state is TerminalState =>
  transitions[state].length === 0
