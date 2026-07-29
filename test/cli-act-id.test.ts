import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")

describe("supervisor CLI act identifiers", () => {
  it("rejects a traversal-shaped undo id at the typed input boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-cli-act-id-"))
    const home = join(root, "home")
    const sentinel = join(root, "outside.txt")
    writeFileSync(sentinel, "outside remains untouched")

    const result = spawnSync(
      "bun",
      ["src/cli.ts", "undo", "../outside.txt"],
      {
        cwd: repository,
        env: { ...process.env, AIRLOCK_HOME: home },
        encoding: "utf8",
        timeout: 30_000
      }
    )

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toMatchObject({
      _tag: "CliInputError",
      field: "act-id"
    })
    expect(readFileSync(sentinel, "utf8")).toBe("outside remains untouched")
  })
})
