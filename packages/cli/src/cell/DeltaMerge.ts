import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import * as nodePath from "node:path"
import { reasonOf } from "../FailureText.ts"
import type { Cell, CellReceipt, WorkspaceDeltaCandidate } from "./Cell.ts"

/**
 * The check that stands between what a confined process produced in its
 * private workspace and the live workspace. Every candidate is checked
 * against the live workspace and against the private output before the first
 * live change; the changes themselves are the caller's, through Hold.
 */

/** Why a delta may not be merged. Nothing has changed when this is raised. */
export class DeltaMergeRefused extends Schema.TaggedError<DeltaMergeRefused>()("DeltaMergeRefused", {
  kind: Schema.Literals(["drift", "unsupported", "revalidation-failed"]),
  paths: Schema.Array(Schema.String),
  reason: Schema.String
}) {}

/** One change to make: remove `target`, or replace it from `source`. */
export type DeltaMergeEntry = Readonly<{
  readonly candidate: WorkspaceDeltaCandidate
  readonly target: string
  readonly source?: string
}>

const relativeTopLevel = (path: string) =>
  path.length > 0 && path !== "." && path !== ".." && !path.includes("/") && !path.includes("\\") && !path.includes("\0")

type ManagedFingerprint = Readonly<{
  readonly exists: boolean
  readonly supported: boolean
  readonly digest: string
  readonly kind?: "file" | "directory"
}>

/** Mirrors the Cell's top-level fingerprint algorithm without following links. */
const fingerprintManagedEntry = async (path: string): Promise<ManagedFingerprint> => {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: unknown }).code === "ENOENT") {
      return { exists: false, supported: true, digest: "" }
    }
    throw cause
  }
  const kind = info.isFile() ? "file" as const : info.isDirectory() ? "directory" as const : undefined
  if (kind === undefined) return { exists: true, supported: false, digest: "" }
  const material = kind === "file"
    ? await readFile(path)
    : (await Promise.all((await readdir(path)).sort().map(async (entry) => {
        const child = await fingerprintManagedEntry(nodePath.join(path, entry))
        if (!child.exists || !child.supported) throw new Error(`unsupported directory child: ${entry}`)
        return `${entry}\0${child.digest}\0`
      }))).join("")
  return {
    exists: true,
    supported: true,
    kind,
    digest: createHash("sha256").update(`${kind}\0${info.mode}\0${info.size}\0`).update(material).digest("hex")
  }
}

const unsupported = (path: string, reason: string) =>
  new DeltaMergeRefused({ kind: "unsupported", paths: [path], reason })
const drifted = (paths: ReadonlyArray<string>, reason: string) =>
  new DeltaMergeRefused({ kind: "drift", paths, reason })

const fingerprint = (path: string, candidate: string, reason: string) =>
  Effect.tryPromise({ try: () => fingerprintManagedEntry(path), catch: () => unsupported(candidate, reason) })

export const preflightDeltaMerge = (
  cell: Cell["Service"],
  workspace: string,
  receipt: CellReceipt
): Effect.Effect<ReadonlyArray<DeltaMergeEntry>, DeltaMergeRefused> =>
  Effect.gen(function* () {
    if (receipt.drift.length > 0) {
      return yield* drifted(receipt.drift.map((drift) => drift.path), "live workspace changed while Cell ran")
    }
    const drift = yield* cell.revalidate(receipt).pipe(
      Effect.mapError((error) => new DeltaMergeRefused({
        kind: "revalidation-failed",
        paths: [],
        reason: `${error._tag}: ${reasonOf(error)}`
      }))
    )
    if (drift.length > 0) {
      return yield* drifted(drift.map((entry) => entry.path), "live workspace drifted before Apply")
    }
    return yield* Effect.forEach(receipt.delta, (candidate) => Effect.gen(function* () {
      if (!relativeTopLevel(candidate.path)) {
        return yield* unsupported(candidate.path, "only top-level non-symlink paths are mergeable in host-native v1")
      }
      const expected = candidate.kind === "deleted" ? candidate.baseline : candidate.private
      if (expected === undefined || (expected.kind !== "file" && expected.kind !== "directory")) {
        return yield* unsupported(candidate.path, "symlink and special-file Cell deltas are not mergeable in host-native v1")
      }
      const target = nodePath.join(workspace, candidate.path)
      const live = yield* fingerprint(target, candidate.path, "live entry contains a symlink or special filesystem object")
      if (candidate.kind === "created") {
        if (live.exists && !live.supported) {
          return yield* unsupported(candidate.path, "created path is occupied by a symlink or special filesystem object")
        }
        if (live.exists) return yield* drifted([candidate.path], "created path is now occupied in live workspace")
      } else if (live.exists && !live.supported) {
        return yield* unsupported(candidate.path, "live entry is a symlink or special filesystem object")
      } else if (!live.exists || live.kind !== candidate.baseline?.kind || live.digest !== candidate.baseline?.digest) {
        return yield* drifted([candidate.path], "live entry no longer matches Cell baseline")
      }
      if (candidate.kind === "deleted") return { candidate, target } satisfies DeltaMergeEntry
      const source = nodePath.join(receipt.privateWorkspace, candidate.path)
      const privateEntry = yield* fingerprint(source, candidate.path, "private Cell output contains a symlink or special filesystem object")
      if (!privateEntry.exists || !privateEntry.supported || privateEntry.kind !== candidate.private?.kind || privateEntry.digest !== candidate.private?.digest) {
        return yield* unsupported(candidate.path, "private Cell output no longer matches the proposed managed entry")
      }
      return { candidate, target, source } satisfies DeltaMergeEntry
    }))
  })
