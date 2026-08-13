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
import { dirname, join, resolve } from "node:path"
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

const admission = (workspace: string, profile: "native-contained" | "compatibility" = "native-contained") => ({
  schemaVersion: "airlock/admission-policy/v1",
  profile,
  principal: "agent/seal-box-test",
  realm: "local",
  admittedBy: "operator/seal-box-test",
  pathAllowlist: [`${workspace}/**`],
  executableAllowlist: ["/bin/sh"],
  endpointAllowlist: []
})

const definition = (id = "vendor.echo") => Buffer.from(`${JSON.stringify({
  schemaVersion: "airlock/tool-definition/v1",
  id,
  version: "1.0.0",
  executables: [{ realm: "local", selector: "/bin/echo" }],
  actions: [{
    name: "check",
    inputSchema: { type: "object" },
    args: [],
    cwd: { _tag: "Literal", value: "/tmp" },
    lowering: "invoke",
    effectFootprint: ["invoke"],
    resultDecoder: "exit-status"
  }]
})}\n`)

type Fixture = {
  readonly root: string
  readonly workspace: string
  readonly binary: string
  readonly admission: string
  readonly definition: string
  readonly privateKey: string
  readonly publicKey: string
}

const fixture = (profile: "native-contained" | "compatibility" = "native-contained"): Fixture => {
  const root = temporary()
  const workspace = join(root, "workspace")
  const keys = join(root, "keys")
  mkdirSync(workspace)
  mkdirSync(keys)
  const binary = join(root, "airlock-fixture")
  const binaryBytes = Buffer.from("#!/bin/sh\necho sealed-fixture\n")
  writeFileSync(binary, binaryBytes)
  chmodSync(binary, 0o755)
  const policy = join(root, "admission.json")
  writeFileSync(policy, `${JSON.stringify(admission(workspace, profile), null, 2)}\n`)
  const definitionPath = join(root, "echo.json")
  writeFileSync(definitionPath, definition())
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
  return {
    root,
    workspace,
    binary,
    admission: policy,
    definition: definitionPath,
    privateKey,
    publicKey
  }
}

const createArgs = (
  item: Fixture,
  out: string,
  options: { readonly compatibility?: boolean; readonly reversed?: boolean } = {}
): Array<string> => [
  "create",
  "--binary", item.binary,
  "--admission", item.admission,
  ...(options.reversed
    ? ["--verb", "actions", "--verb", "run", "--native-action", "process.run", "--native-action", "file.read", "--daemon-op", "reap", "--daemon-op", "commit"]
    : ["--verb", "run", "--verb", "actions", "--native-action", "file.read", "--native-action", "process.run", "--daemon-op", "commit", "--daemon-op", "reap"]),
  "--definition", item.definition,
  "--private-key", item.privateKey,
  "--public-key", item.publicKey,
  "--out", out,
  ...(options.compatibility ? ["--allow-sealed-compatibility"] : [])
]

const created = (
  profile: "native-contained" | "compatibility" = "native-contained",
  options: { readonly compatibility?: boolean; readonly reversed?: boolean } = {}
) => {
  const item = fixture(profile)
  const bundle = join(item.root, "bundle")
  const result = run(createArgs(item, bundle, options))
  expect(result.status, result.stderr).toBe(0)
  return { ...item, bundle, result }
}

const grant = (bundle: string) => JSON.parse(
  readFileSync(join(bundle, "seal", "box-grant.json"), "utf8")
) as { readonly binaryDigest: string; readonly catalog: ReadonlyArray<{ readonly sha256: string }> }

const catalogPath = (bundle: string) => {
  const pin = grant(bundle).catalog[0]!
  return join(bundle, "seal", "catalog", `sha256-${pin.sha256.slice(7)}.airlock-tool.json`)
}

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

  it("creates and verifies a self-contained bundle with exact binary/catalog bytes and readonly modes", () => {
    const item = created()
    const checked = run(["verify", "--bundle", item.bundle])
    expect(checked.status, checked.stderr).toBe(0)
    expect(readFileSync(join(item.bundle, "bin", "airlock"))).toEqual(readFileSync(item.binary))
    expect(readFileSync(join(item.bundle, "bin", "airlock-agent"))).toEqual(readFileSync(item.binary))
    expect(readFileSync(catalogPath(item.bundle))).toEqual(readFileSync(item.definition))
    expect(grant(item.bundle).binaryDigest).toBe(digest(readFileSync(item.binary)))
    expect(mode(join(item.bundle, "bin", "airlock"))).toBe(0o555)
    for (const path of [
      join(item.bundle, "seal", "box-grant.json"),
      join(item.bundle, "seal", "box-grant.ed25519"),
      join(item.bundle, "seal", "operator-ed25519.pub.pem"),
      catalogPath(item.bundle)
    ]) expect(mode(path)).toBe(0o444)
    expect(readFileSync(join(item.bundle, "seal", "box-grant.ed25519"))).toHaveLength(64)
    expect(existsSync(join(item.bundle, "seal", "operator-private.pem"))).toBe(false)
    const files = readdirSync(item.bundle, { recursive: true, encoding: "utf8" })
    expect(files.every((name) => !/private|\.key$/i.test(name))).toBe(true)
  })

  it("fails verification for a flipped binary, flipped definition, and missing signature", () => {
    for (const corrupt of ["binary", "definition", "signature"] as const) {
      const item = created()
      if (corrupt === "binary") {
        const path = join(item.bundle, "bin", "airlock")
        chmodSync(path, 0o755)
        writeFileSync(path, Buffer.from("flipped"))
      } else if (corrupt === "definition") {
        const path = catalogPath(item.bundle)
        chmodSync(path, 0o644)
        writeFileSync(path, definition("vendor.flipped"))
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

  it("rejects invalid literals, duplicates, unknown options, and private-key hazards", () => {
    const item = fixture()
    const cases: ReadonlyArray<Array<string>> = [
      [...createArgs(item, join(item.root, "bad-verb")), "--verb", "shell"],
      [...createArgs(item, join(item.root, "bad-native")), "--native-action", "plugin.run"],
      [...createArgs(item, join(item.root, "bad-daemon")), "--daemon-op", "dispatch"],
      [...createArgs(item, join(item.root, "duplicate")), "--verb", "run"],
      [...createArgs(item, join(item.root, "unknown")), "--surprise", "yes"]
    ]
    for (const args of cases) expect(run(args).status).not.toBe(0)

    chmodSync(item.privateKey, 0o644)
    expect(run(createArgs(item, join(item.root, "broad-private"))).status).not.toBe(0)
    chmodSync(item.privateKey, 0o600)
    const link = join(item.root, "private-link.pem")
    symlinkSync(item.privateKey, link)
    const linked = createArgs(item, join(item.root, "linked-private"))
    linked[linked.indexOf(item.privateKey)] = link
    expect(run(linked).status).not.toBe(0)
  })

  it("requires a loud compatibility flag", () => {
    const item = fixture("compatibility")
    const refused = run(createArgs(item, join(item.root, "refused")))
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain("--allow-sealed-compatibility")
    const allowed = run(createArgs(item, join(item.root, "allowed"), { compatibility: true }))
    expect(allowed.status, allowed.stderr).toBe(0)
  })

  it("has stable grant identity and deterministic signatures across repeated-option order", () => {
    const item = fixture()
    const first = join(item.root, "first")
    const second = join(item.root, "second")
    expect(run(createArgs(item, first)).status).toBe(0)
    expect(run(createArgs(item, second, { reversed: true })).status).toBe(0)
    expect(readFileSync(join(second, "seal", "box-grant.json"))).toEqual(
      readFileSync(join(first, "seal", "box-grant.json"))
    )
    expect(readFileSync(join(second, "seal", "box-grant.ed25519"))).toEqual(
      readFileSync(join(first, "seal", "box-grant.ed25519"))
    )
  })

  it("installs one fresh generation and launchd plist wholly outside the workspace", () => {
    const item = created()
    const root = join(item.root, "system-root")
    const installed = run([
      "install", "--bundle", item.bundle, "--root", root,
      "--box", "alpha", "--workspace", item.workspace,
      "--daemon-user", "airlockd", "--daemon-uid", "501",
      "--daemon-group", "airlockd", "--daemon-gid", "501",
      "--agent-user", "airlock_agent", "--agent-uid", "502",
      "--agent-group", "airlock_agent", "--agent-gid", "502"
    ])
    expect(installed.status, installed.stderr).toBe(0)
    const output = JSON.parse(installed.stdout) as {
      readonly generation: string
      readonly launchd: string
      readonly readiness: string
    }
    expect(output.generation.startsWith(`${root}/Library/Airlock/boxes/alpha/`)).toBe(true)
    expect(output.generation.startsWith(item.workspace)).toBe(false)
    expect(mode(output.generation)).toBe(0o755)
    expect(output.readiness).toBe(join(output.generation, "SEALED"))
    expect(mode(output.readiness)).toBe(0o444)
    expect(JSON.parse(readFileSync(output.readiness, "utf8"))).toMatchObject({
      schemaVersion: "airlock/installed-generation/v1",
      ownershipApplied: false,
      runnable: false,
      activated: false
    })
    expect(readFileSync(join(output.generation, "bin", "airlock"))).toEqual(readFileSync(item.binary))
    expect(readFileSync(join(output.generation, "bin", "airlock-agent"))).toEqual(readFileSync(item.binary))
    expect(JSON.parse(readFileSync(
      join(output.generation, "launchd", "com.airlock.box.alpha.agent.json"),
      "utf8"
    ))).toMatchObject({
      schemaVersion: "airlock/agent-launch/v1",
      executable: join(output.generation, "bin", "airlock-agent"),
      user: "airlock_agent",
      environment: { AIRLOCK_AGENT_SURFACE: "1" }
    })
    expect(mode(join(output.generation, "home"))).toBe(0o700)
    for (const directory of ["hold", "outbox", "hold-locks", "outbox-locks", "runs"]) {
      expect(mode(join(output.generation, "home", directory))).toBe(0o700)
    }
    expect(mode(join(output.generation, "home", "ledger.jsonl"))).toBe(0o600)
    expect(mode(join(output.generation, "run"))).toBe(0o2750)
    const principals = JSON.parse(readFileSync(join(output.generation, "principals.json"), "utf8"))
    expect(principals).toMatchObject({
      ownershipApplied: false,
      ownershipRequired: {
        agentHome: { mode: "0700" },
        run: { mode: "02750" },
        ipc: { mode: "02750" }
      },
      ipc: { sharedGroup: "airlock_agent" }
    })
    const plist = readFileSync(output.launchd, "utf8")
    expect(plist).toContain(`<string>${join(output.generation, "bin", "airlock")}</string>`)
    expect(plist).toContain("<string>serve</string>")
    expect(plist).toContain(`<string>${join(output.generation, "seal")}</string>`)
    expect(plist).toContain(`<string>${join(output.generation, "home")}</string>`)
    expect(plist).toContain(`<string>${join(output.generation, "ipc")}</string>`)
    expect(plist).toContain("<key>AIRLOCK_AGENT_USER</key>\n    <string>airlock_agent</string>")
    expect(plist).toContain("<key>UserName</key>\n  <string>airlockd</string>")
    expect(plist).toContain("<key>GroupName</key>\n  <string>airlockd</string>")
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>")
    if (process.platform === "darwin") {
      const lint = spawnSync("plutil", ["-lint", output.launchd], { encoding: "utf8" })
      expect(lint.status, lint.stderr).toBe(0)
    }
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

  it("refuses unsafe paths, symlink input, equal principals, and second install without altering the first", () => {
    const item = created()
    const root = join(item.root, "root")
    const base = [
      "install", "--bundle", item.bundle, "--root", root,
      "--box", "safe", "--workspace", item.workspace
    ]
    expect(run([...base.slice(0, 7), "../escape", ...base.slice(9)]).status).not.toBe(0)
    expect(run([...base, "--daemon-uid", "700", "--agent-uid", "700"]).status).not.toBe(0)
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
