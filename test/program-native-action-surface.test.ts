import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  ALL_NATIVE_ACTIONS,
  ProgramActionExecutor,
  ProgramActionResult,
  type ProgramActionRequest,
  ProgramRequest,
  ProgramRunner,
  ProgramRunnerLive,
  ProgramRunnerWithNativeActionsLive
} from "../src/program/index.ts"
const runWith = async (
  runnerLayer: ReturnType<typeof ProgramRunnerWithNativeActionsLive>,
  source: string
) => {
  const requests: ProgramActionRequest[] = []
  const executor = Layer.succeed(ProgramActionExecutor, ProgramActionExecutor.of({
    execute: (request) => {
      requests.push(request)
      return Effect.succeed(new ProgramActionResult({
        value: { state: "executed", action: request.call.action },
        artifacts: []
      }))
    }
  }))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* ProgramRunner
      return yield* runner.run(new ProgramRequest({ source }))
    }).pipe(Effect.provide(runnerLayer.pipe(
      Layer.provide(executor),
      Layer.provide(BunCrypto.layer)
    )))
  )
  return { requests, result }
}

const expectPreEffectDenial = (
  observed: Awaited<ReturnType<typeof runWith>>,
  nativeAction: string
) => {
  expect(observed.result).toMatchObject({
    state: "failed",
    plans: [],
    actions: [],
    failure: {
      phase: "contract",
      causeTag: "ProgramActionDecodeFailed",
      reason: expect.stringContaining(nativeAction)
    }
  })
  expect(observed.requests).toEqual([])
}

describe("Program native action surface", () => {
  it("denies direct process.run before constructing a Plan or calling the executor", async () => {
    const observed = await runWith(
      ProgramRunnerWithNativeActionsLive(new Set(["file.write"])),
      `return process.run({ executable: "/usr/bin/true", args: [], cwd: "/tmp" })`
    )
    expectPreEffectDenial(observed, "process.run")
  })

  it.each([
    ["run", `return run({ executable: "/usr/bin/true", args: [], cwd: "/tmp" })`],
    ["capture", `return capture("/tmp/input")`],
    ["apply", `return apply("write", { path: "/tmp/output", content: "ok" })`],
    ["request_external", `return request_external({ endpoint: "https://example.test", method: "POST" })`]
  ])("has no second name for a native action: %s is unknown on the full surface", async (alias, source) => {
    const observed = await runWith(ProgramRunnerWithNativeActionsLive(ALL_NATIVE_ACTIONS), source)
    expect(observed.requests).toEqual([])
    expect(observed.result.state).toBe("failed")
    expect(observed.result.plans).toEqual([])
    expect(observed.result.failure).toMatchObject({
      action: alias,
      phase: "contract",
      causeTag: "UnknownProgramAction"
    })
  })

  it("denies HTTP staging when http.stage is omitted", async () => {
    const observed = await runWith(
      ProgramRunnerWithNativeActionsLive(new Set(["process.run"])),
      `return http.stage({ endpoint: "https://example.test", method: "POST" })`
    )
    expectPreEffectDenial(observed, "http.stage")
  })

  it("allows file.write when it is explicitly included", async () => {
    const observed = await runWith(
      ProgramRunnerWithNativeActionsLive(new Set(["file.write"])),
      `return file.write({ path: "/tmp/output", content: "ok" })`
    )
    expect(observed.result.state).toBe("succeeded")
    expect(observed.requests).toHaveLength(1)
    expect(observed.requests[0]?.call.input).toMatchObject({ action: "file.write" })
    expect(observed.requests[0]?.draft.nodes.map((node) => node._tag)).toEqual(["Apply"])
  })

  it("has no name outside the native surface: a namespaced definition call is unknown", async () => {
    const observed = await runWith(ProgramRunnerLive, `return fixture.invoke.call({})`)
    expect(observed.requests).toEqual([])
    expect(observed.result.state).toBe("failed")
    expect(observed.result.plans).toEqual([])
  })

  it("keeps the default runner at the explicit complete twelve-action surface", async () => {
    expect([...ALL_NATIVE_ACTIONS]).toHaveLength(12)
    const observed = await runWith(
      ProgramRunnerLive,
      `return process.run({ executable: "/usr/bin/true", args: [], cwd: "/tmp" })`
    )
    expect(observed.result.state).toBe("succeeded")
    expect(observed.requests[0]?.draft.nodes[0]?._tag).toBe("Invoke")
  })
})
