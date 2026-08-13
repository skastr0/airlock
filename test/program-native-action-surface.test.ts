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
  ProgramRunnerWithNativeActionsLive,
  ProgramRunnerWithToolsLive
} from "../src/program/index.ts"
import {
  decodeToolDefinition,
  ExportedToolAction,
  ToolDefinitionDocument,
  ToolDefinitionLocation
} from "../src/tools/index.ts"

const location = new ToolDefinitionLocation({
  kind: "builtin",
  directory: "/opt/airlock/tools"
})

const definitionDocument = (definition: unknown) => new ToolDefinitionDocument({
  location,
  file: `/opt/airlock/tools/${String((definition as { readonly id?: unknown }).id)}.json`,
  json: JSON.stringify(definition)
})

const invokeDefinition = {
  schemaVersion: "airlock/tool-definition/v1",
  id: "fixture.invoke",
  version: "1.0.0",
  executables: [{ realm: "local", selector: "/usr/bin/true" }],
  actions: [{
    name: "call",
    inputSchema: { type: "object", additionalProperties: false },
    args: [],
    cwd: { _tag: "Literal", value: "/tmp" },
    environment: {},
    stdin: "discard",
    stdout: "capture",
    stderr: "capture",
    resources: [],
    lowering: "invoke",
    effectFootprint: ["invoke"],
    resultDecoder: "exit-status"
  }]
}

const enqueueDefinition = {
  schemaVersion: "airlock/tool-definition/v2",
  id: "fixture.enqueue",
  version: "1.0.0",
  executables: [],
  actions: [{
    name: "send",
    inputSchema: { type: "object", additionalProperties: false },
    lowering: "enqueue",
    request: {
      method: "POST",
      endpoint: { _tag: "Literal", value: "https://example.test/events" },
      body: { _tag: "Literal", value: "payload" }
    },
    emissionEffect: "mutate",
    effectFootprint: ["enqueue"],
    resultDecoder: "none"
  }]
}

const toolMap = async () => {
  const loaded = await Promise.all([
    Effect.runPromise(decodeToolDefinition(definitionDocument(invokeDefinition))),
    Effect.runPromise(decodeToolDefinition(definitionDocument(enqueueDefinition)))
  ])
  return new Map(loaded.flatMap((item) => item.definition.actions.map((action) => {
    const name = `${item.definition.id}.${action.name}`
    return [name, new ExportedToolAction({ name, loaded: item, action })] as const
  })))
}

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
    }).pipe(Effect.provide(runnerLayer.pipe(Layer.provide(executor))))
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

  it("denies the compact run alias at the same pre-effect gate", async () => {
    const observed = await runWith(
      ProgramRunnerWithNativeActionsLive(new Set(["file.write"])),
      `return run({ executable: "/usr/bin/true", args: [], cwd: "/tmp" })`
    )
    expectPreEffectDenial(observed, "process.run")
    expect(observed.result.failure?.action).toBe("run")
  })

  it.each([
    ["capture", `return capture("/tmp/input")`, "file.read"],
    ["apply", `return apply("write", { path: "/tmp/output", content: "ok" })`, "file.write"],
    ["request_external", `return request_external({ endpoint: "https://example.test", method: "POST" })`, "http.stage"]
  ])("denies the %s alias when its canonical action is omitted", async (_alias, source, nativeAction) => {
    const observed = await runWith(
      ProgramRunnerWithNativeActionsLive(new Set()),
      source
    )
    expectPreEffectDenial(observed, nativeAction)
  })

  it("denies both direct and aliased HTTP staging when http.stage is omitted", async () => {
    for (const source of [
      `return http.stage({ endpoint: "https://example.test", method: "POST" })`,
      `return request_external({ endpoint: "https://example.test", method: "POST" })`
    ]) {
      const observed = await runWith(
        ProgramRunnerWithNativeActionsLive(new Set(["process.run"])),
        source
      )
      expectPreEffectDenial(observed, "http.stage")
    }
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

  it("denies invoke definitions unless process.run is included", async () => {
    const actions = await toolMap()
    const observed = await runWith(
      ProgramRunnerWithToolsLive(actions, "native-contained", new Set(["file.write"])),
      `return fixture.invoke.call({})`
    )
    expectPreEffectDenial(observed, "process.run")
    expect(observed.result.failure?.action).toBe("fixture.invoke.call")
  })

  it("denies enqueue definitions unless http.stage is included", async () => {
    const actions = await toolMap()
    const observed = await runWith(
      ProgramRunnerWithToolsLive(actions, "native-contained", new Set(["process.run"])),
      `return fixture.enqueue.send({})`
    )
    expectPreEffectDenial(observed, "http.stage")
    expect(observed.result.failure?.action).toBe("fixture.enqueue.send")
  })

  it("lowers allowed invoke and enqueue definitions only to the closed Plan tags", async () => {
    const actions = await toolMap()
    const observed = await runWith(
      ProgramRunnerWithToolsLive(
        actions,
        "native-contained",
        new Set(["process.run", "http.stage"])
      ),
      `
        let invoked = fixture.invoke.call({})
        return fixture.enqueue.send({})
      `
    )
    expect(observed.result.state).toBe("succeeded")
    expect(observed.requests).toHaveLength(2)
    expect(observed.requests[0]?.call.input).toMatchObject({
      action: "process.run",
      cellProfile: "native-contained"
    })
    expect(observed.requests[0]?.draft.nodes.map((node) => node._tag)).toEqual([
      "Invoke",
      "Apply"
    ])
    expect(observed.requests[1]?.call.input).toMatchObject({ action: "http.stage" })
    expect(observed.requests[1]?.draft.nodes.map((node) => node._tag)).toEqual([
      "RequestExternal"
    ])
    expect(observed.requests.flatMap((request) => request.draft.nodes).every(
      (node) => ["Capture", "Invoke", "Apply", "RequestExternal"].includes(node._tag)
    )).toBe(true)
  })

  it("keeps the default runner at the explicit complete twelve-action surface", async () => {
    expect([...ALL_NATIVE_ACTIONS]).toHaveLength(12)
    const observed = await runWith(
      ProgramRunnerLive,
      `return run({ executable: "/usr/bin/true", args: [], cwd: "/tmp" })`
    )
    expect(observed.result.state).toBe("succeeded")
    expect(observed.requests[0]?.draft.nodes[0]?._tag).toBe("Invoke")
  })
})
