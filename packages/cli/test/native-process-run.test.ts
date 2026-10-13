import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Cell, CellLive } from "../src/cell/index.ts"
import { Refused } from "@skastr0/airlock"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { FileLedgerLive } from "../src/host/FileLedger.ts"
import { HeldCalls, HeldCallsConfig, HeldCallsLive } from "../src/host/HeldCalls.ts"
import { ProcessRun } from "../src/native/index.ts"
import { processRun } from "../src/native/ProcessRun.ts"
import { ProcessRunner, ProcessRunnerLive } from "../src/process/Process.ts"
import { artifactIdOf } from "../src/native/Artifacts.ts"
import { memoryArtifacts } from "./support/MemoryArtifacts.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"
import { nativeContainmentSupported } from "./support/NativeContainmentTest.ts"

type Run = ReturnType<typeof processRun>
type Output = Exclude<Effect.Success<ReturnType<Run>>, Refused>

// Not /bin/sh: on macOS it re-executes /bin/bash, which a Cell refuses as an
// undeclared program.
const input = (script: string, extra: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(ProcessRun.input)({ executable: "/bin/bash", args: ["-c", script], cwd: ".", ...extra })

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly at: (name: string) => string
  readonly outside: string
  readonly calls: typeof HeldCalls.Service
  readonly hold: typeof Hold.Service
  readonly run: Run
  readonly call: (name: string) => Effect.Effect<Parameters<typeof HeldCalls.Service["run"]>[0]>
  readonly artifacts: ReturnType<typeof memoryArtifacts>
}) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const workspace = path.join(root, "workspace")
      const outside = path.join(root, "outside.txt")
      yield* fs.makeDirectory(workspace)
      const services = yield* Effect.gen(function* () {
        return { calls: yield* HeldCalls, hold: yield* Hold, cell: yield* Cell, process: yield* ProcessRunner }
      }).pipe(Effect.provide(
        HeldCallsLive(new HeldCallsConfig({ retentionMillis: 60_000 })).pipe(
          Layer.provideMerge(CellLive),
          Layer.provideMerge(ProcessRunnerLive),
          Layer.provideMerge(HoldLayer.pipe(Layer.provide(ExclusiveRenameTestLive))),
          Layer.provideMerge(FileLedgerLive),
          Layer.provideMerge(AirlockHome.layer(path.join(root, "airlock-home"))),
          Layer.provideMerge(BunServices.layer)
        )
      ))
      const artifacts = memoryArtifacts()
      return yield* body({
        fs,
        at: (name) => path.join(workspace, name),
        outside,
        calls: services.calls,
        hold: services.hold,
        artifacts,
        run: processRun({
          ...services,
          workspace,
          environment: { PATH: "/usr/bin:/bin" },
          artifacts: artifacts.store
        }),
        call: (name) =>
          services.calls.prepare({
            callId: name, runId: "run", tool: "process.run", version: "1", inputDigest: "sha256:x", resources: []
          }).pipe(Effect.orDie)
      })
    })
  ).pipe(Effect.provide(BunServices.layer))

const done = (value: Output | Refused): Output => {
  if (value instanceof Refused) throw new Error(`refused: ${value.reason}`)
  expect(Result.isSuccess(Schema.encodeUnknownResult(ProcessRun.outcome)(value))).toBe(true)
  return value
}

// ProcessRunner is Bun-backed; scripts/verify-bun-integrations.ts runs this file under Bun.
describe.skipIf(typeof Bun === "undefined")("process.run, unconfined", () => {
  it.effect("reports what the process did and does not claim to know what it changed", () =>
    world(({ fs, at, run, artifacts }) =>
      Effect.gen(function* () {
        const ok = done(yield* run(input("cat; printf err >&2; printf x > made.txt", { stdin: "hello" }), { confined: false }))
        expect(ok).toMatchObject({ outcome: "exited", exit_code: 0, stdout: "hello", stderr: "err", merged: null })
        // Output is kept under the name of its content.
        expect(ok.stdout_artifact).toEqual({
          id: artifactIdOf(new TextEncoder().encode("hello")), media_type: "application/octet-stream", byte_length: 5
        })
        expect(artifacts.held.size).toBe(2)
        expect(yield* fs.readFileString(at("made.txt"))).toBe("x")

        const fromArtifact = done(yield* run(input("cat", { stdinArtifact: artifacts.put("from artifact"), stderr: "discard" }), { confined: false }))
        expect(fromArtifact).toMatchObject({ stdout: "from artifact", stderr: null, stderr_artifact: null })

        // A nonzero exit and a timeout are results, not failures of the call.
        expect(done(yield* run(input("exit 3"), { confined: false }))).toMatchObject({ outcome: "exited", exit_code: 3 })
        expect(done(yield* run(input("sleep 5", { timeoutMs: 100 }), { confined: false })).outcome).toBe("timed-out")
        // A program that cannot start is nothing happening.
        const missing = yield* run(
          Schema.decodeUnknownSync(ProcessRun.input)({ executable: "/nonexistent/program", args: [], cwd: "." }),
          { confined: false }
        )
        expect(missing).toBeInstanceOf(Refused)
      })
    )
  )
})

describe.skipIf(!nativeContainmentSupported)("process.run, confined", () => {
  it.effect("merges what a clean run changed through Hold, and the whole call can be put back", () =>
    world(({ fs, at, calls, run, call }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("changed.txt"), "before")
        yield* fs.writeFileString(at("gone.txt"), "to be removed")
        const held = yield* call("clean")
        const ran = done(yield* run(
          input("printf after > changed.txt; rm gone.txt; printf new > made.txt; printf out", {
            descendantExecutables: ["/bin/rm"]
          }),
          { confined: true, held }
        ))
        expect(ran, ran.stderr ?? "").toMatchObject({ outcome: "exited", exit_code: 0, stdout: "out" })
        expect([...ran.merged!].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: "changed.txt", kind: "modified" },
          { path: "gone.txt", kind: "deleted" },
          { path: "made.txt", kind: "created" }
        ])
        expect(yield* fs.readFileString(at("changed.txt"))).toBe("after")
        expect(yield* fs.exists(at("gone.txt"))).toBe(false)
        expect(yield* fs.readFileString(at("made.txt"))).toBe("new")
        expect((yield* calls.inspect(held)).acts).toHaveLength(3)

        expect((yield* calls.restore(held)).state).toBe("restored")
        expect(yield* fs.readFileString(at("changed.txt"))).toBe("before")
        expect(yield* fs.readFileString(at("gone.txt"))).toBe("to be removed")
        expect(yield* fs.exists(at("made.txt"))).toBe(false)
      })
    )
  )

  it.effect("cannot change anything outside its private copy, and its copy is not deleted", () =>
    world(({ fs, at, outside, hold, run, call }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(outside, "outside before")
        const ran = done(yield* run(
          input(`printf tampered > ${JSON.stringify(outside)}; printf in > in.txt`),
          { confined: true, held: yield* call("escape") }
        ))
        expect(yield* fs.readFileString(outside)).toBe("outside before")
        // The write outside failed, so the shell exited nonzero or not; either
        // way nothing outside changed and only a clean run is merged.
        if (ran.exit_code === 0) expect(yield* fs.readFileString(at("in.txt"))).toBe("in")
        else expect(yield* fs.exists(at("in.txt"))).toBe(false)
        // The private copy went to Hold; nothing was unlinked.
        expect((yield* hold.held).some((act) => act.purpose === "runtime-private")).toBe(true)
        const siblings = yield* fs.readDirectory(at(".."))
        expect(siblings.filter((name) => name.startsWith(".airlock-cell-"))).toEqual([])
      })
    )
  )

  it.effect("discards the changes of a run that did not exit cleanly", () =>
    world(({ fs, at, calls, run, call }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("kept.txt"), "before")
        const held = yield* call("failed")
        const ran = done(yield* run(input("printf after > kept.txt; exit 2"), { confined: true, held }))
        expect(ran, ran.stderr ?? "").toMatchObject({ outcome: "exited", exit_code: 2, merged: [] })
        expect(yield* fs.readFileString(at("kept.txt"))).toBe("before")
        expect((yield* calls.inspect(held)).state).toBe("prepared")
      })
    )
  )

  // Live clock: the test waits on a real process.
  it.live("refuses, with nothing changed, when the live directory moved while it ran", () =>
    world(({ fs, at, calls, run, call }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("contended.txt"), "before")
        yield* fs.writeFileString(at("other.txt"), "other before")
        const held = yield* call("drift")
        // The process changes two files, and waits for a marker so the live
        // one can be edited while it runs.
        const parent = at("..")
        const release = Effect.gen(function* () {
          yield* Effect.sleep("400 millis")
          yield* fs.writeFileString(at("contended.txt"), "edited by someone else")
          // The process sees its private copy, so the marker goes there.
          for (let attempt = 0; attempt < 100; attempt++) {
            const cells = (yield* fs.readDirectory(parent)).filter((name) => name.startsWith(".airlock-cell-"))
            if (cells.length > 0) return yield* fs.writeFileString(`${parent}/${cells[0]}/go`, "")
            yield* Effect.sleep("50 millis")
          }
        }).pipe(Effect.orDie)
        const [result] = yield* Effect.all([
          run(
            input("printf a > other.txt; printf b > contended.txt; while [ ! -e go ]; do sleep 0.05; done", {
              timeoutMs: 20_000,
              descendantExecutables: ["/bin/sleep"]
            }),
            { confined: true, held }
          ),
          release
        ], { concurrency: 2 })
        expect(result).toBeInstanceOf(Refused)
        expect((result as Refused).reason).toContain("live workspace")
        expect(yield* fs.readFileString(at("contended.txt"))).toBe("edited by someone else")
        expect(yield* fs.readFileString(at("other.txt"))).toBe("other before")
        expect((yield* calls.inspect(held)).state).toBe("refused")
      })
    )
  , 30_000)

  it.effect("does not start outside the workspace root, or without the call's claim", () =>
    world(({ fs, at, run, call }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(at("sub"))
        const elsewhere = yield* run(
          Schema.decodeUnknownSync(ProcessRun.input)({ executable: "/bin/bash", args: ["-c", "printf x > made.txt"], cwd: "sub" }),
          { confined: true, held: yield* call("cwd") }
        )
        expect(elsewhere).toBeInstanceOf(Refused)
        expect(yield* fs.exists(at("sub/made.txt"))).toBe(false)
        const unclaimed = yield* run(input("printf x > made.txt"), { confined: true }).pipe(Effect.exit)
        expect(unclaimed._tag).toBe("Failure")
        expect(yield* fs.exists(at("made.txt"))).toBe(false)
      })
    )
  )
})
