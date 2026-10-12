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
import { beforeAll, describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const script = join(repository, "scripts", "seal-box.ts")
const isNonRootDarwin = process.platform === "darwin" &&
  typeof process.getuid === "function" && process.getuid() !== 0

const cleanEnvironment = (extra: Record<string, string | undefined> = {}) => ({
  ...process.env,
  FORCE_COLOR: undefined,
  NO_COLOR: "1",
  AIRLOCK_AGENT_SURFACE: undefined,
  AIRLOCK_POLICY_FILE: undefined,
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
  .replace(/\n\s*Did you mean this\?\n(?: {4}\S+\n?)+/, "\n")
  .replaceAll(basename(binary), "<binary>")
  .replace(/\b(?:approve-plan|commit|cancel|undo|ledger|change|exec|nonsense)\b/g, "<command>")
  .trim()

const outcomeOf = (invocation: SpawnSyncReturns<string>) =>
  (JSON.parse(invocation.stdout) as { readonly outcome: Record<string, unknown> }).outcome

type LocalOutput = {
  readonly generation: string
  readonly binary: string
  readonly agentBinary: string
  readonly seal: string
  readonly home: string
  readonly readiness: string
  readonly operatorKeyAnchor: string
  readonly grantDigest: string
  readonly binaryDigest: string
  readonly verbs: ReadonlyArray<string>
  readonly localSameUser: boolean
  readonly runnable: boolean
  readonly recipe: string
}

const observationTools = ["file.glob", "file.inspect", "file.list", "file.read", "file.stat"]
const localVerbs = ["capabilities", "describe", "doctor", "eval", "inspect", "pending", "review", "run"]

describe.skipIf(!isNonRootDarwin)("same-user local sealed generation", () => {
  const root = mkdtempSync(join(tmpdir(), "airlock-local-sealed-"))
  const workspace = join(root, "workspace")
  const physicalWorkspace = realpathSync(root) + "/workspace"
  const privateKey = join(root, "operator.key")
  const publicKey = join(root, "operator.pub")
  const requestedGeneration = join(root, "box")
  let local: LocalOutput
  let localRecipeOutput = ""

  const startupClone = (name: string): string => {
    const clone = join(realpathSync(root), name)
    mkdirSync(join(clone, "bin"), { recursive: true })
    linkSync(local.binary, join(clone, "bin", "airlock"))
    cpSync(local.seal, join(clone, "seal"), { recursive: true })
    cpSync(local.readiness, join(clone, "SEALED"))
    return clone
  }

  const rewriteGrant = (clone: string, edit: (grant: Record<string, any>) => unknown) => {
    const path = join(clone, "seal", "box-grant.json")
    const edited = edit(JSON.parse(readFileSync(path, "utf8")))
    chmodSync(path, 0o644)
    writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`)
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

  it("publishes a current-user, compile-bound, read-only generation and no private key", () => {
    expect(local.generation).toBe(join(realpathSync(root), "box"))
    expect(local.verbs).toEqual(localVerbs)
    expect(local.localSameUser).toBe(true)
    expect(local.runnable).toBe(true)
    expect(local.recipe).toContain('file.stat({ path: "ok.txt" })')
    expect(local.recipe).not.toContain("--bindings")
    expect(localRecipeOutput).toContain("# Airlock local sealed recipe (copy and paste)")
    expect(localRecipeOutput).toContain('return file.stat({ path: "ok.txt" })')
    expect(localRecipeOutput).not.toContain('\\"ok.txt\\"')

    const readiness = JSON.parse(readFileSync(local.readiness, "utf8"))
    expect(readiness).toEqual({
      schemaVersion: "airlock/installed-generation/v1",
      grantDigest: local.grantDigest,
      binaryDigest: local.binaryDigest,
      ownershipApplied: false,
      localSameUser: true,
      runnable: true
    })
    const grant = JSON.parse(readFileSync(join(local.seal, "box-grant.json"), "utf8"))
    expect(grant).toMatchObject({
      schemaVersion: "airlock/box-grant/v2",
      policy: {
        schemaVersion: "airlock/tool-policy/v1",
        resources: { path: [physicalWorkspace] }
      },
      verbs: localVerbs
    })
    expect(grant.policy.toolGrants.map(({ tool, when }: { tool: string; when: string }) => [tool, when]))
      .toEqual(observationTools.map((tool) => [tool, "now"]))
    expect(readdirSync(local.generation).sort()).toEqual(["SEALED", "bin", "home", "seal"])

    for (const path of [local.generation, local.binary, local.seal, local.home]) {
      expect(statSync(path).uid).toBe(process.getuid!())
    }
    expect(statSync(local.home).mode & 0o777).toBe(0o700)
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

  it("runs the signed observation surface and describes nothing more", () => {
    const observed = invoke(local.binary, [
      "eval",
      "--workspace", physicalWorkspace,
      "--source", `let s = file.stat({ path: "${physicalWorkspace}/ok.txt" })\nassert s.state == "done", "stat"\nreturn s.result`
    ], workspace)
    expect(observed.status, observed.stderr).toBe(0)
    expect(outcomeOf(observed)).toMatchObject({
      ok: true,
      result: { kind: "file", bytes: 3 },
      toolCalls: 1
    })

    const described = invoke(local.binary, ["describe", "--workspace", workspace], workspace)
    expect(described.status, described.stderr).toBe(0)
    const surface = JSON.parse(described.stdout) as { readonly actions: ReadonlyArray<{ readonly name: string }> }
    expect(surface.actions.map(({ name }) => name)).toEqual(observationTools)
  })

  it("runs the printed workspace-relative stat", () => {
    const observed = invoke(local.binary, [
      "eval",
      "--workspace", workspace,
      "--source", 'return file.stat({ path: "ok.txt" })'
    ], workspace)
    expect(observed.status, observed.stderr).toBe(0)
    expect(outcomeOf(observed)).toMatchObject({
      ok: true,
      result: { state: "done", result: { bytes: 3 } }
    })
  })

  it("keeps changes and processes off the surface and reads nothing beyond the workspace", () => {
    const before = readFileSync(join(workspace, "ok.txt"))
    for (const source of [
      'return process.run({ executable: "/bin/sh", args: ["-c", "> ok.txt"], cwd: workspace })',
      'return file.write({ path: "ok.txt", content: "" })',
      'return file.remove({ path: "ok.txt" })'
    ]) {
      const attempted = invoke(local.binary, ["eval", "--workspace", workspace, "--source", source], workspace)
      expect(attempted.status, source).toBe(1)
      expect(outcomeOf(attempted)).toMatchObject({ ok: false, reason: "invalid_code", toolCalls: 0 })
    }
    expect(readFileSync(join(workspace, "ok.txt"))).toEqual(before)

    writeFileSync(join(root, "beside.txt"), "beside the workspace")
    const escaped = invoke(local.binary, [
      "eval", "--workspace", workspace,
      "--source", `return file.read({ path: "${realpathSync(root)}/beside.txt", format: "text" })`
    ], workspace)
    expect(escaped.status, escaped.stderr).toBe(0)
    expect(outcomeOf(escaped)).toMatchObject({ ok: true, result: { state: "refused", refusal: { code: "not-allowed" } } })
    expect(escaped.stdout).not.toContain("beside the workspace")
  })

  it("hides a person's decisions and local changes as ordinary missing subcommands", () => {
    const nonsense = invoke(local.binary, ["nonsense"], workspace)
    expect(nonsense.status).not.toBe(0)
    for (const denied of ["approve-plan", "commit", "cancel", "undo", "ledger", "change", "exec"] as const) {
      const result = invoke(local.binary, [denied], workspace)
      expect(result.status, denied).toBe(nonsense.status)
      expect(normalizeMismatch(result.stderr, local.binary)).toBe(
        normalizeMismatch(nonsense.stderr, local.binary)
      )
    }
    const help = invoke(local.binary, ["--help"], workspace)
    expect(help.status, help.stderr).toBe(0)
    for (const hidden of ["approve-plan", "commit", "cancel", "undo", "change", "exec"])
      expect(help.stdout).not.toMatch(new RegExp(`\\b${hidden}\\b`))
  })

  it("fails startup on a tampered or widened grant and on a grant in a removed shape", () => {
    const refusedWith = (clone: string, reason: string) => {
      const refused = invoke(join(clone, "bin", "airlock"), ["doctor"], workspace)
      expect(refused.status, clone).toBe(78)
      expect(refused.stdout).toBe("")
      expect(JSON.parse(refused.stderr)).toMatchObject({ _tag: "SealVerificationFailed", reason })
    }

    const widenedPolicy = startupClone("policy-widened")
    rewriteGrant(widenedPolicy, (grant) => ({
      ...grant,
      policy: {
        ...grant.policy,
        toolGrants: [...grant.policy.toolGrants, { id: "write", tool: "file.write", when: "now", where: {} }]
      }
    }))
    refusedWith(widenedPolicy, "signature-invalid")

    const widenedCeiling = startupClone("ceiling-widened")
    rewriteGrant(widenedCeiling, (grant) => ({ ...grant, policy: { ...grant.policy, resources: { path: ["/"] } } }))
    refusedWith(widenedCeiling, "signature-invalid")

    const widenedVerbs = startupClone("verbs-widened")
    rewriteGrant(widenedVerbs, (grant) => ({ ...grant, verbs: [...grant.verbs, "ledger"] }))
    refusedWith(widenedVerbs, "signature-invalid")

    // A sealed install is the agent's; no grant can name a person's decision.
    const deciding = startupClone("deciding-verb")
    rewriteGrant(deciding, (grant) => ({ ...grant, verbs: [...grant.verbs, "commit"] }))
    refusedWith(deciding, "invalid-grant")

    const catalog = startupClone("catalog-shape")
    rewriteGrant(catalog, (grant) => ({ ...grant, catalog: [] }))
    refusedWith(catalog, "invalid-grant")

    const v1 = startupClone("v1-shape")
    rewriteGrant(v1, ({ policy: _policy, ...grant }) => ({
      ...grant,
      schemaVersion: "airlock/box-grant/v1",
      admission: {
        schemaVersion: "airlock/admission-policy/v2",
        profile: "native-contained",
        principal: "agent:local-box",
        realm: "local",
        admittedBy: "operator:local-box",
        pathAllowlist: [`${physicalWorkspace}/**`],
        executableAllowlist: [],
        executableEdges: [],
        endpointGrants: []
      },
      nativeActions: ["file.read"],
      daemonOps: []
    }))
    refusedWith(v1, "invalid-grant")
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

  it("refuses a policy that is not a strict ToolPolicy before claiming the output", () => {
    const loose = join(root, "loose-policy.json")
    writeFileSync(loose, `${JSON.stringify({
      schemaVersion: "airlock/tool-policy/v1",
      toolGrants: [{ id: "read", tool: "file.read", when: "now" }],
      resources: { path: [physicalWorkspace] },
      budget: { maxCalls: 8, maxInputBytes: 4096 },
      daemonOps: ["commit"]
    })}\n`)
    const admission = join(root, "admission-policy.json")
    writeFileSync(admission, `${JSON.stringify({
      schemaVersion: "airlock/admission-policy/v2",
      profile: "compatibility",
      principal: "agent:local-compatibility-test",
      realm: "local",
      admittedBy: "operator:local-compatibility-test",
      pathAllowlist: [`${physicalWorkspace}/**`],
      executableAllowlist: [],
      executableEdges: [],
      endpointGrants: []
    })}\n`)
    for (const policy of [loose, admission]) {
      const out = join(root, `refused-${basename(policy, ".json")}`)
      const refused = runSeal([
        "local",
        "--workspace", workspace,
        "--out", out,
        "--private-key", privateKey,
        "--public-key", publicKey,
        "--policy", policy
      ])
      expect(refused.status, policy).toBe(65)
      expect(refused.stderr).toContain("--policy is not a strict ToolPolicy")
      expect(existsSync(out)).toBe(false)
    }
    for (const removed of [["--admission", admission], ["--allow-sealed-compatibility"], ["--with-daemon-commit"]]) {
      const out = join(root, "refused-removed-option")
      const refused = runSeal([
        "local", "--workspace", workspace, "--out", out,
        "--private-key", privateKey, "--public-key", publicKey, ...removed
      ])
      expect(refused.status, removed[0]).toBe(64)
      expect(existsSync(out)).toBe(false)
    }
  })
})
