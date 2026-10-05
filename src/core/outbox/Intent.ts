import type { Result, Schema } from "effect"
import type { InvalidIntent } from "./Records.ts"

/**
 * An intent kind is the unit of extension. Declaring one supplies everything
 * the kernel needs to stage, redact, digest, and record that kind of external
 * act; no kernel file is edited to add one.
 *
 * - `dispatch` is the private material a handler needs to act. It is stored
 *   sealed and is never listed, logged, or put in a receipt.
 * - `summary` is the redacted public description: names and sizes, never
 *   values. It is the only description that leaves the store.
 * - `outcome` is the safe-to-keep result of a completed dispatch.
 *
 * Each schema's encoded side must be JSON, because the kernel canonicalizes
 * and digests the encoded form.
 */
export interface IntentKind<
  Tag extends string,
  Dispatch,
  Summary,
  Outcome
> {
  readonly tag: Tag
  readonly dispatch: Schema.Codec<Dispatch, Schema.Json>
  readonly summary: Schema.Codec<Summary, Schema.Json>
  readonly outcome: Schema.Codec<Outcome, Schema.Json>
  /** Validates the request and produces its redacted description. Pure. */
  readonly summarize: (dispatch: Dispatch) => Result.Result<Summary, InvalidIntent>
  /**
   * The canonical target a supervisor grant is matched against, e.g.
   * `scheme://host/path` for HTTP. A staged authorization must name it exactly.
   */
  readonly target: (summary: Summary) => string
}

export declare namespace IntentKind {
  export type Any = IntentKind<string, any, any, any>
  export type DispatchOf<Kind> = Kind extends IntentKind<string, infer D, any, any> ? D : never
  export type SummaryOf<Kind> = Kind extends IntentKind<string, any, infer S, any> ? S : never
  export type OutcomeOf<Kind> = Kind extends IntentKind<string, any, any, infer O> ? O : never
}

/**
 * The closed set of kinds one Outbox instance serves, keyed by tag. The union
 * of intents, the Dispatcher's handler record, and every decoded emission are
 * derived from this record, so a kind cannot be half-registered.
 */
export type IntentKinds = { readonly [Tag in string]: IntentKind<Tag, any, any, any> }

/** One staged request: a kind tag plus that kind's dispatch material. */
export type Intent<Kinds extends IntentKinds> = {
  readonly [Tag in keyof Kinds & string]: {
    readonly kind: Tag
    readonly dispatch: IntentKind.DispatchOf<Kinds[Tag]>
  }
}[keyof Kinds & string]

export const defineIntentKind = <
  const Tag extends string,
  Dispatch,
  Summary,
  Outcome
>(kind: IntentKind<Tag, Dispatch, Summary, Outcome>): IntentKind<Tag, Dispatch, Summary, Outcome> => kind
