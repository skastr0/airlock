import { FileSystem, Path } from "@effect/platform"
import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { lstat, open } from "node:fs/promises"
import { AirlockHome } from "./AirlockHome.ts"
import {
  ActId,
  HeldManifest,
  LedgerEntry,
  NotHeld,
  NothingToUndo,
  OverwriteReceipt,
  ProtectedPath,
  ReapReport,
  RemoveReceipt,
  RuntimePrivateNotUndoable,
  RuntimePrivateRetentionReceipt,
  TargetNotFound,
  UndoConflict,
  UndoReceipt,
  UnknownAct
} from "./domain.ts"
import { Ledger, type LedgerError } from "./Ledger.ts"
import {
  ExclusiveRename,
  type ExclusiveRenameError
} from "./platform/ExclusiveRename.ts"
import { makeExclusiveFileLock } from "./platform/ExclusiveFileLock.ts"
import { CheckedOutcome, CheckedRecord, CheckedRequest, observeClaim, OperationKey } from "./change/Checked.ts"
import { attempt, ChangeError, checkParent, checkTree, exists as treeExists, identity, sameIdentity, scan, snapshot } from "./change/Tree.ts"
import { ProposalId, SnapshotReceipt } from "./change/Contracts.ts"
import { inspectSnapshots, readSnapshotRecord, type SnapshotInspection, SnapshotRecord, snapshotReceipt, snapshotRecordPath, snapshotSource } from "./change/Snapshots.ts"

// The recovery floor, by construction: the destructive part of every mutation
// is a rename. The single unlink site in this component is `reap` — the runner's
// second phase, never an acting agent's operation.

export class HoldFilesystemError extends Schema.TaggedError<HoldFilesystemError>()(
  "HoldFilesystemError",
  {
    operation: Schema.String,
    target: Schema.String,
    reason: Schema.String
  }
) {}

export class CrossVolumeHold extends Schema.TaggedError<CrossVolumeHold>()(
  "CrossVolumeHold",
  {
    target: Schema.String,
    holdDir: Schema.String
  }
) {}

export class HoldRecoveryIndeterminate extends Schema.TaggedError<HoldRecoveryIndeterminate>()(
  "HoldRecoveryIndeterminate",
  {
    id: ActId,
    target: Schema.String
  }
) {}

export class TargetOccupied extends Schema.TaggedError<TargetOccupied>()(
  "TargetOccupied",
  { target: Schema.String }
) {}

export class SourceNotFound extends Schema.TaggedError<SourceNotFound>()(
  "SourceNotFound",
  { source: Schema.String }
) {}

export class SourceVolumeMismatch extends Schema.TaggedError<SourceVolumeMismatch>()(
  "SourceVolumeMismatch",
  {
    source: Schema.String,
    target: Schema.String,
    holdDir: Schema.String,
    sourceDevice: Schema.Number,
    targetDevice: Schema.Number,
    holdDevice: Schema.Number
  }
) {}

export class SourceEqualsTarget extends Schema.TaggedError<SourceEqualsTarget>()(
  "SourceEqualsTarget",
  { source: Schema.String, target: Schema.String }
) {}

export class OverlappingReplacementPaths extends Schema.TaggedError<OverlappingReplacementPaths>()(
  "OverlappingReplacementPaths",
  { source: Schema.String, target: Schema.String }
) {}

export class UnsupportedReplacementSymlink extends Schema.TaggedError<UnsupportedReplacementSymlink>()(
  "UnsupportedReplacementSymlink",
  {
    path: Schema.String,
    role: Schema.Literal("source", "target")
  }
) {}

export class HoldRecoveryRequired extends Schema.TaggedError<HoldRecoveryRequired>()(
  "HoldRecoveryRequired",
  {
    id: ActId,
    target: Schema.String,
    phase: Schema.Literal("retain", "install", "restore", "undo", "ledger"),
    recovery: Schema.optional(
      Schema.Struct({
        act: Schema.Literal("remove", "overwrite", "displaced"),
        journalState: Schema.Literal("prepared", "held"),
        rename: Schema.Literal("confirmed"),
        next: Schema.Literal("journal-reconciliation-required"),
        source: Schema.String,
        destination: Schema.String,
        syncedDirectories: Schema.Array(Schema.String),
        failedDirectory: Schema.String
      })
    ),
    reason: Schema.String
  }
) {}

export class HoldReapRecoveryRequired extends Schema.TaggedError<HoldReapRecoveryRequired>()(
  "HoldReapRecoveryRequired",
  {
    reaped: Schema.Array(ActId),
    current: ActId,
    phase: Schema.Literal("remove", "sync", "ledger"),
    currentRemoval: Schema.Literal("possible", "confirmed"),
    at: Schema.DateTimeUtc,
    reason: Schema.String
  }
) {}

type HoldIoError = HoldFilesystemError | CrossVolumeHold
type HoldRecoveryError = HoldFilesystemError | HoldRecoveryIndeterminate
type HoldMutationError = HoldIoError | LedgerError | HoldRecoveryRequired

export class ReplaceMetadata extends Schema.Class<ReplaceMetadata>("ReplaceMetadata")({
  device: Schema.Number,
  inode: Schema.optional(Schema.Number),
  mode: Schema.Number,
  bytes: Schema.Number
}) {}

export class ReplaceReceipt extends Schema.Class<ReplaceReceipt>("ReplaceReceipt")({
  id: ActId,
  source: Schema.String,
  target: Schema.String,
  kind: Schema.Literal("file", "directory"),
  metadata: ReplaceMetadata,
  previousHeld: Schema.Boolean,
  at: Schema.DateTimeUtc
}) {}

export class Hold extends Context.Tag("airlock/Hold")<
  Hold,
  {
    readonly replaceChecked: (request: CheckedRequest) => Effect.Effect<CheckedOutcome, ChangeError>
    readonly undoChecked: (receiptId: string) => Effect.Effect<CheckedOutcome, ChangeError>
    readonly checkedStatus: (operationKey: string) => Effect.Effect<CheckedOutcome | undefined, ChangeError>
    readonly recoverChecked: (operationKey: string, restore?: boolean) => Effect.Effect<CheckedOutcome | undefined, ChangeError>
    readonly acknowledgeChecked: (operationKey: string) => Effect.Effect<void, ChangeError>
    readonly remove: (
      target: string
    ) => Effect.Effect<
      RemoveReceipt,
      TargetNotFound | ProtectedPath | UnsupportedReplacementSymlink | HoldMutationError
    >
    readonly overwrite: (
      target: string,
      content: string
    ) => Effect.Effect<
      OverwriteReceipt,
      TargetNotFound | ProtectedPath | UnsupportedReplacementSymlink | HoldMutationError | TargetOccupied
    >
    readonly retireRuntimePrivate: (
      target: string
    ) => Effect.Effect<
      RuntimePrivateRetentionReceipt,
      TargetNotFound | ProtectedPath | UnsupportedReplacementSymlink | HoldMutationError
    >
    readonly replaceFrom: (
      target: string,
      source: string
    ) => Effect.Effect<
      ReplaceReceipt,
      | ProtectedPath
      | TargetNotFound
      | SourceNotFound
      | SourceVolumeMismatch
      | SourceEqualsTarget
      | OverlappingReplacementPaths
      | UnsupportedReplacementSymlink
      | HoldMutationError
      | TargetOccupied
    >
    /**
     * Reserve a journaled private stage before an adapter writes candidate
     * bytes, then install that candidate through the ordinary replacement
     * transition. The stage remains inside its prepared Hold act until Reaper
     * collects it; interruption can therefore leave recovery material, never
     * an untracked private object.
     */
    readonly replaceByStaging: <E>(
      target: string,
      kind: "file" | "directory",
      populate: (stage: string) => Effect.Effect<void, E>
    ) => Effect.Effect<
      ReplaceReceipt,
      | E
      | ProtectedPath
      | TargetNotFound
      | SourceNotFound
      | SourceVolumeMismatch
      | SourceEqualsTarget
      | OverlappingReplacementPaths
      | UnsupportedReplacementSymlink
      | HoldMutationError
      | TargetOccupied
    >
    readonly undo: (
      id: ActId
    ) => Effect.Effect<
      UndoReceipt,
      | TargetNotFound
      | UnknownAct
      | NotHeld
      | RuntimePrivateNotUndoable
      | UndoConflict
      | UnsupportedReplacementSymlink
      | HoldMutationError
    >
    readonly undoLast: Effect.Effect<
      UndoReceipt,
      | TargetNotFound
      | NothingToUndo
      | UnknownAct
      | NotHeld
      | RuntimePrivateNotUndoable
      | UndoConflict
      | UnsupportedReplacementSymlink
      | HoldMutationError
    >
    readonly held: Effect.Effect<ReadonlyArray<HeldManifest>, HoldFilesystemError>
    readonly inspectChangeSnapshots: (id: string) => Effect.Effect<SnapshotInspection, ChangeError>
    readonly retireChangeSnapshots: (input: { id: string, expectedDigest: string }) => Effect.Effect<SnapshotReceipt, ChangeError>
    readonly collectChangeSnapshots: (id: string) => Effect.Effect<SnapshotReceipt, ChangeError>
    readonly reap: (
      olderThanMillis: number
    ) => Effect.Effect<
      ReapReport,
      HoldFilesystemError | HoldReapRecoveryRequired
    >
  }
>() {}

// `HeldManifest` is the stable public receipt shape. The journal adds an
// internal prepared state so a crash between rename and receipt can be
// reconciled on the next construction without widening the public contract.
class RetainedMetadata extends Schema.Class<RetainedMetadata>("RetainedMetadata")({
  device: Schema.Number,
  inode: Schema.optional(Schema.Number),
  mode: Schema.Number,
  bytes: Schema.Number
}) {}

class InstalledIdentity extends Schema.Class<InstalledIdentity>("InstalledIdentity")({
  kind: Schema.Literal("file", "directory"),
  device: Schema.Number,
  inode: Schema.Number,
  birthtimeMillis: Schema.Number,
  mode: Schema.Number,
  bytes: Schema.Number
}) {}

class HoldJournal extends Schema.Class<HoldJournal>("HoldJournal")({
  state: Schema.Literal("prepared", "held", "restored"),
  manifest: HeldManifest,
  retained: Schema.optional(RetainedMetadata),
  installed: Schema.optional(InstalledIdentity),
  checkedKey: Schema.optional(Schema.String),
  checkedPinned: Schema.optional(Schema.Boolean),
  snapshotRetirementId: Schema.optional(Schema.String)
}) {}

type Entry = Readonly<{
  readonly kind: "file" | "directory"
  readonly retained: RetainedMetadata
}>

type ReplaceSource = Readonly<{
  readonly kind: "file" | "directory"
  readonly metadata: ReplaceMetadata
  readonly identity: InstalledIdentity
}>

class HoldPostRenameDirectorySyncFailed extends Schema.TaggedError<HoldPostRenameDirectorySyncFailed>()(
  "HoldPostRenameDirectorySyncFailed",
  {
    source: Schema.String,
    destination: Schema.String,
    operation: Schema.String,
    syncedDirectories: Schema.Array(Schema.String),
    failedDirectory: Schema.String,
    reason: Schema.String
  }
) {}

const encodeJournal = Schema.encode(Schema.parseJson(HoldJournal))
const decodeJournal = Schema.decode(Schema.parseJson(HoldJournal))
const decodeLegacyManifest = Schema.decode(Schema.parseJson(HeldManifest))

const newActId = () => ActId.make(`act_${crypto.randomUUID().slice(0, 13)}`)

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT"

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* AirlockHome
  const ledger = yield* Ledger
  const exclusiveRename = yield* ExclusiveRename

  const actDir = (id: string) => path.join(home.holdDir, id)
  const manifestFile = (id: string) => path.join(actDir(id), "manifest.json")
  const payloadFile = (id: string) => path.join(actDir(id), "payload")
  const stageFile = (id: string) => path.join(actDir(id), "stage")
  const lockRoot = path.join(home.home, "hold-locks")
  const activeLock = path.join(lockRoot, "active")
  const releasedLock = path.join(lockRoot, "released")
  const abandonedLock = path.join(lockRoot, "abandoned")

  const fsError = (operation: string, target: string) => (cause: unknown) =>
    new HoldFilesystemError({ operation, target, reason: reasonOf(cause) })

  const guard = Effect.fnUntraced(function* (target: string) {
    if (target === "/") {
      return yield* new ProtectedPath({ target, reason: "filesystem root" })
    }
    if (target === home.home || target.startsWith(`${home.home}/`)) {
      return yield* new ProtectedPath({ target, reason: "airlock home" })
    }
  })

  yield* fs
    .makeDirectory(lockRoot, { recursive: true })
    .pipe(Effect.mapError(fsError("create Hold lock directory", lockRoot)))

  const syncDirectory = (directory: string, operation: string) =>
    Effect.tryPromise({
      try: async () => {
        const handle = await open(directory, "r")
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
      catch: fsError(operation, directory)
    })

  /**
   * Replacing rename is intentionally limited to journal publication. Journal
   * candidates are replicas of the same state record, so publishing the newer
   * candidate may replace the canonical name. It must never install live
   * managed bytes or recovery payloads.
   */
  const renameJournalReplacingDurable = (
    source: string,
    target: string,
    operation: string
  ) =>
    fs.rename(source, target).pipe(
      Effect.mapError(fsError(operation, target)),
      Effect.zipRight(
        Effect.forEach(
          [...new Set([path.dirname(source), path.dirname(target)])],
          (directory) =>
            syncDirectory(directory, `${operation} directory sync`),
          { concurrency: 1, discard: true }
        )
      )
    )

  const renameExclusiveDurable = (
    source: string,
    target: string,
    operation: string
  ) =>
    Effect.gen(function* () {
      yield* exclusiveRename.moveNoReplace(source, target)
      const syncedDirectories: string[] = []
      for (const directory of [
        ...new Set([path.dirname(source), path.dirname(target)])
      ]) {
        const synced = yield* syncDirectory(
          directory,
          `${operation} directory sync`
        ).pipe(Effect.either)
        if (synced._tag === "Left") {
          return yield* new HoldPostRenameDirectorySyncFailed({
            source,
            destination: target,
            operation,
            syncedDirectories,
            failedDirectory: directory,
            reason: synced.left.reason
          })
        }
        syncedDirectories.push(directory)
      }
    })

  const exclusiveFailure = (
    operation: string,
    target: string
  ) => (
    error: ExclusiveRenameError | HoldFilesystemError
  ): HoldFilesystemError => {
    if (error._tag === "HoldFilesystemError") return error
    const reason =
      error._tag === "ExclusiveRenameTargetExists"
        ? `target appeared during atomic no-replace rename from ${error.source}`
        : error._tag === "ExclusiveRenameUnavailable"
          ? `${error.platform}: ${error.reason}`
          : `${error.reason} (errno ${error.errno})`
    return new HoldFilesystemError({ operation, target, reason })
  }

  const writeNewDurable = (
    target: string,
    content: string,
    operation: string,
    replaceReplica = false
  ) =>
    Effect.tryPromise({
      try: async () => {
        const handle = await open(target, replaceReplica ? "w" : "wx", 0o600)
        try {
          await handle.writeFile(content, "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
      catch: fsError(operation, target)
    }).pipe(
      Effect.zipRight(
        syncDirectory(path.dirname(target), `${operation} directory sync`)
      )
    )

  const writeJournal = (journal: HoldJournal) =>
    encodeJournal(journal).pipe(
      Effect.mapError(fsError("encode hold journal", manifestFile(journal.manifest.id))),
      Effect.flatMap((json) => {
        const target = manifestFile(journal.manifest.id)
        const staged = `${target}.next-${journal.checkedKey === undefined ? crypto.randomUUID() : "checked"}`
        return writeNewDurable(
          staged,
          json,
          "write staged hold journal",
          journal.checkedKey !== undefined
        ).pipe(
          Effect.zipRight(
            renameJournalReplacingDurable(staged, target, "install hold journal")
          )
        )
      })
    )

  /**
   * Cross-process serialization uses a bounded three-file protocol. Releasing
   * or recovering a lease is an atomic rename over one reusable tombstone;
   * Reaper remains the only component that can physically unlink state.
   */
  const lock = makeExclusiveFileLock({
    root: lockRoot,
    active: activeLock,
    released: releasedLock,
    abandoned: abandonedLock,
    onError: (operation, target, cause) =>
      fsError(`Hold lock ${operation}`, target)(cause)
  })

  const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withLock(effect)

  const decodeStoredJournal = (raw: string, id: ActId) =>
    decodeJournal(raw).pipe(
      // Existing v0 manifests are a supported persisted format. Rewrite them
      // as journals on their next state transition; never make a prior hold
      // unreadable because the recovery format grew a phase.
      Effect.catchAll(() =>
        decodeLegacyManifest(raw).pipe(
          Effect.map(
            (manifest) =>
              new HoldJournal({ state: manifest.status, manifest })
          )
        )
      ),
      Effect.mapError(fsError("decode hold journal", manifestFile(id)))
    )

  type JournalCandidate = Readonly<{
    readonly file: string
    readonly modifiedAt: number
    readonly journal: HoldJournal
  }>

  const journalRank = (state: HoldJournal["state"]) =>
    state === "prepared" ? 0 : state === "held" ? 1 : 2

  /**
   * Journal publication is file-sync + rename + directory-sync. If the
   * process stopped between the first two steps, the durable `.next-*` file is
   * still authoritative recovery material. Select the furthest valid state
   * (then the newest file), and atomically promote it before reconciliation.
   */
  const loadRecoverableJournal = Effect.fnUntraced(function* (id: ActId) {
    const directory = actDir(id)
    const entries = yield* fs
      .readDirectory(directory)
      .pipe(Effect.mapError(fsError("list hold journal candidates", directory)))
    const names = entries.filter(
      (entry) =>
        entry === "manifest.json" ||
        entry.startsWith("manifest.json.next-")
    )
    if (names.length === 0) {
      return yield* new HoldFilesystemError({
        operation: "read hold journal",
        target: manifestFile(id),
        reason: "no durable journal candidate"
      })
    }

    const decoded = yield* Effect.forEach(
      names,
      (name) => {
        const candidate = path.join(directory, name)
        return Effect.all({
          raw: fs
            .readFileString(candidate)
            .pipe(Effect.mapError(fsError("read hold journal candidate", candidate))),
          info: Effect.tryPromise({
            try: () => lstat(candidate),
            catch: fsError("stat hold journal candidate", candidate)
          })
        }).pipe(
          Effect.flatMap(({ raw, info }) =>
            decodeStoredJournal(raw, id).pipe(
              Effect.flatMap((journal) =>
                journal.manifest.id === id
                  ? Effect.succeed({
                      file: candidate,
                      modifiedAt: info.mtimeMs,
                      journal
                    } satisfies JournalCandidate)
                  : Effect.fail(
                      new HoldFilesystemError({
                        operation: "decode hold journal",
                        target: candidate,
                        reason: `journal id ${journal.manifest.id} does not match ${id}`
                      })
                    )
              )
            )
          ),
          Effect.either
        )
      },
      { concurrency: 1 }
    )
    const valid = decoded.flatMap((result) =>
      result._tag === "Right" ? [result.right] : []
    )
    if (valid.length === 0) {
      const failure = decoded.find((result) => result._tag === "Left")
      return yield* failure?._tag === "Left"
        ? failure.left
        : new HoldFilesystemError({
            operation: "decode hold journal",
            target: manifestFile(id),
            reason: "no valid journal candidate"
          })
    }

    valid.sort((left, right) => {
      const state = journalRank(right.journal.state) - journalRank(left.journal.state)
      return state === 0 ? right.modifiedAt - left.modifiedAt : state
    })
    const selected = valid[0]!
    if (selected.file !== manifestFile(id)) {
      yield* renameJournalReplacingDurable(
        selected.file,
        manifestFile(id),
        "promote staged hold journal"
      )
    }
    return selected.journal
  })

  const readJournal = (id: ActId) =>
    fs.stat(actDir(id)).pipe(
      Effect.mapError((error) =>
        error._tag === "SystemError" && error.reason === "NotFound"
          ? new UnknownAct({ id })
          : fsError("stat hold act", actDir(id))(error)
      ),
      Effect.zipRight(loadRecoverableJournal(id))
    )

  const pathExists = (target: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await lstat(target)
          return true
        } catch (cause) {
          if (isNotFound(cause)) return false
          throw cause
        }
      },
      catch: fsError("lstat existence", target)
    })

  const inspect = Effect.fnUntraced(function* (target: string) {
    const info = yield* Effect.tryPromise({
      try: () => lstat(target),
      catch: (cause) =>
        isNotFound(cause)
          ? new TargetNotFound({ target })
          : fsError("lstat held target", target)(cause)
    })
    if (info.isSymbolicLink()) {
      return yield* new UnsupportedReplacementSymlink({ path: target, role: "target" })
    }
    if (!info.isFile() && !info.isDirectory()) {
      return yield* new HoldFilesystemError({
        operation: "inspect held target",
        target,
        reason: "only regular files and directories are supported"
      })
    }
    return {
      kind: info.isDirectory() ? ("directory" as const) : ("file" as const),
      retained: new RetainedMetadata({
        device: info.dev,
        inode: info.ino,
        mode: info.mode,
        bytes: info.size
      })
    } satisfies Entry
  })

  // `HeldManifest` intentionally models files and directories only. lstat is
  // therefore a fail-closed preflight: do not let an unrepresentable dangling
  // symlink reach an exists/stat path that would follow it and lose the name.
  const inspectSource = (source: string) =>
    Effect.tryPromise({
      try: () => lstat(source),
      catch: (cause) =>
        isNotFound(cause)
          ? new SourceNotFound({ source })
          : fsError("lstat replacement source", source)(cause)
    }).pipe(
      Effect.flatMap((info): Effect.Effect<
        ReplaceSource,
        UnsupportedReplacementSymlink | HoldFilesystemError
      > => {
        if (info.isSymbolicLink()) {
          return Effect.fail(
            new UnsupportedReplacementSymlink({
              path: source,
              role: "source"
            })
          )
        }
        if (!info.isFile() && !info.isDirectory()) {
          return Effect.fail(
            new HoldFilesystemError({
              operation: "inspect replacement source",
              target: source,
              reason: "only regular files and directories are supported"
            })
          )
        }
        const kind = info.isDirectory()
          ? ("directory" as const)
          : ("file" as const)
        return Effect.succeed({
          kind,
          metadata: new ReplaceMetadata({
            device: info.dev,
            inode: info.ino,
            mode: info.mode,
            bytes: info.size
          }),
          identity: new InstalledIdentity({
            kind,
            device: info.dev,
            inode: info.ino,
            birthtimeMillis: info.birthtimeMs,
            mode: info.mode,
            bytes: info.size
          })
        } satisfies ReplaceSource)
      })
    )

  const matchesInstalledIdentity = (
    target: string,
    expected: InstalledIdentity
  ) =>
    Effect.tryPromise({
      try: async () => {
        let info: Awaited<ReturnType<typeof lstat>>
        try {
          info = await lstat(target)
        } catch (cause) {
          if (isNotFound(cause)) return false
          throw cause
        }
        const kind = info.isDirectory()
          ? ("directory" as const)
          : info.isFile()
            ? ("file" as const)
            : undefined
        return kind !== undefined &&
          kind === expected.kind &&
          info.dev === expected.device &&
          info.ino === expected.inode &&
          info.birthtimeMs === expected.birthtimeMillis &&
          info.mode === expected.mode &&
          info.size === expected.bytes
      },
      catch: fsError("verify prepared install identity", target)
    })

  const replacementTargetExists = (target: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await lstat(target)
        } catch (cause) {
          if (isNotFound(cause)) return undefined
          throw cause
        }
      },
      catch: (cause) => fsError("lstat replacement target", target)(cause)
    }).pipe(
      Effect.flatMap((info) => {
        if (info === undefined) return Effect.succeed(false)
        if (info.isSymbolicLink()) {
          return new UnsupportedReplacementSymlink({ path: target, role: "target" })
        }
        return Effect.succeed(true)
      })
    )

  // A rename into or out of the hold is only atomic on one volume. We admit
  // the path before allocating an act or moving any live entry.
  const admitSameVolume = (target: string) =>
    Effect.all({
      hold: fs
        .stat(home.holdDir)
        .pipe(Effect.mapError(fsError("stat hold directory", home.holdDir))),
      parent: fs
        .stat(path.dirname(target))
        .pipe(Effect.mapError(fsError("stat target parent", path.dirname(target))))
    }).pipe(
      Effect.flatMap(({ hold, parent }) =>
        hold.dev === parent.dev
          ? Effect.void
          : new CrossVolumeHold({ target, holdDir: home.holdDir })
      )
    )

  const admitReplacement = (
    source: string,
    target: string,
    entry: ReplaceSource,
    existingTargetDevice?: number
  ) =>
    Effect.all({
      hold: fs
        .stat(home.holdDir)
        .pipe(Effect.mapError(fsError("stat hold directory", home.holdDir))),
      targetParent: fs
        .stat(path.dirname(target))
        .pipe(Effect.mapError(fsError("stat target parent", path.dirname(target))))
    }).pipe(
      Effect.flatMap(({ hold, targetParent }) => {
        const targetDevice = existingTargetDevice ?? targetParent.dev
        return hold.dev === targetDevice && hold.dev === entry.metadata.device
          ? Effect.void
          : new SourceVolumeMismatch({
              source,
              target,
              holdDir: home.holdDir,
              sourceDevice: entry.metadata.device,
              targetDevice,
              holdDevice: hold.dev
            })
      })
    )

  const reserveAct = Effect.fnUntraced(function* (
    manifest: HeldManifest,
    retained?: RetainedMetadata,
    checkedKey?: string
  ) {
    yield* fs
      .makeDirectory(actDir(manifest.id), { recursive: true, ...(checkedKey === undefined ? {} : { mode: 0o700 }) })
      .pipe(Effect.mapError(fsError("create hold act", actDir(manifest.id))))
    yield* syncDirectory(home.holdDir, "create hold act directory sync")
    yield* writeJournal(
      new HoldJournal({ state: "prepared", manifest, ...(retained === undefined ? {} : { retained }),
        ...(checkedKey === undefined ? {} : { checkedKey, checkedPinned: true }) })
    )
  })

  const postRenameRecoveryRequired = (
    manifest: HeldManifest,
    phase: "retain" | "install" | "restore" | "undo",
    journalState: "prepared" | "held",
    failure: HoldPostRenameDirectorySyncFailed
  ) =>
    new HoldRecoveryRequired({
      id: manifest.id,
      target: manifest.target,
      phase,
      recovery: {
        act: manifest.act,
        journalState,
        rename: "confirmed",
        next: "journal-reconciliation-required",
        source: failure.source,
        destination: failure.destination,
        syncedDirectories: failure.syncedDirectories,
        failedDirectory: failure.failedDirectory
      },
      reason: failure.reason
    })

  const bindInstallIdentity = Effect.fnUntraced(function* (
    manifest: HeldManifest,
    source: string
  ) {
    const sourceEntry = yield* inspectSource(source)
    const journal = yield* readJournal(manifest.id).pipe(
      Effect.catchTag(
        "UnknownAct",
        () => new HoldFilesystemError({
          operation: "bind prepared install identity",
          target: manifestFile(manifest.id),
          reason: `hold act ${manifest.id} disappeared before install`
        })
      )
    )
    if (journal.state === "restored") {
      return yield* new HoldRecoveryRequired({
        id: manifest.id,
        target: manifest.target,
        phase: "install",
        reason: "hold journal was already restored before install identity binding"
      })
    }
    const bound = new HoldJournal({
      ...journal,
      installed: sourceEntry.identity
    })
    yield* writeJournal(bound)
    return {
      journal: bound,
      journalState: journal.state,
      sourceEntry
    }
  })

  // Rename `target` into a fresh act. The prepared journal is persisted before
  // the only destructive transition. On recovery, payload presence proves the
  // rename completed; target presence proves it did not.
  const holdTarget = Effect.fnUntraced(function* (
    target: string,
    act: "remove" | "overwrite" | "displaced",
    entry: Entry,
    purpose?: "runtime-private"
  ) {
    yield* admitSameVolume(target)
    const id = newActId()
    const at = yield* DateTime.now
    const manifest = new HeldManifest({
      id,
      act,
      target,
      kind: entry.kind,
      hasPayload: true,
      ...(purpose === undefined ? {} : { purpose }),
      status: "held",
      at
    })
    yield* reserveAct(manifest, entry.retained)
    yield* renameExclusiveDurable(
      target,
      payloadFile(id),
      "retain target"
    ).pipe(
      Effect.mapError((error) =>
        error instanceof HoldPostRenameDirectorySyncFailed
          ? postRenameRecoveryRequired(
              manifest,
              "retain",
              "prepared",
              error
            )
          : exclusiveFailure("retain target", payloadFile(id))(error)
      )
    )
    yield* writeJournal(
      new HoldJournal({ state: "held", manifest, retained: entry.retained })
    )
    return manifest
  })

  const prepareCreation = Effect.fnUntraced(function* (
    target: string,
    kind: "file" | "directory" = "file"
  ) {
    yield* admitSameVolume(target)
    const id = newActId()
    const at = yield* DateTime.now
    const manifest = new HeldManifest({
      id,
      act: "overwrite",
      target,
      kind,
      hasPayload: false,
      status: "held",
      at
    })
    yield* reserveAct(manifest)
    return manifest
  })

  /**
   * Candidate production is private, but its lifetime is still owned by
   * Hold. Reserving the act before invoking adapter glue means a failed copy,
   * interrupted write, or process crash leaves a journal that Reaper can
   * enumerate. The outer Hold lease remains held until replacement finishes,
   * so Reaper cannot collect an in-flight stage.
   */
  const reserveRuntimePrivateStage = Effect.fnUntraced(function* (
    kind: "file" | "directory"
  ) {
    const id = newActId()
    const at = yield* DateTime.now
    const stage = stageFile(id)
    const manifest = new HeldManifest({
      id,
      act: "remove",
      target: stage,
      kind,
      hasPayload: false,
      purpose: "runtime-private",
      status: "held",
      at
    })
    yield* reserveAct(manifest)
    return stage
  })

  // New content never writes through the live target. The stage file shares
  // the target's device (admitted above), so installing it is another rename.
  const installStaged = Effect.fnUntraced(function* (
    manifest: HeldManifest,
    content: string
  ) {
    yield* writeNewDurable(
      stageFile(manifest.id),
      content,
      "write staged replacement"
    )
    const bound = yield* bindInstallIdentity(
      manifest,
      stageFile(manifest.id)
    ).pipe(
      Effect.mapError((error) =>
        error instanceof SourceNotFound
          ? new HoldFilesystemError({
              operation: "bind staged replacement identity",
              target: stageFile(manifest.id),
              reason: "durable stage disappeared before install"
            })
          : error
      )
    )
    const occupied = yield* pathExists(manifest.target)
    if (occupied) return yield* new TargetOccupied({ target: manifest.target })
    yield* renameExclusiveDurable(
      stageFile(manifest.id),
      manifest.target,
      "install staged replacement"
    ).pipe(
      Effect.mapError((error) =>
        error instanceof HoldPostRenameDirectorySyncFailed
          ? postRenameRecoveryRequired(
              manifest,
              "install",
              bound.journalState,
              error
            )
          : error._tag === "ExclusiveRenameTargetExists"
          ? new TargetOccupied({ target: manifest.target })
          : exclusiveFailure("install staged replacement", manifest.target)(error)
      )
    )
    yield* writeJournal(new HoldJournal({ ...bound.journal, state: "held" }))
    return bound.sourceEntry
  })

  // `source` is already a complete Cell output. Installing it is a rename,
  // not a copy or a tool-specific interpretation. The prepared creation path
  // lets startup recover a crash after this rename but before its held receipt.
  const installSource = Effect.fnUntraced(function* (
    manifest: HeldManifest,
    source: string
  ) {
    const bound = yield* bindInstallIdentity(manifest, source)
    const occupied = yield* pathExists(manifest.target)
    if (occupied) return yield* new TargetOccupied({ target: manifest.target })
    yield* renameExclusiveDurable(
      source,
      manifest.target,
      "install replacement source"
    ).pipe(
      Effect.mapError((error) =>
        error instanceof HoldPostRenameDirectorySyncFailed
          ? postRenameRecoveryRequired(
              manifest,
              "install",
              bound.journalState,
              error
            )
          : error._tag === "ExclusiveRenameTargetExists"
          ? new TargetOccupied({ target: manifest.target })
          : error._tag === "ExclusiveRenameFailed" &&
            error.errno === 2
          ? new SourceNotFound({ source })
          : exclusiveFailure("install replacement source", manifest.target)(error)
      )
    )
    yield* writeJournal(new HoldJournal({ ...bound.journal, state: "held" }))
    return bound.sourceEntry
  })

  const recoverFailedInstall = Effect.fnUntraced(function* (manifest: HeldManifest) {
    if (yield* pathExists(manifest.target)) {
      return yield* new HoldRecoveryIndeterminate({
        id: manifest.id,
        target: manifest.target
      })
    }
    if (manifest.hasPayload) {
      if (!(yield* pathExists(payloadFile(manifest.id)))) {
        return yield* new HoldRecoveryIndeterminate({
          id: manifest.id,
          target: manifest.target
        })
      }
      yield* renameExclusiveDurable(
        payloadFile(manifest.id),
        manifest.target,
        "restore target after failed install"
      ).pipe(
        Effect.mapError((error) =>
          error instanceof HoldPostRenameDirectorySyncFailed
            ? postRenameRecoveryRequired(
                manifest,
                "restore",
                manifest.hasPayload ? "held" : "prepared",
                error
              )
            : error._tag === "ExclusiveRenameTargetExists"
            ? new HoldRecoveryIndeterminate({
                id: manifest.id,
                target: manifest.target
              })
            : exclusiveFailure(
                "restore target after failed install",
                manifest.target
              )(error)
        )
      )
    }
    yield* writeJournal(
      new HoldJournal({
        state: "restored",
        manifest: new HeldManifest({
          ...manifest,
          hasPayload: false,
          status: "restored"
        })
      })
    )
  })

  const recoveryRequired = (
    manifest: HeldManifest,
    phase: "install" | "ledger",
    cause: unknown
  ) =>
    new HoldRecoveryRequired({
      id: manifest.id,
      target: manifest.target,
      phase,
      reason: `${cause instanceof Error && "_tag" in cause ? String(cause._tag) : "Error"}: ${reasonOf(cause)}`
    })

  const failedInstallRecoveryRequired = (
    manifest: HeldManifest,
    installCause: unknown,
    recoveryCause: unknown
  ) =>
    new HoldRecoveryRequired({
      id: manifest.id,
      target: manifest.target,
      phase: "install",
      reason:
        `install failed (${reasonOf(installCause)}); ` +
        `automatic recovery also failed (${reasonOf(recoveryCause)})`
    })

  const recordAfterDurableMutation = (
    restore: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>,
    manifest: HeldManifest,
    entry: LedgerEntry
  ) =>
    restore(
      ledger.record(entry).pipe(
        Effect.mapError((cause) =>
          recoveryRequired(manifest, "ledger", cause)
        )
      )
    ).pipe(
      Effect.exit,
      Effect.flatMap((recorded) => {
        if (Exit.isSuccess(recorded)) return Effect.void
        return Cause.isInterruptedOnly(recorded.cause)
          ? Effect.fail(
              new HoldRecoveryRequired({
                id: manifest.id,
                target: manifest.target,
                phase: "ledger",
                reason: "Interrupt: ledger append interrupted after durable mutation"
              })
            )
          : Effect.failCause(recorded.cause)
      })
    )

  const reconcileJournal = Effect.fnUntraced(function* (journal: HoldJournal) {
    // Checked operations own their recovery evidence. An ambiguous operation
    // remains inspectable and pinned, never bricks legacy Hold construction.
    if (journal.checkedKey !== undefined || journal.snapshotRetirementId !== undefined) return
    if (journal.state === "restored") return
    const { manifest } = journal
    const payloadExists = yield* pathExists(payloadFile(manifest.id))
    const targetExists = yield* pathExists(manifest.target)

    if (journal.state === "prepared") {
      if (manifest.hasPayload) {
        if (payloadExists) {
          yield* writeJournal(new HoldJournal({ ...journal, state: "held" }))
          return
        }
        if (targetExists) {
          yield* writeJournal(
            new HoldJournal({
              ...journal,
              state: "restored",
              manifest: new HeldManifest({ ...manifest, hasPayload: false, status: "restored" })
            })
          )
          return
        }
        return yield* new HoldRecoveryIndeterminate({
          id: manifest.id,
          target: manifest.target
        })
      }

      // Runtime-private stages never confer undo authority over a live managed
      // name. Presence is therefore enough to retain or retire their payload.
      if (manifest.purpose === "runtime-private") {
        yield* writeJournal(
          new HoldJournal({
            ...journal,
            state: targetExists ? "held" : "restored",
            manifest: new HeldManifest({
              ...manifest,
              hasPayload: false,
              status: targetExists ? "held" : "restored"
            })
          })
        )
        return
      }

      // A managed prepared creation may become undoable only when the target
      // is the exact filesystem object bound before the rename. Mere path
      // presence could be a foreign creator racing a crash.
      if (targetExists) {
        if (
          journal.installed === undefined ||
          !(yield* matchesInstalledIdentity(
            manifest.target,
            journal.installed
          ))
        ) {
          return yield* new HoldRecoveryIndeterminate({
            id: manifest.id,
            target: manifest.target
          })
        }
      }
      yield* writeJournal(
        new HoldJournal({
          ...journal,
          state: targetExists ? "held" : "restored",
          manifest: new HeldManifest({
            ...manifest,
            hasPayload: false,
            status: targetExists ? "held" : "restored"
          })
        })
      )
      return
    }

    if (manifest.hasPayload && !payloadExists && targetExists) {
      // This is the only post-rename shape produced by a completed undo: its
      // held payload has returned to target, but the final receipt write lost
      // a crash race. Do not expose it as undoable again.
      yield* writeJournal(
        new HoldJournal({
          ...journal,
          state: "restored",
          manifest: new HeldManifest({ ...manifest, hasPayload: false, status: "restored" })
        })
      )
      return
    }

    if (manifest.hasPayload && !payloadExists && !targetExists) {
      return yield* new HoldRecoveryIndeterminate({
        id: manifest.id,
        target: manifest.target
      })
    }

    if (!manifest.hasPayload && !targetExists) {
      yield* writeJournal(
        new HoldJournal({
          ...journal,
          state: "restored",
          manifest: new HeldManifest({ ...manifest, status: "restored" })
        })
      )
    }
  })

  const listJournals = fs.readDirectory(home.holdDir).pipe(
    Effect.mapError(fsError("list hold acts", home.holdDir)),
    Effect.flatMap((entries) =>
      Effect.forEach(entries.filter((entry) => entry.startsWith("act_")), (entry) => {
        const id = ActId.make(entry)
        return fs.stat(actDir(id)).pipe(
          Effect.mapError(fsError("stat hold act", actDir(id))),
          Effect.flatMap((info) =>
            info.type === "Directory"
              ? loadRecoverableJournal(id)
              : Effect.succeed(undefined)
          )
        )
      })
    ),
    Effect.map((journals) => journals.flatMap((journal) => (journal === undefined ? [] : [journal])))
  )

  const reconcile = listJournals.pipe(
    Effect.flatMap((journals) => Effect.forEach(journals, reconcileJournal))
  )

  // No act can be served until prepared crash states have become either held,
  // restored, or an explicit recovery error. This is what makes the manifest
  // state machine a construction boundary rather than an advisory log.
  yield* withLock(reconcile)

  const remove = Effect.fn("Hold.remove")(function* (rawTarget: string) {
    const target = path.resolve(rawTarget)
    yield* guard(target)
    const entry = yield* inspect(target)
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const manifest = yield* holdTarget(target, "remove", entry)
        yield* recordAfterDurableMutation(
          restore,
          manifest,
          new LedgerEntry({
            at: manifest.at,
            effect: "mutation",
            act: "remove",
            ref: manifest.id,
            detail: target
          })
        )
        return new RemoveReceipt({
          id: manifest.id,
          target,
          kind: entry.kind,
          at: manifest.at
        })
      })
    )
  })

  const overwrite = Effect.fn("Hold.overwrite")(function* (
    rawTarget: string,
    content: string
  ) {
    const target = path.resolve(rawTarget)
    yield* guard(target)
    const exists = yield* pathExists(target)
    const existing = exists ? yield* inspect(target) : undefined
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const manifest = existing === undefined
          ? yield* prepareCreation(target)
          : yield* holdTarget(target, "overwrite", existing)
        const installed = yield* installStaged(manifest, content).pipe(Effect.either)
        if (installed._tag === "Left") {
          if (
            installed.left instanceof HoldRecoveryRequired &&
            installed.left.recovery !== undefined
          ) {
            return yield* installed.left
          }
          const recovered = yield* recoverFailedInstall(manifest).pipe(Effect.either)
          if (recovered._tag === "Left") {
            if (
              recovered.left instanceof HoldRecoveryRequired &&
              recovered.left.recovery !== undefined
            ) {
              return yield* recovered.left
            }
            return yield* failedInstallRecoveryRequired(
              manifest,
              installed.left,
              recovered.left
            )
          }
          return yield* installed.left
        }
        yield* recordAfterDurableMutation(
          restore,
          manifest,
          new LedgerEntry({
            at: manifest.at,
            effect: "mutation",
            act: "overwrite",
            ref: manifest.id,
            detail: target
          })
        )
        return new OverwriteReceipt({
          id: manifest.id,
          target,
          previousHeld: manifest.hasPayload,
          at: manifest.at
        })
      })
    )
  })

  const retireRuntimePrivate = Effect.fn("Hold.retireRuntimePrivate")(function* (
    rawTarget: string
  ) {
    const target = path.resolve(rawTarget)
    yield* guard(target)
    const entry = yield* inspect(target)
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const manifest = yield* holdTarget(
          target,
          "remove",
          entry,
          "runtime-private"
        )
        yield* recordAfterDurableMutation(
          restore,
          manifest,
          new LedgerEntry({
            at: manifest.at,
            effect: "mutation",
            act: "retire-runtime-private",
            ref: manifest.id,
            detail: target
          })
        )
        return new RuntimePrivateRetentionReceipt({
          id: manifest.id,
          target,
          kind: entry.kind,
          at: manifest.at
        })
      })
    )
  })

  const replaceFrom = Effect.fn("Hold.replaceFrom")(function* (
    rawTarget: string,
    rawSource: string
  ) {
    const target = path.resolve(rawTarget)
    const source = path.resolve(rawSource)
    yield* guard(target)
    const sourceInsideTarget = source.startsWith(`${target}/`)
    const targetInsideSource = target.startsWith(`${source}/`)
    if (source === target) {
      return yield* new SourceEqualsTarget({ source, target })
    }
    if (sourceInsideTarget || targetInsideSource) {
      return yield* new OverlappingReplacementPaths({ source, target })
    }
    const sourceEntry = yield* inspectSource(source)
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const targetExists = yield* replacementTargetExists(target)
        const existingTarget = targetExists ? yield* inspect(target) : undefined
        yield* admitReplacement(
          source,
          target,
          sourceEntry,
          existingTarget?.retained.device
        )
        const manifest = existingTarget !== undefined
          ? yield* holdTarget(target, "overwrite", existingTarget)
          : yield* prepareCreation(
              target,
              sourceEntry.kind === "directory" ? "directory" : "file"
            )
        const installed = yield* installSource(manifest, source).pipe(Effect.either)
        if (installed._tag === "Left") {
          if (
            installed.left instanceof HoldRecoveryRequired &&
            installed.left.recovery !== undefined
          ) {
            return yield* installed.left
          }
          const recovered = yield* recoverFailedInstall(manifest).pipe(Effect.either)
          if (recovered._tag === "Left") {
            if (
              recovered.left instanceof HoldRecoveryRequired &&
              recovered.left.recovery !== undefined
            ) {
              return yield* recovered.left
            }
            return yield* failedInstallRecoveryRequired(
              manifest,
              installed.left,
              recovered.left
            )
          }
          return yield* installed.left
        }
        yield* recordAfterDurableMutation(
          restore,
          manifest,
          new LedgerEntry({
            at: manifest.at,
            effect: "mutation",
            act: "overwrite",
            ref: manifest.id,
            detail: `${source} -> ${target}`
          })
        )
        return new ReplaceReceipt({
          id: manifest.id,
          source,
          target,
          kind: installed.right.kind,
          metadata: installed.right.metadata,
          previousHeld: manifest.hasPayload,
          at: manifest.at
        })
      })
    )
  })

  const replaceByStaging = <E>(
    rawTarget: string,
    kind: "file" | "directory",
    populate: (stage: string) => Effect.Effect<void, E>
  ) =>
    Effect.gen(function* () {
      const stage = yield* reserveRuntimePrivateStage(kind)
      yield* populate(stage)
      return yield* replaceFrom(rawTarget, stage)
    }).pipe(Effect.withSpan("Hold.replaceByStaging"))

  const undo = Effect.fn("Hold.undo")(function* (id: ActId) {
    const journal = yield* readJournal(id)
    if (journal.checkedKey !== undefined || journal.snapshotRetirementId !== undefined) {
      return yield* new NotHeld({ id, status: "checked operation: use exact change receipt" })
    }
    if (journal.state !== "held") {
      return yield* new NotHeld({ id, status: journal.state })
    }
    const { manifest } = journal
    if (manifest.purpose === "runtime-private") {
      return yield* new RuntimePrivateNotUndoable({
        id,
        target: manifest.target
      })
    }
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const at = yield* DateTime.now
        const targetExists = yield* pathExists(manifest.target)
        let displaced: ActId | undefined
        if (targetExists) {
          if (manifest.act === "overwrite") {
            const entry = yield* inspect(manifest.target)
            const current = yield* holdTarget(manifest.target, "displaced", entry)
            displaced = current.id
          } else {
            return yield* new UndoConflict({ target: manifest.target })
          }
        }
        if (manifest.hasPayload) {
          yield* fs
            .makeDirectory(path.dirname(manifest.target), { recursive: true })
            .pipe(Effect.mapError(fsError("create undo parent", path.dirname(manifest.target))))
          yield* renameExclusiveDurable(
            payloadFile(id),
            manifest.target,
            "restore held payload"
          ).pipe(
            Effect.mapError((error) =>
              error instanceof HoldPostRenameDirectorySyncFailed
                ? postRenameRecoveryRequired(
                    manifest,
                    "undo",
                    "held",
                    error
                  )
                : error._tag === "ExclusiveRenameTargetExists"
                ? new UndoConflict({ target: manifest.target })
                : exclusiveFailure("restore held payload", manifest.target)(error)
            )
          )
        }
        yield* writeJournal(
          new HoldJournal({
            ...journal,
            state: "restored",
            manifest: new HeldManifest({ ...manifest, hasPayload: false, status: "restored" })
          })
        )
        yield* recordAfterDurableMutation(
          restore,
          manifest,
          new LedgerEntry({
            at,
            effect: "mutation",
            act: "undo",
            ref: id,
            detail: manifest.target
          })
        )
        return new UndoReceipt({ id, target: manifest.target, displaced, at })
      })
    )
  })

  const held = listJournals.pipe(
    Effect.map((journals) =>
      journals
        .filter((journal) => journal.state === "held" && journal.snapshotRetirementId === undefined)
        .map((journal) => journal.manifest)
        .sort((a, b) => DateTime.toEpochMillis(a.at) - DateTime.toEpochMillis(b.at))
    )
  )

  const undoLast = Effect.gen(function* () {
    const current = yield* held
    const last = current
      .filter((manifest) => manifest.purpose !== "runtime-private")
      .at(-1)
    if (last === undefined) return yield* new NothingToUndo({})
    return yield* undo(last.id)
  })

  const reap = Effect.fn("Hold.reap")(function* (olderThanMillis: number, retirement?: HoldJournal) {
    const now = yield* DateTime.now
    const cutoff = DateTime.subtract(now, { millis: olderThanMillis })
    const all = retirement === undefined ? yield* listJournals : []
    const expired: HoldJournal[] = []
    if (retirement !== undefined) expired.push(retirement)
    for (const journal of all) {
      if (journal.snapshotRetirementId !== undefined) continue
      if (journal.checkedPinned === true || !DateTime.lessThanOrEqualTo(journal.manifest.at, cutoff)) continue
      if (journal.checkedKey !== undefined) {
        // Correlated receipts are the release authority. Even a stale staged
        // unpin journal must not make a newer unresolved undo collectible.
        const record = yield* readChecked(journal.checkedKey).pipe(Effect.mapError(fsError("read checked reaper authority", manifestFile(journal.manifest.id))))
        if (record?.phase !== "finished" || record.acknowledged !== true) continue
        if (Schema.is(ProposalId)(journal.checkedKey)) {
          const retirement = yield* attempt("read private-stage retirement pin", () => readSnapshotRecord(home.home, journal.checkedKey!))
            .pipe(Effect.mapError(fsError("read snapshot reaper authority", manifestFile(journal.manifest.id))))
          if (retirement?.phase === "prepared" && retirement.plan.bindings.some(b => b.sourceActId === journal.manifest.id)) continue
        }
        if (record.undoOf === undefined) {
          const undo = yield* readChecked(`undo_${journal.checkedKey}`).pipe(Effect.mapError(fsError("read checked undo reaper authority", manifestFile(journal.manifest.id))))
          if (undo !== undefined && (undo.phase !== "finished" || undo.acknowledged !== true)) continue
        }
      }
      expired.push(journal)
    }
    const reaped: ActId[] = []
    for (const journal of expired) {
      const id = journal.manifest.id
      /*
       * Selection and lock waiting remain interruptible. Once terminal
       * authority enters this region, however, cancellation cannot surface as
       * a bare interrupt after the unique recovery bytes may have disappeared.
       * Removal and its directory sync are uninterruptible; Ledger publication
       * is restored so cancellation becomes an exact partial/recovery receipt.
       */
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // The single physical deletion site in this component.
          yield* fs
            .remove(retirement === undefined ? actDir(id) : payloadFile(id), { recursive: true })
            .pipe(
              Effect.mapError((cause) =>
                new HoldReapRecoveryRequired({
                  reaped,
                  current: id,
                  phase: "remove",
                  currentRemoval: "possible",
                  at: now,
                  reason: reasonOf(cause)
                })
              )
            )
          reaped.push(id)
          yield* syncDirectory(
            retirement === undefined ? home.holdDir : actDir(id),
            "reap hold act directory sync"
          ).pipe(
            Effect.mapError((cause) =>
              new HoldReapRecoveryRequired({
                reaped,
                current: id,
                phase: "sync",
                currentRemoval: "confirmed",
                at: now,
                reason: reasonOf(cause)
              })
            )
          )
          const recorded = yield* restore(
            ledger.record(
              new LedgerEntry({
                at: now,
                effect: "mutation",
                act: "reap",
                ref: id,
                detail: journal.manifest.target
              })
            ).pipe(
              Effect.mapError((cause) =>
                new HoldReapRecoveryRequired({
                  reaped,
                  current: id,
                  phase: "ledger",
                  currentRemoval: "confirmed",
                  at: now,
                  reason: reasonOf(cause)
                })
              )
            )
          ).pipe(Effect.exit)
          if (Exit.isSuccess(recorded)) return
          return yield* Cause.isInterruptedOnly(recorded.cause)
            ? new HoldReapRecoveryRequired({
                reaped,
                current: id,
                phase: "ledger",
                currentRemoval: "confirmed",
                at: now,
                reason:
                  "Interrupt: ledger append interrupted after confirmed reap"
              })
            : Effect.failCause(recorded.cause)
        })
      )
    }
    return new ReapReport({ reaped, at: now })
  })

  const checkedRoot = path.join(home.holdDir, "checked")
  const checkedFile = (key: string) => path.join(checkedRoot, `${key}.json`)
  const checkedError = (cause: unknown) => new ChangeError({ operation: "checked Hold", reason: reasonOf(cause) })
  const readChecked = Effect.fnUntraced(function* (raw: string) {
    const key = yield* Schema.decodeUnknown(OperationKey)(raw)
    if (!(yield* pathExists(checkedFile(key)))) return undefined
    const json = yield* fs.readFileString(checkedFile(key))
    const record = yield* Schema.decode(Schema.parseJson(CheckedRecord))(json)
    if (record.request.operationKey !== key) return yield* checkedError("operation key mismatch")
    return record
  })
  const writeChecked = Effect.fnUntraced(function* (record: CheckedRecord, initial = false) {
    const json = yield* Schema.encode(Schema.parseJson(CheckedRecord))(record)
    if (initial) {
      yield* fs.makeDirectory(checkedRoot, { recursive: true, mode: 0o700 })
      yield* syncDirectory(home.holdDir, "checked root sync")
      yield* writeNewDurable(checkedFile(record.request.operationKey), json, "claim checked operation")
    } else {
      // Reuse only an unpublished metadata replica. The canonical record is
      // always authoritative; private recovery payloads are never overwritten.
      const next = `${checkedFile(record.request.operationKey)}.next`
      yield* writeNewDurable(next, json, "stage checked outcome", true)
      yield* renameJournalReplacingDurable(next, checkedFile(record.request.operationKey), "publish checked outcome")
    }
  })
  const outcomeOf = (record: CheckedRecord): CheckedOutcome => record.outcome ?? ({
    version: "checked-hold/v1", receiptId: record.request.operationKey,
    operationKey: record.request.operationKey, target: record.request.target,
    proposalDigest: record.request.proposalDigest, claim: record.claim,
    state: "recovery-required", actId: record.actId, displacedActId: record.displacedActId,
    installed: record.installed, reason: `interrupted at ${record.phase}; installation is never retried`
  })
  const finishChecked = Effect.fnUntraced(function* (
    record: CheckedRecord, state: CheckedOutcome["state"], reason?: string
  ) {
    const outcome: CheckedOutcome = { ...outcomeOf({ ...record, outcome: undefined }), state, reason }
    yield* writeChecked({ ...record, phase: state === "recovery-required" ? record.phase : "finished", outcome })
    return outcome
  })
  const failedChecked = (record: CheckedRecord, state: "rejected" | "recovery-required", cause: unknown) =>
    finishChecked(record, state, reasonOf(cause)).pipe(Effect.catchAll(publication => Effect.succeed({
      ...outcomeOf({ ...record, outcome: undefined }),
      reason: `${reasonOf(cause)}; outcome publication failed (${reasonOf(publication)}); durable claim requires recovery`
    })))
  const reserveChecked = Effect.fnUntraced(function* (
    request: CheckedRequest, kind: "file" | "directory", hasPayload: boolean, act: "overwrite" | "displaced"
  ) {
    yield* admitSameVolume(request.target)
    const manifest = new HeldManifest({
      id: newActId(), target: request.target, kind, hasPayload, act,
      at: yield* DateTime.now, status: "held"
    })
    yield* reserveAct(manifest, undefined, request.operationKey)
    return manifest
  })
  const pinCheckedAct = Effect.fnUntraced(function* (id: string, pinned: boolean) {
    const journal = yield* readJournal(ActId.make(id))
    if (journal.checkedPinned === pinned) return
    yield* writeJournal(new HoldJournal({ ...journal, checkedPinned: pinned }))
  })

  /** Declarative checks run under the same lease as retain/install/reap.
   * The correlation record and pinned act precede every live rename. No
   * callback supplied by a caller can substitute for these checks. */
  const replaceChecked = Effect.fnUntraced(function* (raw: CheckedRequest) {
    const request = yield* Schema.decodeUnknown(CheckedRequest)(raw)
    const prior = yield* readChecked(request.operationKey)
    if (prior !== undefined) return outcomeOf(prior)
    let record: CheckedRecord = { request, phase: "claimed", claim: observeClaim() }
    yield* writeChecked(record, true)
    let mutationPossible = false
    const execution = yield* Effect.gen(function* () {
      yield* guard(request.target)
      yield* attempt("check target parent", () => checkParent(request.target, request.parent, home.home))
      const manifest = yield* reserveChecked(request, request.candidate.tree.kind, request.expected !== null, "overwrite")
      record = { ...record, actId: manifest.id }
      yield* writeChecked(record)
      const candidate = yield* attempt("copy checked candidate", async () => {
        const source = await snapshot(request.candidate.path, stageFile(manifest.id), request.candidate.tree.bytes)
        if (source.tree.digest !== request.candidate.tree.digest) throw new Error("candidate digest drift")
        const copied = await scan(stageFile(manifest.id))
        if (request.expected !== null && request.expected.tree.kind !== copied.tree.kind) throw new Error("target kind differs")
        return copied
      })
      record = { ...record, installed: candidate, phase: "retaining" }
      yield* writeChecked(record)
      yield* attempt("check baseline immediately before retain", async () => {
        await checkParent(request.target, request.parent, home.home)
        await checkTree(stageFile(manifest.id), candidate)
        await checkTree(request.target, request.expected)
      })
      mutationPossible = true
      if (request.expected !== null) {
        yield* renameExclusiveDurable(request.target, payloadFile(manifest.id), "checked retain")
        yield* attempt("verify retained baseline", () => checkTree(payloadFile(manifest.id), request.expected))
      }
      record = { ...record, phase: "installing" }
      yield* writeChecked(record)
      yield* renameExclusiveDurable(stageFile(manifest.id), request.target, "checked install")
      yield* attempt("verify checked installation", () => checkTree(request.target, candidate))
      return yield* finishChecked(record, "installed")
    }).pipe(Effect.either)
    if (execution._tag === "Right") return execution.right
    return yield* failedChecked(record, mutationPossible ? "recovery-required" : "rejected", execution.left)
  })

  const undoChecked = Effect.fnUntraced(function* (receiptId: string) {
    yield* Schema.decodeUnknown(OperationKey)(receiptId)
    const key = `undo_${receiptId}`
    const prior = yield* readChecked(key)
    if (prior !== undefined) return outcomeOf(prior)
    const original = yield* readChecked(receiptId)
    if (original?.outcome?.state !== "installed" || original.installed === undefined || original.actId === undefined || original.undoOf !== undefined) {
      return yield* checkedError("exact successful apply receipt required")
    }
    const request: CheckedRequest = {
      ...original.request, operationKey: key, expected: original.installed,
      candidate: { path: payloadFile(original.actId), tree: original.request.expected?.tree ?? original.installed.tree }
    }
    let record: CheckedRecord = { request, undoOf: receiptId, actId: original.actId, phase: "claimed", claim: observeClaim() }
    yield* writeChecked(record, true)
    let mutationPossible = false
    const execution = yield* Effect.gen(function* () {
      yield* pinCheckedAct(original.actId!, true)
      yield* attempt("check undo bindings", async () => {
        await checkParent(request.target, request.parent, home.home)
        await checkTree(request.target, original.installed!)
        if (original.request.expected !== null) await checkTree(payloadFile(original.actId!), original.request.expected)
      })
      const displaced = yield* reserveChecked(request, original.installed!.tree.kind, true, "displaced")
      record = { ...record, displacedActId: displaced.id, phase: "retaining", installed: original.request.expected ?? undefined }
      yield* writeChecked(record)
      yield* attempt("check current immediately before undo retain", async () => {
        await checkParent(request.target, request.parent, home.home)
        if (original.request.expected !== null) await checkTree(payloadFile(original.actId!), original.request.expected)
        await checkTree(request.target, original.installed!)
      })
      mutationPossible = true
      yield* renameExclusiveDurable(request.target, payloadFile(displaced.id), "checked undo displace")
      yield* attempt("verify undo displaced candidate", () => checkTree(payloadFile(displaced.id), original.installed!))
      record = { ...record, phase: "installing" }
      yield* writeChecked(record)
      if (original.request.expected !== null) {
        yield* renameExclusiveDurable(payloadFile(original.actId!), request.target, "checked undo restore")
      }
      yield* attempt("verify checked undo", () => checkTree(request.target, original.request.expected))
      return yield* finishChecked(record, "undone")
    }).pipe(Effect.either)
    if (execution._tag === "Right") return execution.right
    return yield* failedChecked(record, mutationPossible ? "recovery-required" : "rejected", execution.left)
  })

  const recoverChecked = Effect.fnUntraced(function* (key: string, restore = false) {
    let record = yield* readChecked(key)
    if (record === undefined) return undefined
    if (record.phase === "finished") return outcomeOf(record)
    if (record.phase === "claimed") return yield* finishChecked(record, "rejected", "interrupted before live mutation was authorized")
    const current = record
    const syncRecovery = Effect.gen(function* () {
      yield* syncDirectory(path.dirname(current.request.target), "checked recovery target sync")
      if (current.actId !== undefined) yield* syncDirectory(actDir(current.actId), "checked recovery original sync")
      if (current.displacedActId !== undefined) yield* syncDirectory(actDir(current.displacedActId), "checked recovery displaced sync")
    })
    // A restoration is itself a journaled, no-clobber operation. Reconcile its
    // exact identity after interruption; do not confuse it with installation.
    if (record.phase === "restoring" && record.rollback !== undefined) {
      const rollback = record.rollback
      const restored = yield* attempt("prove recovery restoration", async () => {
        await checkParent(current.request.target, current.request.parent, home.home)
        await checkTree(current.request.target, rollback.restored)
        if (await treeExists(payloadFile(rollback.sourceActId))) throw new Error("restoration source still present")
      }).pipe(Effect.either)
      if (restored._tag === "Right") {
        yield* syncRecovery
        return yield* finishChecked({ ...record, installed: rollback.restored }, "rolled-back")
      }
    }
    const proven = yield* Effect.gen(function* () {
      if (current.phase !== "installing" || current.actId === undefined) return yield* checkedError("not an install completion phase")
      yield* attempt("reconcile checked target", async () => {
        await checkParent(current.request.target, current.request.parent, home.home)
        await checkTree(current.request.target, current.installed ?? null)
        if (current.undoOf === undefined) {
          if (current.request.expected !== null) await checkTree(payloadFile(current.actId!), current.request.expected)
          if (await treeExists(stageFile(current.actId!))) throw new Error("install source still present")
        } else {
          if (current.displacedActId === undefined) throw new Error("missing displaced act")
          await checkTree(payloadFile(current.displacedActId), current.request.expected)
        }
      })
      yield* syncRecovery
      return yield* finishChecked(current, current.undoOf === undefined ? "installed" : "undone")
    }).pipe(Effect.either)
    if (proven._tag === "Right") return proven.right

    // A source still at its bound live name and no retained payload proves
    // that the first rename did not occur. This consumes, never resumes, it.
    const sourceActId = record.undoOf === undefined ? record.actId : record.displacedActId
    if (record.phase === "retaining" && sourceActId !== undefined) {
      const untouched = yield* attempt("prove unmutated checked operation", async () => {
        await checkParent(current.request.target, current.request.parent, home.home)
        await checkTree(current.request.target, current.request.expected)
        if (await treeExists(payloadFile(sourceActId))) throw new Error("retained payload exists")
        if (current.undoOf === undefined && current.installed !== undefined) await checkTree(stageFile(current.actId!), current.installed)
      }).pipe(Effect.either)
      if (untouched._tag === "Right") return yield* finishChecked(record, "rejected", "interrupted before first live rename")
    }
    if (!restore || sourceActId === undefined || record.request.expected === null) return outcomeOf(record)
    const rollback = record.rollback ?? { sourceActId, restored: record.request.expected }
    const restored = yield* Effect.gen(function* () {
      yield* attempt("admit explicit recovery restoration", async () => {
        await checkParent(current.request.target, current.request.parent, home.home)
        await checkTree(payloadFile(rollback.sourceActId), rollback.restored)
        await checkTree(current.request.target, null)
      })
      record = { ...current, rollback, phase: "restoring", outcome: undefined }
      yield* writeChecked(record)
      yield* attempt("check immediately before recovery restoration", async () => {
        await checkParent(current.request.target, current.request.parent, home.home)
        await checkTree(payloadFile(rollback.sourceActId), rollback.restored)
        await checkTree(current.request.target, null)
      })
      yield* renameExclusiveDurable(payloadFile(rollback.sourceActId), current.request.target, "checked recovery restoration")
      yield* attempt("verify recovery restoration", () => checkTree(current.request.target, rollback.restored))
      return yield* finishChecked({ ...record, installed: rollback.restored }, "rolled-back")
    }).pipe(Effect.either)
    return restored._tag === "Right" ? restored.right : yield* failedChecked(record, "recovery-required", restored.left)
  })
  const acknowledgeChecked = Effect.fnUntraced(function* (key: string) {
    const record = yield* readChecked(key)
    if (record === undefined || record.phase !== "finished") return yield* checkedError("cannot acknowledge unresolved operation")
    if (record.undoOf === undefined) {
      const undo = yield* readChecked(`undo_${key}`)
      if (undo !== undefined && (undo.phase !== "finished" || undo.acknowledged !== true)) return
    }
    // Caller has already fsynced its workflow receipt. Mark that fact before
    // releasing any recovery bytes. Repeating acknowledgement completes a
    // crashed unpin, but cannot release a later undo's unacknowledged pins.
    if (record.acknowledged !== true) yield* writeChecked({ ...record, acknowledged: true })
    for (const id of [record.actId, record.displacedActId]) {
      if (id !== undefined && (yield* pathExists(actDir(id)))) yield* pinCheckedAct(id, false)
    }
  })
  const checkedLocked = <A, E>(effect: Effect.Effect<A, E>) =>
    withLock(Effect.uninterruptible(effect)).pipe(Effect.mapError(checkedError))

  const writeSnapshotRecord = Effect.fnUntraced(function* (record: SnapshotRecord) {
    const file = snapshotRecordPath(home.home, record.plan.id)
    yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
    yield* syncDirectory(home.holdDir, "snapshot retirement root sync")
    const json = Schema.encodeSync(Schema.parseJson(SnapshotRecord))(record)
    yield* writeNewDurable(`${file}.next`, json, "snapshot retirement replica", true)
    yield* renameJournalReplacingDurable(`${file}.next`, file, "snapshot retirement publication")
  })
  const verifyBundle = (record: SnapshotRecord) => attempt("verify retirement bundle binding", async () => {
    if (record.actId === undefined || record.bundle === undefined) throw new Error("retirement bundle not bound")
    const stat = await lstat(payloadFile(record.actId))
    if (!stat.isDirectory() || !sameIdentity(identity(stat), record.bundle)) throw new Error("retirement bundle identity drift")
  })
  const retireChangeSnapshots = Effect.fnUntraced(function* (input: { id: string, expectedDigest: string }) {
    const inspected = yield* attempt("inspect snapshot retirement", () => inspectSnapshots(home.home, input.id))
    if (inspected.plan === undefined || inspected.plan.retirementDigest !== input.expectedDigest) return yield* checkedError("retirement digest mismatch or unsettled proposal; not retired")
    let record: SnapshotRecord = inspected.record ?? { plan: inspected.plan, phase: "prepared", actId: newActId() }
    if (record.phase !== "prepared") return snapshotReceipt(record, inspected.row.snapshots.state === "recovery-required" ? "retirement state drift; inspect inventory errors" : undefined)
    const result = yield* Effect.gen(function* () {
      if (inspected.record === undefined) yield* writeSnapshotRecord(record)
      const id = ActId.make(record.actId!)
      if (!(yield* pathExists(manifestFile(id)))) {
        yield* fs.makeDirectory(actDir(id), { recursive: true, mode: 0o700 })
        yield* syncDirectory(home.holdDir, "snapshot act directory sync")
        const manifest = new HeldManifest({ id, act: "remove", target: path.join(home.home, "changes", input.id),
          kind: "directory", at: yield* DateTime.now, status: "held", hasPayload: true })
        yield* writeJournal(new HoldJournal({ state: "held", manifest, checkedPinned: true, snapshotRetirementId: input.id }))
      }
      const journal = yield* readJournal(id)
      if (journal.snapshotRetirementId !== input.id) return yield* checkedError("retirement act correlation mismatch")
      if (record.bundle === undefined) {
        yield* fs.makeDirectory(payloadFile(id), { recursive: true, mode: 0o700 })
        if ((yield* fs.readDirectory(payloadFile(id))).length !== 0) return yield* checkedError("unbound nonempty retirement bundle")
        yield* syncDirectory(actDir(id), "snapshot bundle directory sync")
        record = { ...record, bundle: yield* attempt("bind retirement bundle", async () => identity(await lstat(payloadFile(id)))) }
        yield* writeSnapshotRecord(record)
      }
      yield* verifyBundle(record)
      for (const binding of record.plan.bindings) {
        const source = snapshotSource(home.home, input.id, binding), destination = path.join(payloadFile(id), binding.side)
        if (yield* pathExists(source)) {
          yield* attempt("check private snapshot retirement", async () => { await checkTree(source, binding.expected); await checkTree(destination, null) })
          yield* renameExclusiveDurable(source, destination, "retire change snapshot")
        }
        yield* attempt("verify retired snapshot", async () => { await checkTree(source, null); await checkTree(destination, binding.expected) })
        // A prior process may have exited between rename and either sync.
        yield* syncDirectory(path.dirname(source), "retired snapshot source sync")
        yield* syncDirectory(path.dirname(destination), "retired snapshot destination sync")
      }
      record = { ...record, phase: "retired" }
      yield* writeSnapshotRecord(record)
      return snapshotReceipt(record)
    }).pipe(Effect.either)
    return result._tag === "Right" ? result.right : snapshotReceipt(record, reasonOf(result.left))
  })
  const collectChangeSnapshots = Effect.fnUntraced(function* (raw: string) {
    const id = yield* Schema.decodeUnknown(ProposalId)(raw)
    let record = yield* attempt("read snapshot retirement", () => readSnapshotRecord(home.home, id))
    if (record === undefined || record.phase === "prepared") return yield* checkedError("explicit completed retirement required before collection")
    if (record.phase === "collected") {
      const inspected = yield* attempt("verify collected private bytes absent", () => inspectSnapshots(home.home, id))
      return snapshotReceipt(record, inspected.row.snapshots.state === "collected" ? undefined : "private bytes remain; reservation not released")
    }
    const result = yield* Effect.gen(function* () {
      const actId = ActId.make(record!.actId!)
      const journal = yield* readJournal(actId)
      if (journal.snapshotRetirementId !== id) return yield* checkedError("collection act correlation mismatch")
      for (const side of ["candidate", "baseline"]) yield* attempt("verify proposal private bytes absent", () => checkTree(path.join(home.home, "changes", id, side), null))
      for (const binding of record!.plan.bindings) yield* attempt("verify private source absent", () => checkTree(snapshotSource(home.home, id, binding), null))
      if (yield* pathExists(payloadFile(actId))) {
        yield* verifyBundle(record!)
        if (record!.phase === "retired") {
          const names = yield* fs.readDirectory(payloadFile(actId))
          if (names.length !== record!.plan.bindings.length) return yield* checkedError("unapproved retirement bundle entries")
          for (const b of record!.plan.bindings) yield* attempt("verify collection digest", () => checkTree(path.join(payloadFile(actId), b.side), b.expected))
        }
        record = { ...record!, phase: "collecting" }
        yield* writeSnapshotRecord(record)
        yield* reap(0, journal)
      } else if (record!.phase !== "collecting") return yield* checkedError("retired bundle missing before collection claim")
      yield* syncDirectory(actDir(actId), "collected bundle absence sync")
      record = { ...record!, phase: "collected" }
      yield* writeSnapshotRecord(record)
      return snapshotReceipt(record)
    }).pipe(Effect.either)
    return result._tag === "Right" ? result.right : snapshotReceipt(record!, reasonOf(result.left))
  })

  return Hold.of({
    inspectChangeSnapshots: (id) => checkedLocked(attempt("inspect change snapshots", () => inspectSnapshots(home.home, id))),
    retireChangeSnapshots: (input) => checkedLocked(retireChangeSnapshots(input)),
    collectChangeSnapshots: (id) => checkedLocked(collectChangeSnapshots(id)),
    replaceChecked: (request) => checkedLocked(replaceChecked(request)),
    undoChecked: (receiptId) => checkedLocked(undoChecked(receiptId)),
    checkedStatus: (key) => checkedLocked(readChecked(key).pipe(Effect.map(r => r === undefined ? undefined : outcomeOf(r)))),
    recoverChecked: (key, restore) => checkedLocked(recoverChecked(key, restore)),
    acknowledgeChecked: (key) => checkedLocked(acknowledgeChecked(key)),
    remove: (target) => withLock(remove(target)),
    overwrite: (target, content) => withLock(overwrite(target, content)),
    retireRuntimePrivate: (target) => withLock(retireRuntimePrivate(target)),
    replaceFrom: (target, source) => withLock(replaceFrom(target, source)),
    replaceByStaging: (target, kind, populate) =>
      withLock(replaceByStaging(target, kind, populate)),
    undo: (id) => withLock(undo(id)),
    undoLast: withLock(undoLast),
    held: withLock(held),
    reap: (olderThanMillis) => withLock(reap(olderThanMillis))
  })
})

/** Component layer: tests and alternate platforms provide the capability. */
export const HoldLayer = Layer.effect(Hold, make)
