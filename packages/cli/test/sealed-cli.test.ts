import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { Schema } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { BoxGrant, BoxGrantVerb } from "@skastr0/airlock"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  OPERATOR_PUBLIC_KEY_FILE,
  boxGrantSigningPayload
} from "../src/seal/index.ts"
import { Sha256Digest } from "@skastr0/airlock"

const repository = resolve(import.meta.dirname, "..")
const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-sealed-cli-")))
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
  Sha256Digest.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)

type Grant = Readonly<{ id: string; tool: string; when: "now" | "approved" }>

const policyOf = (toolGrants: ReadonlyArray<Grant>, path: ReadonlyArray<string> = [root]) => ({
  schemaVersion: "airlock/tool-policy/v1",
  toolGrants,
  resources: { path },
  budget: { maxCalls: 32, maxInputBytes: 65_536 }
})

const readNow: Grant = { id: "read", tool: "file.read", when: "now" }
const statNow: Grant = { id: "stat", tool: "file.stat", when: "now" }
const writeNow: Grant = { id: "write", tool: "file.write", when: "now" }

const makeSeal = (name: string, options: {
  readonly verbs: ReadonlyArray<BoxGrantVerb>
  readonly policy?: ReturnType<typeof policyOf>
}) => {
  const directory = join(root, `seal-${name}`)
  mkdirSync(directory, { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const grant = Schema.decodeUnknownSync(BoxGrant)({
    schemaVersion: "airlock/box-grant/v2",
    policy: options.policy ?? policyOf([readNow]),
    verbs: options.verbs,
    binaryDigest: digest(readFileSync(binary))
  })
  writeFileSync(join(directory, BOX_GRANT_FILE), `${JSON.stringify(Schema.encodeSync(BoxGrant)(grant), null, 2)}\n`)
  writeFileSync(
    join(directory, OPERATOR_PUBLIC_KEY_FILE),
    publicKey.export({ format: "pem", type: "spki" })
  )
  writeFileSync(
    join(directory, BOX_GRANT_SIGNATURE_FILE),
    sign(null, boxGrantSigningPayload(grant), privateKey)
  )
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
      AIRLOCK_POLICY_FILE: undefined,
      ...options.env
    }
  })
}

const workspaceNamed = (name: string) => {
  const workspace = join(root, name)
  mkdirSync(workspace, { recursive: true })
  return workspace
}

const outcomeOf = (invocation: Invocation) =>
  (JSON.parse(invocation.stdout) as { readonly outcome: Record<string, unknown> }).outcome
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
/** Spelling suggestions the command runner appends to an unknown subcommand. */
const suggestionBlock = /\n\s*Did you mean this\?\n((?: {4}\S+\n?)+)/
const suggestedCommands = (text: string): ReadonlyArray<string> =>
  (suggestionBlock.exec(stripAnsi(text))?.[1] ?? "").split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
const normalizeMismatch = (text: string) => stripAnsi(text)
  .replace(suggestionBlock, "\n")
  .replaceAll(basename(binary), "<binary>")
  .replace(/\b(?:approve-plan|commit|cancel|undo|reap|change|nonsense|exec|rm|write|send|serve)\b/g, "<command>")
  .trim()

const allVerbs = BoxGrantVerb.literals
/** What a person decides: on the unsealed person's binary only, never grantable to a seal. */
const supervisorVerbs = ["approve-plan", "commit", "cancel", "undo", "reap"] as const
const everyCommand = [
  "describe", "review", "run", "eval", "approve-plan", "pending", "inspect",
  "commit", "cancel", "undo", "reap", "ledger", "doctor", "capabilities", "change"
]
const subcommandsOf = (help: string) => {
  const section = stripAnsi(help).split("SUBCOMMANDS")[1] ?? ""
  return section.split("\n").map((line) => line.trim().split(/\s+/)[0]!).filter((name) => name.length > 0)
}

describe("sealed CLI grant graph", () => {
  it("keeps every command unsealed, and the agent's binary without a person's decisions", () => {
    const help = invoke(["--help"])
    expect(help.status, help.stderr).toBe(0)
    expect(subcommandsOf(help.stdout)).toEqual(everyCommand)

    const agentHelp = invoke(["--help"], { env: { AIRLOCK_AGENT_SURFACE: "1" } })
    expect(agentHelp.status, agentHelp.stderr).toBe(0)
    expect(subcommandsOf(agentHelp.stdout)).toEqual(
      everyCommand.filter((verb) => !(supervisorVerbs as ReadonlyArray<string>).includes(verb))
    )
    expect([...allVerbs, ...supervisorVerbs, "change"].sort()).toEqual([...everyCommand].sort())
  })

  it("answers exactly the signed verbs on both aliases", () => {
    const every = makeSeal("every-verb", { verbs: allVerbs })
    const some = makeSeal("some-verbs", { verbs: ["eval", "run", "pending"] })
    for (const agent of [false, true]) {
      const env = { AIRLOCK_AGENT_SURFACE: agent ? "1" : undefined }
      const all = invoke(["--help"], { seal: every, env })
      expect(all.status, all.stderr).toBe(0)
      expect(subcommandsOf(all.stdout)).toEqual([...allVerbs])
      const granted = invoke(["--help"], { seal: some, env })
      expect(subcommandsOf(granted.stdout)).toEqual(["run", "eval", "pending"])
    }
  })

  it("holds a sealed run to the signed policy, never to the environment", () => {
    const workspace = workspaceNamed("program-workspace")
    const outside = workspaceNamed("outside-workspace")
    writeFileSync(join(outside, "secret.txt"), "outside the signed ceiling")
    const broad = join(root, "broad-policy.json")
    writeFileSync(broad, JSON.stringify(policyOf([readNow, writeNow, { id: "rm", tool: "file.remove", when: "now" }], ["/"])))
    const seal = makeSeal("program", {
      verbs: ["eval", "run", "pending"],
      policy: policyOf([readNow, writeNow], [workspace])
    })
    const home = join(root, "program-home")
    const sealed = (args: ReadonlyArray<string>, agent = false) => invoke(args, {
      seal,
      home,
      cwd: workspace,
      env: { AIRLOCK_AGENT_SURFACE: agent ? "1" : undefined, AIRLOCK_POLICY_FILE: broad }
    })

    const evaluated = sealed([
      "eval", "--workspace", workspace,
      "--source", 'let w = file.write({ path: "evaluated.txt", content: "signed-eval" })\nreturn w.state'
    ], true)
    expect(evaluated.status, evaluated.stderr).toBe(0)
    expect(outcomeOf(evaluated)).toEqual({ ok: true, result: "done", toolCalls: 1 })
    expect(readFileSync(join(workspace, "evaluated.txt"), "utf8")).toBe("signed-eval")

    const program = join(workspace, "program.air")
    writeFileSync(program, 'let w = file.write({ path: "run.txt", content: "signed-run" })\nassert w.state == "done", "write"\nreturn w.result.bytes\n')
    const ran = sealed(["run", program, "--workspace", workspace])
    expect(ran.status, ran.stderr).toBe(0)
    expect(outcomeOf(ran)).toEqual({ ok: true, result: 10, toolCalls: 1 })
    expect(readFileSync(join(workspace, "run.txt"), "utf8")).toBe("signed-run")

    // A tool the signed policy does not grant is not on the surface: the
    // program is invalid and nothing runs, whatever the policy file says.
    const victim = join(workspace, "run.txt")
    const removal = sealed([
      "eval", "--workspace", workspace,
      "--source", 'return file.remove({ path: "run.txt" })'
    ])
    expect(removal.status).toBe(1)
    expect(outcomeOf(removal)).toMatchObject({ ok: false, reason: "invalid_code", toolCalls: 0 })
    expect(readFileSync(victim, "utf8")).toBe("signed-run")
    const process = sealed([
      "eval", "--workspace", workspace,
      "--source", `return process.run({ executable: "/bin/sh", args: ["-c", "printf x > marker"], cwd: "${workspace}" })`
    ])
    expect(process.status).toBe(1)
    expect(outcomeOf(process)).toMatchObject({ ok: false, reason: "invalid_code", toolCalls: 0 })
    expect(existsSync(join(workspace, "marker"))).toBe(false)

    // A granted tool is still held to the signed path ceiling.
    const escapeRead = sealed([
      "eval", "--workspace", workspace,
      "--source", `return file.read({ path: "${join(outside, "secret.txt")}", format: "text" })`
    ])
    expect(escapeRead.status, escapeRead.stderr).toBe(0)
    expect(outcomeOf(escapeRead)).toMatchObject({
      ok: true,
      result: { state: "refused", refusal: { code: "not-allowed" } }
    })
    expect(escapeRead.stdout).not.toContain("outside the signed ceiling")
    const escapeWrite = sealed([
      "eval", "--workspace", workspace,
      "--source", `let w = file.write({ path: "${join(outside, "planted.txt")}", content: "x" })\nassert w.state == "done", "write"\nreturn true`
    ])
    expect(escapeWrite.status).toBe(1)
    expect(outcomeOf(escapeWrite)).toMatchObject({ ok: false })
    expect(existsSync(join(outside, "planted.txt"))).toBe(false)

    const unknownFlag = sealed([
      "eval", "--source", "return true", "--workspace", workspace, "--policy", broad
    ])
    expect(unknownFlag.status).not.toBe(0)
    expect(unknownFlag.stdout).toBe("")
  })

  it("makes denied and removed verbs ordinary missing subcommands", () => {
    const seal = makeSeal("denied", { verbs: ["run", "eval", "pending"] })
    for (const agent of [false, true]) {
      const env = { AIRLOCK_AGENT_SURFACE: agent ? "1" : undefined }
      const nonsense = invoke(["nonsense"], { seal, env })
      expect(nonsense.status).not.toBe(0)
      expect(stripAnsi(nonsense.stderr)).toContain("Unknown subcommand")
      for (const denied of [...supervisorVerbs, "change", "exec", "rm", "write", "send", "serve"]) {
        const result = invoke([denied], { seal, env })
        expect(result.status, denied).toBe(nonsense.status)
        expect(normalizeMismatch(result.stderr)).toBe(normalizeMismatch(nonsense.stderr))
        for (const suggested of suggestedCommands(result.stderr))
          expect(["run", "eval", "pending"]).toContain(suggested)
        expect(result.stderr).not.toContain("CliInputError")
      }
    }

    const empty = makeSeal("empty", { verbs: [] })
    const emptyKnown = invoke(["commit"], { seal: empty })
    const emptyNonsense = invoke(["nonsense"], { seal: empty })
    expect(emptyKnown.status).toBe(emptyNonsense.status)
    expect(emptyKnown.status).not.toBe(0)
    expect(normalizeMismatch(emptyKnown.stderr)).toBe(normalizeMismatch(emptyNonsense.stderr))
    expect(stripAnsi(emptyKnown.stderr)).not.toContain("TypeError")
    const emptyHelp = invoke(["--help"], { seal: empty })
    expect(emptyHelp.status, emptyHelp.stderr).toBe(0)
    expect(subcommandsOf(emptyHelp.stdout)).toEqual([])
  })

  it("omits local changes from both sealed aliases even with every verb granted", () => {
    const seal = makeSeal("no-local-changes", {
      verbs: allVerbs,
      policy: policyOf([readNow, writeNow])
    })
    for (const agent of [false, true]) {
      const options = { seal, env: { AIRLOCK_AGENT_SURFACE: agent ? "1" : undefined } }
      const help = invoke(["--help"], options)
      expect(help.status, help.stderr).toBe(0)
      expect(help.stdout).not.toMatch(/\bchange\b/)
      const refused = invoke(["change", "apply", "proposal"], options)
      expect(refused.status).not.toBe(0)
      expect(stripAnsi(refused.stderr)).toContain("Unknown subcommand")
    }
  })

  it("describes only the signed tools, and nothing a workspace file adds", () => {
    const workspace = workspaceNamed("discovery-workspace")
    const statOnly = makeSeal("discovery-stat", {
      verbs: ["describe"],
      policy: policyOf([statNow], [workspace])
    })
    const described = invoke(["describe", "--workspace", workspace], { seal: statOnly, cwd: workspace })
    expect(described.status, described.stderr).toBe(0)
    const listed = JSON.parse(described.stdout) as {
      readonly actions: ReadonlyArray<{ readonly name: string }>
      readonly description: string
    }
    expect(listed.actions.map(({ name }) => name)).toEqual(["file.stat"])
    expect(listed.description).not.toContain("file.write")
    expect(listed.description).not.toContain("process.run")

    // Nothing a workspace can hold names a new action: a file where tool
    // definitions used to be discovered changes neither the listing nor a run.
    const ambient = join(workspace, ".airlock", "tools")
    mkdirSync(ambient, { recursive: true })
    writeFileSync(join(ambient, "extra.airlock-tool.json"), JSON.stringify({
      schemaVersion: "airlock/tool-definition/v2",
      id: "invoke_tool",
      version: "1.0.0",
      executables: [{ realm: "local", selector: "/bin/echo" }],
      actions: [{ name: "call", inputSchema: { type: "object" }, args: [], lowering: "invoke" }]
    }))
    const after = invoke(["describe", "--workspace", workspace], { seal: statOnly, cwd: workspace })
    expect(after.status, after.stderr).toBe(0)
    expect(JSON.parse(after.stdout)).toEqual(listed)
  })

  it("constructs every command from one guarded descriptor table", () => {
    const source = readFileSync(join(repository, "src", "cli.ts"), "utf8")
    const table = source.slice(
      source.indexOf("const commandDescriptors"),
      source.indexOf("const makeRoot")
    )
    const mapped = [...table.matchAll(/\{ verb: "([^"]+)", supervisor:/g)].map((match) => match[1])
    expect(mapped).toEqual(everyCommand)
    expect(source).toContain('descriptor.verb !== "change"')
    expect(source.match(/const requireVerb =/g)).toHaveLength(1)
    // Every handler re-checks its verb against the verified seal.
    expect(source).toMatch(/const withAirlock = [\s\S]*?requireVerb\(seal, verb\)/)
    for (const verb of ["ledger", "doctor", "capabilities"])
      expect(source).toContain(`requireVerb(seal, "${verb}")`)
  })
})
