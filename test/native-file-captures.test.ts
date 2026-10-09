import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as AirlockHome from "../src/AirlockHome.ts"
import { HoldLayer } from "../src/Hold.ts"
import { FileLedgerLive } from "../src/host/FileLedger.ts"
import { Refused } from "../src/core/airlock/Implement.ts"
import {
  FileGlob,
  FileInspect,
  FileList,
  FileRead,
  FileStat,
  NativeFileSystem,
  NativeFileSystemLive,
  NativeFilesystemConfig
} from "../src/native/index.ts"
import { fileCaptures } from "../src/native/FileCaptures.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"


const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly workspace: string
  readonly outside: string
  readonly captures: ReturnType<typeof fileCaptures>
}) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const workspace = path.join(root, "workspace")
      const outside = path.join(root, "outside")
      yield* fs.makeDirectory(workspace)
      yield* fs.makeDirectory(outside)
      const native = yield* Effect.provide(
        NativeFileSystem,
        NativeFileSystemLive(new NativeFilesystemConfig({ workspace })).pipe(
          Layer.provideMerge(HoldLayer.pipe(Layer.provide(ExclusiveRenameTestLive))),
          Layer.provideMerge(FileLedgerLive),
          Layer.provideMerge(AirlockHome.layer(path.join(root, "airlock-home"))),
          Layer.provideMerge(BunServices.layer)
        )
      )
      return yield* body({ fs, path, workspace, outside, captures: fileCaptures(native) })
    })
  ).pipe(Effect.provide(BunServices.layer))

// An implementation's answer must be what its contract says comes back.
const answers = <A, I>(output: Schema.Codec<A, I>, value: unknown) =>
  Result.isSuccess(Schema.encodeUnknownResult(output)(value))

const run = <A>(value: A | Promise<A> | Effect.Effect<A, unknown>) =>
  Effect.isEffect(value) ? (value as Effect.Effect<A, unknown>) : Effect.promise(() => Promise.resolve(value))

describe("local file captures", () => {
  it.effect("answer each capture contract from the real filesystem", () =>
    world(({ fs, path, workspace, captures }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(workspace, "note.txt"), "hello")
        yield* fs.writeFileString(path.join(workspace, "data.json"), `{"n":1,"list":[true,null]}`)

        const text = yield* run(captures["file.read"]({ path: "note.txt", format: "text" }))
        expect(text).toBe("hello")
        const bytes = yield* run(captures["file.read"]({ path: "note.txt", format: "bytes" }))
        expect(bytes).toEqual([104, 101, 108, 108, 111])
        const json = yield* run(captures["file.read"]({ path: "data.json", format: "json" }))
        expect(json).toEqual({ n: 1, list: [true, null] })
        for (const value of [text, bytes, json]) expect(answers(FileRead.outcome, value)).toBe(true)

        const stat = yield* run(captures["file.stat"]({ path: "note.txt" }))
        expect(stat).toMatchObject({ kind: "file", bytes: 5 })
        expect(answers(FileStat.outcome, stat)).toBe(true)
        const inspected = yield* run(captures["file.inspect"]({ path: "note.txt" }))
        expect(answers(FileInspect.outcome, inspected)).toBe(true)

        const listed = yield* run(captures["file.list"]({ path: "." }))
        expect(answers(FileList.outcome, listed)).toBe(true)
        expect((listed as ReadonlyArray<{ name: string }>).map((entry) => entry.name).sort())
          .toEqual(["data.json", "note.txt"])

        const globbed = yield* run(captures["file.glob"]({ root: ".", pattern: "*.txt" }))
        expect(answers(FileGlob.outcome, globbed)).toBe(true)
        expect(globbed).toHaveLength(1)
      })
    )
  )

  it.effect("refuse, and read nothing, outside the workspace or through a symlink", () =>
    world(({ fs, path, workspace, outside, captures }) =>
      Effect.gen(function* () {
        const secret = path.join(outside, "secret.txt")
        yield* fs.writeFileString(secret, "the secret")
        yield* fs.symlink(secret, path.join(workspace, "link.txt"))

        for (const target of ["../outside/secret.txt", secret, "link.txt", "missing.txt"]) {
          const answer = yield* run(captures["file.read"]({ path: target, format: "text" }))
          expect(answer, target).toBeInstanceOf(Refused)
          expect((answer as Refused).reason, target).not.toContain("the secret")
        }
        expect(yield* run(captures["file.stat"]({ path: "link.txt" }))).toBeInstanceOf(Refused)
        expect(yield* run(captures["file.list"]({ path: "../outside" }))).toBeInstanceOf(Refused)
        expect(yield* run(captures["file.glob"]({ root: "../outside", pattern: "*" }))).toBeInstanceOf(Refused)
      })
    )
  )
})
