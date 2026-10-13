import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Result } from "effect"
import { join } from "node:path"
import type { ToolHost } from "@skastr0/airlock"
import { filesystemHost } from "../src/host/FilesystemHost.ts"

const recovery = {
  prepare: () => Effect.die("unused"),
  inspect: () => Effect.die("unused"),
  restore: () => Effect.die("unused")
}

const withHost = <Value, Error>(body: (host: ToolHost, fs: FileSystem.FileSystem, workspace: string) => Effect.Effect<Value, Error>) =>
  Effect.scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspace = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
    const host = yield* filesystemHost({ workspace, confiningProfiles: [], recovery })
    return yield* body(host, fs, workspace)
  })).pipe(Effect.provide(BunServices.layer))

describe("security: local resource authority", () => {
  it.effect("never promotes an executable descendant into another descendant's root", () =>
    withHost((host, fs, workspace) => Effect.gen(function* () {
      for (const name of ["root", "child", "grandchild"]) yield* fs.writeFileString(join(workspace, name), "fixture")
      const root = yield* host.resources.bind({ kind: "executable", selector: join(workspace, "root"), rights: ["invoke"], field: "executable" })
      const child = yield* host.resources.bind({ kind: "executable", selector: join(workspace, "child"), rights: ["execute"], field: "children", index: 0, parent: root })
      const promoted = yield* host.resources.bind({ kind: "executable", selector: join(workspace, "grandchild"), rights: ["execute"], field: "children", index: 1, parent: child }).pipe(Effect.result)
      expect(Result.isFailure(promoted)).toBe(true)
      const sibling = yield* host.resources.bind({ kind: "executable", selector: join(workspace, "grandchild"), rights: ["execute"], field: "children", index: 1, parent: root })
      expect(sibling.binding.rights).toEqual(["execute"])
    }))
  )

  it.effect("keeps admitted path evidence immutable across later use and rebinding", () =>
    withHost((host, fs, workspace) => Effect.gen(function* () {
      yield* fs.writeFileString(join(workspace, "original"), "fixture")
      const bound = yield* host.resources.bind({ kind: "path", selector: "original", rights: ["read"], field: "path" })
      const original = JSON.parse(JSON.stringify(bound.binding))
      expect(Reflect.set(bound.binding, "selector", join(workspace, "other"))).toBe(false)
      expect(Reflect.set(bound.binding.rights, 0, "write")).toBe(false)
      expect(typeof bound.binding.identity).toBe("object")
      if (typeof bound.binding.identity === "object" && bound.binding.identity !== null) {
        expect(Reflect.set(bound.binding.identity, "inode", -1)).toBe(false)
      }
      expect(bound.binding).toEqual(original)
      expect((yield* host.resources.rebind({ binding: bound.binding })).binding).toEqual(original)

      const absent = yield* host.resources.bind({ kind: "path", selector: "new/deep/file", rights: ["write"], field: "path" })
      if (typeof absent.binding.identity === "object" && absent.binding.identity !== null) {
        const parent = Object.getOwnPropertyDescriptor(absent.binding.identity, "parent")?.value
        expect(parent).toBeDefined()
        expect(Reflect.set(parent, "inode", -1)).toBe(false)
      }
      expect((yield* host.resources.rebind({ binding: absent.binding })).binding).toEqual(absent.binding)
    }))
  )
})
