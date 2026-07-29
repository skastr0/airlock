import { FileSystem, Path } from "@effect/platform"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
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
  TargetNotFound,
  UndoConflict,
  UndoReceipt,
  UnknownAct
} from "./domain.ts"
import { Ledger } from "./Ledger.ts"

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

type HoldIoError = HoldFilesystemError | CrossVolumeHold
type HoldRecoveryError = HoldFilesystemError | HoldRecoveryIndeterminate

export class Hold extends Context.Tag("airlock/Hold")<
  Hold,
  {
    readonly remove: (
      target: string
    ) => Effect.Effect<
      RemoveReceipt,
      TargetNotFound | ProtectedPath | HoldIoError
    >
    readonly overwrite: (
      target: string,
      content: string
    ) => Effect.Effect<
      OverwriteReceipt,
      ProtectedPath | HoldIoError | TargetOccupied
    >
    readonly undo: (
      id: ActId
    ) => Effect.Effect<
      UndoReceipt,
      UnknownAct | NotHeld | UndoConflict | HoldIoError
    >
    readonly undoLast: Effect.Effect<
      UndoReceipt,
      NothingToUndo | UnknownAct | NotHeld | UndoConflict | HoldIoError
    >
    readonly held: Effect.Effect<ReadonlyArray<HeldManifest>, HoldFilesystemError>
    readonly reap: (
      olderThanMillis: number
    ) => Effect.Effect<ReapReport, HoldFilesystemError>
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

class HoldJournal extends Schema.Class<HoldJournal>("HoldJournal")({
  state: Schema.Literal("prepared", "held", "restored"),
  manifest: HeldManifest,
  retained: Schema.optional(RetainedMetadata)
}) {}

type Entry = Readonly<{
  readonly kind: "file" | "directory"
  readonly retained: RetainedMetadata
}>

const encodeJournal = Schema.encode(Schema.parseJson(HoldJournal))
const decodeJournal = Schema.decode(Schema.parseJson(HoldJournal))
const decodeLegacyManifest = Schema.decode(Schema.parseJson(HeldManifest))

const newActId = () => ActId.make(`act_${crypto.randomUUID().slice(0, 13)}`)

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* AirlockHome
  const ledger = yield* Ledger

  const actDir = (id: string) => path.join(home.holdDir, id)
  const manifestFile = (id: string) => path.join(actDir(id), "manifest.json")
  const payloadFile = (id: string) => path.join(actDir(id), "payload")
  const stageFile = (id: string) => path.join(actDir(id), "stage")

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

  const writeJournal = (journal: HoldJournal) =>
    encodeJournal(journal).pipe(
      Effect.mapError(fsError("encode hold journal", manifestFile(journal.manifest.id))),
      Effect.flatMap((json) =>
        fs
          .writeFileString(manifestFile(journal.manifest.id), json)
          .pipe(Effect.mapError(fsError("write hold journal", manifestFile(journal.manifest.id))))
      )
    )

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

  const readJournal = (id: ActId) =>
    fs.readFileString(manifestFile(id)).pipe(
      Effect.mapError((error) =>
        error._tag === "SystemError" && error.reason === "NotFound"
          ? new UnknownAct({ id })
          : fsError("read hold journal", manifestFile(id))(error)
      ),
      Effect.flatMap((raw) => decodeStoredJournal(raw, id))
    )

  const inspect = (target: string) =>
    fs.stat(target).pipe(
      Effect.mapError(fsError("stat", target)),
      Effect.map((info) => {
        const inode = Option.getOrUndefined(info.ino)
        return {
          kind: info.type === "Directory" ? ("directory" as const) : ("file" as const),
          retained: new RetainedMetadata({
            device: info.dev,
            ...(inode === undefined ? {} : { inode }),
            mode: info.mode,
            bytes: Number(info.size)
          })
        } satisfies Entry
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

  const reserveAct = Effect.fnUntraced(function* (
    manifest: HeldManifest,
    retained?: RetainedMetadata
  ) {
    yield* fs
      .makeDirectory(actDir(manifest.id), { recursive: true })
      .pipe(Effect.mapError(fsError("create hold act", actDir(manifest.id))))
    yield* writeJournal(
      new HoldJournal({ state: "prepared", manifest, ...(retained === undefined ? {} : { retained }) })
    )
  })

  // Rename `target` into a fresh act. The prepared journal is persisted before
  // the only destructive transition. On recovery, payload presence proves the
  // rename completed; target presence proves it did not.
  const holdTarget = Effect.fnUntraced(function* (
    target: string,
    act: "remove" | "overwrite" | "displaced",
    entry: Entry
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
      status: "held",
      at
    })
    yield* reserveAct(manifest, entry.retained)
    yield* fs
      .rename(target, payloadFile(id))
      .pipe(Effect.mapError(fsError("retain target", target)))
    yield* writeJournal(
      new HoldJournal({ state: "held", manifest, retained: entry.retained })
    )
    return manifest
  })

  const prepareCreation = Effect.fnUntraced(function* (target: string) {
    yield* admitSameVolume(target)
    const id = newActId()
    const at = yield* DateTime.now
    const manifest = new HeldManifest({
      id,
      act: "overwrite",
      target,
      kind: "file",
      hasPayload: false,
      status: "held",
      at
    })
    yield* reserveAct(manifest)
    return manifest
  })

  // New content never writes through the live target. The stage file shares
  // the target's device (admitted above), so installing it is another rename.
  const installStaged = Effect.fnUntraced(function* (
    manifest: HeldManifest,
    content: string
  ) {
    yield* fs
      .writeFileString(stageFile(manifest.id), content)
      .pipe(Effect.mapError(fsError("write staged replacement", stageFile(manifest.id))))
    const occupied = yield* fs
      .exists(manifest.target)
      .pipe(Effect.mapError(fsError("check replacement target", manifest.target)))
    if (occupied) return yield* new TargetOccupied({ target: manifest.target })
    yield* fs
      .rename(stageFile(manifest.id), manifest.target)
      .pipe(Effect.mapError(fsError("install staged replacement", manifest.target)))
    if (!manifest.hasPayload) {
      yield* writeJournal(new HoldJournal({ state: "held", manifest }))
    }
  })

  const reconcileJournal = Effect.fnUntraced(function* (journal: HoldJournal) {
    if (journal.state === "restored") return
    const { manifest } = journal
    const payloadExists = yield* fs
      .exists(payloadFile(manifest.id))
      .pipe(Effect.mapError(fsError("inspect held payload", payloadFile(manifest.id))))
    const targetExists = yield* fs
      .exists(manifest.target)
      .pipe(Effect.mapError(fsError("inspect held target", manifest.target)))

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

      // A prepared creation either installed its staged replacement (target
      // exists) or never crossed the live boundary. Its stage bytes remain in
      // the act for the reaper; no recovery path unlinks them.
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
      Effect.forEach(entries, (entry) => {
        const id = ActId.make(entry)
        return fs.stat(actDir(id)).pipe(
          Effect.mapError(fsError("stat hold act", actDir(id))),
          Effect.flatMap((info) =>
            info.type === "Directory"
              ? fs.readFileString(manifestFile(id)).pipe(
                  Effect.mapError(fsError("read hold journal", manifestFile(id))),
                  Effect.flatMap((raw) => decodeStoredJournal(raw, id))
                )
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
  yield* reconcile

  const remove = Effect.fn("Hold.remove")(function* (rawTarget: string) {
    const target = path.resolve(rawTarget)
    yield* guard(target)
    const exists = yield* fs
      .exists(target)
      .pipe(Effect.mapError(fsError("check remove target", target)))
    if (!exists) return yield* new TargetNotFound({ target })
    const entry = yield* inspect(target)
    const manifest = yield* holdTarget(target, "remove", entry)
    yield* ledger.record(
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

  const overwrite = Effect.fn("Hold.overwrite")(function* (
    rawTarget: string,
    content: string
  ) {
    const target = path.resolve(rawTarget)
    yield* guard(target)
    const exists = yield* fs
      .exists(target)
      .pipe(Effect.mapError(fsError("check overwrite target", target)))
    const manifest = exists
      ? yield* inspect(target).pipe(
          Effect.flatMap((entry) => holdTarget(target, "overwrite", entry))
        )
      : yield* prepareCreation(target)
    yield* installStaged(manifest, content)
    yield* ledger.record(
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

  const undo = Effect.fn("Hold.undo")(function* (id: ActId) {
    const journal = yield* readJournal(id)
    if (journal.state !== "held") {
      return yield* new NotHeld({ id, status: journal.state })
    }
    const { manifest } = journal
    const at = yield* DateTime.now
    const targetExists = yield* fs
      .exists(manifest.target)
      .pipe(Effect.mapError(fsError("check undo target", manifest.target)))
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
      yield* fs
        .rename(payloadFile(id), manifest.target)
        .pipe(Effect.mapError(fsError("restore held payload", manifest.target)))
    }
    yield* writeJournal(
      new HoldJournal({
        ...journal,
        state: "restored",
        manifest: new HeldManifest({ ...manifest, hasPayload: false, status: "restored" })
      })
    )
    yield* ledger.record(
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
    const last = current.at(-1)
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
    for (const journal of expired) {
      // The single physical deletion site in this component.
      yield* fs
        .remove(actDir(journal.manifest.id), { recursive: true })
        .pipe(Effect.mapError(fsError("reap hold act", actDir(journal.manifest.id))))
      yield* ledger.record(
        new LedgerEntry({
          at: now,
          effect: "mutation",
          act: "reap",
          ref: journal.manifest.id,
          detail: journal.manifest.target
        })
      )
    }
    return new ReapReport({ reaped: expired.map((journal) => journal.manifest.id), at: now })
  })

  return Hold.of({ remove, overwrite, undo, undoLast, held, reap })
})

export const HoldLive = Layer.effect(Hold, make)
