import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const install = join(repository, "scripts", "install-linux.sh")
const uninstall = join(repository, "scripts", "uninstall-linux.sh")
const build = join(repository, "scripts", "build-linux.ts")
const root = () => mkdtempSync(join(tmpdir(), "airlock-linux-distribution-"))
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

const fixture = (temporary: string) => {
  const source = join(temporary, "airlock")
  const agentSource = join(temporary, "airlock-agent")
  const launcherSource = join(temporary, "airlock-linux-launcher")
  const bwrap = join(temporary, "bwrap")
  const checksum = join(temporary, "airlock.sha256")
  writeFileSync(
    source,
    '#!/bin/sh\ncase "${1:-}" in --version) echo 0.1.0;; doctor) printf \'%s\\n\' \'{"schemaVersion": "airlock/linux-capabilities/v1", "runtime": {}}\';; *) exit 64;; esac\n'
  )
  writeFileSync(agentSource, '#!/bin/sh\n[ "${1:-}" = --version ] && echo 0.1.0\n')
  writeFileSync(
    launcherSource,
    '#!/bin/sh\n[ "${1:-}" = --probe ] && echo "airlock-linux-launcher-v1 landlock-abi=10 seccomp=1"\n'
  )
  // Multi-digit major/ABI values keep the installer's minimum-version parsers
  // monotonic instead of accidentally accepting only today's number widths.
  writeFileSync(bwrap, '#!/bin/sh\n[ "${1:-}" = --version ] && echo "bubblewrap 10.1.0"\n')
  for (const path of [source, agentSource, launcherSource, bwrap]) chmodSync(path, 0o755)
  writeFileSync(
    checksum,
    [source, agentSource, launcherSource]
      .map((path) => `${sha256(path)}  ${path.split("/").at(-1)}`)
      .join("\n") + "\n"
  )
  return { source, agentSource, launcherSource, bwrap, checksum }
}

type Fixture = ReturnType<typeof fixture>
const run = (
  script: string,
  args: ReadonlyArray<string>,
  temporary: string,
  environment: Readonly<Record<string, string>> = {}
) => spawnSync("/bin/sh", [script, ...args], {
  cwd: repository,
  env: {
    ...process.env,
    HOME: join(temporary, "home"),
    ...environment
  },
  encoding: "utf8",
  timeout: 60_000
})

const installArgs = (candidate: Fixture, prefix: string) => [
  "--source", candidate.source,
  "--agent-source", candidate.agentSource,
  "--launcher-source", candidate.launcherSource,
  "--checksum", candidate.checksum,
  "--bwrap", candidate.bwrap,
  "--prefix", prefix
]

const installed = (prefix: string) => ({
  airlock: join(prefix, "bin", "airlock"),
  agent: join(prefix, "bin", "airlock-agent"),
  launcher: join(prefix, "libexec", "airlock", "airlock-linux-launcher")
})

describe.skipIf(process.platform !== "linux")("Linux distribution", () => {
  it("installs and uninstalls the verified three-artifact unit", () => {
    const temporary = root()
    const candidate = fixture(temporary)
    const prefix = join(temporary, "prefix")
    const result = run(install, installArgs(candidate, prefix), temporary)
    expect(result.status, result.stderr).toBe(0)
    expect(Object.values(installed(prefix)).every(existsSync)).toBe(true)

    const removed = run(uninstall, ["--prefix", prefix], temporary)
    expect(removed.status, removed.stderr).toBe(0)
    expect(Object.values(installed(prefix)).some(existsSync)).toBe(false)
    expect(removed.stdout).toContain("replaced/uninstall.")
  })

  it("rejects corrupt, old, privileged, and root-aliased inputs before displacement", () => {
    for (const mode of ["checksum", "old-bwrap", "setid-bwrap"] as const) {
      const temporary = root()
      const candidate = fixture(temporary)
      const prefix = join(temporary, "prefix")
      mkdirSync(join(prefix, "bin"), { recursive: true })
      const prior = join(prefix, "bin", "airlock")
      writeFileSync(prior, "prior")
      if (mode === "checksum") writeFileSync(candidate.checksum, `${"0".repeat(64)}  airlock\n`)
      if (mode === "old-bwrap") {
        writeFileSync(candidate.bwrap, '#!/bin/sh\necho "bubblewrap 0.11.0"\n')
        chmodSync(candidate.bwrap, 0o755)
      }
      if (mode === "setid-bwrap") {
        const changed = spawnSync("/bin/chmod", ["4755", candidate.bwrap])
        expect(changed.status).toBe(0)
      }
      const result = run(
        install,
        [...installArgs(candidate, prefix), "--replace"],
        temporary
      )
      expect(result.status, `${mode}: ${result.stderr}\n${result.stdout}`).not.toBe(0)
      expect(readFileSync(prior, "utf8")).toBe("prior")
    }

    const temporary = root()
    const candidate = fixture(temporary)
    const alias = join(temporary, "root")
    symlinkSync("/", alias)
    const result = run(install, installArgs(candidate, alias), temporary)
    expect(result.status).toBe(64)
  })

  it("restores all prior bytes after each install rename boundary", { timeout: 30_000 }, () => {
    for (const failAt of [1, 2, 3, 4, 5, 6]) {
      const temporary = root()
      const candidate = fixture(temporary)
      const prefix = join(temporary, "prefix")
      const targets = installed(prefix)
      mkdirSync(join(prefix, "bin"), { recursive: true })
      mkdirSync(join(prefix, "libexec", "airlock"), { recursive: true })
      writeFileSync(targets.airlock, `prior-airlock-${failAt}`)
      writeFileSync(targets.agent, `prior-agent-${failAt}`)
      writeFileSync(targets.launcher, `prior-launcher-${failAt}`)
      const shims = join(temporary, "shims")
      const counter = join(temporary, "mv-count")
      mkdirSync(shims)
      writeFileSync(
        join(shims, "mv"),
        '#!/bin/sh\ncount=0\n[ ! -f "$AIRLOCK_MV_COUNTER" ] || count=$(cat "$AIRLOCK_MV_COUNTER")\ncount=$((count + 1))\nprintf %s "$count" > "$AIRLOCK_MV_COUNTER"\n[ "$count" -ne "$AIRLOCK_FAIL_MV_AT" ] || exit 91\nexec /bin/mv "$@"\n'
      )
      chmodSync(join(shims, "mv"), 0o755)
      const result = run(
        install,
        [...installArgs(candidate, prefix), "--replace"],
        temporary,
        {
          AIRLOCK_FAIL_MV_AT: String(failAt),
          AIRLOCK_MV_COUNTER: counter,
          PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`
        }
      )
      expect(result.status).toBe(75)
      expect(readFileSync(targets.airlock, "utf8")).toBe(`prior-airlock-${failAt}`)
      expect(readFileSync(targets.agent, "utf8")).toBe(`prior-agent-${failAt}`)
      expect(readFileSync(targets.launcher, "utf8")).toBe(`prior-launcher-${failAt}`)
    }
  })

  it("restores the installed unit when uninstall displacement fails", () => {
    const temporary = root()
    const candidate = fixture(temporary)
    const prefix = join(temporary, "prefix")
    expect(run(install, installArgs(candidate, prefix), temporary).status).toBe(0)
    const targets = installed(prefix)
    const before = Object.fromEntries(
      Object.entries(targets).map(([name, path]) => [name, readFileSync(path)])
    )
    const shims = join(temporary, "shims")
    const counter = join(temporary, "mv-count")
    mkdirSync(shims)
    writeFileSync(
      join(shims, "mv"),
      '#!/bin/sh\ncount=0\n[ ! -f "$AIRLOCK_MV_COUNTER" ] || count=$(cat "$AIRLOCK_MV_COUNTER")\ncount=$((count + 1))\nprintf %s "$count" > "$AIRLOCK_MV_COUNTER"\n[ "$count" -ne 2 ] || exit 91\nexec /bin/mv "$@"\n'
    )
    chmodSync(join(shims, "mv"), 0o755)
    const result = run(uninstall, ["--prefix", prefix], temporary, {
      AIRLOCK_MV_COUNTER: counter,
      PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`
    })
    expect(result.status).toBe(75)
    for (const [name, path] of Object.entries(targets)) {
      expect(readFileSync(path)).toEqual(before[name])
    }
  })

  it("builds, installs, discovers, and executes the real standalone native unit", { timeout: 120_000 }, () => {
    const temporary = root()
    const out = join(temporary, "dist")
    const built = spawnSync("bun", [build, "--out", out], {
      cwd: repository,
      env: process.env,
      encoding: "utf8",
      timeout: 60_000
    })
    expect(built.status, built.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(join(out, "airlock.manifest.json"), "utf8"))
    expect(manifest).toMatchObject({
      schema_version: 1,
      platform: "linux",
      architecture: process.arch,
      executables: [
        { name: "airlock" },
        { name: "airlock-agent" },
        { name: "airlock-linux-launcher" }
      ],
      build_probe: { seccomp: true }
    })
    const secondBuild = spawnSync("bun", [build, "--out", out], {
      cwd: repository,
      encoding: "utf8"
    })
    expect(secondBuild.status).not.toBe(0)

    const bwrap = existsSync("/usr/local/bin/bwrap")
      ? "/usr/local/bin/bwrap"
      : "/usr/bin/bwrap"
    const prefix = join(temporary, "prefix")
    const installedResult = run(install, [
      "--source", join(out, "airlock"),
      "--agent-source", join(out, "airlock-agent"),
      "--launcher-source", join(out, "airlock-linux-launcher"),
      "--checksum", join(out, "airlock.sha256"),
      "--bwrap", bwrap,
      "--prefix", prefix
    ], temporary)
    expect(installedResult.status, installedResult.stderr).toBe(0)

    const workspace = join(temporary, "workspace")
    const home = join(temporary, "airlock-home")
    const policy = join(temporary, "policy.json")
    const program = join(temporary, "program.air")
    mkdirSync(workspace)
    writeFileSync(
      program,
      'return process.run({ executable: "/usr/bin/touch", args: ["installed.txt"], cwd: workspace, cellProfile: "native-contained", stdout: "capture", stderr: "capture" })\n'
    )
    writeFileSync(policy, JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: "agent:linux-distribution",
      realm: "local",
      admittedBy: "operator:linux-distribution",
      pathAllowlist: [`${workspace}/**`],
      executableAllowlist: ["/usr/bin/touch"],
      endpointAllowlist: []
    }))
    const executed = spawnSync(installed(prefix).airlock, [
      "run", program, "--workspace", workspace, "--profile", "native-contained"
    ], {
      env: {
        ...process.env,
        AIRLOCK_BWRAP: bwrap,
        AIRLOCK_HOME: home,
        AIRLOCK_POLICY_FILE: policy
      },
      encoding: "utf8",
      timeout: 30_000
    })
    expect(executed.status, `${executed.stderr}\n${executed.stdout}`).toBe(0)
    expect(JSON.parse(executed.stdout)).toMatchObject({
      profile: "native-contained",
      result: { state: "succeeded" }
    })
    expect(existsSync(join(workspace, "installed.txt"))).toBe(true)
    expect(run(uninstall, ["--prefix", prefix], temporary).status).toBe(0)
    expect(readdirSync(join(prefix, "bin")).filter((name) => !name.startsWith("."))).toEqual([])
  })
})
