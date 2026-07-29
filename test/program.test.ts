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
          source: `return process.run({ executable: "/usr/bin/printf", args: ["ok"], cwd: "/tmp" })`
        }))
      }).pipe(Effect.provide(TestLayer))
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.draft.nodes[0]).toMatchObject({ _tag: "Invoke", executable: "/usr/bin/printf", args: ["ok"] })
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

  it("decodes aliases through the native Schema boundary", async () => {
    const raw = await Effect.runPromise(decodeProgramAction("run", ["/usr/bin/true", [], { cwd: "/tmp" }]))
    const call = await Effect.runPromise(canonicalizeProgramAction("run", raw))
    expect(call).toMatchObject({ action: "process.run", executable: "/usr/bin/true", cwd: "/tmp", realm: "local" })
  })

  it("fails unknown action names in the typed error channel", async () => {
    const result = await Effect.runPromise(Effect.either(decodeProgramAction("shell", [])))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(UnknownProgramAction)
  })
})
