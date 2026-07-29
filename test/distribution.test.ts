import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  const checksum = join(temporary, "airlock.sha256")
  writeFileSync(
    source,
    "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then echo airlock-test; exit 0; fi\nif [ \"${1:-}\" = \"doctor\" ]; then echo healthy; exit 0; fi\nexit 64\n"
  )
  chmodSync(source, 0o755)
  writeFileSync(checksum, `${sha256(source)}  airlock\n`)
  return { source, checksum }
}

const run = (script: string, args: Array<string>, temporary: string) =>
  spawnSync("/bin/sh", [script, ...args], {
    cwd: repository,
    env: {
      ...process.env,
      AIRLOCK_TRASH_DIR: join(temporary, "trash"),
      HOME: join(temporary, "home")
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
    const trash = join(temporary, "trash")
    expect(existsSync(trash)).toBe(true)
  })

  it("rejects a corrupt artifact and moves an installed binary to temporary Trash on uninstall", () => {
    const temporary = root()
    const { checksum, source } = fixture(temporary)
    const prefix = join(temporary, "prefix")
    writeFileSync(checksum, "0".repeat(64) + "  airlock\n")
    const rejected = run(
      install,
      ["--source", source, "--checksum", checksum, "--prefix", prefix],
      temporary
    )
    expect(rejected.status).toBe(65)
    expect(existsSync(join(prefix, "bin", "airlock"))).toBe(false)

    writeFileSync(checksum, `${sha256(source)}  airlock\n`)
    expect(
      run(install, ["--source", source, "--checksum", checksum, "--prefix", prefix], temporary)
        .status
    ).toBe(0)
    const removed = run(uninstall, ["--prefix", prefix], temporary)
    expect(removed.status).toBe(0)
    expect(existsSync(join(prefix, "bin", "airlock"))).toBe(false)
    expect(existsSync(join(temporary, "trash"))).toBe(true)
  })
})
