import { Context, Effect, Schema } from "effect"

/**
 * Atomic no-replace rename is a platform capability, not a preflight check.
 *
 * A successful call proves that `source` moved to an absent `target` in one
 * filesystem transition. A target that appears concurrently is preserved and
 * reported as `ExclusiveRenameTargetExists`.
 */
export class ExclusiveRenameTargetExists extends Schema.TaggedError<ExclusiveRenameTargetExists>()(
  "ExclusiveRenameTargetExists",
  {
    source: Schema.String,
    target: Schema.String
  }
) {}

export class ExclusiveRenameUnavailable extends Schema.TaggedError<ExclusiveRenameUnavailable>()(
  "ExclusiveRenameUnavailable",
  {
    platform: Schema.String,
    reason: Schema.String
  }
) {}

export class ExclusiveRenameFailed extends Schema.TaggedError<ExclusiveRenameFailed>()(
  "ExclusiveRenameFailed",
  {
    source: Schema.String,
    target: Schema.String,
    errno: Schema.Number,
    reason: Schema.String
  }
) {}

export type ExclusiveRenameError =
  | ExclusiveRenameTargetExists
  | ExclusiveRenameUnavailable
  | ExclusiveRenameFailed

export class ExclusiveRename extends Context.Tag("airlock/ExclusiveRename")<
  ExclusiveRename,
  {
    readonly moveNoReplace: (
      source: string,
      target: string
    ) => Effect.Effect<void, ExclusiveRenameError>
  }
>() {}
