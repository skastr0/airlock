import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BoxGrant } from "@skastr0/airlock"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  OPERATOR_PUBLIC_KEY_FILE,
  boxGrantDigest,
  boxGrantSigningPayload
} from "../src/seal/index.ts"
import { Sha256Digest } from "@skastr0/airlock"

const repository = resolve(import.meta.dirname, "..", "..", "..")
const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-sealed-proof-")))
const generation = join(root, "generation")
const binary = join(generation, "bin", "airlock")
const agentBinary = join(generation, "bin", "airlock-agent")
const workspace = join(root, "workspace")
const home = join(generation, "home")
const sealPath = join(generation, "seal")
const policyPath = join(root, "signed-policy.json")
const operator = generateKeyPairSync("ed25519")
const publicKeyPath = join(root, "operator.pub.pem")
let provider: Server
let origin = ""
let hits = 0

const sha256 = (bytes: Uint8Array) =>
  Sha256Digest.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)

const agentVerbs = ["describe", "eval", "inspect", "pending", "run"] as const

beforeAll(async () => {
  mkdirSync(join(generation, "bin"), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, "observed.txt"), "sealed observation\n")
  writeFileSync(publicKeyPath, operator.publicKey.export({ format: "pem", type: "spki" }))
  const built = spawnSync("bun", [
    "scripts/build-box.ts", "--public-key", publicKeyPath, "--out", binary
  ], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1" }
  })
  expect(built.status, built.stderr).toBe(0)
  cpSync(binary, agentBinary)
  provider = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"ok":true}\n')
  })
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done))
  const address = provider.address()
  if (address === null || typeof address === "string") throw new Error("provider unavailable")
  origin = `http://127.0.0.1:${address.port}`

  const policy = {
    schemaVersion: "airlock/tool-policy/v1",
    toolGrants: [
      ...["file.inspect", "file.read", "file.list", "file.glob", "file.stat"].map((tool) => ({ id: tool, tool, when: "now" })),
      // Granted, but every send waits for a person.
      { id: "send", tool: "http.stage", when: "approved" }
    ],
    resources: { path: [workspace], endpoint: [`${origin}/v1/*`] },
    budget: { maxCalls: 32, maxInputBytes: 65_536 }
  }
  writeFileSync(policyPath, JSON.stringify(policy))
  mkdirSync(sealPath, { recursive: true })
  const grant = Schema.decodeUnknownSync(BoxGrant)({
    schemaVersion: "airlock/box-grant/v2",
    policy,
    verbs: agentVerbs,
    binaryDigest: sha256(readFileSync(binary))
  })
  writeFileSync(join(sealPath, BOX_GRANT_FILE), `${JSON.stringify(Schema.encodeSync(BoxGrant)(grant), null, 2)}\n`)
  writeFileSync(join(sealPath, BOX_GRANT_SIGNATURE_FILE), sign(null, boxGrantSigningPayload(grant), operator.privateKey))
  writeFileSync(join(sealPath, OPERATOR_PUBLIC_KEY_FILE), operator.publicKey.export({ format: "pem", type: "spki" }))
  writeFileSync(join(generation, "SEALED"), `${JSON.stringify({
    schemaVersion: "airlock/installed-generation/v1",
    grantDigest: boxGrantDigest(grant),
    binaryDigest: grant.binaryDigest,
    ownershipApplied: true,
    runnable: true
  })}\n`)
}, 60_000)

afterAll(async () => {
  await new Promise<void>((done) => provider.close(() => done()))
})

const run = async (command: ReadonlyArray<string>, args: ReadonlyArray<string>, env: Record<string, string | undefined>) => {
  const child = spawn(command[0]!, [...command.slice(1), ...args], {
    cwd: workspace,
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1", AIRLOCK_POLICY_FILE: undefined, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  child.stdout!.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const status = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("command timeout")) }, 20_000)
    child.once("error", reject)
    child.once("exit", (code) => { clearTimeout(timer); done(code) })
  })
  return { status, stdout, stderr }
}

/** The agent's sealed binary, as its harness launches it. */
const agent = (args: ReadonlyArray<string>) => run([agentBinary], args, { AIRLOCK_AGENT_SURFACE: "1" })

describe("portable sealed-box proof", () => {
  it("answers only the signed agent verbs and runs the signed observation surface", async () => {
    const help = await agent(["--help"])
    expect(help.status, help.stderr).toBe(0)
    for (const verb of agentVerbs) expect(help.stdout).toMatch(new RegExp(`\\b${verb}\\b`))
    for (const denied of ["approve-plan", "commit", "cancel", "undo", "reap", "ledger", "change", "serve", "exec"])
      expect(help.stdout).not.toMatch(new RegExp(`\\b${denied}\\b`))

    const observation = await agent([
      "eval", "--workspace", workspace, "--source",
      'let a = file.inspect({ path: "observed.txt" })\n' +
      'let b = file.read({ path: "observed.txt", format: "text" })\n' +
      'let c = file.list({ path: "." })\n' +
      'let d = file.glob({ root: ".", pattern: "*.txt" })\n' +
      'let e = file.stat({ path: "observed.txt" })\n' +
      'assert b.state == "done", "read"\n' +
      "return [a.state, b.result, c.state, d.state, e.state]"
    ])
    expect(observation.status, observation.stderr).toBe(0)
    expect(JSON.parse(observation.stdout).outcome).toEqual({
      ok: true,
      result: ["done", "sealed observation\n", "done", "done", "done"],
      toolCalls: 5
    })
    expect(JSON.parse((await agent(["pending", "--workspace", workspace])).stdout)).toEqual([])
  }, 60_000)

  it("leaves a staged request waiting for a person: the agent's binary cannot commit it", async () => {
    const before = hits
    const program = join(workspace, "send.air")
    writeFileSync(program, `return http.stage({ endpoint: "${origin}/v1/status", method: "POST", body: "hello", holdMillis: 0 })\n`)
    const staged = await agent(["run", program, "--workspace", workspace])
    expect(staged.status, staged.stderr).toBe(0)
    expect(JSON.parse(staged.stdout).outcome).toMatchObject({ ok: true, result: { state: "staged" } })
    expect(hits).toBe(before)

    const outside = await agent([
      "eval", "--workspace", workspace, "--source",
      `return http.stage({ endpoint: "${origin}/v2/status", method: "POST", holdMillis: 0 })`
    ])
    expect(JSON.parse(outside.stdout).outcome).toMatchObject({ ok: true, result: { state: "refused" } })

    const pending = JSON.parse((await agent(["pending", "--workspace", workspace])).stdout) as ReadonlyArray<{ readonly id: string }>
    expect(pending).toHaveLength(1)
    const id = pending[0]!.id

    for (const decision of ["commit", "cancel", "approve-plan"]) {
      const refused = await agent([decision, id, "--workspace", workspace])
      expect(refused.status, decision).not.toBe(0)
      expect(refused.stderr).toContain("Unknown subcommand")
    }
    // The non-agent name is the same sealed graph, not a way around it.
    const direct = await run([binary], ["commit", id, "--workspace", workspace], {})
    expect(direct.status).not.toBe(0)
    expect(direct.stderr).toContain("Unknown subcommand")
    expect(hits).toBe(before)
    expect(JSON.parse((await agent(["pending", "--workspace", workspace])).stdout)).toHaveLength(1)

    // A person, holding the same policy over the same state, commits it.
    const committed = await run(["bun", join(repository, "packages", "cli", "src", "cli.ts")], ["commit", id, "--workspace", workspace], {
      AIRLOCK_HOME: home,
      AIRLOCK_POLICY_FILE: policyPath
    })
    expect(committed.status, committed.stderr).toBe(0)
    expect(JSON.parse(committed.stdout)).toMatchObject({ id, state: "committed", provenance: { committedBy: "supervisor" } })
    expect(hits).toBe(before + 1)
    expect(JSON.parse((await agent(["pending", "--workspace", workspace])).stdout)).toEqual([])
  }, 60_000)
})
