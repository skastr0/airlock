import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Refused } from "../src/core/airlock/Implement.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { FileLedgerLive } from "../src/host/FileLedger.ts"
import { HeldCalls, HeldCallsConfig, HeldCallsLive } from "../src/host/HeldCalls.ts"
import { fileApplies } from "../src/native/FileApplies.ts"
import {
  FileCopy,
  FileMkdir,
  FileMove,
  FileRemove,
  FileWrite,
  NativeFileSystem,
  NativeFileSystemLive,
  NativeFilesystemConfig
} from "../src/native/index.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly at: (name: string) => string
  readonly hold: typeof Hold.Service
  readonly calls: typeof HeldCalls.Service
  readonly applies: ReturnType<typeof fileApplies>
  /** Claims a fresh call, as the kernel does before it dispatches an apply. */
  readonly call: (name: string) => Effect.Effect<Parameters<ReturnType<typeof fileApplies>["file.write"]>[1]>
}) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const workspace = path.join(root, "workspace")
      yield* fs.makeDirectory(workspace)
      const services = yield* Effect.gen(function* () {
        return { calls: yield* HeldCalls, hold: yield* Hold, native: yield* NativeFileSystem }
      }).pipe(Effect.provide(
        HeldCallsLive(new HeldCallsConfig({ retentionMillis: 60_000 })).pipe(
          Layer.provideMerge(NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))),
          Layer.provideMerge(HoldLayer.pipe(Layer.provide(ExclusiveRenameTestLive))),
          Layer.provideMerge(FileLedgerLive),
          Layer.provideMerge(AirlockHome.layer(path.join(root, "airlock-home"))),
          Layer.provideMerge(BunServices.layer)
        )
      ))
      return yield* body({
        fs,
        at: (name) => path.join(workspace, name),
        hold: services.hold,
        calls: services.calls,
        applies: fileApplies({
          files: services.native,
          calls: services.calls,
          artifact: (id) =>
            id === "artifact-1" ? Effect.succeed(new TextEncoder().encode("from artifact")) : Effect.fail("unknown artifact")
        }),
        call: (name) =>
          services.calls.prepare({
            callId: name, runId: "run", tool: "file", version: "1", inputDigest: "sha256:x", resources: []
          }).pipe(Effect.orDie)
      })
    })
  ).pipe(Effect.provide(BunServices.layer))

const answers = <A, I>(output: Schema.Codec<A, I>, value: unknown) =>
  Result.isSuccess(Schema.encodeUnknownResult(output)(value))

describe("local file applies", () => {
  it.effect("answer each apply contract and can put each whole call back", () =>
    world(({ fs, at, calls, applies, call }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("note.txt"), "before")

        const write = yield* call("write")
        const written = yield* applies["file.write"]({ path: "note.txt", content: "after" }, write)
        expect(answers(FileWrite.outcome, written)).toBe(true)
        expect(written).toMatchObject({ previous_held: true, bytes: 5 })

        const copy = yield* call("copy")
        const copied = yield* applies["file.copy"]({ source: "note.txt", destination: "copy.txt" }, copy)
        expect(answers(FileCopy.outcome, copied)).toBe(true)
        expect(yield* fs.readFileString(at("copy.txt"))).toBe("after")

        const mkdir = yield* call("mkdir")
        const made = yield* applies["file.mkdir"]({ path: "a/b/c", parents: true }, mkdir)
        expect(answers(FileMkdir.outcome, made)).toBe(true)
        expect((made as { act_ids: ReadonlyArray<string> }).act_ids).toHaveLength(3)

        const move = yield* call("move")
        const moved = yield* applies["file.move"]({ source: "copy.txt", destination: "a/b/c/moved.txt" }, move)
        expect(answers(FileMove.outcome, moved)).toBe(true)
        expect(yield* fs.exists(at("copy.txt"))).toBe(false)

        const remove = yield* call("remove")
        const removed = yield* applies["file.remove"]({ path: "note.txt" }, remove)
        expect(answers(FileRemove.outcome, removed)).toBe(true)
        expect(yield* fs.exists(at("note.txt"))).toBe(false)

        // Newest call first, each one whole.
        for (const reference of [remove, move, mkdir, copy, write]) {
          expect((yield* calls.restore(reference)).state, reference.callId).toBe("restored")
        }
        expect(yield* fs.readFileString(at("note.txt"))).toBe("before")
        expect(yield* fs.exists(at("copy.txt"))).toBe(false)
        expect(yield* fs.exists(at("a"))).toBe(false)
      })
    )
  )

  it.effect("write the bytes of an artifact of the run", () =>
    world(({ fs, at, applies, call }) =>
      Effect.gen(function* () {
        const written = yield* applies["file.write"]({ path: "out.txt", sourceArtifact: "artifact-1" }, yield* call("artifact"))
        expect(written).toMatchObject({ previous_held: false, bytes: 13 })
        expect(yield* fs.readFileString(at("out.txt"))).toBe("from artifact")
        const missing = yield* applies["file.write"]({ path: "out.txt", sourceArtifact: "nope" }, yield* call("missing"))
        expect(missing).toBeInstanceOf(Refused)
        expect(yield* fs.readFileString(at("out.txt"))).toBe("from artifact")
      })
    )
  )

  it.effect("refuse, with nothing in effect, a call that cannot be carried out", () =>
    world(({ fs, at, hold, calls, applies, call }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("kept.txt"), "kept")
        for (const [name, run] of [
          ["remove-absent", (held) => applies["file.remove"]({ path: "absent.txt" }, held)],
          ["remove-outside", (held) => applies["file.remove"]({ path: "../outside.txt" }, held)],
          ["move-absent", (held) => applies["file.move"]({ source: "absent.txt", destination: "kept.txt" }, held)],
          ["copy-onto-itself", (held) => applies["file.copy"]({ source: "kept.txt", destination: "kept.txt" }, held)]
        ] as ReadonlyArray<readonly [string, (held: Parameters<typeof applies["file.remove"]>[1]) => Effect.Effect<unknown, unknown>]>) {
          const reference = yield* call(name)
          expect(yield* run(reference), name).toBeInstanceOf(Refused)
          expect((yield* calls.inspect(reference)).state, name).toBe("refused")
        }
        expect(yield* fs.readFileString(at("kept.txt"))).toBe("kept")
        expect((yield* hold.held).filter((act) => act.status === "held")).toEqual([])
      })
    )
  )

  it.effect("never apply the same call twice", () =>
    world(({ fs, at, applies, call }) =>
      Effect.gen(function* () {
        const reference = yield* call("once")
        yield* applies["file.write"]({ path: "once.txt", content: "first" }, reference)
        const again = yield* applies["file.write"]({ path: "once.txt", content: "second" }, reference).pipe(Effect.flip)
        expect(again).toMatchObject({ _tag: "HeldCallNotFresh" })
        expect(yield* fs.readFileString(at("once.txt"))).toBe("first")
      })
    )
  )
})
