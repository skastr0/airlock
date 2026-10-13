import type { Result, Schema } from "effect"
import type { InvalidIntent } from "./Records.ts"

/**
 * How a committed act of one kind is answered by an act of another. It is
 * never an undo: it produces a new intent that is staged, admitted, held and
 * committed like any other, and whose record links back to the original.
 *
 * A kind that declares no compensation has none. That is what irreversible
 * means here, and the type says so: `Compensates` is `never`.
 */
export interface Compensation<Dispatch, Outcome, Target extends string> {
  /** Tag of the kind that answers this one. It must be registered in the same Outbox. */
  readonly kind: Target
  /** The kind itself, so an Outbox can check it registered this exact kind under that tag. */
  readonly with: IntentKind.Any
  /** Pure. Builds the answering kind's dispatch from what was sent and what came back. */
  readonly intent: (committed: {
    readonly dispatch: Dispatch
    readonly outcome: Outcome
  }) => unknown
}

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
  Outcome,
  Compensates extends string = never
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
  readonly compensate?: Compensation<Dispatch, Outcome, Compensates>
}

export declare namespace IntentKind {
  export type Any = IntentKind<string, any, any, any, any>
  export type DispatchOf<Kind> = Kind extends IntentKind<string, infer D, any, any, any> ? D : never
  export type SummaryOf<Kind> = Kind extends IntentKind<string, any, infer S, any, any> ? S : never
  export type OutcomeOf<Kind> = Kind extends IntentKind<string, any, any, infer O, any> ? O : never
  /** The tag of the kind that answers this one, or `never` when it is irreversible. */
  export type CompensatesOf<Kind> = Kind extends IntentKind<string, any, any, any, infer T> ? T : never
}

/**
 * The closed set of kinds one Outbox instance serves, keyed by tag. The union
 * of intents, the Dispatcher's handler record, and every decoded emission are
 * derived from this record, so a kind cannot be half-registered.
 */
export type IntentKinds = { readonly [Tag in string]: IntentKind<Tag, any, any, any, any> }

/**
 * A kind registry in which every declared compensation targets a kind that is
 * also registered. A registry that is not closed does not typecheck: the
 * offending kind's `compensate.kind` is reported against the registered tags.
 */
export type ClosedUnderCompensation<Kinds extends IntentKinds> = {
  readonly [Tag in keyof Kinds]: [IntentKind.CompensatesOf<Kinds[Tag]>] extends [keyof Kinds]
    ? unknown
    : { readonly compensate: { readonly kind: keyof Kinds & string } }
}

/** The tags of the kinds that declare a compensation. */
export type CompensableTag<Kinds extends IntentKinds> = {
  readonly [Tag in keyof Kinds & string]: [IntentKind.CompensatesOf<Kinds[Tag]>] extends [never]
    ? never
    : Tag
}[keyof Kinds & string]

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
  Outcome,
  Compensates extends string = never
>(
  kind: IntentKind<Tag, Dispatch, Summary, Outcome, Compensates>
): IntentKind<Tag, Dispatch, Summary, Outcome, Compensates> => kind

/**
 * Declares that a committed act is answered by an act of `target`. `intent` is
 * typed by the target kind's dispatch, so a compensation cannot be built for a
 * kind that does not exist or with material that kind does not accept.
 */
export const compensateWith = <Dispatch, Outcome, Target extends IntentKind.Any>(
  target: Target,
  intent: (committed: {
    readonly dispatch: Dispatch
    readonly outcome: Outcome
  }) => IntentKind.DispatchOf<Target>
): Compensation<Dispatch, Outcome, Target["tag"]> => ({ kind: target.tag, with: target, intent })
