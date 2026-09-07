import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { bindTarget, hash, limits, scan, snapshot } from "../src/change/Tree.ts"

const world = async (body: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "change-tree-")))
  try { await body(root) } finally { await rm(root, { recursive: true, force: true }) }
}

describe("regular-tree/v1", () => {
  it("canonical digest binds bytes, kind, name and ordinary mode, not inode/time/directory size", () => world(async root => {
    const source = path.join(root, "source"), copy = path.join(root, "copy")
    await mkdir(source)
    await writeFile(path.join(source, "binary"), Buffer.from([0, 255, 1]))
    await chmod(path.join(source, "binary"), 0o640)
    const original = await snapshot(source, copy)
    const independent = await scan(copy)
    expect(independent.identity.inode).not.toBe(original.identity.inode)
    expect(independent.tree.digest).toBe(original.tree.digest)
    expect(independent.tree.entries[1]!.digest).toBe(hash(Buffer.from([0, 255, 1])))
    await utimes(copy, 1, 2)
    expect((await scan(copy)).tree.digest).toBe(original.tree.digest)
    await rename(path.join(copy, "binary"), path.join(copy, "other"))
    expect((await scan(copy)).tree.digest).not.toBe(original.tree.digest)
    await rename(path.join(copy, "other"), path.join(copy, "binary"))
    await chmod(path.join(copy, "binary"), 0o600)
    expect((await scan(copy)).tree.digest).not.toBe(original.tree.digest)
    await chmod(path.join(copy, "binary"), 0o640)
    await writeFile(path.join(copy, "binary"), Buffer.from([0, 254, 1]))
    expect((await scan(copy)).tree.digest).not.toBe(original.tree.digest)
    expect(await readFile(path.join(source, "binary"))).toEqual(Buffer.from([0, 255, 1]))
  }))

  it("rejects links, hardlinks and unsupported modes", () => world(async root => {
    const file = path.join(root, "file")
    await writeFile(file, "x")
    await symlink(file, path.join(root, "sym"))
    await expect(scan(path.join(root, "sym"))).rejects.toThrow("symlink")
    await expect(scan(root)).rejects.toThrow()
    await link(file, path.join(root, "hard"))
    await expect(scan(file)).rejects.toThrow("hardlink")
    const special = path.join(root, "special")
    await writeFile(special, "x")
    // Bun's chmod currently masks special bits; use the OS utility to create
    // the adversarial input rather than silently testing ordinary 0600.
    execFileSync("chmod", ["4600", special])
    await expect(scan(special)).rejects.toThrow("mode")
  }))

  it("bounds bytes, reserved snapshot bytes, entries and depth", () => world(async root => {
    const file = path.join(root, "file")
    await writeFile(file, "123")
    await expect(snapshot(file, path.join(root, "copy"), 2)).rejects.toThrow("byte limit")
    await truncate(file, limits.bytes + 1)
    await expect(scan(file)).rejects.toThrow("byte limit")
    const deep = path.join(root, "deep")
    await mkdir(deep)
    let cursor = deep
    for (let i = 0; i <= limits.depth; i++) { cursor = path.join(cursor, "d"); await mkdir(cursor) }
    await expect(scan(deep)).rejects.toThrow("depth")
    const wide = path.join(root, "wide")
    await mkdir(wide)
    await Promise.all(Array.from({ length: limits.entries }, (_, i) => writeFile(path.join(wide, String(i)), "")))
    await expect(scan(wide)).rejects.toThrow("entry limit")
  }))

  it("requires existing non-symlink parent and rejects home overlap both directions", () => world(async root => {
    const home = path.join(root, "home")
    await mkdir(home)
    await expect(bindTarget(path.join(root, "missing", "file"), home)).rejects.toThrow()
    await expect(bindTarget(path.join(home, "file"), home)).rejects.toThrow("overlaps")
    await expect(bindTarget(root, home)).rejects.toThrow("overlaps")
    await symlink(root, path.join(root, "alias"))
    await expect(bindTarget(path.join(root, "alias", "file"), home)).rejects.toThrow("symlink")
    await expect(bindTarget(`${root}/alias/../file`, home)).rejects.toThrow("symlink")
  }))

  it.skipIf(process.platform !== "linux")("rejects mounted trees before traversing them", async () => {
    await expect(scan("/proc")).rejects.toThrow("mount topology")
  })
})
