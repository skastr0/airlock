import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  ToolDefinitionLocation,
  ToolDefinitionReadFailed,
  decodeToolDefinition
} from "../src/tools/Definitions.ts"
import {
  makeFileToolDefinitionReader,
  TOOL_DEFINITION_FILE_SUFFIX
} from "../src/tools/FileReader.ts"

const location = (directory: string) => new ToolDefinitionLocation({ kind: "project", directory })

const definition = (id: string) => JSON.stringify({
  schemaVersion: "airlock/tool-definition/v1",
  id,
  version: "1.0.0",
  executables: [{ realm: "machine", selector: "/usr/bin/true" }],
  actions: [{
    name: "check",
    inputSchema: { type: "object" },
    args: [],
    cwd: { _tag: "Literal", value: "/tmp" },
    lowering: "invoke",
    effectFootprint: ["invoke"],
    resultDecoder: "exit-status"
  }]
})

describe("file tool-definition reader", () => {
  it.effect("reads only direct regular definition files in stable filename order", () =>
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "airlock-tool-reader-"))
      await writeFile(join(directory, `zeta${TOOL_DEFINITION_FILE_SUFFIX}`), definition("zeta"))
      await writeFile(join(directory, `alpha${TOOL_DEFINITION_FILE_SUFFIX}`), definition("alpha"))
      await writeFile(join(directory, "ignored.json"), definition("ignored"))
      await mkdir(join(directory, `nested${TOOL_DEFINITION_FILE_SUFFIX}`))

      const documents = await Effect.runPromise(makeFileToolDefinitionReader().read(location(directory)))
      expect(documents.map((document) => document.file)).toEqual([
        join(directory, `alpha${TOOL_DEFINITION_FILE_SUFFIX}`),
        join(directory, `zeta${TOOL_DEFINITION_FILE_SUFFIX}`)
      ])
      expect(documents.map((document) => document.json)).toEqual([definition("alpha"), definition("zeta")])
    })
  )

  it.effect("returns malformed JSON as inert text for the schema decoder to reject", () =>
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "airlock-tool-reader-"))
      await writeFile(join(directory, `malformed${TOOL_DEFINITION_FILE_SUFFIX}`), "{not json")

      const [document] = await Effect.runPromise(makeFileToolDefinitionReader().read(location(directory)))
      expect(document?.json).toBe("{not json")
      const error = await Effect.runPromise(decodeToolDefinition(document!).pipe(Effect.flip))
      expect(error._tag).toBe("ToolDefinitionDecodeFailed")
    })
  )

  it.effect("does not follow definition or location symlinks", () =>
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "airlock-tool-reader-"))
      const outside = await mkdtemp(join(tmpdir(), "airlock-tool-reader-outside-"))
      const outsideFile = join(outside, `outside${TOOL_DEFINITION_FILE_SUFFIX}`)
      await writeFile(outsideFile, definition("outside"))
      await symlink(outsideFile, join(directory, `linked${TOOL_DEFINITION_FILE_SUFFIX}`))

      const documents = await Effect.runPromise(makeFileToolDefinitionReader().read(location(directory)))
      expect(documents).toEqual([])

      const locationLink = join(tmpdir(), `airlock-tool-reader-link-${Date.now()}-${Math.random()}`)
      await symlink(directory, locationLink)
      const error = await Effect.runPromise(makeFileToolDefinitionReader().read(location(locationLink)).pipe(Effect.flip))
      expect(error).toBeInstanceOf(ToolDefinitionReadFailed)
      expect(error).toMatchObject({ reason: "exact definition location is not a regular directory" })
    })
  )

  it.effect("fails closed with a redacted size-limit reason", () =>
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "airlock-tool-reader-"))
      await writeFile(join(directory, `large${TOOL_DEFINITION_FILE_SUFFIX}`), "x".repeat(17))

      const error = await Effect.runPromise(
        makeFileToolDefinitionReader({ maxBytes: 16 }).read(location(directory)).pipe(Effect.flip)
      )
      expect(error).toBeInstanceOf(ToolDefinitionReadFailed)
      expect(error).toMatchObject({ reason: "definition exceeds 16 byte limit" })
      expect(error.reason).not.toContain(directory)
    })
  )
})
