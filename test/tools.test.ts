import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  DuplicateToolDefinition,
  InvalidToolDefinition,
  ToolActionNameCollision,
  ToolDefinitionDecodeFailed,
  ToolDefinitionDirectories,
  ToolDefinitionDocument,
  ToolDefinitionRegistry,
  ToolDefinitionLocation,
  ToolInputRejected,
  type ToolDefinitionReader,
  exportToolActions,
  decodeToolDefinition,
  knownToolDefinitionLocations,
  loadKnownToolDefinitions,
  validateToolValue
} from "../src/tools/index.ts"

const directories = new ToolDefinitionDirectories({
  builtin: "/runtime/tools",
  installed: "/opt/airlock/tools",
  user: "/home/agent/.config/airlock/tools",
  project: "/srv/app/.airlock/tools"
})

const location = (kind: "builtin" | "installed" | "user" | "project") =>
  knownToolDefinitionLocations(directories).find((candidate) => candidate.kind === kind) as ToolDefinitionLocation

const definition = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "airlock/tool-definition/v1",
  id: "archive",
  version: "1.0.0",
  executables: [{ realm: "machine", selector: "/usr/bin/tar" }],
  actions: [{
    name: "extract",
    inputSchema: { type: "object", required: ["archive"] },
    args: [
      { _tag: "Literal", value: "-xf" },
      { _tag: "Input", path: ["archive"] }
    ],
    cwd: { _tag: "Literal", value: "/srv/app" },
    environment: { LANG: { _tag: "Literal", value: "C" } },
    stdin: "discard",
    stdout: "capture",
    stderr: "capture",
    timeoutMs: 30_000,
    outputLimitBytes: 16_384,
    resources: [{
      kind: "path", realm: "machine", selector: { _tag: "Input", path: ["destination"] }, rights: ["write"]
    }],
    lowering: "invoke",
    effectFootprint: ["capture", "invoke", "apply"],
    resultDecoder: "exit-status"
  }],
  ...overrides
})

const document = (json: unknown, kind: "builtin" | "installed" | "user" | "project" = "builtin") =>
  new ToolDefinitionDocument({
    location: location(kind),
    file: `${location(kind).directory}/archive.json`,
    json: JSON.stringify(json)
  })

describe("inert tool definitions", () => {
  it.effect("decodes a template-only invoke definition with executable kept separate", () =>
    Effect.gen(function* () {
      const loaded = yield* decodeToolDefinition(document(definition()))
      const action = loaded.definition.actions[0]!
      expect(loaded.definition.executables).toEqual([{ realm: "machine", selector: "/usr/bin/tar" }])
      expect(action).toMatchObject({
        name: "extract",
        args: [{ _tag: "Literal", value: "-xf" }, { _tag: "Input", path: ["archive"] }],
        cwd: { _tag: "Literal", value: "/srv/app" },
        stdin: "discard",
        stdout: "capture",
        stderr: "capture",
        timeoutMs: 30_000,
        outputLimitBytes: 16_384,
        lowering: "invoke"
      })
      expect("argv" in action).toBe(false)
    })
  )

  it.effect("rejects legacy argv and definitions that claim a lowering without its effect", () =>
    Effect.gen(function* () {
      const legacy = definition()
      const legacyAction = (legacy.actions as Array<Record<string, unknown>>)[0]!
      legacyAction.argv = legacyAction.args
      delete legacyAction.args
      const decodeError = yield* decodeToolDefinition(document(legacy)).pipe(Effect.flip)
      expect(decodeError).toBeInstanceOf(ToolDefinitionDecodeFailed)

      const missingEffect = definition({
        actions: [{
          ...definition().actions[0] as Record<string, unknown>,
          effectFootprint: ["capture"]
        }]
      })
      const validationError = yield* decodeToolDefinition(document(missingEffect)).pipe(Effect.flip)
      expect(validationError).toBeInstanceOf(InvalidToolDefinition)
      expect(validationError).toMatchObject({ field: "actions.extract.effectFootprint" })
    })
  )

  it.effect("requires one absolute executable and callable dotted namespace segments", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
        ["multiple", { executables: [{ realm: "machine", selector: "/usr/bin/tar" }, { realm: "machine", selector: "/usr/bin/bsdtar" }] }, "executables"],
        ["relative", { executables: [{ realm: "machine", selector: "tar" }] }, "executables[].selector"],
        ["bad-id", { id: "unix-archive" }, "id"],
        ["bad-action", { actions: [{ ...definition().actions[0] as Record<string, unknown>, name: "extract-file" }] }, "actions.extract-file.name"]
      ]
      for (const [, candidate, field] of cases) {
        const error = yield* decodeToolDefinition(document(definition(candidate))).pipe(Effect.flip)
        expect(error).toBeInstanceOf(InvalidToolDefinition)
        expect(error).toMatchObject({ field })
      }

      const dotted = yield* decodeToolDefinition(document(definition({ id: "unix.archive" })))
      expect(dotted.definition.id).toBe("unix.archive")
    })
  )

  it.effect("loads only from explicit locations in precedence order and fails closed on identity collisions", () =>
    Effect.gen(function* () {
      const visited: string[] = []
      const reader: ToolDefinitionReader = {
        read: (candidate) => {
          visited.push(candidate.kind)
          return Effect.succeed(candidate.kind === "builtin" ? [document(definition(), "builtin")] : [])
        }
      }
      const registry = yield* loadKnownToolDefinitions(reader, directories)
      expect(visited).toEqual(["builtin", "installed", "user", "project"])
      expect(registry.definitions).toHaveLength(1)

      const duplicateReader: ToolDefinitionReader = {
        read: (candidate) => Effect.succeed(
          candidate.kind === "builtin" || candidate.kind === "project"
            ? [document(definition(), candidate.kind)]
            : []
        )
      }
      const duplicate = yield* loadKnownToolDefinitions(duplicateReader, directories).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(DuplicateToolDefinition)
      expect(duplicate).toMatchObject({ id: "archive", version: "1.0.0" })
    })
  )

  it.effect("validates every declared schema field and refuses native shadowing", () =>
    Effect.gen(function* () {
      const loaded = yield* decodeToolDefinition(document(definition()))
      const action = loaded.definition.actions[0]!
      const schema = {
        type: "object",
        properties: {
          first: { type: "string" },
          second: { type: "integer" }
        },
        required: ["first", "second"],
        additionalProperties: false
      }

      const validationError = yield* validateToolValue(
        loaded.definition,
        action,
        schema,
        { first: "ok", second: "not-an-integer" }
      ).pipe(Effect.flip)
      expect(validationError).toBeInstanceOf(ToolInputRejected)
      expect(validationError).toMatchObject({
        path: "$.second",
        reason: "expected integer"
      })

      const registry = new ToolDefinitionRegistry({ definitions: [loaded] })
      const collision = yield* exportToolActions(
        registry,
        new Set(["archive.extract"])
      ).pipe(Effect.flip)
      expect(collision).toBeInstanceOf(ToolActionNameCollision)
      expect(collision).toMatchObject({
        name: "archive.extract",
        reason: "native-shadow"
      })
    })
  )
})
