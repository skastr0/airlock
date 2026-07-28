import { FileSystem, Path } from "@effect/platform"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
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

// The recovery floor, by construction: every verb in this component is a
// rename. The single unlink site in the entire codebase is `reap` — the
// second phase, held by the reaper, never by the acting agent.

export class Hold extends Context.Tag("airlock/Hold")<
  Hold,
  {
    readonly remove: (
      target: string
    ) => Effect.Effect<RemoveReceipt, TargetNotFound | ProtectedPath>
    readonly overwrite: (
      target: string,
      content: string
    ) => Effect.Effect<OverwriteReceipt, ProtectedPath>
    readonly undo: (
      id: ActId
    ) => Effect.Effect<UndoReceipt, UnknownAct | NotHeld | UndoConflict>
    readonly undoLast: Effect.Effect<UndoReceipt, NothingToUndo | UndoConflict>
    readonly held: Effect.Effect<ReadonlyArray<HeldManifest>>
    readonly reap: (olderThanMillis: number) => Effect.Effect<ReapReport>
  }
>() {}

const encodeManifest = Schema.encode(Schema.parseJson(HeldManifest))
const decodeManifest = Schema.decode(Schema.parseJson(HeldManifest))

const newActId = () => ActId.make(`act_${crypto.randomUUID().slice(0, 13)}`)

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* AirlockHome
  const ledger = yield* Ledger

  const manifestFile = (id: string) =>
    path.join(home.holdDir, id, "manifest.json")
  const payloadFile = (id: string) => path.join(home.holdDir, id, "payload")

  const guard = Effect.fnUntraced(function* (target: string) {
    if (target === "/") {
      return yield* new ProtectedPath({ target, reason: "filesystem root" })
    }
    if (target === home.home || target.startsWith(`${home.home}/`)) {
      return yield* new ProtectedPath({ target, reason: "airlock home" })
    }
  })

  const writeManifest = (manifest: HeldManifest) =>
    encodeManifest(manifest).pipe(
      Effect.flatMap((json) =>
        fs.writeFileString(manifestFile(manifest.id), json)
      ),
      Effect.orDie
    )

  const readManifest = (id: string) =>
    fs.readFileString(manifestFile(id)).pipe(Effect.flatMap(decodeManifest))

  // rename `target` into a fresh hold act; the caller owns the manifest fields
  const holdTarget = Effect.fnUntraced(function* (
    target: string,
    act: "remove" | "overwrite" | "displaced",
    kind: "file" | "directory"
  ) {
    const id = newActId()
    const at = yield* DateTime.now
    yield* fs
      .makeDirectory(path.join(home.holdDir, id), { recursive: true })
      .pipe(Effect.orDie)
    yield* fs.rename(target, payloadFile(id)).pipe(Effect.orDie)
    const manifest = new HeldManifest({
      id,
      act,
      target,
      kind,
      hasPayload: true,
      status: "held",
      at
    })
    yield* writeManifest(manifest)
    return manifest
  })

  const kindOf = (target: string) =>
    fs
      .stat(target)
      .pipe(
        Effect.map((info) =>
          info.type === "Directory" ? ("directory" as const) : ("file" as const)
        )
      )

  const remove = Effect.fn("Hold.remove")(function* (rawTarget: string) {
    const target = path.resolve(rawTarget)
    yield* guard(target)
    const kind = yield* kindOf(target).pipe(
      Effect.mapError(() => new TargetNotFound({ target }))
    )
    const manifest = yield* holdTarget(target, "remove", kind)
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
      kind,
      at: manifest.at
    })
  })

  const overwrite = Effect.fn("Hold.overwrite")(function* (
    rawTarget: string,
    content: string
  ) {
    const target = path.resolve(rawTarget)
    yield* guard(target)
    const exists = yield* fs.exists(target).pipe(Effect.orDie)
    const at = yield* DateTime.now
    let manifest: HeldManifest
    if (exists) {
      const kind = yield* kindOf(target).pipe(Effect.orDie)
      manifest = yield* holdTarget(target, "overwrite", kind)
    } else {
      // creation: nothing to hold, but the act is recorded so it can be
      // undone (undo displaces the created file back into the hold)
      const id = newActId()
      yield* fs
        .makeDirectory(path.join(home.holdDir, id), { recursive: true })
        .pipe(Effect.orDie)
      manifest = new HeldManifest({
        id,
        act: "overwrite",
        target,
        kind: "file",
        hasPayload: false,
        status: "held",
        at
      })
      yield* writeManifest(manifest)
    }
    yield* fs.writeFileString(target, content).pipe(Effect.orDie)
    yield* ledger.record(
      new LedgerEntry({
        at,
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
      at
    })
  })

  const undo = Effect.fn("Hold.undo")(function* (id: ActId) {
    const manifest = yield* readManifest(id).pipe(
      Effect.mapError(() => new UnknownAct({ id }))
    )
    if (manifest.status !== "held") {
      return yield* new NotHeld({ id, status: manifest.status })
    }
    const at = yield* DateTime.now
    const targetExists = yield* fs.exists(manifest.target).pipe(Effect.orDie)
    let displaced: ActId | undefined
    if (targetExists) {
      if (manifest.act === "overwrite") {
        // the current version makes room, but is itself held — an undo
        // never destroys bytes either
        const kind = yield* kindOf(manifest.target).pipe(Effect.orDie)
        const d = yield* holdTarget(manifest.target, "displaced", kind)
        displaced = d.id
      } else {
        return yield* new UndoConflict({ target: manifest.target })
      }
    }
    if (manifest.hasPayload) {
      yield* fs
        .makeDirectory(path.dirname(manifest.target), { recursive: true })
        .pipe(Effect.orDie)
      yield* fs.rename(payloadFile(id), manifest.target).pipe(Effect.orDie)
    }
    yield* writeManifest(
      new HeldManifest({ ...manifest, hasPayload: false, status: "restored" })
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

  const listManifests = fs.readDirectory(home.holdDir).pipe(
    Effect.flatMap(
      Effect.forEach((entry) =>
        readManifest(entry).pipe(Effect.option)
      )
    ),
    Effect.map((options) =>
      options.flatMap((o) => (o._tag === "Some" ? [o.value] : []))
    ),
    Effect.orDie
  )

  const held = listManifests.pipe(
    Effect.map((all) =>
      all
        .filter((m) => m.status === "held")
        .sort((a, b) => DateTime.toEpochMillis(a.at) - DateTime.toEpochMillis(b.at))
    )
  )

  const undoLast = Effect.gen(function* () {
    const current = yield* held
    const last = current.at(-1)
    if (last === undefined) return yield* new NothingToUndo({})
    return yield* undo(last.id).pipe(
      Effect.catchTags({
        UnknownAct: (e) => Effect.die(e),
        NotHeld: (e) => Effect.die(e)
      })
    )
  })

  const reap = Effect.fn("Hold.reap")(function* (olderThanMillis: number) {
    const now = yield* DateTime.now
    const cutoff = DateTime.subtract(now, { millis: olderThanMillis })
    const all = yield* listManifests
    const expired = all.filter((m) => DateTime.lessThanOrEqualTo(m.at, cutoff))
    for (const m of expired) {
      // the single unlink site in the codebase: the reaper's second phase
      yield* fs
        .remove(path.join(home.holdDir, m.id), { recursive: true })
        .pipe(Effect.orDie)
      yield* ledger.record(
        new LedgerEntry({
          at: now,
          effect: "mutation",
          act: "reap",
          ref: m.id,
          detail: m.target
        })
      )
    }
    return new ReapReport({ reaped: expired.map((m) => m.id), at: now })
  })

  return Hold.of({ remove, overwrite, undo, undoLast, held, reap })
})

export const HoldLive = Layer.effect(Hold, make)
