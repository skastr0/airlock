import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = dirname(fileURLToPath(new URL("../package.json", import.meta.url)))

describe("CLI composition root", () => {
  it("constructs the agent surface with Hold available to NativeFileSystem", () => {
    const home = mkdtempSync(join(tmpdir(), "airlock-cli-composition-"))
    try {
      const result = spawnSync(
        "bun",
        ["src/agent-cli.ts", "actions"],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            AIRLOCK_HOME: home
          },
          timeout: 30_000
        }
      )

      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout) as {
        readonly schemaVersion: string
        readonly actions: ReadonlyArray<{ readonly name: string }>
      }
      expect(report.schemaVersion).toBe("airlock/actions/v1")
      expect(report.actions.map((action) => action.name)).toContain(
        "file.read"
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
