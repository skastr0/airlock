import { BunContext } from "@effect/platform-bun"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as AirlockHome from "../src/AirlockHome.ts"
import {
  AdmissionPolicyV2,
  BoxGrant,
  BoxGrantCatalogPin,
  EndpointGrantPolicy,
  hashBoxGrant
} from "../src/admission/index.ts"
import { daemonTick, runDaemonHealthServer } from "../src/daemon/index.ts"
import { HoldLive } from "../src/HoldLive.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { Outbox, OutboxLive } from "../src/Outbox.ts"
import {
  BOX_GRANT_FILE,
  BOX_GRANT_SIGNATURE_FILE,
  BinarySnapshot,
  OPERATOR_PUBLIC_KEY_FILE,
  SEAL_CATALOG_DIRECTORY,
  boxGrantSigningPayload,
  catalogFileNameForPin,
  reverifySeal,
  verifySealAtPath
} from "../src/seal/index.ts"

const repository = resolve(import.meta.dirname, "..")
const root = mkdtempSync(join(tmpdir(), "airlock-sealed-proof-"))
const generation = join(root, "generation")
const binary = join(generation, "bin", "airlock")
const agentBinary = join(generation, "bin", "airlock-agent")
const workspace = join(root, "workspace")
const home = join(generation, "home")
const socketPath = join(generation, "ipc", "daemon.sock")
const sealPath = join(generation, "seal")
const fixtureBytes = readFileSync(join(repository, "examples", "tools", "fixture-status.airlock-tool.json"))
const operator = generateKeyPairSync("ed25519")
const publicKeyPath = join(root, "operator.pub.pem")
let provider: Server
let origin = ""
let hits = 0
let grant: BoxGrant
let healthFiber: Fiber.RuntimeFiber<never, unknown> | undefined

const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const

beforeAll(async () => {
  mkdirSync(join(generation, "bin"), { recursive: true })
  mkdirSync(join(generation, "ipc"), { recursive: true })
  mkdirSync(home, { recursive: true })
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
  provider = createServer((request, response) => {
    if (request.url === "/v1/status" && request.method === "GET") hits += 1
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"ok":true}\n')
  })
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done))
  const address = provider.address()
  if (address === null || typeof address === "string") throw new Error("provider unavailable")
  origin = `http://127.0.0.1:${address.port}`

  mkdirSync(join(sealPath, SEAL_CATALOG_DIRECTORY), { recursive: true })
  const pin = new BoxGrantCatalogPin({ id: "fixture_status", sha256: sha256(fixtureBytes) })
  grant = new BoxGrant({
    schemaVersion: "airlock/box-grant/v1",
    admission: new AdmissionPolicyV2({
      schemaVersion: "airlock/admission-policy/v2",
      profile: "compatibility",
      principal: "agent:sealed-proof",
      realm: "local",
      admittedBy: "operator:sealed-proof",
      pathAllowlist: [`${workspace}/**`],
      executableAllowlist: [],
      endpointGrants: [new EndpointGrantPolicy({
        selector: `${origin}/v1/*`, methods: ["GET"], class: "read", commit: "auto"
      })]
    }),
    verbs: ["eval", "run", "held", "pending", "serve"],
    nativeActions: [
      "file.inspect", "file.read", "file.list", "file.glob", "file.stat", "http.stage"
    ],
    catalog: [pin],
    daemonOps: ["commit"],
    binaryDigest: sha256(readFileSync(binary))
  })
  writeFileSync(join(sealPath, BOX_GRANT_FILE), `${JSON.stringify(grant, null, 2)}\n`)
  writeFileSync(join(sealPath, BOX_GRANT_SIGNATURE_FILE), sign(null, boxGrantSigningPayload(grant), operator.privateKey))
  writeFileSync(join(sealPath, OPERATOR_PUBLIC_KEY_FILE), operator.publicKey.export({ format: "pem", type: "spki" }))
  writeFileSync(join(sealPath, SEAL_CATALOG_DIRECTORY, catalogFileNameForPin(pin)), fixtureBytes)
  writeFileSync(join(generation, "SEALED"), `${JSON.stringify({
    schemaVersion: "airlock/installed-generation/v1",
    grantDigest: hashBoxGrant(grant),
    binaryDigest: grant.binaryDigest,
    ownershipApplied: true,
    runnable: true,
    activated: false
  })}\n`)
}, 60_000)

afterAll(async () => {
  if (healthFiber !== undefined) await Effect.runPromise(Fiber.interrupt(healthFiber))
  await new Promise<void>((done) => provider.close(() => done()))
})

const env = () => ({
  ...process.env,
  FORCE_COLOR: undefined,
  NO_COLOR: "1",
  AIRLOCK_AGENT_SURFACE: "1"
})

const invoke = async (args: ReadonlyArray<string>) => {
  const child = spawn(agentBinary, [...args], { cwd: workspace, env: env(), stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout!.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const status = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("agent command timeout")) }, 10_000)
    child.once("error", reject)
    child.once("exit", (code) => { clearTimeout(timer); done(code) })
  })
  return { status, stdout, stderr }
}

const waitFor = async (predicate: () => boolean, failure: string) => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(failure)
}

const stateLayer = OutboxLive.pipe(
  Layer.provideMerge(LedgerLive),
  Layer.provideMerge(AirlockHome.layer(home)),
  Layer.provideMerge(BunContext.layer)
).pipe(Layer.provideMerge(
  HoldLive.pipe(
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(home)),
    Layer.provideMerge(BunContext.layer)
  )
))

const verifiedSeal = () => {
  const bytes = new Uint8Array(readFileSync(binary))
  const provider = () => Effect.succeed(new BinarySnapshot({ path: binary, rawBytes: bytes }))
  return Effect.runPromise(verifySealAtPath(sealPath, { binarySnapshotProvider: provider })).then((seal) => ({ seal, provider }))
}

describe("portable sealed-box proof", () => {
  it("allows only the four agent verbs and the signed observation surface", async () => {
    const { seal } = await verifiedSeal()
    healthFiber = Effect.runFork(runDaemonHealthServer({
      socketPath,
      state: { grantDigest: seal.grantDigest, ready: true }
    }))
    await waitFor(() => { try { return lstatSync(socketPath).isSocket() } catch { return false } }, "health socket missing")

    const help = await invoke(["--help"])
    expect(help.status, help.stderr).toBe(0)
    for (const verb of ["eval", "run", "held", "pending"]) expect(help.stdout).toMatch(new RegExp(`\\b${verb}\\b`))
    for (const denied of ["serve", "exec", "write", "rm", "send", "commit", "reap", "flush"])
      expect(help.stdout).not.toMatch(new RegExp(`\\b${denied}\\b`))
    expect(grant.nativeActions).toEqual([
      "file.inspect", "file.read", "file.list", "file.glob", "file.stat", "http.stage"
    ])
    expect(grant.nativeActions).not.toContain("process.run")

    const observation = await invoke([
      "eval", "--workspace", workspace, "--source",
      'let a = file.inspect({ path: "observed.txt" })\n' +
      'let b = file.read({ path: "observed.txt", format: "text" })\n' +
      'let c = file.list({ path: "." })\n' +
      'let d = file.glob({ root: ".", pattern: "*.txt" })\n' +
      'return file.stat({ path: "observed.txt" })'
    ])
    expect(observation.status, observation.stderr).toBe(0)
    const payload = JSON.parse(observation.stdout)
    expect(payload.result.actions.map((entry: { request: { call: { action: string } } }) => entry.request.call.action))
      .toEqual(["file.inspect", "file.read", "file.list", "file.glob", "file.stat"])
    expect(payload.result.plans.flatMap((plan: { nodes: ReadonlyArray<{ kind: string }> }) => plan.nodes.map((node) => node.kind)))
      .toEqual(["Capture", "Capture", "Capture", "Capture", "Capture"])
    expect((await invoke(["held"])).stdout.trim()).toBe("[]")
  }, 30_000)

  it("commits read evidence only through daemonTick and keeps declared mutation pending", async () => {
    const before = hits
    const readProgram = join(workspace, "read.air")
    writeFileSync(readProgram, `return fixture_status.read({ endpoint: "${origin}/v1/status" })\n`)
    const staged = await invoke(["run", readProgram, "--workspace", workspace])
    expect(staged.status, staged.stderr).toBe(0)
    expect(JSON.parse(staged.stdout)).toMatchObject({ result: { result: { state: "staged" } } })
    expect(hits).toBe(before)
    const pendingBefore = JSON.parse((await invoke(["pending"])).stdout)
    expect(pendingBefore).toHaveLength(1)
    expect(pendingBefore[0].authorization).toMatchObject({ dispatchClass: "read" })

    const { seal, provider } = await verifiedSeal()
    const report = await Effect.runPromise(daemonTick({
      seal,
      reverify: (expected) => reverifySeal(expected, { binarySnapshotProvider: provider })
    }).pipe(Effect.provide(stateLayer)))
    expect(report.attempted).toEqual([pendingBefore[0].id])
    expect(report.committed).toEqual([pendingBefore[0].id])
    expect(hits).toBe(before + 1)
    expect(JSON.parse((await invoke(["pending"])).stdout)).toEqual([])

    const mutate = await invoke([
      "eval", "--workspace", workspace, "--source",
      `return fixture_status.reconcile({ endpoint: "${origin}/v1/status" })`
    ])
    expect(mutate.status, mutate.stderr).toBe(0)
    const pendingMutate = JSON.parse((await invoke(["pending"])).stdout)
    expect(pendingMutate).toHaveLength(1)
    expect(pendingMutate[0].authorization).toBeUndefined()
    const second = await Effect.runPromise(daemonTick({
      seal,
      reverify: (expected) => reverifySeal(expected, { binarySnapshotProvider: provider })
    }).pipe(Effect.provide(stateLayer)))
    expect(second.attempted).toEqual([])
    expect(hits).toBe(before + 1)
  }, 30_000)

  it("fails closed when the same-seal daemon disappears", async () => {
    await Effect.runPromise(Fiber.interrupt(healthFiber!))
    healthFiber = undefined
    const refused = await invoke([
      "eval", "--workspace", workspace, "--source", "return true"
    ])
    expect(refused.status).toBe(1)
    expect(refused.stdout).toBe("")
    expect(JSON.parse(refused.stderr)).toMatchObject({ _tag: "CliInputError", field: "daemon" })
  })
})
