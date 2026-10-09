import { Effect, FileSystem, Path, Result } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import type { BoundResource, ToolHost } from "../src/core/contract/ToolHost.ts"
import { localToolHost } from "../src/host/LocalToolHost.ts"
import { FileRead, FileWrite, HttpGet, HttpStage, ProcessRun } from "../src/native/index.ts"

const neverRecovers = {
  prepare: () => Effect.die("unused"),
  inspect: () => Effect.die("unused"),
  restore: () => Effect.die("unused")
}

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly workspace: string
  readonly outside: string
  readonly host: ToolHost
}) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // The temp directory is reached through a symlink on macOS; the
      // physical spelling is what a binding must carry.
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const workspace = path.join(root, "workspace")
      const outside = path.join(root, "outside")
      yield* fs.makeDirectory(workspace)
      yield* fs.makeDirectory(outside)
      const host = yield* localToolHost({ workspace, confiningProfiles: ["native-contained"], recovery: neverRecovers })
      return yield* body({ fs, path, workspace, outside, host })
    })
  ).pipe(Effect.provide(BunServices.layer))

describe("local tool host — paths", () => {
  it.effect("binds a path to the physical object, whatever spelling named it", () =>
    world(({ fs, path, workspace, host }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(workspace, "note.txt"), "x")
        yield* fs.symlink(workspace, path.join(workspace, "..", "alias"))
        const { resources } = host
        const direct = yield* resources.bind({ kind: "path", selector: "note.txt", rights: ["read"], field: "path" })
        const dotted = yield* resources.bind({ kind: "path", selector: "./sub/../note.txt", rights: ["read"], field: "path" })
        const aliased = yield* resources.bind({
          kind: "path", selector: path.join(workspace, "..", "alias", "note.txt"), rights: ["read"], field: "path"
        })
        expect(direct.binding.selector).toBe(path.join(workspace, "note.txt"))
        expect(dotted.binding).toEqual(direct.binding)
        expect(aliased.binding).toEqual(direct.binding)
        expect(direct.binding.identity).toMatchObject({ kind: "file", inode: expect.any(Number) })
      })
    )
  )

  it.effect("keeps a call inside its scope, and a symlink cannot take it out", () =>
    world(({ fs, path, workspace, outside, host }) =>
      Effect.gen(function* () {
        const { resources } = host
        yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret")
        yield* fs.makeDirectory(path.join(workspace, "sub"))
        yield* fs.writeFileString(path.join(workspace, "sub", "in.txt"), "in")
        yield* fs.symlink(outside, path.join(workspace, "escape"))
        yield* fs.symlink(path.join(outside, "secret.txt"), path.join(workspace, "leaf-link"))
        const scope = yield* resources.scope({ kind: "path", selectors: [`${workspace}/**`] })
        const read = (selector: string) =>
          resources.bind({ kind: "path", selector, rights: ["read"], field: "path" })

        expect(resources.within(yield* read("sub/in.txt"), scope)).toBe(true)
        expect(resources.within(yield* read("."), scope)).toBe(true)
        // Through a symlinked directory the path is bound to where it really is.
        const escaped = yield* read("escape/secret.txt")
        expect(escaped.binding.selector).toBe(path.join(outside, "secret.txt"))
        expect(resources.within(escaped, scope)).toBe(false)
        expect(resources.within(yield* read("../outside/secret.txt"), scope)).toBe(false)
        // A sibling whose name merely starts with the scope's is outside it.
        yield* fs.makeDirectory(`${workspace}-other`)
        expect(resources.within(yield* read(`${workspace}-other`), scope)).toBe(false)
        // A symlink leaf is refused, not followed.
        expect((yield* read("leaf-link").pipe(Effect.flip))._tag).toBe("ResourceRefused")
        expect((yield* read("missing.txt").pipe(Effect.flip))._tag).toBe("ResourceRefused")

        const narrow = yield* resources.scope({ kind: "path", selectors: [path.join(workspace, "sub")] })
        expect(resources.within(yield* read("sub/in.txt"), narrow)).toBe(true)
        expect(resources.within(yield* read("."), narrow)).toBe(false)
        // A scope that cannot be resolved is refused when the policy loads.
        expect((yield* resources.scope({ kind: "path", selectors: ["relative/**"] }).pipe(Effect.flip))._tag)
          .toBe("ResourceRefused")
      })
    )
  )

  it.effect("binds a path that does not exist yet through its directory, for writing only", () =>
    world(({ fs, path, workspace, host }) =>
      Effect.gen(function* () {
        const { resources } = host
        const scope = yield* resources.scope({ kind: "path", selectors: [workspace] })
        const fresh = yield* resources.bind({ kind: "path", selector: "new/deep/out.txt", rights: ["write"], field: "path" })
        expect(fresh.binding.identity).toMatchObject({
          absent: true,
          parent: { path: workspace },
          leaf: path.join("new", "deep", "out.txt")
        })
        expect(resources.within(fresh, scope)).toBe(true)

        // The same call, admitted again later, still means the same thing.
        expect((yield* resources.rebind({ binding: fresh.binding })).binding).toEqual(fresh.binding)
        // Once something appears there, the admitted binding no longer holds.
        yield* fs.makeDirectory(path.join(workspace, "new", "deep"), { recursive: true })
        yield* fs.writeFileString(path.join(workspace, "new", "deep", "out.txt"), "appeared")
        expect((yield* resources.rebind({ binding: fresh.binding }).pipe(Effect.flip)).reason).toContain("changed since admission")

        // A replaced file is a different object under the same name.
        const target = path.join(workspace, "swap.txt")
        yield* fs.writeFileString(target, "one")
        const bound = yield* resources.bind({ kind: "path", selector: "swap.txt", rights: ["read", "write"], field: "path" })
        yield* fs.rename(target, path.join(workspace, "swap-old.txt"))
        yield* fs.writeFileString(target, "two")
        expect((yield* resources.rebind({ binding: bound.binding }).pipe(Effect.flip))._tag).toBe("ResourceRefused")
      })
    )
  )

  it.effect("accepts in `within` only what this host bound", () =>
    world(({ workspace, host }) =>
      Effect.gen(function* () {
        const scope = yield* host.resources.scope({ kind: "path", selectors: [workspace] })
        const forged: BoundResource = {
          binding: { field: "path", kind: "path", rights: ["read"], selector: workspace, identity: {} },
          capability: { kind: "path", physical: workspace }
        }
        expect(host.resources.within(forged, scope)).toBe(false)
        const real = yield* host.resources.bind({ kind: "path", selector: ".", rights: ["read"], field: "path" })
        expect(host.resources.within(real, { kind: "path", capability: [workspace] })).toBe(false)
      })
    )
  )
})

describe("local tool host — executables", () => {
  it.effect("binds an executable to the file that will run, and a descendant to its root", () =>
    world(({ fs, path, workspace, host }) =>
      Effect.gen(function* () {
        const { resources } = host
        const tool = path.join(workspace, "tool")
        const helper = path.join(workspace, "helper")
        yield* fs.writeFileString(tool, "#!/bin/sh\n")
        yield* fs.writeFileString(helper, "#!/bin/sh\n")
        yield* fs.symlink(tool, path.join(workspace, "tool-link"))
        const root = yield* resources.bind({
          kind: "executable", selector: path.join(workspace, "tool-link"), rights: ["invoke"], field: "executable"
        })
        expect(root.binding.selector).toBe(tool)
        const child = yield* resources.bind({
          kind: "executable", selector: helper, rights: ["execute"], field: "descendantExecutables", index: 0, parent: root
        })
        expect(child.binding.identity).toMatchObject({ path: helper, parent: tool })

        const allowed = yield* resources.scope({ kind: "executable", selectors: [tool] })
        expect(resources.within(root, allowed)).toBe(true)
        expect(resources.within(child, allowed)).toBe(false)

        const refused = (request: Parameters<typeof resources.bind>[0]) =>
          resources.bind(request).pipe(Effect.flip, Effect.map((error) => error._tag))
        expect(yield* refused({ kind: "executable", selector: "tool", rights: ["invoke"], field: "executable" })).toBe("ResourceRefused")
        expect(yield* refused({ kind: "executable", selector: workspace, rights: ["invoke"], field: "executable" })).toBe("ResourceRefused")
        expect(yield* refused({ kind: "executable", selector: helper, rights: ["execute"], field: "d" })).toBe("ResourceRefused")
        expect(yield* refused({ kind: "executable", selector: helper, rights: ["invoke"], field: "d", parent: root })).toBe("ResourceRefused")
        // Only a root can be a parent: not a descendant, and not a bound path.
        expect(yield* refused({ kind: "executable", selector: helper, rights: ["execute"], field: "d", parent: child })).toBe("ResourceRefused")
        const asPath = yield* resources.bind({ kind: "path", selector: "tool", rights: ["read"], field: "path" })
        expect(yield* refused({ kind: "executable", selector: helper, rights: ["execute"], field: "d", parent: asPath })).toBe("ResourceRefused")

        // Evidence cannot be changed after binding, at any depth.
        for (const bound of [root, child, asPath]) {
          expect(Object.isFrozen(bound.binding)).toBe(true)
          expect(Object.isFrozen(bound.binding.rights)).toBe(true)
          expect(Object.isFrozen(bound.binding.identity)).toBe(true)
          expect(() => { (bound.binding.rights as unknown as Array<string>).push("write") }).toThrow()
          expect(() => { (bound.binding.identity as { path: string }).path = "/elsewhere" }).toThrow()
        }
      })
    )
  )
})

describe("local tool host — what may run without approval", () => {
  it.effect("is reads, held file changes, and a process this machine can confine", () =>
    world(({ host }) =>
      Effect.sync(() => {
        const ok = (contract: Parameters<ToolHost["validateGrant"]>[0]["contract"], when: "now" | "approved", params?: Record<string, string>) =>
          Result.isSuccess(host.validateGrant({
            contract,
            grant: { tool: contract.tag, when, ...(params === undefined ? {} : { host: params }) }
          }))
        expect(ok(FileRead, "now")).toBe(true)
        expect(ok(HttpGet, "now")).toBe(true)
        expect(ok(FileWrite, "now")).toBe(true)
        // Nothing here can call a request back.
        expect(ok(HttpStage, "now")).toBe(false)
        expect(ok(HttpStage, "approved")).toBe(true)

        expect(ok(ProcessRun, "now", { profile: "native-contained" })).toBe(true)
        // Unconfined, by name or by omission, always waits for a person.
        expect(ok(ProcessRun, "now", { profile: "compatibility" })).toBe(false)
        expect(ok(ProcessRun, "now")).toBe(false)
        expect(ok(ProcessRun, "approved", { profile: "compatibility" })).toBe(true)
        expect(ok(ProcessRun, "approved")).toBe(true)
        // A profile this machine cannot provide is refused when the policy loads.
        expect(ok(ProcessRun, "now", { profile: "vm-enclosed" })).toBe(false)
        expect(ok(ProcessRun, "approved", { profile: "vm-enclosed" })).toBe(false)
        expect(ok(ProcessRun, "approved", { profile: "invented" })).toBe(false)
        expect(ok(ProcessRun, "approved", { profile: "native-contained", extra: "x" })).toBe(false)
        // Only a tool that starts a process takes host parameters.
        expect(ok(FileWrite, "now", { profile: "native-contained" })).toBe(false)
        expect(Result.isSuccess(host.validateGrant({ contract: FileRead, grant: { tool: "file.write", when: "now" } }))).toBe(false)
      })
    )
  )
})
