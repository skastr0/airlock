import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const install = join(repository, "scripts", "install-macos.sh")
const uninstall = join(repository, "scripts", "uninstall-macos.sh")
const root = () => {
  const temporary = mkdtempSync(join(tmpdir(), "airlock-distribution-"))
  return temporary
}

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

const fixture = (temporary: string) => {
  const source = join(temporary, "airlock")
  const agentSource = join(temporary, "airlock-agent")
  const checksum = join(temporary, "airlock.sha256")
  writeFileSync(
    source,
    "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then echo airlock-test; exit 0; fi\nif [ \"${1:-}\" = \"doctor\" ]; then echo healthy; exit 0; fi\nexit 64\n"
  )
  chmodSync(source, 0o755)
  writeFileSync(
    agentSource,
    "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then echo airlock-agent-test; exit 0; fi\nexit 64\n"
  )
  chmodSync(agentSource, 0o755)
  writeFileSync(
    checksum,
    `${sha256(source)}  airlock\n${sha256(agentSource)}  airlock-agent\n`
  )
  return { source, agentSource, checksum }
}

const run = (
  script: string,
  args: Array<string>,
  temporary: string,
  environment: Record<string, string> = {}
) =>
  spawnSync("/bin/sh", [script, ...args], {
    cwd: repository,
    env: {
      ...process.env,
      AIRLOCK_TRASH_DIR: join(temporary, "trash"),
      HOME: join(temporary, "home"),
      ...environment
    },
    encoding: "utf8"
  })

describe("macOS distribution scripts", () => {
  it("installs a checksum-verified binary into an explicit temporary prefix and runs doctor", () => {
    const temporary = root()
    const { checksum, source } = fixture(temporary)
    const prefix = join(temporary, "prefix")
    const result = run(
      install,
      ["--source", source, "--checksum", checksum, "--prefix", prefix],
      temporary
    )

    expect(result.status).toBe(0)
    expect(existsSync(join(prefix, "bin", "airlock"))).toBe(true)
    expect(existsSync(join(prefix, "bin", "airlock-agent"))).toBe(true)
    expect(result.stdout).toContain("healthy")
  })

  it("refuses replacement unless it is explicit, then preserves the prior binary in Trash", () => {
    const temporary = root()
    const { checksum, source } = fixture(temporary)
    const prefix = join(temporary, "prefix")
    const target = join(prefix, "bin", "airlock")
    mkdirSync(join(prefix, "bin"), { recursive: true })
    writeFileSync(target, "prior")

    const refused = run(
      install,
      ["--source", source, "--checksum", checksum, "--prefix", prefix],
      temporary
    )
    expect(refused.status).toBe(73)
    expect(readFileSync(target, "utf8")).toBe("prior")

    const replaced = run(
      install,
      ["--source", source, "--checksum", checksum, "--prefix", prefix, "--replace"],
      temporary
    )
    expect(replaced.status).toBe(0)
    expect(readFileSync(target, "utf8")).toContain("airlock-test")
    expect(readFileSync(join(prefix, "bin", "airlock-agent"), "utf8")).toContain(
      "airlock-agent-test"
    )
    const trash = join(temporary, "trash")
    expect(existsSync(trash)).toBe(true)
  })

  it("rejects a corrupt artifact and moves an installed binary to temporary Trash on uninstall", () => {
    const temporary = root()
    const { agentSource, checksum, source } = fixture(temporary)
    const prefix = join(temporary, "prefix")
    writeFileSync(checksum, "0".repeat(64) + "  airlock\n")
    const rejected = run(
      install,
      ["--source", source, "--checksum", checksum, "--prefix", prefix],
      temporary
    )
    expect(rejected.status).toBe(65)
    expect(existsSync(join(prefix, "bin", "airlock"))).toBe(false)

    writeFileSync(
      checksum,
      `${sha256(source)}  airlock\n${sha256(agentSource)}  airlock-agent\n`
    )
    expect(
      run(install, ["--source", source, "--checksum", checksum, "--prefix", prefix], temporary)
        .status
    ).toBe(0)
    const removed = run(uninstall, ["--prefix", prefix], temporary)
    expect(removed.status).toBe(0)
    expect(existsSync(join(prefix, "bin", "airlock"))).toBe(false)
    expect(existsSync(join(prefix, "bin", "airlock-agent"))).toBe(false)
    expect(existsSync(join(temporary, "trash"))).toBe(true)
  })

  it("rejects root-equivalent prefixes before any write and does not replace either binary before both candidates probe", () => {
    const temporary = root()
    const { agentSource, checksum, source } = fixture(temporary)
    const shims = join(temporary, "shims")
    const mkdirLog = join(temporary, "mkdir.log")
    mkdirSync(shims)
    const mkdirShim = join(shims, "mkdir")
    writeFileSync(mkdirShim, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$AIRLOCK_MKDIR_LOG\"\nexit 99\n")
    chmodSync(mkdirShim, 0o755)
    const rootLink = join(temporary, "root-link")
    symlinkSync("/", rootLink)
    for (const prefix of ["/", "//", "/./", "/tmp/..", rootLink]) {
      const rejected = run(
        install,
        ["--source", source, "--checksum", checksum, "--prefix", prefix],
        temporary,
        {
          AIRLOCK_MKDIR_LOG: mkdirLog,
          PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`
        }
      )
      expect(rejected.status).toBe(64)
      const uninstallRejected = run(
        uninstall,
        ["--prefix", prefix],
        temporary,
        {
          AIRLOCK_MKDIR_LOG: mkdirLog,
          PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`
        }
      )
      expect(uninstallRejected.status).toBe(64)
    }
    expect(existsSync(mkdirLog)).toBe(false)

    writeFileSync(agentSource, "#!/bin/sh\nexit 73\n")
    chmodSync(agentSource, 0o755)
    writeFileSync(
      checksum,
      `${sha256(source)}  airlock\n${sha256(agentSource)}  airlock-agent\n`
    )
    const prefix = join(temporary, "prefix")
    const target = join(prefix, "bin", "airlock")
    const agentTarget = join(prefix, "bin", "airlock-agent")
    mkdirSync(join(prefix, "bin"), { recursive: true })
    writeFileSync(target, "prior-supervisor")
    writeFileSync(agentTarget, "prior-agent")
    const failed = run(
      install,
      ["--source", source, "--checksum", checksum, "--prefix", prefix, "--replace"],
      temporary
    )
    expect(failed.status).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("prior-supervisor")
    expect(readFileSync(agentTarget, "utf8")).toBe("prior-agent")
  })

  it("restores the byte-identical prior pair and returns failure at every install rename boundary", () => {
    for (const failAt of [1, 2, 3, 4]) {
      const temporary = root()
      const { checksum, source } = fixture(temporary)
      const prefix = join(temporary, "prefix")
      const bin = join(prefix, "bin")
      const target = join(bin, "airlock")
      const agentTarget = join(bin, "airlock-agent")
      const shims = join(temporary, "shims")
      const counter = join(temporary, "mv-count")
      mkdirSync(bin, { recursive: true })
      mkdirSync(shims)
      writeFileSync(target, `prior-supervisor-${failAt}`)
      writeFileSync(agentTarget, `prior-agent-${failAt}`)
      const moveShim = join(shims, "mv")
      writeFileSync(
        moveShim,
        "#!/bin/sh\ncount=0\nif [ -f \"$AIRLOCK_MV_COUNTER\" ]; then count=$(cat \"$AIRLOCK_MV_COUNTER\"); fi\ncount=$((count + 1))\nprintf '%s' \"$count\" > \"$AIRLOCK_MV_COUNTER\"\nif [ \"$count\" -eq \"$AIRLOCK_FAIL_MV_AT\" ]; then exit 91; fi\nexec /bin/mv \"$@\"\n"
      )
      chmodSync(moveShim, 0o755)
      const failed = run(
        install,
        ["--source", source, "--checksum", checksum, "--prefix", prefix, "--replace"],
        temporary,
        {
          AIRLOCK_FAIL_MV_AT: String(failAt),
          AIRLOCK_MV_COUNTER: counter,
          PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`
        }
      )
      expect(failed.status).toBe(75)
      expect(readFileSync(target, "utf8")).toBe(`prior-supervisor-${failAt}`)
      expect(readFileSync(agentTarget, "utf8")).toBe(`prior-agent-${failAt}`)
    }
  })
})
