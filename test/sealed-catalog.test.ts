import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  type BoxGrantSha256,
  decodeBoxGrant,
  hashBoxGrant
} from "../src/admission/BoxGrant.ts"
import {
  LegacyToolDefinitionPathRejected,
  LegacyToolDefinitionTamper,
  SealedCatalogDecodeFailed,
  SealedCatalogExportFailed,
  assertNoLegacyToolDefinitions,
  legacyDefinitionDirectories,
  loadVerifiedCatalog,
  sealedTools
} from "../src/seal/Catalog.ts"
import {
  VerifiedCatalogDocument,
  VerifiedSeal
} from "../src/seal/Seal.ts"
import {
  ToolActionLoweringRequest,
  ToolDefinitionDirectories,
  ToolDefinitionDocument,
  ToolDefinitionLocation,
  decodeToolDefinition,
  lowerToolAction
} from "../src/tools/index.ts"

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))

const digest = (value: Uint8Array): BoxGrantSha256 =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as BoxGrantSha256

const definition = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "airlock/tool-definition/v1",
  id: "vendor.echo",
  version: "1.0.0",
  executables: [{ realm: "machine", selector: "/usr/bin/true" }],
  actions: [{
    name: "check",
    inputSchema: {
      type: "object",
      additionalProperties: false
    },
    args: [{ _tag: "Literal", value: "hello" }],
    cwd: { _tag: "Literal", value: "/tmp" },
    lowering: "invoke",
    effectFootprint: ["invoke"],
    resultDecoder: "exit-status"
  }],
  ...overrides
})

const snapshotAt = async (
  file: string,
  rawBytes: Uint8Array = bytes(definition())
): Promise<VerifiedCatalogDocument> => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, rawBytes)
  const captured = new Uint8Array(await readFile(file))
  const location = new ToolDefinitionLocation({
    kind: "installed",
    directory: dirname(file)
  })
  const loaded = await Effect.runPromise(decodeToolDefinition(
    new ToolDefinitionDocument({
      location,
      file,
      json: new TextDecoder("utf-8", { fatal: true }).decode(captured)
    })
  ))
  return new VerifiedCatalogDocument({
    id: loaded.definition.id,
    path: file,
    digest: digest(captured),
    rawBytes: captured,
    definition: loaded.definition
  })
}

const sealWith = async (
  sealPath: string,
  catalog: ReadonlyArray<VerifiedCatalogDocument>
): Promise<VerifiedSeal> => {
  const binaryBytes = new TextEncoder().encode("sealed airlock test binary\n")
  const grant = await Effect.runPromise(decodeBoxGrant({
    schemaVersion: "airlock/box-grant/v1",
    admission: {
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent/catalog-test",
      realm: "local",
      admittedBy: "operator/catalog-test",
      pathAllowlist: ["/workspace/**"],
      executableAllowlist: ["/usr/bin/true"],
      endpointAllowlist: []
    },
    verbs: ["run", "actions"],
    nativeActions: ["file.read", "process.run"],
    catalog: catalog.map((document) => ({
      id: document.id,
      sha256: document.digest
    })),
    daemonOps: [],
    binaryDigest: digest(binaryBytes)
  }))
  return new VerifiedSeal({
    sealPath,
    grant,
    grantDigest: hashBoxGrant(grant),
    binaryPath: "/fixture/airlock",
    binaryDigest: grant.binaryDigest,
    catalog: [...catalog]
  })
}

const makeSeal = async () => {
  const root = await mkdtemp(join(tmpdir(), "airlock-sealed-catalog-"))
  const source = join(root, "seal", "catalog", "pinned.airlock-tool.json")
  const snapshot = await snapshotAt(source)
  const seal = await sealWith(join(root, "seal"), [snapshot])
  return { root, source, snapshot, seal }
}

const exactDirectories = async (root: string) => {
  const directories = new ToolDefinitionDirectories({
    builtin: join(root, "builtin"),
    installed: join(root, "installed"),
    user: join(root, "user"),
    project: join(root, "project")
  })
  await Promise.all([
    mkdir(directories.builtin, { recursive: true }),
    mkdir(directories.installed, { recursive: true }),
    mkdir(directories.user, { recursive: true }),
    mkdir(directories.project, { recursive: true })
  ])
  return directories
}

const failed = async <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.flip))

describe("sealed catalog mapping", () => {
  it("exports only the pinned snapshot and leaves it callable by generic lowering", async () => {
    const { seal } = await makeSeal()
    const tools = await Effect.runPromise(loadVerifiedCatalog(
      seal,
      new Set(["file.read", "process.run"])
    ))

    expect(tools.map((tool) => tool.name)).toEqual(["vendor.echo.check"])
    expect(tools[0]!.loaded.definition.id).toBe("vendor.echo")

    const lowered = await Effect.runPromise(lowerToolAction(
      new ToolActionLoweringRequest({
        loaded: tools[0]!.loaded,
        action: "check",
        input: {},
        executable: "/usr/bin/true",
        cellProfile: "compatibility"
      })
    ))
    expect(lowered.call).toMatchObject({
      action: "process.run",
      executable: "/usr/bin/true",
      args: ["hello"]
    })
  })

  it("maps an empty verified catalog to no extension actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "airlock-sealed-empty-"))
    const seal = await sealWith(join(root, "seal"), [])
    const tools = await Effect.runPromise(loadVerifiedCatalog(seal, new Set()))
    expect(tools).toEqual([])
  })

  it("never reopens a catalog path after its bytes were captured", async () => {
    const { root, source, seal } = await makeSeal()

    // Replace the source bytes, then remove the verified live binding by
    // rename. Mapping must still use the retained VerifiedCatalogDocument.
    await writeFile(source, bytes(definition({ id: "attacker.changed" })))
    await rename(source, join(root, "catalog-source-moved-away"))
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" })

    const tools = await Effect.runPromise(loadVerifiedCatalog(seal, new Set()))
    expect(tools.map((tool) => tool.name)).toEqual(["vendor.echo.check"])
  })

  it("refuses native shadowing through a sealed export error", async () => {
    const { seal } = await makeSeal()
    const error = await failed(loadVerifiedCatalog(
      seal,
      new Set(["vendor.echo.check"])
    ))
    expect(error).toBeInstanceOf(SealedCatalogExportFailed)
    expect(error).toMatchObject({
      name: "vendor.echo.check",
      reason: "native-shadow"
    })
  })

  it("re-runs the generic decoder so definitions cannot mint class or commit", async () => {
    for (const forbidden of ["class", "commit"] as const) {
      const { root, snapshot } = await makeSeal()
      const rawBytes = bytes(definition({ [forbidden]: "auto" }))
      const hostile = new VerifiedCatalogDocument({
        id: snapshot.id,
        path: snapshot.path,
        digest: digest(rawBytes),
        rawBytes,
        // Models corrupted in-memory bytes next to the originally decoded
        // value. A legitimate verifier never creates this mismatch.
        definition: snapshot.definition
      })
      const seal = await sealWith(join(root, "seal"), [hostile])
      const error = await failed(loadVerifiedCatalog(seal, new Set()))
      expect(error).toBeInstanceOf(SealedCatalogDecodeFailed)
      expect(error).toMatchObject({ cause: "ToolGrantAssertionRejected" })
    }
  })
})

describe("sealed legacy-definition refusal", () => {
  it("refuses an immediate suffix in every fixed legacy root before catalog export", async () => {
    const locations = ["builtin", "installed", "user", "project"] as const
    for (const kind of locations) {
      const { root, seal } = await makeSeal()
      const directories = await exactDirectories(join(root, `legacy-${kind}`))
      await writeFile(
        join(directories[kind], `${kind}.airlock-tool.json`),
        "bytes are never loaded"
      )

      // This native-name set would make catalog export fail if it ran first.
      const error = await failed(sealedTools(seal, root, {
        directories,
        nativeActionNames: new Set(["vendor.echo.check"])
      }))
      expect(error).toBeInstanceOf(LegacyToolDefinitionTamper)
      expect(error).toMatchObject({
        location: { kind },
        reason: "legacy-definition-present"
      })
    }
  })

  it("refuses suffix-bearing symlinks and directories without following them", async () => {
    for (const kind of ["symlink", "directory"] as const) {
      const root = await mkdtemp(join(tmpdir(), `airlock-legacy-${kind}-`))
      const directories = await exactDirectories(join(root, "legacy"))
      const candidate = join(
        directories.project,
        `${kind}.airlock-tool.json`
      )
      if (kind === "symlink") {
        const target = join(root, "outside.txt")
        await writeFile(target, "not read")
        await symlink(target, candidate)
      } else {
        await mkdir(candidate)
      }

      const error = await failed(assertNoLegacyToolDefinitions(root, {
        directories
      }))
      expect(error).toBeInstanceOf(LegacyToolDefinitionTamper)
      expect(error).toMatchObject({ path: candidate })
    }
  })

  it("ignores unrelated immediate names and never recurses", async () => {
    const { root, seal } = await makeSeal()
    const directories = await exactDirectories(join(root, "legacy"))
    await writeFile(join(directories.builtin, "README.txt"), "ignored")
    await writeFile(
      join(directories.installed, "almost.airlock-tool.JSON"),
      "ignored"
    )
    const nested = join(directories.user, "nested")
    await mkdir(nested)
    await writeFile(
      join(nested, "nested.airlock-tool.json"),
      "outside the exact immediate scope"
    )

    const tools = await Effect.runPromise(sealedTools(seal, root, {
      directories
    }))
    expect(tools.map((tool) => tool.name)).toEqual(["vendor.echo.check"])
  })

  it("derives the project root from each selected workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "airlock-legacy-workspace-"))
    const workspaceA = join(root, "workspace-a")
    const workspaceB = join(root, "workspace-b")
    const overrides = {
      builtin: join(root, "distribution", "tool-definitions"),
      airlockHome: join(root, "airlock-home"),
      homeDirectory: join(root, "home"),
      env: {}
    }
    const directoriesA = legacyDefinitionDirectories(workspaceA, overrides)
    const directoriesB = legacyDefinitionDirectories(workspaceB, overrides)
    await Promise.all([
      ...Object.values(directoriesA).map((path) => mkdir(path, { recursive: true })),
      mkdir(directoriesB.project, { recursive: true })
    ])
    const candidate = join(
      directoriesB.project,
      "alternate.airlock-tool.json"
    )
    await writeFile(candidate, "never loaded")

    await Effect.runPromise(assertNoLegacyToolDefinitions(workspaceA, overrides))
    const error = await failed(assertNoLegacyToolDefinitions(
      workspaceB,
      overrides
    ))
    expect(error).toBeInstanceOf(LegacyToolDefinitionTamper)
    expect(error).toMatchObject({ path: candidate })
  })

  it("refuses symlink and non-directory legacy roots as ambiguous paths", async () => {
    for (const kind of ["symlink", "file"] as const) {
      const root = await mkdtemp(join(tmpdir(), `airlock-legacy-root-${kind}-`))
      const directories = new ToolDefinitionDirectories({
        builtin: join(root, "missing-builtin"),
        installed: join(root, "missing-installed"),
        user: join(root, `user-${kind}`),
        project: join(root, "missing-project")
      })
      if (kind === "symlink") {
        const target = join(root, "real-user")
        await mkdir(target)
        await symlink(target, directories.user)
      } else {
        await writeFile(directories.user, "not a directory")
      }

      const error = await failed(assertNoLegacyToolDefinitions(root, {
        directories
      }))
      expect(error).toBeInstanceOf(LegacyToolDefinitionPathRejected)
      expect(error).toMatchObject({
        location: { kind: "user" },
        reason: kind === "symlink" ? "symlink" : "not-directory"
      })
    }
  })
})
