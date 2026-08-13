import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PhysicalPathSelectorBindingFailed,
  bindPhysicalPathSelector
} from "../src/native/index.ts"

const effect = (workspace: string, selector: string) =>
  bindPhysicalPathSelector(workspace, selector).pipe(
    Effect.provide(BunContext.layer)
  )

const run = (workspace: string, selector: string) =>
  Effect.runPromise(effect(workspace, selector))

describe("physical path selector binding", () => {
  it("binds relative selectors and a deep missing suffix from the longest existing prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-selector-"))
    const workspace = join(root, "workspace")
    mkdirSync(join(workspace, "existing"), { recursive: true })

    expect(await run(workspace, "existing/value.txt")).toBe(
      join(realpathSync(workspace), "existing", "value.txt")
    )
    expect(await run(workspace, "future/deep/value.txt")).toBe(
      join(realpathSync(workspace), "future", "deep", "value.txt")
    )
  })

  it.skipIf(process.platform !== "darwin")(
    "canonicalizes the macOS /tmp alias",
    async () => {
      const root = mkdtempSync("/tmp/airlock-selector-tmp-")
      const workspace = join(root, "workspace")
      mkdirSync(workspace)
      expect(await run(workspace, join(workspace, "new.txt"))).toBe(
        join(realpathSync(workspace), "new.txt")
      )
      expect(realpathSync(workspace).startsWith("/private/tmp/")).toBe(true)
    }
  )

  it("refuses an existing selected symlink instead of retargeting the request", async () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-selector-link-"))
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    writeFileSync(join(workspace, "target.txt"), "keep")
    symlinkSync("target.txt", join(workspace, "link.txt"))

    const failure = await Effect.runPromise(
      effect(workspace, "link.txt").pipe(Effect.flip)
    )
    expect(failure).toMatchObject({
      _tag: "PhysicalPathSelectorBindingFailed",
      operation: "inspect-selector"
    } satisfies Partial<PhysicalPathSelectorBindingFailed>)

  })

  it("does not climb on a non-directory prefix failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "airlock-selector-file-"))
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    writeFileSync(join(workspace, "file"), "not a directory")

    const failure = await Effect.runPromise(
      effect(workspace, "file/child").pipe(Effect.flip)
    )
    expect(failure).toMatchObject({
      _tag: "PhysicalPathSelectorBindingFailed"
    })
  })
})
