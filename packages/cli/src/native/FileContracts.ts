import { Effect, Schema } from "effect"
import { defineToolContract } from "@skastr0/airlock"
import { ArtifactId } from "./Artifacts.ts"
import { ActId } from "@skastr0/airlock"
import { NativeEntryKind } from "./NativeFileSystem.ts"

/**
 * The local filesystem as tool contracts: five that capture and five that
 * apply. A contract says what a call is and what comes back; it touches no
 * file. The host supplies the implementations, and every apply goes through
 * Hold there.
 *
 * Every path a call names is a public field declared as a path resource with
 * the rights the call needs on it, so a grant can bound it and a record can
 * show it. File content never is.
 */

const Stat = Schema.Struct({
  path: Schema.String,
  kind: NativeEntryKind,
  bytes: Schema.Finite,
  mode: Schema.Finite,
  device: Schema.Finite,
  inode: Schema.Finite
})

const Path = Schema.Struct({ path: Schema.String })

/** Identity-safe inspection of one entry. Symlinks are refused, not followed. */
export const FileInspect = defineToolContract({
  name: "file.inspect",
  version: "1",
  effect: "capture",
  input: Path,
  output: Stat,
  public: ["path"],
  resources: { path: { kind: "path", rights: ["read"] } }
})

/** Metadata of one entry. Symlinks are refused, not followed. */
export const FileStat = defineToolContract({
  name: "file.stat",
  version: "1",
  effect: "capture",
  input: Path,
  output: Stat,
  public: ["path"],
  resources: { path: { kind: "path", rights: ["read"] } }
})

/**
 * A file's content: `text` is decoded UTF-8, `bytes` is a list of byte values,
 * `json` is the parsed document.
 */
export const FileRead = defineToolContract({
  name: "file.read",
  version: "1",
  effect: "capture",
  input: Schema.Struct({
    path: Schema.String,
    format: Schema.Literals(["text", "bytes", "json"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("text" as const))
    )
  }),
  output: Schema.Json,
  public: ["path", "format"],
  resources: { path: { kind: "path", rights: ["read"] } }
})

export const FileList = defineToolContract({
  name: "file.list",
  version: "1",
  effect: "capture",
  input: Path,
  output: Schema.Array(Schema.Struct({ name: Schema.String, stat: Stat })),
  public: ["path"],
  resources: { path: { kind: "path", rights: ["read"] } }
})

/** Paths under `root` matching a bounded pattern. Only `root` is a path. */
export const FileGlob = defineToolContract({
  name: "file.glob",
  version: "1",
  effect: "capture",
  input: Schema.Struct({ root: Schema.String, pattern: Schema.String }),
  output: Schema.Array(Schema.String),
  public: ["root", "pattern"],
  resources: { root: { kind: "path", rights: ["read"] } }
})

/**
 * Replaces a file with content given inline or taken from an artifact of this
 * run. Exactly one source: a call with both, or neither, does not decode.
 */
export const FileWrite = defineToolContract({
  name: "file.write",
  version: "1",
  effect: "apply",
  input: Schema.Struct({
    path: Schema.String,
    content: Schema.optionalKey(Schema.String),
    sourceArtifact: Schema.optionalKey(ArtifactId)
  }).pipe(
    Schema.check(Schema.makeFilter((input) =>
      (input.content === undefined) !== (input.sourceArtifact === undefined) ||
      "provide exactly one of content and sourceArtifact"
    ))
  ),
  output: Schema.Struct({
    act_id: ActId,
    target: Schema.String,
    /** Whether there was a previous entry, now held. */
    previous_held: Schema.Boolean,
    bytes: Schema.Finite
  }),
  public: ["path"],
  resources: { path: { kind: "path", rights: ["write"] } }
})

export const FileRemove = defineToolContract({
  name: "file.remove",
  version: "1",
  effect: "apply",
  input: Path,
  output: Schema.Struct({ act_id: ActId, target: Schema.String, kind: NativeEntryKind }),
  public: ["path"],
  resources: { path: { kind: "path", rights: ["write"] } }
})

const Transfer = Schema.Struct({ source: Schema.String, destination: Schema.String })

export const FileCopy = defineToolContract({
  name: "file.copy",
  version: "1",
  effect: "apply",
  input: Transfer,
  output: Schema.Struct({
    act_id: ActId,
    source: Schema.String,
    target: Schema.String,
    previous_held: Schema.Boolean,
    bytes: Schema.Finite
  }),
  public: ["source", "destination"],
  resources: { source: { kind: "path", rights: ["read"] }, destination: { kind: "path", rights: ["write"] } }
})

/** Two held acts: the install at the destination and the removal of the source. */
export const FileMove = defineToolContract({
  name: "file.move",
  version: "1",
  effect: "apply",
  input: Transfer,
  output: Schema.Struct({
    install_act_id: ActId,
    remove_act_id: ActId,
    source: Schema.String,
    target: Schema.String
  }),
  public: ["source", "destination"],
  resources: { source: { kind: "path", rights: ["read", "write"] }, destination: { kind: "path", rights: ["write"] } }
})

/** One held act per directory created; none when the directory already existed. */
export const FileMkdir = defineToolContract({
  name: "file.mkdir",
  version: "1",
  effect: "apply",
  input: Schema.Struct({
    path: Schema.String,
    parents: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
  }),
  output: Schema.Struct({ path: Schema.String, act_ids: Schema.Array(ActId) }),
  public: ["path", "parents"],
  resources: { path: { kind: "path", rights: ["write"] } }
})

export const FileContracts = [
  FileInspect,
  FileStat,
  FileRead,
  FileList,
  FileGlob,
  FileWrite,
  FileRemove,
  FileCopy,
  FileMove,
  FileMkdir
] as const
