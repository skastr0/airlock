import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import {
  AdmissionPolicy,
  BoxGrant,
  BoxGrantCatalogPin,
  type BoxGrantVerb
} from "../src/admission/index.ts"
import { type NativeActionName } from "../src/actions/index.ts"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  OPERATOR_PUBLIC_KEY_FILE,
  SEAL_CATALOG_DIRECTORY,
  boxGrantSigningPayload,
  catalogFileNameForPin
} from "../src/seal/index.ts"

const repository = resolve(import.meta.dirname, "..")
const root = mkdtempSync(join(tmpdir(), "airlock-sealed-cli-"))
const binary = join(root, "airlock")

beforeAll(() => {
  const built = spawnSync("bun", [
    "build",
    "--compile",
    "--outfile",
    binary,
    "src/cli.ts"
  ], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1" }
  })
  expect(built.status, built.stderr).toBe(0)
}, 60_000)

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const

const defaultAdmission = () => new AdmissionPolicy({
  schemaVersion: "airlock/admission-policy/v1",
  profile: "compatibility",
  principal: "agent:sealed-cli-test",
  realm: "local",
  admittedBy: "operator:sealed-cli-test",
  pathAllowlist: [`${root}/**`],
  executableAllowlist: ["/bin/sh", "/bin/echo"],
  endpointAllowlist: []
})

const makeSeal = (name: string, options: {
  readonly verbs: ReadonlyArray<BoxGrantVerb>
  readonly nativeActions: ReadonlyArray<NativeActionName>
  readonly admission?: AdmissionPolicy
  readonly definitions?: ReadonlyArray<{
    readonly id: string
    readonly bytes: Uint8Array
  }>
}) => {
  const directory = join(root, `seal-${name}`)
  const catalog = join(directory, SEAL_CATALOG_DIRECTORY)
  mkdirSync(catalog, { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const definitions = options.definitions ?? []
  const pins = definitions.map((definition) => new BoxGrantCatalogPin({
    id: definition.id,
    sha256: digest(definition.bytes)
  }))
  const grant = new BoxGrant({
    schemaVersion: "airlock/box-grant/v1",
    admission: options.admission ?? defaultAdmission(),
    verbs: [...options.verbs],
    nativeActions: [...options.nativeActions],
    catalog: pins,
    daemonOps: [],
    binaryDigest: digest(readFileSync(binary))
  })
  writeFileSync(join(directory, BOX_GRANT_FILE), `${JSON.stringify(grant, null, 2)}\n`)
  writeFileSync(
    join(directory, OPERATOR_PUBLIC_KEY_FILE),
    publicKey.export({ format: "pem", type: "spki" })
  )
  writeFileSync(
    join(directory, BOX_GRANT_SIGNATURE_FILE),
    sign(null, boxGrantSigningPayload(grant), privateKey)
  )
  for (const [index, definition] of definitions.entries()) {
    writeFileSync(
      join(catalog, catalogFileNameForPin(pins[index]!)),
      definition.bytes
    )
  }
  return directory
}

type Invocation = SpawnSyncReturns<string>

const invoke = (
  args: ReadonlyArray<string>,
  options: {
    readonly seal?: string
    readonly home?: string
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string | undefined>>
  } = {}
): Invocation => {
  const home = options.home ?? mkdtempSync(join(root, "home-"))
  mkdirSync(home, { recursive: true })
  return spawnSync(binary, [...args], {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      NO_COLOR: "1",
      AIRLOCK_SEAL: options.seal,
      AIRLOCK_HOME: home,
      HOME: home,
      AIRLOCK_AGENT_SURFACE: undefined,
      ...options.env
    }
  })
}

const parseJson = (text: string) => JSON.parse(text) as Record<string, unknown>
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
const normalizeMismatch = (text: string) => stripAnsi(text)
  .replaceAll(basename(binary), "<binary>")
  .replace(/\b(?:commit|exec|undo|nonsense)\b/g, "<command>")
  .trim()

const fullVerbs = [
  "rm", "write", "undo", "held", "reap",
  "send", "pending", "commit", "cancel", "flush",
  "doctor", "capabilities", "actions", "schema", "exec", "run", "eval",
  "ledger", "runs", "run-receipt"
] as const

describe("sealed CLI grant graph", () => {
  it("keeps the unsealed supervisor and reduced agent surfaces unchanged", () => {
    const help = invoke(["--help"])
    expect(help.status, help.stderr).toBe(0)
    for (const verb of fullVerbs) expect(help.stdout).toMatch(new RegExp(`\\b${verb}\\b`))

    const executed = invoke([
      "exec",
      "--executable", "/bin/echo",
      "--arg", "unsealed",
      "--cwd", root
    ])
    expect(executed.status, executed.stderr).toBe(0)
    expect(parseJson(executed.stdout)).toMatchObject({
      profile: "compatibility",
      stdout: "unsealed\n"
    })

    const agentHelp = invoke(["--help"], {
      env: { AIRLOCK_AGENT_SURFACE: "1" }
    })
    expect(agentHelp.status, agentHelp.stderr).toBe(0)
    for (const verb of [
      "doctor", "capabilities", "actions", "schema", "run", "eval",
      "held", "pending", "ledger", "runs", "run-receipt"
    ]) expect(agentHelp.stdout).toMatch(new RegExp(`\\b${verb}\\b`))
    for (const verb of ["exec", "commit", "undo", "reap", "flush"])
      expect(agentHelp.stdout).not.toMatch(new RegExp(`\\b${verb}\\b`))
  })

  it("uses only signed verbs, native actions, profile, and admission for programs", () => {
    const seal = makeSeal("program", {
      verbs: ["eval", "run", "held"],
      nativeActions: ["file.write"]
    })
    const workspace = join(root, "program-workspace")
    const home = join(root, "program-home")
    mkdirSync(workspace)

    const evaluated = invoke([
      "eval",
      "--source", 'return file.write({ path: "evaluated.txt", content: "signed-eval" })',
      "--workspace", workspace
    ], {
      seal,
      home,
      cwd: workspace,
      env: {
        AIRLOCK_AGENT_SURFACE: "1",
        AIRLOCK_AGENT_PROFILE: "not-a-profile",
        AIRLOCK_POLICY_FILE: join(root, "must-not-be-read.json")
      }
    })
    expect(evaluated.status, evaluated.stderr).toBe(0)
    expect(parseJson(evaluated.stdout)).toMatchObject({
      profile: "compatibility",
      result: { state: "succeeded" }
    })
    expect(readFileSync(join(workspace, "evaluated.txt"), "utf8")).toBe("signed-eval")

    const program = join(workspace, "program.air")
    writeFileSync(program, 'return file.write({ path: "run.txt", content: "signed-run" })\n')
    const run = invoke(["run", program, "--workspace", workspace], {
      seal,
      home,
      cwd: workspace,
      env: {
        AIRLOCK_AGENT_PROFILE: "vm-enclosed",
        AIRLOCK_POLICY_FILE: join(root, "also-must-not-be-read.json")
      }
    })
    expect(run.status, run.stderr).toBe(0)
    expect(parseJson(run.stdout)).toMatchObject({ profile: "compatibility" })
    expect(readFileSync(join(workspace, "run.txt"), "utf8")).toBe("signed-run")

    const held = invoke(["held"], { seal, home, cwd: workspace })
    expect(held.status, held.stderr).toBe(0)
    expect(JSON.parse(held.stdout)).toEqual(expect.any(Array))

    const maliciousProfile = invoke([
      "eval", "--source", "return true", "--workspace", workspace,
      "--profile", "native-contained"
    ], { seal, home, cwd: workspace })
    expect(maliciousProfile.status).not.toBe(0)
    expect(stripAnsi(maliciousProfile.stderr)).toMatch(/Unknown option|--profile/i)
    expect(maliciousProfile.stdout).toBe("")
  })

  it("makes denied verbs and native-bypassing aliases ordinary missing subcommands", () => {
    const seal = makeSeal("denied", {
      verbs: ["run", "eval", "held"],
      nativeActions: ["file.write"]
    })
    const nonsense = invoke(["nonsense"], { seal })
    expect(nonsense.status).not.toBe(0)
    expect(stripAnsi(nonsense.stderr)).toContain("CommandMismatch")

    for (const denied of ["commit", "exec", "undo"] as const) {
      const result = invoke([denied], { seal })
      expect(result.status).toBe(nonsense.status)
      expect(normalizeMismatch(result.stderr)).toBe(normalizeMismatch(nonsense.stderr))
      expect(result.stderr).not.toContain("CliInputError")
    }

    const help = invoke(["--help"], { seal })
    expect(help.status, help.stderr).toBe(0)
    for (const visible of ["run", "eval", "held"])
      expect(help.stdout).toMatch(new RegExp(`\\b${visible}\\b`))
    for (const hidden of ["commit", "exec", "undo", "serve"])
      expect(help.stdout).not.toMatch(new RegExp(`\\b${hidden}\\b`))

    // A verb alone cannot reopen a second raw native-action route.
    const aliases = makeSeal("native-aliases-denied", {
      verbs: ["rm", "write", "send", "exec", "held"],
      nativeActions: []
    })
    const aliasNonsense = invoke(["nonsense"], { seal: aliases })
    for (const denied of ["rm", "write", "send", "exec"] as const) {
      const result = invoke([denied], { seal: aliases })
      expect(result.status).toBe(aliasNonsense.status)
      expect(normalizeMismatch(result.stderr)).toBe(
        normalizeMismatch(aliasNonsense.stderr)
      )
      expect(result.stderr).not.toContain("CliInputError")
    }
    const aliasHelp = invoke(["--help"], { seal: aliases })
    for (const hidden of ["rm", "write", "send", "exec"])
      expect(aliasHelp.stdout).not.toMatch(new RegExp(`\\b${hidden}\\b`))

    const empty = makeSeal("empty", { verbs: [], nativeActions: [] })
    const emptyKnown = invoke(["write"], { seal: empty })
    const emptyNonsense = invoke(["nonsense"], { seal: empty })
    expect(emptyKnown.status).toBe(emptyNonsense.status)
    expect(emptyKnown.status).not.toBe(0)
    expect(normalizeMismatch(emptyKnown.stderr)).toBe(
      normalizeMismatch(emptyNonsense.stderr)
    )
    expect(stripAnsi(emptyKnown.stderr)).toContain("CommandMismatch")
    expect(stripAnsi(emptyKnown.stderr)).not.toContain("TypeError")
    const emptyHelp = invoke(["--help"], { seal: empty })
    expect(emptyHelp.status, emptyHelp.stderr).toBe(0)
    for (const verb of fullVerbs)
      expect(emptyHelp.stdout).not.toMatch(new RegExp(`\\b${verb}\\b`))
  })

  it("requires process.run in addition to exec before a shell alias can run", () => {
    const seal = makeSeal("exec-without-process", {
      verbs: ["exec", "held"],
      nativeActions: ["file.write"]
    })
    const workspace = join(root, "exec-workspace")
    const home = join(root, "exec-home")
    const marker = join(workspace, "shell-marker")
    mkdirSync(workspace)

    const refused = invoke([
      "exec",
      "--executable", "/bin/sh",
      "--arg=-c",
      `--arg=printf marker > ${marker}`,
      "--cwd", workspace
    ], { seal, home, cwd: workspace })
    expect(refused.status).not.toBe(0)
    expect(stripAnsi(refused.stderr)).toContain("CommandMismatch")
    expect(existsSync(marker)).toBe(false)
    const runDirectory = join(home, "runs")
    expect(existsSync(runDirectory) ? readdirSync(runDirectory) : []).toEqual([])

    const scoped = makeSeal("exec-scoped-cwd", {
      verbs: ["exec"],
      nativeActions: ["process.run"],
      admission: new AdmissionPolicy({
        schemaVersion: "airlock/admission-policy/v1",
        profile: "native-contained",
        principal: "agent:exec-scope-test",
        realm: "local",
        admittedBy: "operator:exec-scope-test",
        pathAllowlist: [`${workspace}/**`],
        executableAllowlist: ["/bin/sh"],
        endpointAllowlist: []
      })
    })
    const outside = join(root, "outside-exec-workspace")
    mkdirSync(outside)
    const outOfScope = invoke([
      "exec", "--executable", "/bin/sh", "--arg", "-c", "--arg", "true",
      "--cwd", outside, "--private-workspace", join(root, "private-exec")
    ], { seal: scoped, home, cwd: workspace })
    expect(outOfScope.status).toBe(1)
    expect(parseJson(outOfScope.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "admission"
    })
  })

  it.skipIf(process.platform !== "darwin")(
    "binds a sealed raw exec /tmp cwd to its admitted physical spelling",
    () => {
      const temporary = mkdtempSync("/tmp/airlock-sealed-exec-")
      const workspace = join(temporary, "workspace")
      const privateWorkspace = join(temporary, "private")
      mkdirSync(workspace)
      const policy = new AdmissionPolicy({
        schemaVersion: "airlock/admission-policy/v1",
        profile: "native-contained",
        principal: "agent:raw-exec-path-test",
        realm: "local",
        admittedBy: "operator:raw-exec-path-test",
        pathAllowlist: [`${workspace}/**`],
        executableAllowlist: ["/usr/bin/true"],
        endpointAllowlist: []
      })
      const seal = makeSeal("raw-exec-path", {
        verbs: ["exec"],
        nativeActions: ["process.run"],
        admission: policy
      })
      const result = invoke([
        "exec",
        "--executable", "/usr/bin/true",
        "--cwd", workspace,
        "--private-workspace", privateWorkspace
      ], { seal, cwd: workspace })
      expect(result.status, result.stderr).toBe(0)
      expect(parseJson(result.stdout)).toMatchObject({
        profile: "native-contained",
        sourceWorkspace: realpathSync(workspace)
      })
    }
  )

  it("admits sealed raw mutation and staging aliases against the signed policy", () => {
    const workspace = join(root, "raw-admission-workspace")
    const allowed = join(workspace, "allowed")
    const denied = join(workspace, "denied")
    mkdirSync(allowed, { recursive: true })
    mkdirSync(denied, { recursive: true })
    const policy = new AdmissionPolicy({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:raw-admission-test",
      realm: "local",
      admittedBy: "operator:raw-admission-test",
      pathAllowlist: [`${allowed}/**`],
      executableAllowlist: [],
      endpointAllowlist: ["https://allowed.invalid/*"]
    })
    const seal = makeSeal("raw-admission", {
      verbs: ["write", "rm", "send", "pending", "held"],
      nativeActions: ["file.write", "file.remove", "http.stage"],
      admission: policy
    })
    const home = join(root, "raw-admission-home")

    const allowedWrite = invoke([
      "write", join(allowed, "ok.txt"), "allowed"
    ], { seal, home, cwd: workspace })
    expect(allowedWrite.status, allowedWrite.stderr).toBe(0)
    expect(readFileSync(join(allowed, "ok.txt"), "utf8")).toBe("allowed")

    const relativeWrite = invoke([
      "write", "allowed/relative.txt", "relative"
    ], { seal, home, cwd: workspace })
    expect(relativeWrite.status, relativeWrite.stderr).toBe(0)
    expect(readFileSync(join(allowed, "relative.txt"), "utf8")).toBe("relative")
    const relativeRemove = invoke(["rm", "allowed/relative.txt"], {
      seal,
      home,
      cwd: workspace
    })
    expect(relativeRemove.status, relativeRemove.stderr).toBe(0)
    expect(existsSync(join(allowed, "relative.txt"))).toBe(false)

    const symlinkTarget = join(allowed, "symlink-target.txt")
    const symlinkPath = join(allowed, "symlink.txt")
    writeFileSync(symlinkTarget, "must remain")
    symlinkSync("symlink-target.txt", symlinkPath)
    const refusedSymlink = invoke(["rm", symlinkPath], {
      seal,
      home,
      cwd: workspace
    })
    expect(refusedSymlink.status).toBe(1)
    expect(readFileSync(symlinkTarget, "utf8")).toBe("must remain")
    expect(existsSync(symlinkPath)).toBe(true)

    const deniedWritePath = join(denied, "blocked.txt")
    const deniedWrite = invoke([
      "write", deniedWritePath, "blocked"
    ], { seal, home, cwd: workspace })
    expect(deniedWrite.status).toBe(1)
    expect(parseJson(deniedWrite.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "admission"
    })
    expect(existsSync(deniedWritePath)).toBe(false)

    const deniedRemovePath = join(denied, "keep.txt")
    writeFileSync(deniedRemovePath, "keep")
    const deniedRemove = invoke(["rm", deniedRemovePath], {
      seal,
      home,
      cwd: workspace
    })
    expect(deniedRemove.status).toBe(1)
    expect(readFileSync(deniedRemovePath, "utf8")).toBe("keep")

    const deniedStage = invoke([
      "send", "https://denied.invalid/stage"
    ], { seal, home, cwd: workspace })
    expect(deniedStage.status).toBe(1)
    const pending = invoke(["pending"], { seal, home, cwd: workspace })
    expect(pending.status, pending.stderr).toBe(0)
    expect(JSON.parse(pending.stdout)).toEqual([])
  })

  it("loads only pinned definitions and filters discovery by the signed native surface", () => {
    const workspace = join(root, "discovery-workspace")
    mkdirSync(workspace, { recursive: true })
    const invokeBytes = new TextEncoder().encode(JSON.stringify({
      schemaVersion: "airlock/tool-definition/v1",
      id: "invoke_tool",
      version: "1.0.0",
      executables: [{ realm: "local", selector: "/bin/echo" }],
      actions: [{
        name: "call",
        inputSchema: {
          type: "object",
          properties: { cwd: { type: "string" } },
          required: ["cwd"],
          additionalProperties: false
        },
        args: [],
        cwd: { _tag: "Input", path: ["cwd"] },
        lowering: "invoke",
        effectFootprint: ["invoke"],
        resultDecoder: "exit-status"
      }]
    }))
    const enqueueBytes = new TextEncoder().encode(JSON.stringify({
      schemaVersion: "airlock/tool-definition/v2",
      id: "enqueue_tool",
      version: "1.0.0",
      executables: [],
      actions: [{
        name: "stage",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        },
        lowering: "enqueue",
        emissionEffect: "mutate",
        request: {
          method: "POST",
          endpoint: { _tag: "Literal", value: "https://example.invalid/stage" }
        },
        effectFootprint: ["enqueue"],
        resultDecoder: "none"
      }]
    }))
    const definitions = [
      { id: "invoke_tool", bytes: invokeBytes },
      { id: "enqueue_tool", bytes: enqueueBytes }
    ]

    const fileOnlySeal = makeSeal("discovery-file", {
      verbs: ["actions", "schema"],
      nativeActions: ["file.write"],
      definitions
    })
    const fileOnly = invoke(["actions", "--workspace", workspace], {
      seal: fileOnlySeal,
      cwd: workspace
    })
    expect(fileOnly.status, fileOnly.stderr).toBe(0)
    expect(parseJson(fileOnly.stdout)).toMatchObject({
      actions: [{ name: "file.write" }],
      definitions: []
    })

    for (const subject of ["actions", "all"]) {
      const visibleSchema = invoke(["schema", subject], {
        seal: fileOnlySeal,
        cwd: workspace
      })
      expect(visibleSchema.status, visibleSchema.stderr).toBe(0)
      const visibleActions = (parseJson(visibleSchema.stdout) as {
        readonly actions: ReadonlyArray<{
          readonly name: string
          readonly resultSchema?: unknown
        }>
      }).actions
      expect(visibleActions.map(({ name }) => name)).toEqual(["file.write"])
      expect(visibleActions[0]?.resultSchema).toBeDefined()
      expect(visibleSchema.stdout).not.toContain("file.read")
    }

    const disabledSchema = invoke(["schema", "file.read"], {
      seal: fileOnlySeal,
      cwd: workspace
    })
    expect(disabledSchema.status).toBe(1)
    expect(parseJson(disabledSchema.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "subject"
    })
    expect(disabledSchema.stderr).not.toContain("file.read")

    const enqueueSeal = makeSeal("discovery-enqueue", {
      verbs: ["actions", "schema"],
      nativeActions: ["http.stage"],
      definitions
    })
    const enqueueOnly = invoke(["actions", "--workspace", workspace], {
      seal: enqueueSeal,
      cwd: workspace
    })
    expect(enqueueOnly.status, enqueueOnly.stderr).toBe(0)
    const enqueuePayload = parseJson(enqueueOnly.stdout) as {
      readonly actions: ReadonlyArray<{ readonly name: string }>
      readonly definitions: ReadonlyArray<{ readonly name: string }>
    }
    expect(enqueuePayload.actions.map(({ name }) => name)).toEqual(["http.stage"])
    expect(enqueuePayload.definitions.map(({ name }) => name)).toContain("enqueue_tool.stage")
    expect(enqueuePayload.definitions.map(({ name }) => name)).not.toContain("invoke_tool.call")

    const invokeSeal = makeSeal("discovery-invoke", {
      verbs: ["actions"],
      nativeActions: ["process.run"],
      definitions
    })
    const invokeOnly = invoke(["actions", "--workspace", workspace], {
      seal: invokeSeal,
      cwd: workspace
    })
    expect(invokeOnly.status, invokeOnly.stderr).toBe(0)
    const invokePayload = parseJson(invokeOnly.stdout) as {
      readonly definitions: ReadonlyArray<{ readonly name: string }>
    }
    expect(invokePayload.definitions.map(({ name }) => name)).toContain("invoke_tool.call")
    expect(invokePayload.definitions.map(({ name }) => name)).not.toContain("enqueue_tool.stage")

    const ambient = join(workspace, ".airlock", "tools")
    mkdirSync(ambient, { recursive: true })
    writeFileSync(join(ambient, "extra.airlock-tool.json"), invokeBytes)
    const refused = invoke(["actions", "--workspace", workspace], {
      seal: enqueueSeal,
      cwd: workspace
    })
    expect(refused.status).toBe(1)
    expect(parseJson(refused.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "tool-definitions"
    })
  })

  it("constructs all current commands from one guarded descriptor table", () => {
    const source = readFileSync(join(repository, "src", "cli.ts"), "utf8")
    const table = source.slice(
      source.indexOf("const commandDescriptors"),
      source.indexOf("const unsealedAgentVerbOrder")
    )
    const mapped = [...table.matchAll(/\{ verb: "([^"]+)", supervisor:/g)]
      .map((match) => match[1])
    expect(mapped).toEqual([...fullVerbs, "serve"])
    expect(new Set(mapped)).toHaveLength(21)
    expect(table).toContain('{ verb: "serve", supervisor: makeServe, sealedOnly: true }')
    expect(source.match(/const requireVerb =/g)).toHaveLength(1)
    expect(source.match(/const requireNativeAction =/g)).toHaveLength(1)
    for (const [verb, action] of [
      ["rm", "file.remove"],
      ["write", "file.write"],
      ["send", "http.stage"],
      ["exec", "process.run"]
    ] as const) {
      expect(table).toContain(`verb: "${verb}"`)
      expect(table).toContain(`nativeAction: "${action}"`)
      expect(source).toContain(`requireNativeAction(seal, "${action}")`)
    }

    for (const verb of fullVerbs) {
      const guarded = source.match(new RegExp(
        `requireVerb\\(seal, "${verb.replace("-", "\\-")}"\\)`,
        "g"
      )) ?? []
      expect(guarded.length, `${verb} must guard every handler variant`).toBeGreaterThanOrEqual(
        verb === "run" || verb === "eval" ? 3 : 1
      )
    }
  })
})
