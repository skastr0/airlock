import { Effect, type Schema } from "effect"
import { type Refused, refused } from "../core/airlock/Implement.ts"
import type { ToolContract } from "../core/contract/ToolContract.ts"
import type { FileGlob, FileInspect, FileList, FileRead, FileStat } from "./FileContracts.ts"
import { type NativeFileSystem, type NativeFilesystemErrorUnion, type NativeStat } from "./NativeFileSystem.ts"

/**
 * The local implementations of the five capture tools. They only read. Any
 * way a read can fail leaves the filesystem as it was, so every failure is a
 * refusal: final, and meaning nothing happened.
 */

type Captures = {
  readonly "file.inspect": typeof FileInspect
  readonly "file.stat": typeof FileStat
  readonly "file.read": typeof FileRead
  readonly "file.list": typeof FileList
  readonly "file.glob": typeof FileGlob
}

// The refusal names the kind of failure and never the path's content.
const nothingRead = <A>(tool: string, read: Effect.Effect<A, NativeFilesystemErrorUnion>): Effect.Effect<A | Refused> =>
  Effect.catch(read, (error) => Effect.succeed(refused(`${tool} read nothing: ${error._tag}`)))

const stat = (entry: NativeStat) => ({
  path: entry.path,
  kind: entry.kind,
  bytes: entry.bytes,
  mode: entry.mode,
  device: entry.device,
  inode: entry.inode
})

/** One function per capture contract. A read needs nothing but its input. */
export type FileCaptures = {
  readonly [Name in keyof Captures]: (
    input: ToolContract.ShapeOf<Captures[Name]>["input"]
  ) => Effect.Effect<ToolContract.OutputOf<Captures[Name]> | Refused, unknown>
}

export const fileCaptures = (fs: NativeFileSystem["Service"]): FileCaptures => ({
  "file.inspect": ({ path }) => nothingRead("file.inspect", Effect.map(fs.inspect(path), stat)),
  "file.stat": ({ path }) => nothingRead("file.stat", Effect.map(fs.stat(path), stat)),
  "file.read": ({ path, format }) =>
    nothingRead(
      "file.read",
      format === "text"
        ? fs.readText(path)
        : format === "bytes"
          ? Effect.map(fs.readBytes(path), (bytes) => [...bytes])
          : // `readJson` parses a JSON document, so what it returns is JSON.
            (fs.readJson(path) as Effect.Effect<Schema.Json, NativeFilesystemErrorUnion>)
    ),
  "file.list": ({ path }) =>
    nothingRead(
      "file.list",
      Effect.map(fs.list(path), (entries) => entries.map((entry) => ({ name: entry.name, stat: stat(entry.stat) })))
    ),
  "file.glob": ({ root, pattern }) => nothingRead("file.glob", fs.glob(root, pattern))
})
