import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  canonicalizeProgramAction,
  decodeProgramAction,
  ProgramActionResult,
  ProgramActionExecutor,
  ProgramRequest,
  ProgramRunner,
  ProgramRunnerLive,
  type ProgramActionRequest,
  UnknownProgramAction
} from "../src/program/index.ts"

const calls: ProgramActionRequest[] = []
const ExecutorLive = Layer.succeed(ProgramActionExecutor, {
  execute: (request: ProgramActionRequest) => {
    calls.push(request)
    return Effect.succeed(new ProgramActionResult({
      value: { state: "succeeded", action: request.call.action, planId: request.draft.id },
      artifacts: []
    }))
  }
})
const TestLayer = ProgramRunnerLive.pipe(Layer.provide(ExecutorLive))

describe("ProgramRunner", () => {
  it("executes each branch-selected action as an independent plan fragment", async () => {
    calls.length = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ProgramRunner
        return yield* runner.run(new ProgramRequest({
          source: `
            let source = capture("notes.txt")
            if source != null {
              return apply("write", { path: "out.txt", content: "done" })
            }
            return null
          `
        }))
      }).pipe(Effect.provide(TestLayer))
    )

    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.call.action)).toEqual(["file.read", "file.write"])
    expect(calls[0]!.draft.nodes[0]!._tag).toBe("Capture")
    expect(calls[1]!.draft.nodes[0]!._tag).toBe("Apply")
    expect(calls[1]!.inlineArtifacts[0]!.bytes).toEqual(new TextEncoder().encode("done"))
    expect(result.result).toMatchObject({ action: "file.write", state: "succeeded" })
  })

  it("normalizes dotted native verbs without granting reflective calls", async () => {
    calls.length = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ProgramRunner
        return yield* runner.run(new ProgramRequest({
          source: `return process.run({ executable: "/usr/bin/printf", args: ["ok"], descendantExecutables: ["/bin/sh"], cwd: "/tmp" })`
        }))
      }).pipe(Effect.provide(TestLayer))
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.draft.nodes[0]).toMatchObject({
      _tag: "Invoke",
      executable: "/usr/bin/printf",
      args: ["ok"],
      descendantExecutables: ["/bin/sh"]
    })
  })

  it("returns a partial run report with completed action records when a later language failure aborts evaluation", async () => {
    calls.length = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ProgramRunner
        return yield* runner.run(new ProgramRequest({
          source: `
            let written = file.write({ path: "out.txt", content: "done" })
            let staged = http.stage({ endpoint: "https://example.test/collect", method: "POST", body: "payload", holdMillis: 5000 })
            assert false, "stop after the admitted actions"
            return { written: written, staged: staged }
          `
        }))
      }).pipe(Effect.provide(TestLayer))
    )

    expect(result.state).toBe("partial")
    expect(result.result).toBeNull()
    expect(result.failure).toMatchObject({
      action: "program",
      phase: "language",
      causeTag: "AssertionFailed"
    })
    expect(result.actions).toHaveLength(2)
    expect(result.actions[0]!.result.value).toMatchObject({
      state: "succeeded",
      action: "file.write",
      planId: expect.any(String)
    })
    expect(result.actions[1]!.result.value).toMatchObject({
      state: "succeeded",
      action: "http.stage",
      planId: expect.any(String)
    })
    expect(result.plans).toHaveLength(2)
    expect(calls).toHaveLength(2)
  })

  it("decodes alias inputs into canonical process and HTTP actions", async () => {
    const processCall = await Effect.runPromise(decodeProgramAction("run", [{
      executable: "/usr/bin/true",
      args: [],
      descendantExecutables: ["/bin/sh"],
      cwd: "/tmp",
      stdin: null,
      timeout: { kind: "Duration", value: 2, unit: "m" },
      cellProfile: "native-contained"
    }]))
    const call = await Effect.runPromise(canonicalizeProgramAction("run", processCall))
    expect(call).toMatchObject({
      action: "process.run",
      executable: "/usr/bin/true",
      cwd: "/tmp",
      descendantExecutables: ["/bin/sh"],
      stdin: "discard",
      timeoutMs: 120_000,
      realm: "local"
    })

    const staged = await Effect.runPromise(decodeProgramAction("request_external", [{
      method: "POST",
      endpoint: "https://example.test/collect",
      hold: { kind: "Duration", value: 30, unit: "s" },
      body: { b: 2, a: 1 }
    }]))
    expect(staged).toMatchObject({
      action: "http.stage",
      holdMillis: 30_000,
      body: "{\"a\":1,\"b\":2}"
    })
  })

  it("rejects mutually exclusive alias timing fields", async () => {
    const runConflict = await Effect.runPromise(Effect.either(decodeProgramAction("run", [{
      executable: "/usr/bin/true",
      args: [],
      cwd: "/tmp",
      timeout: { kind: "Duration", value: 1, unit: "s" },
      timeoutMs: 1_000
    }])))
    expect(runConflict._tag).toBe("Left")
    if (runConflict._tag === "Left") {
      expect(runConflict.left).toMatchObject({
        action: "run",
        reason: "timeout and timeoutMs are mutually exclusive"
      })
    }

    const stagedConflict = await Effect.runPromise(Effect.either(decodeProgramAction("request_external", [{
      method: "POST",
      endpoint: "https://example.test/collect",
      hold: { kind: "Duration", value: 1, unit: "s" },
      holdMillis: 1_000
    }])))
    expect(stagedConflict._tag).toBe("Left")
    if (stagedConflict._tag === "Left") {
      expect(stagedConflict.left).toMatchObject({
        action: "request_external",
        reason: "hold and holdMillis are mutually exclusive"
      })
    }
  })

  it("fails unknown action names in the typed error channel", async () => {
    const result = await Effect.runPromise(Effect.either(decodeProgramAction("shell", [])))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(UnknownProgramAction)
  })
})
