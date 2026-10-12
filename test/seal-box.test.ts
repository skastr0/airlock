import { createHash, createPublicKey } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const script = join(repository, "scripts", "seal-box.ts")

const run = (args: ReadonlyArray<string>) => spawnSync("bun", [script, ...args], {
  cwd: repository,
  encoding: "utf8",
  env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1" }
})

const temporary = () => mkdtempSync(join(tmpdir(), "airlock-seal-box-"))
const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const mode = (path: string) => statSync(path).mode & 0o7777

const toolPolicy = (workspace: string) => ({
  schemaVersion: "airlock/tool-policy/v1",
  toolGrants: [
    { id: "read", tool: "file.read", when: "now", where: {} },
    { id: "write", tool: "file.write", when: "approved", where: {} }
  ],
  resources: { path: [workspace] },
  flowRules: [],
  flow: {},
  budget: { maxCalls: 16, maxInputBytes: 65_536 }
})

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]))
}

type Fixture = {
  readonly root: string
  readonly workspace: string
  readonly binary: string
  readonly policy: string
  readonly privateKey: string
  readonly publicKey: string
}

const fixture = (): Fixture => {
  const root = temporary()
  const workspace = join(root, "workspace")
  const keys = join(root, "keys")
  mkdirSync(workspace)
  mkdirSync(keys)
  const binary = join(root, "airlock-fixture")
  const binaryBytes = Buffer.from("#!/bin/sh\necho sealed-fixture\n")
  writeFileSync(binary, binaryBytes)
  chmodSync(binary, 0o755)
  const policy = join(root, "policy.json")
  writeFileSync(policy, `${JSON.stringify(toolPolicy(workspace), null, 2)}\n`)
  const privateKey = join(keys, "operator-private.pem")
  const publicKey = join(keys, "operator-public.pem")
  const generated = run([
    "keygen", "--private-key", privateKey, "--public-key", publicKey
  ])
  expect(generated.status, generated.stderr).toBe(0)
  const operatorDer = createPublicKey(readFileSync(publicKey)).export({
    format: "der",
    type: "spki"
  })
  writeFileSync(
    `${binary}.operator-key.sha256`,
    `sha256:${createHash("sha256").update(operatorDer).digest("hex")}\n`
  )
  return { root, workspace, binary, policy, privateKey, publicKey }
}

const createArgs = (
  item: Fixture,
  out: string,
  options: { readonly reversed?: boolean; readonly policy?: string } = {}
): Array<string> => [
  "create",
  "--binary", item.binary,
  "--policy", options.policy ?? item.policy,
  ...(options.reversed
    ? ["--verb", "pending", "--verb", "eval", "--verb", "run"]
    : ["--verb", "run", "--verb", "eval", "--verb", "pending"]),
  "--private-key", item.privateKey,
  "--public-key", item.publicKey,
  "--out", out
]

const created = () => {
  const item = fixture()
  const bundle = join(item.root, "bundle")
  const result = run(createArgs(item, bundle))
  expect(result.status, result.stderr).toBe(0)
  return { ...item, bundle, result }
}

const grant = (bundle: string) => JSON.parse(
  readFileSync(join(bundle, "seal", "box-grant.json"), "utf8")
) as { readonly binaryDigest: string; readonly verbs: ReadonlyArray<string>; readonly policy: unknown }

describe("seal-box operator bundle tool", () => {
  it("generates Ed25519 PEM keys exclusively with private/public modes and no key output", () => {
    const root = temporary()
    const privateKey = join(root, "private.pem")
    const publicKey = join(root, "public.pem")
    const generated = run(["keygen", "--private-key", privateKey, "--public-key", publicKey])
    expect(generated.status, generated.stderr).toBe(0)
    expect(generated.stdout).not.toContain("BEGIN")
    expect(readFileSync(privateKey, "utf8")).toContain("BEGIN PRIVATE KEY")
    expect(readFileSync(publicKey, "utf8")).toContain("BEGIN PUBLIC KEY")
    expect(mode(privateKey)).toBe(0o600)
    expect([0o444, 0o644]).toContain(mode(publicKey))

    const privateBefore = readFileSync(privateKey)
    const publicBefore = readFileSync(publicKey)
    const refused = run(["keygen", "--private-key", privateKey, "--public-key", publicKey])
    expect(refused.status).toBe(73)
    expect(readFileSync(privateKey)).toEqual(privateBefore)
    expect(readFileSync(publicKey)).toEqual(publicBefore)
  })

  it("creates and verifies a self-contained bundle with exact binary bytes, the signed policy and readonly modes", () => {
    const item = created()
    const checked = run(["verify", "--bundle", item.bundle])
    expect(checked.status, checked.stderr).toBe(0)
    expect(readFileSync(join(item.bundle, "bin", "airlock"))).toEqual(readFileSync(item.binary))
    expect(readFileSync(join(item.bundle, "bin", "airlock-agent"))).toEqual(readFileSync(item.binary))
    expect(grant(item.bundle)).toMatchObject({ schemaVersion: "airlock/box-grant/v2", verbs: ["eval", "pending", "run"] })
    expect(grant(item.bundle).policy).toEqual(toolPolicy(item.workspace))
    for (const removed of ["catalog", "admission", "nativeActions", "daemonOps"])
      expect(grant(item.bundle)).not.toHaveProperty(removed)
    expect(readdirSync(join(item.bundle, "seal")).sort()).toEqual([
      "box-grant.ed25519", "box-grant.json", "operator-ed25519.pub.pem"
    ])
    expect(grant(item.bundle).binaryDigest).toBe(digest(readFileSync(item.binary)))
    expect(mode(join(item.bundle, "bin", "airlock"))).toBe(0o555)
    for (const path of [
      join(item.bundle, "seal", "box-grant.json"),
      join(item.bundle, "seal", "box-grant.ed25519"),
      join(item.bundle, "seal", "operator-ed25519.pub.pem")
    ]) expect(mode(path)).toBe(0o444)
    expect(readFileSync(join(item.bundle, "seal", "box-grant.ed25519"))).toHaveLength(64)
    expect(existsSync(join(item.bundle, "seal", "operator-private.pem"))).toBe(false)
    const files = readdirSync(item.bundle, { recursive: true, encoding: "utf8" })
    expect(files.every((name) => !/private|\.key$/i.test(name))).toBe(true)
  })

  it("fails verification for a flipped binary, a widened grant, and missing signature", () => {
    for (const corrupt of ["binary", "policy", "verbs", "signature"] as const) {
      const item = created()
      if (corrupt === "binary") {
        const path = join(item.bundle, "bin", "airlock")
        chmodSync(path, 0o755)
        writeFileSync(path, Buffer.from("flipped"))
      } else if (corrupt === "policy" || corrupt === "verbs") {
        // The grant is what the box pins: more authority under the old signature.
        const path = join(item.bundle, "seal", "box-grant.json")
        const widened = JSON.parse(readFileSync(path, "utf8")) as {
          verbs: Array<string>
          policy: { toolGrants: Array<unknown> }
        }
        if (corrupt === "policy") widened.policy.toolGrants.push({ id: "rm", tool: "file.remove", when: "now", where: {} })
        else widened.verbs.push("inspect")
        chmodSync(path, 0o644)
        writeFileSync(path, JSON.stringify(widened))
      } else {
        renameSync(
          join(item.bundle, "seal", "box-grant.ed25519"),
          join(item.bundle, "seal", "missing-signature")
        )
      }
      const rejected = run(["verify", "--bundle", item.bundle])
      expect(rejected.status, `${corrupt}: ${rejected.stderr}`).not.toBe(0)
    }
  })

  it("rejects invalid verbs, duplicates, removed and unknown options, loose policies, and private-key hazards", () => {
    const item = fixture()
    const cases: ReadonlyArray<Array<string>> = [
      [...createArgs(item, join(item.root, "bad-verb")), "--verb", "shell"],
      [...createArgs(item, join(item.root, "removed-verb")), "--verb", "serve"],
      [...createArgs(item, join(item.root, "local-verb")), "--verb", "change"],
      [...createArgs(item, join(item.root, "deciding-verb")), "--verb", "commit"],
      [...createArgs(item, join(item.root, "duplicate")), "--verb", "run"],
      [...createArgs(item, join(item.root, "native")), "--native-action", "file.read"],
      [...createArgs(item, join(item.root, "daemon")), "--daemon-op", "commit"],
      [...createArgs(item, join(item.root, "admission")), "--admission", item.policy],
      [...createArgs(item, join(item.root, "compatibility")), "--allow-sealed-compatibility"],
      [...createArgs(item, join(item.root, "unknown")), "--surprise", "yes"],
      [...createArgs(item, join(item.root, "definition")), "--definition", item.policy]
    ]
    for (const args of cases) {
      const refused = run(args)
      expect(refused.status, args.join(" ")).not.toBe(0)
      expect(existsSync(args[args.indexOf("--out") + 1]!)).toBe(false)
    }

    const loose = join(item.root, "loose-policy.json")
    writeFileSync(loose, JSON.stringify({ ...toolPolicy(item.workspace), verbs: ["commit"] }))
    const admission = join(item.root, "admission-policy.json")
    writeFileSync(admission, JSON.stringify({
      schemaVersion: "airlock/admission-policy/v2",
      profile: "native-contained",
      principal: "agent/seal-box-test",
      realm: "local",
      admittedBy: "operator/seal-box-test",
      pathAllowlist: [`${item.workspace}/**`],
      executableAllowlist: [],
      executableEdges: [],
      endpointGrants: []
    }))
    const looseGrant = join(item.root, "loose-grant.json")
    writeFileSync(looseGrant, JSON.stringify({
      ...toolPolicy(item.workspace),
      toolGrants: [{ id: "read", tool: "file.read", when: "now", escalate: true }]
    }))
    for (const policy of [loose, admission, looseGrant]) {
      const out = join(item.root, `policy-${policy.split("/").pop()}`)
      const refused = run(createArgs(item, out, { policy }))
      expect(refused.status, policy).toBe(65)
      expect(refused.stderr).toContain("--policy is not a strict ToolPolicy")
      expect(existsSync(out)).toBe(false)
    }

    chmodSync(item.privateKey, 0o644)
    expect(run(createArgs(item, join(item.root, "broad-private"))).status).not.toBe(0)
    chmodSync(item.privateKey, 0o600)
    const link = join(item.root, "private-link.pem")
    symlinkSync(item.privateKey, link)
    const linked = createArgs(item, join(item.root, "linked-private"))
    linked[linked.indexOf(item.privateKey)] = link
    expect(run(linked).status).not.toBe(0)
  })

  it("has stable grant identity and deterministic signatures across verb order and policy key order", () => {
    const item = fixture()
    const reversedPolicy = join(item.root, "reversed-policy.json")
    writeFileSync(reversedPolicy, JSON.stringify(reverseKeys(toolPolicy(item.workspace))))
    const first = join(item.root, "first")
    const second = join(item.root, "second")
    expect(run(createArgs(item, first)).status).toBe(0)
    expect(run(createArgs(item, second, { reversed: true, policy: reversedPolicy })).status).toBe(0)
    expect(readFileSync(join(second, "seal", "box-grant.json"))).toEqual(
      readFileSync(join(first, "seal", "box-grant.json"))
    )
    expect(readFileSync(join(second, "seal", "box-grant.ed25519"))).toEqual(
      readFileSync(join(first, "seal", "box-grant.ed25519"))
    )
  })

  it("installs one fresh generation wholly outside the workspace, with no daemon in it", () => {
    const item = created()
    const root = join(item.root, "system-root")
    const installed = run([
      "install", "--bundle", item.bundle, "--root", root,
      "--box", "alpha", "--workspace", item.workspace,
      "--agent-user", "airlock_agent", "--agent-uid", "502",
      "--agent-group", "airlock_agent", "--agent-gid", "502"
    ])
    expect(installed.status, installed.stderr).toBe(0)
    const output = JSON.parse(installed.stdout) as {
      readonly generation: string
      readonly agentLaunch: string
      readonly readiness: string
    }
    expect(output.generation.startsWith(`${root}/Library/Airlock/boxes/alpha/`)).toBe(true)
    expect(output.generation.startsWith(item.workspace)).toBe(false)
    expect(mode(output.generation)).toBe(0o755)
    expect(output.readiness).toBe(join(output.generation, "SEALED"))
    expect(mode(output.readiness)).toBe(0o444)
    expect(JSON.parse(readFileSync(output.readiness, "utf8"))).toEqual({
      schemaVersion: "airlock/installed-generation/v1",
      grantDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      binaryDigest: digest(readFileSync(item.binary)),
      ownershipApplied: false,
      runnable: false
    })
    expect(readFileSync(join(output.generation, "bin", "airlock"))).toEqual(readFileSync(item.binary))
    expect(readFileSync(join(output.generation, "bin", "airlock-agent"))).toEqual(readFileSync(item.binary))
    expect(output.agentLaunch).toBe(join(output.generation, "agent-launch.json"))
    expect(JSON.parse(readFileSync(output.agentLaunch, "utf8"))).toMatchObject({
      schemaVersion: "airlock/agent-launch/v1",
      executable: join(output.generation, "bin", "airlock-agent"),
      user: "airlock_agent",
      uid: 502,
      environment: { AIRLOCK_AGENT_SURFACE: "1" }
    })
    expect(readdirSync(output.generation).sort()).toEqual([
      "SEALED", "agent-launch.json", "bin", "home", "principals.json", "seal"
    ])
    expect(mode(join(output.generation, "home"))).toBe(0o700)
    for (const directory of ["hold", "outbox", "hold-locks", "outbox-locks"]) {
      expect(mode(join(output.generation, "home", directory))).toBe(0o700)
    }
    expect(mode(join(output.generation, "home", "ledger.jsonl"))).toBe(0o600)
    const principals = JSON.parse(readFileSync(join(output.generation, "principals.json"), "utf8"))
    expect(principals).toEqual({
      agent: { user: "airlock_agent", uid: 502, group: "airlock_agent", gid: 502 },
      ownershipApplied: false,
      ownershipRequired: {
        generationOwner: { uid: 0, gid: 0 },
        agentHome: { path: join(output.generation, "home"), uid: 502, gid: 502, mode: "0700" },
        note: expect.any(String)
      }
    })
  })

  it("derives production --root / as /Library/Airlock instead of rejecting filesystem root", () => {
    const source = readFileSync(script, "utf8")
    expect(source).toContain('const installRoot = join(root, "Library", "Airlock")')
    expect(source).not.toContain('fail("--root must not be the filesystem root")')
    expect(join("/", "Library", "Airlock", "boxes")).toBe("/Library/Airlock/boxes")
  })

  it("requires root for --apply-ownership and otherwise marks the artifact non-runnable", () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) return
    const item = created()
    const refused = run([
      "install", "--bundle", item.bundle,
      "--root", join(item.root, "ownership-root"),
      "--box", "owned", "--workspace", item.workspace,
      "--apply-ownership"
    ])
    expect(refused.status).toBe(77)
    expect(refused.stderr).toContain("requires root")
  })

  it("refuses unsafe paths, symlink input, a root agent, daemon options, and second install without altering the first", () => {
    const item = created()
    const root = join(item.root, "root")
    const base = [
      "install", "--bundle", item.bundle, "--root", root,
      "--box", "safe", "--workspace", item.workspace
    ]
    expect(run([...base.slice(0, 7), "../escape", ...base.slice(9)]).status).not.toBe(0)
    for (const rootAgent of [
      ["--agent-uid", "0"], ["--agent-user", "root"], ["--agent-gid", "0"], ["--agent-group", "wheel"]
    ]) expect(run([...base, ...rootAgent]).status, rootAgent.join(" ")).not.toBe(0)
    for (const daemon of [["--daemon-user", "root"], ["--daemon-uid", "0"]]) {
      expect(run([...base, ...daemon]).status, daemon.join(" ")).toBe(64)
    }
    expect(run(["install", "--bundle", item.bundle, "--root", item.workspace, "--box", "safe", "--workspace", item.workspace]).status).not.toBe(0)

    const bundleLink = join(item.root, "bundle-link")
    symlinkSync(item.bundle, bundleLink)
    expect(run(["install", "--bundle", bundleLink, "--root", root, "--box", "safe", "--workspace", item.workspace]).status).not.toBe(0)
    const rootTarget = join(item.root, "root-target")
    const rootLink = join(item.root, "root-link")
    mkdirSync(rootTarget)
    symlinkSync(rootTarget, rootLink)
    expect(run(["install", "--bundle", item.bundle, "--root", rootLink, "--box", "safe", "--workspace", item.workspace]).status).not.toBe(0)
    const workspaceLink = join(item.root, "workspace-link")
    symlinkSync(item.workspace, workspaceLink)
    expect(run(["install", "--bundle", item.bundle, "--root", root, "--box", "safe", "--workspace", workspaceLink]).status).not.toBe(0)
    expect(existsSync(join(root, "Library", "Airlock", "boxes", "safe"))).toBe(false)

    const first = run(base)
    expect(first.status, first.stderr).toBe(0)
    const generation = (JSON.parse(first.stdout) as { readonly generation: string }).generation
    const before = readFileSync(join(generation, "bin", "airlock"))
    const readinessBefore = readFileSync(join(generation, "SEALED"))
    const second = run(base)
    expect(second.status).toBe(73)
    expect(readFileSync(join(generation, "bin", "airlock"))).toEqual(before)
    expect(readFileSync(join(generation, "SEALED"))).toEqual(readinessBefore)
    expect(lstatSync(generation).isDirectory()).toBe(true)
  })
})
