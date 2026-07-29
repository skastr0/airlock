import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")

describe("CLI failure finalization", () => {
  it("reports failure without bypassing an enclosing Effect scope finalizer", () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-cli-finalizer-"))
    const home = join(root, "home")
    const marker = join(root, "released.txt")
    const preload = join(root, "preload.ts")

    writeFileSync(
      preload,
      `
        import { Effect, Layer, ManagedRuntime } from "effect"
        import { writeFileSync } from "node:fs"

        const runtime = ManagedRuntime.make(
          Layer.scopedDiscard(
            Effect.acquireRelease(
              Effect.void,
              () => Effect.sync(() => {
                writeFileSync(${JSON.stringify(marker)}, "released")
              })
            )
          )
        )

        await runtime.runPromise(Effect.void)
        process.once("beforeExit", () => {
          void runtime.dispose()
        })
      `
    )

    const result = spawnSync(
      "bun",
      [
        "--preload",
        preload,
        "src/cli.ts",
        "undo",
        "../invalid-act-id"
      ],
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
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, "utf8")).toBe("released")
  })
})
