import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const script = join(repository, "scripts", "seal-box.ts")
const isNonRootDarwin = process.platform === "darwin" &&
  typeof process.getuid === "function" && process.getuid() !== 0

const cleanEnvironment = (extra: Record<string, string | undefined> = {}) => ({
  ...process.env,
  FORCE_COLOR: undefined,
  NO_COLOR: "1",
  AIRLOCK_AGENT_SURFACE: undefined,
  ...extra
})

const runSeal = (
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined> = {}
) => spawnSync("bun", [script, ...args], {
  cwd: repository,
  encoding: "utf8",
  env: cleanEnvironment(environment),
  timeout: 120_000
})

const invoke = (
  binary: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: Record<string, string | undefined> = {}
): SpawnSyncReturns<string> => spawnSync(binary, [...args], {
  cwd,
  encoding: "utf8",
  env: cleanEnvironment(environment),
  timeout: 30_000
})

const stripAnsi = (text: string) =>
  text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")

const normalizeMismatch = (text: string, binary: string) => stripAnsi(text)
  .replaceAll(basename(binary), "<binary>")
  .replace(/\b(?:commit|exec|undo|nonsense)\b/g, "<command>")
  .trim()

const waitForExit = async (pid: number) => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((done) => setTimeout(done, 25))
    } catch {
      return
    }
  }
  throw new Error(`daemon ${pid} did not exit`)
}

type LocalOutput = {
  readonly generation: string
  readonly binary: string
  readonly agentBinary: string
  readonly seal: string
  readonly home: string
  readonly socket: string
  readonly readiness: string
  readonly operatorKeyAnchor: string
  readonly grantDigest: string
  readonly binaryDigest: string
  readonly profile: string
  readonly daemonOps: ReadonlyArray<string>
  readonly daemonPid?: number
  readonly daemonReady: boolean
  readonly localSameUser: boolean
  readonly runnable: boolean
  readonly recipe: string
}

describe.skipIf(!isNonRootDarwin)("same-user local sealed generation", () => {
  const root = mkdtempSync(join(tmpdir(), "airlock-local-sealed-"))
  const workspace = join(root, "workspace")
  const physicalWorkspace = realpathSync(root) + "/workspace"
  const privateKey = join(root, "operator.key")
  const publicKey = join(root, "operator.pub")
  const requestedGeneration = join(root, "box")
  let local: LocalOutput
  let localRecipeOutput = ""
  let daemonPid: number | undefined

  const startupClone = (name: string): string => {
    const clone = join(realpathSync(root), name)
    mkdirSync(join(clone, "bin"), { recursive: true })
    linkSync(local.binary, join(clone, "bin", "airlock"))
    cpSync(local.seal, join(clone, "seal"), { recursive: true })
    cpSync(local.readiness, join(clone, "SEALED"))
    return clone
  }

  beforeAll(() => {
    mkdirSync(workspace)
    writeFileSync(join(workspace, "ok.txt"), "hi\n")
    const generated = runSeal([
      "keygen", "--private-key", privateKey, "--public-key", publicKey
    ])
    expect(generated.status, generated.stderr).toBe(0)

    const created = runSeal([
      "local",
      "--workspace", workspace,
      "--out", requestedGeneration,
      "--private-key", privateKey,
      "--public-key", publicKey
    ])
    expect(created.status, created.stderr).toBe(0)
    local = JSON.parse(created.stdout) as LocalOutput
    localRecipeOutput = created.stderr
  }, 120_000)

  afterAll(async () => {
    if (daemonPid !== undefined) {
      try {
        process.kill(daemonPid, "SIGTERM")
        await waitForExit(daemonPid)
      } catch {
        // A daemon already killed by its test needs no cleanup.
      }
    }
  })

  it("publishes a current-user, compile-bound generation and no private key", () => {
    expect(local.generation).toBe(join(realpathSync(root), "box"))
    expect(local.profile).toBe("native-contained")
    expect(local.daemonOps).toEqual([])
    expect(local.daemonReady).toBe(false)
    expect(local.localSameUser).toBe(true)
    expect(local.runnable).toBe(true)
    expect(local.recipe).toContain('file.stat({ path: "ok.txt" })')
    expect(localRecipeOutput).toContain("# Airlock local sealed recipe (copy and paste)")
    expect(localRecipeOutput).toContain('return file.stat({ path: "ok.txt" })')
    expect(localRecipeOutput).not.toContain('\\"ok.txt\\"')
    expect(local.recipe).toContain("# daemonOps is empty; no daemon is required")
    expect(local.recipe).not.toContain(" serve ")

    const readiness = JSON.parse(readFileSync(local.readiness, "utf8"))
    expect(readiness).toMatchObject({
      schemaVersion: "airlock/installed-generation/v1",
      grantDigest: local.grantDigest,
      binaryDigest: local.binaryDigest,
      ownershipApplied: false,
      localSameUser: true,
      runnable: true,
      activated: false
    })
    const grant = JSON.parse(readFileSync(
      join(local.seal, "box-grant.json"),
      "utf8"
    ))
    expect(grant).toMatchObject({
      admission: {
        schemaVersion: "airlock/admission-policy/v2",
        profile: "native-contained",
        pathAllowlist: [`${physicalWorkspace}/**`],
        executableAllowlist: [],
        endpointGrants: []
      },
      verbs: ["actions", "doctor", "eval", "held", "pending", "run", "schema", "serve"],
      nativeActions: [
        "file.glob", "file.inspect", "file.list", "file.read", "file.stat",
        "http.stage"
      ],
      catalog: [],
      daemonOps: []
    })

    for (const path of [
      local.generation,
      local.binary,
      local.seal,
      local.home,
      join(local.generation, "ipc")
    ]) {
      expect(statSync(path).uid).toBe(process.getuid!())
    }
    expect(statSync(local.home).mode & 0o777).toBe(0o700)
    expect(statSync(join(local.generation, "ipc")).mode & 0o777).toBe(0o700)
    expect(statSync(join(local.generation, "bin")).mode & 0o777).toBe(0o755)
    expect(statSync(local.binary).mode & 0o777).toBe(0o555)
    expect(statSync(local.agentBinary).mode & 0o777).toBe(0o555)
    expect(statSync(local.operatorKeyAnchor).mode & 0o777).toBe(0o444)
    expect(readFileSync(local.operatorKeyAnchor, "utf8"))
      .toMatch(/^sha256:[0-9a-f]{64}\n$/)

    const inputPrivate = realpathSync(privateKey)
    expect(relative(local.generation, inputPrivate).startsWith(".."))
      .toBe(true)
    const names = readdirSync(local.generation, {
      recursive: true,
      encoding: "utf8"
    })
    expect(names.every((name) => !/private|\.key$/i.test(name))).toBe(true)
    for (const name of names) {
      const path = join(local.generation, name)
      if (!lstatSync(path).isFile()) continue
      expect(readFileSync(path).includes(Buffer.from("-----BEGIN PRIVATE KEY-----")))
        .toBe(false)
    }

    const doctor = invoke(local.binary, ["doctor"], workspace, {
      AIRLOCK_SEAL: join(root, "attacker-seal"),
      AIRLOCK_HOME: join(root, "attacker-home"),
      AIRLOCK_DAEMON_UID_INTERNAL: "0",
      AIRLOCK_GENERATION_MODE_INTERNAL: "root-tenant"
    })
    expect(doctor.status, doctor.stderr).toBe(0)
    expect(JSON.parse(doctor.stdout)).toMatchObject({ version: expect.any(String) })
    expect(existsSync(join(root, "attacker-home"))).toBe(false)
  })

  it("rejects root-tenant readiness in a compile-bound local binary", () => {
    const rootMarkerClone = startupClone("root-marker-clone")
    const readinessPath = join(rootMarkerClone, "SEALED")
    const readiness = JSON.parse(readFileSync(readinessPath, "utf8"))
    chmodSync(readinessPath, 0o644)
    writeFileSync(readinessPath, `${JSON.stringify({
      ...readiness,
      ownershipApplied: true,
      localSameUser: false,
      runnable: true
    })}\n`)

    const refused = invoke(
      join(rootMarkerClone, "bin", "airlock"),
      ["doctor"],
      workspace
    )
    expect(refused.status).toBe(78)
    expect(refused.stdout).toBe("")
    expect(JSON.parse(refused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed",
      reason: "installation-not-ready"
    })
  })

  it("runs the signed observation surface and publishes the real stat result", () => {
    const observed = invoke(local.binary, [
      "eval",
      "--workspace", physicalWorkspace,
      "--source", `return file.stat({ path: "${physicalWorkspace}/ok.txt" })`
    ], workspace)
    expect(observed.status, observed.stderr).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({
      profile: "native-contained",
      result: {
        state: "succeeded",
        result: { kind: "file", bytes: 3 }
      }
    })

    const schema = invoke(local.binary, ["schema", "file.stat"], workspace)
    expect(schema.status, schema.stderr).toBe(0)
    const resultSchema = JSON.parse(schema.stdout).action.resultSchema
    expect(resultSchema.properties.bytes).toBeDefined()
    expect(resultSchema.properties.size).toBeUndefined()
  })

  it("runs the printed workspace-relative stat", () => {
    const observed = invoke(local.binary, [
      "eval",
      "--workspace", workspace,
      "--source", 'return file.stat({ path: "ok.txt" })'
    ], workspace)
    expect(observed.status, observed.stderr).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({
      result: { state: "succeeded", result: { bytes: 3 } }
    })
  })

  it("keeps process.run off the surface and leaves the file unchanged", () => {
    const before = readFileSync(join(workspace, "ok.txt"))
    const attempted = invoke(local.binary, [
      "eval",
      "--workspace", workspace,
      "--bindings", JSON.stringify({ workspace }),
      "--source",
      'return process.run({ executable: "/bin/sh", args: ["-c", "> ok.txt"], cwd: workspace, stdout: "capture", stderr: "capture" })'
    ], workspace)
    expect(attempted.status).toBe(1)
    expect(JSON.parse(attempted.stdout)).toMatchObject({
      result: {
        state: "failed",
        failure: {
          phase: "contract",
          causeTag: "ProgramActionDecodeFailed"
        }
      }
    })
    expect(readFileSync(join(workspace, "ok.txt"))).toEqual(before)
  })

  it("hides commit, undo, and exec as ordinary missing subcommands", () => {
    const nonsense = invoke(local.binary, ["nonsense"], workspace)
    expect(nonsense.status).not.toBe(0)
    for (const denied of ["commit", "undo", "exec"] as const) {
      const result = invoke(local.binary, [denied], workspace)
      expect(result.status).toBe(nonsense.status)
      expect(normalizeMismatch(result.stderr, local.binary)).toBe(
        normalizeMismatch(nonsense.stderr, local.binary)
      )
    }
    const help = invoke(local.binary, ["--help"], workspace)
    expect(help.status, help.stderr).toBe(0)
    for (const hidden of ["commit", "undo", "exec", "write", "rm"])
      expect(help.stdout).not.toMatch(new RegExp(`\\b${hidden}\\b`))
  })

  it("fails startup on signed-grant and exact-catalog tamper", () => {
    const signatureClone = startupClone("signature-tamper")
    const signatureGrantPath = join(signatureClone, "seal", "box-grant.json")
    const signatureGrant = JSON.parse(readFileSync(signatureGrantPath, "utf8"))
    signatureGrant.admission.admittedBy = "attacker:unsigned-edit"
    chmodSync(signatureGrantPath, 0o644)
    writeFileSync(signatureGrantPath, `${JSON.stringify(signatureGrant, null, 2)}\n`)
    const signatureRefused = invoke(
      join(signatureClone, "bin", "airlock"),
      ["doctor"],
      workspace
    )
    expect(signatureRefused.status).toBe(78)
    expect(JSON.parse(signatureRefused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed",
      reason: "signature-invalid"
    })

    const catalogClone = startupClone("catalog-tamper")
    writeFileSync(
      join(catalogClone, "seal", "catalog", "evil.airlock-tool.json"),
      '{}\n'
    )
    const catalogRefused = invoke(
      join(catalogClone, "bin", "airlock"),
      ["doctor"],
      workspace
    )
    expect(catalogRefused.status).toBe(78)
    expect(JSON.parse(catalogRefused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed",
      reason: "catalog-file-extra"
    })
  }, 120_000)

  it("keeps a source loader outside the compiled sealed identity", () => {
    const sourceHome = join(root, "source-mode-home")
    const refused = spawnSync("bun", ["run", "src/cli.ts", "doctor"], {
      cwd: repository,
      encoding: "utf8",
      env: cleanEnvironment({
        AIRLOCK_SEAL: local.seal,
        AIRLOCK_HOME: sourceHome
      }),
      timeout: 30_000
    })
    expect(refused.status).toBe(78)
    expect(refused.stdout).toBe("")
    expect(JSON.parse(refused.stderr)).toMatchObject({
      _tag: "SealVerificationFailed",
      phase: "identity",
      reason: "source-mode"
    })
    expect(existsSync(sourceHome)).toBe(false)
  })

  it("refuses local roots that expose the signing key or overlap output", () => {
    const unsafeWorkspace = join(root, "unsafe-workspace")
    mkdirSync(unsafeWorkspace)
    const unsafePrivate = join(unsafeWorkspace, "operator.key")
    const unsafePublic = join(root, "unsafe.pub")
    expect(runSeal([
      "keygen",
      "--private-key", unsafePrivate,
      "--public-key", unsafePublic
    ]).status).toBe(0)
    const unsafeOut = join(root, "unsafe-box")
    const exposed = runSeal([
      "local",
      "--workspace", unsafeWorkspace,
      "--out", unsafeOut,
      "--private-key", unsafePrivate,
      "--public-key", unsafePublic
    ])
    expect(exposed.status).toBe(65)
    expect(exposed.stderr).toContain("physically outside the readable workspace")
    expect(existsSync(unsafeOut)).toBe(false)

    const nestedOut = join(workspace, "nested-box")
    const overlapping = runSeal([
      "local",
      "--workspace", workspace,
      "--out", nestedOut,
      "--private-key", privateKey,
      "--public-key", publicKey
    ])
    expect(overlapping.status).not.toBe(0)
    expect(overlapping.stderr).toContain("physically disjoint")
    expect(existsSync(nestedOut)).toBe(false)

    const workspaceLink = join(root, "workspace-alias")
    symlinkSync(workspace, workspaceLink)
    const aliasOut = join(workspaceLink, "alias-box")
    const aliased = runSeal([
      "local",
      "--workspace", workspace,
      "--out", aliasOut,
      "--private-key", privateKey,
      "--public-key", publicKey
    ])
    expect(aliased.status).not.toBe(0)
    expect(aliased.stderr).toContain("physically disjoint")
    expect(existsSync(aliasOut)).toBe(false)
  })

  it("requires the loud compatibility flag before claiming the output", () => {
    const admission = join(root, "compatibility.json")
    writeFileSync(admission, `${JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "compatibility",
      principal: "agent:local-compatibility-test",
      realm: "local",
      admittedBy: "operator:local-compatibility-test",
      pathAllowlist: [`${physicalWorkspace}/**`],
      executableAllowlist: [],
      endpointAllowlist: []
    })}\n`)
    const out = join(root, "compatibility-without-flag")
    const refused = runSeal([
      "local",
      "--workspace", workspace,
      "--out", out,
      "--private-key", privateKey,
      "--public-key", publicKey,
      "--admission", admission
    ])
    expect(refused.status).toBe(65)
    expect(refused.stderr).toContain("--allow-sealed-compatibility")
    expect(existsSync(out)).toBe(false)
  })

  it("starts one same-binary commit daemon and fails closed after it dies", async () => {
    const daemonGeneration = join(root, "daemon-box")
    const created = runSeal([
      "local",
      "--workspace", workspace,
      "--out", daemonGeneration,
      "--private-key", privateKey,
      "--public-key", publicKey,
      "--with-daemon-commit"
    ], {
      // The compile-bound local wrapper must delete this inherited root limit.
      AIRLOCK_DAEMON_UID_INTERNAL: "0"
    })
    expect(created.status, created.stderr).toBe(0)
    expect(created.stderr).toContain("same-digest daemon is ready")
    expect(created.stderr).toContain('return file.stat({ path: "ok.txt" })')
    const daemon = JSON.parse(created.stdout) as LocalOutput
    daemonPid = daemon.daemonPid
    expect(daemon.daemonOps).toEqual(["commit"])
    expect(daemon.daemonReady).toBe(true)
    expect(daemonPid).toEqual(expect.any(Number))
    expect(daemon.recipe).toContain(`AIRLOCK_DAEMON_PID=${daemonPid}`)
    expect(daemon.recipe).not.toContain(" serve ")
    expect(lstatSync(daemon.socket).isSocket()).toBe(true)
    process.kill(daemonPid!, 0)

    const live = invoke(daemon.binary, [
      "eval",
      "--workspace", physicalWorkspace,
      "--source", `return file.stat({ path: "${physicalWorkspace}/ok.txt" })`
    ], workspace)
    expect(live.status, live.stderr).toBe(0)
    expect(JSON.parse(live.stdout)).toMatchObject({
      result: { state: "succeeded", result: { bytes: 3 } }
    })

    process.kill(daemonPid!, "SIGTERM")
    await waitForExit(daemonPid!)
    daemonPid = undefined
    const dead = invoke(daemon.binary, [
      "eval", "--workspace", workspace, "--source", "return true"
    ], workspace)
    expect(dead.status).toBe(1)
    expect(dead.stdout).toBe("")
    expect(JSON.parse(dead.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "daemon"
    })
  }, 120_000)
})
