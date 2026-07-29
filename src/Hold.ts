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
  installed: Schema.optional(InstalledIdentity)
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
    operation: string
  ) =>
    Effect.tryPromise({
      try: async () => {
        const handle = await open(target, "wx", 0o600)
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
        const staged = `${target}.next-${crypto.randomUUID()}`
        return writeNewDurable(
          staged,
          json,
          "write staged hold journal"
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
    retained?: RetainedMetadata
  ) {
    yield* fs
      .makeDirectory(actDir(manifest.id), { recursive: true })
      .pipe(Effect.mapError(fsError("create hold act", actDir(manifest.id))))
    yield* syncDirectory(home.holdDir, "create hold act directory sync")
    yield* writeJournal(
      new HoldJournal({ state: "prepared", manifest, ...(retained === undefined ? {} : { retained }) })
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
        .filter((journal) => journal.state === "held")
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

  const reap = Effect.fn("Hold.reap")(function* (olderThanMillis: number) {
    const now = yield* DateTime.now
    const cutoff = DateTime.subtract(now, { millis: olderThanMillis })
    const all = yield* listJournals
    const expired = all.filter((journal) =>
      DateTime.lessThanOrEqualTo(journal.manifest.at, cutoff)
    )
    const reaped: ActId[] = []
    for (const journal of expired) {
      const id = journal.manifest.id
      // The single physical deletion site in this component.
      yield* fs
        .remove(actDir(id), { recursive: true })
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
      yield* syncDirectory(home.holdDir, "reap hold act directory sync").pipe(
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
      yield* ledger.record(
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
    }
    return new ReapReport({ reaped, at: now })
  })

  return Hold.of({
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
