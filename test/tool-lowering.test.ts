import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  ToolActionLoweringRequest,
  ToolExecutableRejected,
  ToolTemplateRejected,
  UnknownToolAction,
  UnsupportedToolActionLowering,
  decodeToolDefinition,
  decodeToolResult,
  lowerToolAction,
  ToolDefinitionDocument,
  ToolDefinitionLocation,
  ToolResultDecodeFailed
} from "../src/tools/index.ts"

const location = new ToolDefinitionLocation({
  kind: "builtin",
  directory: "/opt/airlock/tools"
})

const archiveDefinition = (actions?: ReadonlyArray<Record<string, unknown>>) => ({
  schemaVersion: "airlock/tool-definition/v1",
  id: "unix.archive",
  version: "1.0.0",
  executables: [{ realm: "machine", selector: "/usr/bin/tar" }],
  actions: actions ?? [{
    name: "extract",
    inputSchema: {
      type: "object",
      required: ["archive", "destination", "cwd"]
    },
    args: [
      { _tag: "Literal", value: "-xzf" },
      { _tag: "Input", path: ["archive"] },
      { _tag: "Literal", value: "-C" },
      { _tag: "Input", path: ["destination"] }
    ],
    cwd: { _tag: "Input", path: ["cwd"] },
    environment: {
      LANG: { _tag: "Literal", value: "C" },
      AIRLOCK_ATTEMPT: { _tag: "Input", path: ["attempt"] }
    },
    stdin: "discard",
    stdout: "capture",
    stderr: "capture",
    timeoutMs: 180_000,
    outputLimitBytes: 32_768,
    resources: [
      {
        kind: "path",
        realm: "machine",
        selector: { _tag: "Input", path: ["archive"] },
        rights: ["read"]
      },
      {
        kind: "path",
        realm: "machine",
        selector: { _tag: "Input", path: ["destination"] },
        rights: ["write"]
      }
    ],
    lowering: "invoke",
    effectFootprint: ["invoke", "apply"],
    resultDecoder: "exit-status"
  }]
})

const load = (definition: unknown) =>
  decodeToolDefinition(
    new ToolDefinitionDocument({
      location,
      file: "/opt/airlock/tools/archive.airlock-tool.json",
      json: JSON.stringify(definition)
    })
  )

const request = (
  loaded: Effect.Effect.Success<ReturnType<typeof load>>,
  input: Readonly<Record<string, unknown>>,
  overrides: Partial<ToolActionLoweringRequest> = {}
) =>
  new ToolActionLoweringRequest({
    loaded,
    action: "extract",
    input,
    executable: "/usr/bin/tar",
    cellProfile: "native-contained",
    ...overrides
  })

describe("inert tool action lowering", () => {
  it.effect("composes tar generically while keeping hostile input in one argv atom", () =>
    Effect.gen(function* () {
      const loaded = yield* load(archiveDefinition())
      const hostileArchive = "state.tgz; rm -rf / && echo pwned"
      const lowered = yield* lowerToolAction(
        request(loaded, {
          archive: hostileArchive,
          destination: "/sandbox/.hermes",
          cwd: "/sandbox",
          attempt: 2
        })
      )

      expect(lowered.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(lowered.call).toMatchObject({
        action: "process.run",
        executable: "/usr/bin/tar",
        args: ["-xzf", hostileArchive, "-C", "/sandbox/.hermes"],
        cwd: "/sandbox",
        env: { LANG: "C", AIRLOCK_ATTEMPT: "2" },
        stdin: "discard",
        stdout: "capture",
        stderr: "capture",
        timeoutMs: 180_000,
        outputLimitBytes: 32_768,
        cellProfile: "native-contained",
        realm: "machine"
      })
      expect(lowered.call.args[1]).toBe(hostileArchive)
      expect(lowered.lowering.nodes[0]).toMatchObject({
        _tag: "Invoke",
        executable: "/usr/bin/tar",
        args: ["-xzf", hostileArchive, "-C", "/sandbox/.hermes"]
      })
      expect(lowered.lowering.nodes[0]?.requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "executable",
          selector: "/usr/bin/tar",
          rights: ["execute"]
        }),
        expect.objectContaining({
          kind: "path",
          selector: "/sandbox/.hermes",
          rights: ["write"]
        })
      ]))

      const otherInput = yield* lowerToolAction(
        request(loaded, {
          archive: "other.tgz",
          destination: "/tmp/out",
          cwd: "/tmp",
          attempt: false
        })
      )
      expect(otherInput.definitionDigest).toBe(lowered.definitionDigest)
    })
  )

  it.effect("rejects executable identities the definition did not constrain", () =>
    Effect.gen(function* () {
      const loaded = yield* load(archiveDefinition())
      const input = {
        archive: "state.tgz",
        destination: "/sandbox/.hermes",
        cwd: "/sandbox",
        attempt: 1
      }

      const relative = yield* lowerToolAction(
        request(loaded, input, { executable: "tar" })
      ).pipe(Effect.flip)
      expect(relative).toBeInstanceOf(ToolExecutableRejected)
      expect(relative).toMatchObject({ reason: "must-be-absolute" })

      const mismatched = yield* lowerToolAction(
        request(loaded, input, { executable: "/bin/tar" })
      ).pipe(Effect.flip)
      expect(mismatched).toBeInstanceOf(ToolExecutableRejected)
      expect(mismatched).toMatchObject({ reason: "not-declared" })

      const undeclaredHelperAction = {
        ...archiveDefinition().actions[0]!,
        resources: [
          {
            kind: "executable",
            realm: "machine",
            selector: { _tag: "Literal", value: "/usr/bin/python3" },
            rights: ["execute"]
          }
        ]
      }
      const withUndeclaredHelper = yield* load(
        archiveDefinition([undeclaredHelperAction])
      )
      const helper = yield* lowerToolAction(
        request(withUndeclaredHelper, input)
      ).pipe(Effect.flip)
      expect(helper).toBeInstanceOf(ToolExecutableRejected)
      expect(helper).toMatchObject({
        executable: "/usr/bin/python3",
        reason: "not-declared"
      })
    })
  )

  it.effect("rejects unknown and unsupported definition actions", () =>
    Effect.gen(function* () {
      const enqueue = {
        ...archiveDefinition().actions[0]!,
        name: "publish",
        lowering: "enqueue",
        effectFootprint: ["enqueue"]
      }
      const loaded = yield* load(archiveDefinition([
        archiveDefinition().actions[0]!,
        enqueue
      ]))
      const input = {
        archive: "state.tgz",
        destination: "/sandbox/.hermes",
        cwd: "/sandbox",
        attempt: 1
      }

      const unknown = yield* lowerToolAction(
        request(loaded, input, { action: "does-not-exist" })
      ).pipe(Effect.flip)
      expect(unknown).toBeInstanceOf(UnknownToolAction)

      const unsupported = yield* lowerToolAction(
        request(loaded, input, { action: "publish" })
      ).pipe(Effect.flip)
      expect(unsupported).toBeInstanceOf(UnsupportedToolActionLowering)
      expect(unsupported).toMatchObject({ lowering: "enqueue" })
    })
  )

  it.effect("rejects missing, non-scalar, accessor, artifact, and secret templates", () =>
    Effect.gen(function* () {
      const base = archiveDefinition().actions[0]!
      const cases: ReadonlyArray<{
        readonly name: string
        readonly action: Record<string, unknown>
        readonly input: Readonly<Record<string, unknown>>
        readonly reason: string
      }> = [
        {
          name: "missing",
          action: base,
          input: { destination: "/tmp", cwd: "/tmp", attempt: 1 },
          reason: "missing"
        },
        {
          name: "non-scalar",
          action: base,
          input: {
            archive: ["state.tgz"],
            destination: "/tmp",
            cwd: "/tmp",
            attempt: 1
          },
          reason: "non-scalar"
        },
        {
          name: "non-scalar-cwd",
          action: base,
          input: {
            archive: "state.tgz",
            destination: "/tmp",
            cwd: { path: "/tmp" },
            attempt: 1
          },
          reason: "non-scalar"
        },
        {
          name: "non-scalar-env",
          action: base,
          input: {
            archive: "state.tgz",
            destination: "/tmp",
            cwd: "/tmp",
            attempt: ["one"]
          },
          reason: "non-scalar"
        },
        {
          name: "artifact",
          action: {
            ...base,
            args: [{ _tag: "Artifact", path: ["archive"] }]
          },
          input: {
            archive: "artifact/archive",
            destination: "/tmp",
            cwd: "/tmp",
            attempt: 1
          },
          reason: "runtime-binding-required"
        },
        {
          name: "secret",
          action: {
            ...base,
            environment: {
              TOKEN: { _tag: "Secret", path: ["token"] }
            }
          },
          input: {
            archive: "state.tgz",
            destination: "/tmp",
            cwd: "/tmp",
            attempt: 1
          },
          reason: "runtime-binding-required"
        }
      ]

      for (const [index, testCase] of cases.entries()) {
        const actionName = `case_${index}`
        const loaded = yield* load(archiveDefinition([{
          ...testCase.action,
          name: actionName
        }]))
        const error = yield* lowerToolAction(
          request(loaded, testCase.input, { action: actionName })
        ).pipe(Effect.flip)
        expect(error, testCase.name).toBeInstanceOf(ToolTemplateRejected)
        expect(error, testCase.name).toMatchObject({ reason: testCase.reason })
      }

      const loaded = yield* load(archiveDefinition())
      const accessorInput: Record<string, unknown> = {
        destination: "/tmp",
        cwd: "/tmp",
        attempt: 1
      }
      Object.defineProperty(accessorInput, "archive", {
        enumerable: true,
        get: () => {
          throw new Error("must never execute")
        }
      })
      const accessor = yield* lowerToolAction(
        request(loaded, accessorInput)
      ).pipe(Effect.flip)
      expect(accessor).toBeInstanceOf(ToolTemplateRejected)
      expect(accessor).toMatchObject({ reason: "accessor-not-data" })
    })
  )

  it.effect("decodes tool results against the declared output schema", () =>
    Effect.gen(function* () {
      const loaded = yield* load(archiveDefinition())
      const lowered = {
        definitionId: loaded.definition.id,
        actionName: loaded.definition.actions[0]!.name,
        resultDecoder: "json-stdout" as const,
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            count: { type: "integer" }
          },
          required: ["ok", "count"],
          additionalProperties: false
        }
      }

      const value = yield* decodeToolResult(lowered, {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, count: 2 }),
        stderr: ""
      })
      expect(value).toEqual({ ok: true, count: 2 })

      const failure = yield* decodeToolResult(lowered, {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, count: "nope" }),
        stderr: ""
      }).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(ToolResultDecodeFailed)
      expect(failure).toMatchObject({
        reason: expect.stringContaining("$.count: expected integer")
      })
    })
  )
})
