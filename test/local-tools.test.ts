import { DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import * as AirlockHome from "../src/AirlockHome.ts"
import { Refused } from "../src/core/airlock/Implement.ts"
import { Sha256Digest } from "../src/core/Canonical.ts"
import type { BoundResource, HeldReference, ToolHost } from "../src/core/contract/ToolHost.ts"
import { Hold, HoldLayer } from "../src/Hold.ts"
import { FileLedgerLive } from "../src/host/FileLedger.ts"
import { HeldCalls, HeldCallsConfig, HeldCallsLive } from "../src/host/HeldCalls.ts"
import { localRecovery } from "../src/host/LocalRecovery.ts"
import { localToolHost } from "../src/host/LocalToolHost.ts"
import { type LocalCallContext, localTools } from "../src/host/LocalTools.ts"
import { NativeFileSystem, NativeFileSystemLive, NativeFilesystemConfig, ProcessRun } from "../src/native/index.ts"
import { ProcessSpawnFailed } from "../src/process/Process.ts"
import { ExclusiveRenameTestLive } from "./support/ExclusiveRenameTestLive.ts"

/**
 * The assembled local tools, given what the kernel will give them: resources
 * bound by the local host and a claim prepared through its recovery port.
 * The wire token is the kernel's alone to mint, so the HTTP tools are tested
 * through the kernel in native-http-tools.test.ts.
 */

const unused = <A>(what: string) => new Proxy({}, { get: () => { throw new Error(`${what} is not used here`) } }) as A

const world = <A, E>(body: (args: {
  readonly fs: FileSystem.FileSystem
  readonly at: (name: string) => string
  readonly outside: string
  readonly host: ToolHost
  readonly tools: ReturnType<typeof localTools>
  /** The context the kernel builds for one call. */
  readonly context: (
    resources: ReadonlyArray<BoundResource>,
    options?: { readonly claim?: string; readonly host?: Record<string, string>; readonly validUntil?: DateTime.Utc }
  ) => Effect.Effect<Omit<LocalCallContext, "held"> & { readonly held: HeldReference | undefined }>
  /** Requests that reached the plain, unconfined process runner. */
  readonly unconfinedRuns: Array<string>
}) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const workspace = path.join(root, "workspace")
      const outside = path.join(root, "outside")
      yield* fs.makeDirectory(workspace)
      yield* fs.makeDirectory(outside)
      const services = yield* Effect.gen(function* () {
        return { calls: yield* HeldCalls, hold: yield* Hold, files: yield* NativeFileSystem }
      }).pipe(Effect.provide(
        HeldCallsLive(new HeldCallsConfig({ retentionMillis: 60_000 })).pipe(
          Layer.provideMerge(NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))),
          Layer.provideMerge(HoldLayer.pipe(Layer.provide(ExclusiveRenameTestLive))),
          Layer.provideMerge(FileLedgerLive),
          Layer.provideMerge(AirlockHome.layer(path.join(root, "airlock-home"))),
          Layer.provideMerge(BunServices.layer)
        )
      ))
      const unconfinedRuns: Array<string> = []
      const recovery = localRecovery(services.calls)
      const host = yield* localToolHost({ workspace, confiningProfiles: ["native-contained"], recovery })
      const tools = localTools({
        ...services,
        process: {
          run: (request) =>
            Effect.sync(() => unconfinedRuns.push(request.executable)).pipe(
              Effect.andThen(Effect.fail(new ProcessSpawnFailed({ executable: request.executable, cause: "stub" })))
            )
        },
        cell: unused("the Cell"),
        workspace,
        environment: {},
        confiningProfiles: ["native-contained"],
        responseLimitBytes: 1_024,
        artifact: () => Effect.fail("no artifacts"),
        keep: () => Effect.fail("no artifacts")
      })
      return yield* body({
        fs,
        at: (name) => path.join(workspace, name),
        outside,
        host,
        tools,
        unconfinedRuns,
        context: (resources, options = {}) =>
          Effect.gen(function* () {
            const held = options.claim === undefined ? undefined : yield* recovery.prepare({
              callId: options.claim,
              runId: "run",
              tool: "file",
              version: "1",
              inputDigest: Sha256Digest.make(`sha256:${"a".repeat(64)}`),
              resources: resources.map((resource) => resource.binding),
              host: options.host ?? {}
            })
            return {
              signal: new AbortController().signal,
              wireToken: unused<LocalCallContext["wireToken"]>("the wire token"),
              host: options.host ?? {},
              resources,
              ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
              held
            }
          }).pipe(Effect.orDie)
      })
    })
  ).pipe(Effect.provide(BunServices.layer))

const path = (host: ToolHost, field: string, selector: string, rights: ReadonlyArray<"read" | "write">) =>
  host.resources.bind({ kind: "path", selector, rights: rights as ["read"], field }).pipe(Effect.orDie)

describe("local tools", () => {
  it.effect("act on the path admission bound, not on the string in the input", () =>
    world(({ fs, at, host, tools, context }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("admitted.txt"), "admitted")
        yield* fs.writeFileString(at("other.txt"), "other")
        const read = yield* tools["file.read"](
          { path: "other.txt", format: "text" },
          yield* context([yield* path(host, "path", "admitted.txt", ["read"])])
        )
        expect(read).toBe("admitted")

        yield* tools["file.write"](
          { path: "other.txt", content: "written" },
          yield* context([yield* path(host, "path", "admitted.txt", ["write"])], { claim: "write" })
        )
        expect(yield* fs.readFileString(at("admitted.txt"))).toBe("written")
        expect(yield* fs.readFileString(at("other.txt"))).toBe("other")
      })
    )
  )

  it.effect("refuse a call that arrives without its admitted resource, and fail one without its claim", () =>
    world(({ fs, at, host, tools, context }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("note.txt"), "before")
        expect(yield* tools["file.read"]({ path: "note.txt", format: "text" }, yield* context([]))).toBeInstanceOf(Refused)
        expect(yield* tools["file.remove"]({ path: "note.txt" }, yield* context([], { claim: "no-path" }))).toBeInstanceOf(Refused)
        // A source alone is not enough for a move.
        const source = yield* path(host, "source", "note.txt", ["read", "write"])
        expect(yield* tools["file.move"]({ source: "note.txt", destination: "moved.txt" }, yield* context([source], { claim: "half" })))
          .toBeInstanceOf(Refused)
        // An apply the kernel did not claim in Hold first does not run.
        const bound = yield* path(host, "path", "note.txt", ["write"])
        const unclaimed = yield* tools["file.remove"]({ path: "note.txt" }, yield* context([bound])).pipe(Effect.exit)
        expect(unclaimed._tag).toBe("Failure")
        expect(yield* fs.readFileString(at("note.txt"))).toBe("before")
      })
    )
  )

  it.effect("apply under the kernel's claim, so the recovery port can put the call back", () =>
    world(({ fs, at, host, tools, context }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("a.txt"), "source")
        yield* fs.writeFileString(at("b.txt"), "destination before")
        const call = yield* context([
          yield* path(host, "source", "a.txt", ["read", "write"]),
          yield* path(host, "destination", "b.txt", ["write"])
        ], { claim: "move" })
        yield* tools["file.move"]({ source: "a.txt", destination: "b.txt" }, call)
        expect(yield* fs.readFileString(at("b.txt"))).toBe("source")

        const recovery = host.recovery!
        expect((yield* recovery.inspect(call.held!)).state).toBe("done")
        expect((yield* recovery.restore(call.held!)).state).toBe("restored")
        expect(yield* fs.readFileString(at("a.txt"))).toBe("source")
        expect(yield* fs.readFileString(at("b.txt"))).toBe("destination before")
      })
    )
  )

  it.effect("do no forward work under a grant that has run out", () =>
    world(({ fs, at, host, tools, context, unconfinedRuns }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(at("note.txt"), "before")
        const past = DateTime.makeUnsafe(Date.now() - 1_000)
        const bound = yield* path(host, "path", "note.txt", ["write"])
        const write = yield* tools["file.write"]({ path: "note.txt", content: "after" }, yield* context([bound], { claim: "expired-write", validUntil: past }))
        expect(write).toBeInstanceOf(Refused)
        expect((write as Refused).reason).toContain("grant expired")
        expect(yield* fs.readFileString(at("note.txt"))).toBe("before")

        const endpoint = yield* host.resources.bind({
          kind: "endpoint", selector: "https://example.test/send", rights: ["emit"], field: "endpoint"
        }).pipe(Effect.orDie)
        // The wire token here throws if touched: an expired call never reaches for it.
        const sent = yield* tools["http.stage"](
          { endpoint: "https://example.test/send", method: "POST", headers: {}, holdMillis: 0 },
          yield* context([endpoint], { validUntil: past })
        )
        expect(sent).toBeInstanceOf(Refused)

        const input = Schema.decodeUnknownSync(ProcessRun.input)({ executable: "/bin/bash", args: ["-c", "true"], cwd: "." })
        const ran = yield* tools["process.run"](input, yield* context([
          yield* host.resources.bind({ kind: "executable", selector: "/bin/bash", rights: ["invoke"], field: "executable" }).pipe(Effect.orDie),
          yield* path(host, "cwd", ".", ["read", "write"])
        ], { validUntil: past }))
        expect(ran).toBeInstanceOf(Refused)
        expect(unconfinedRuns).toEqual([])
      })
    )
  )

  it.effect("confine a process exactly when the grant names a profile this machine provides", () =>
    world(({ host, tools, context, unconfinedRuns }) =>
      Effect.gen(function* () {
        const input = Schema.decodeUnknownSync(ProcessRun.input)({ executable: "/bin/bash", args: ["-c", "true"], cwd: "." })
        const resources = [
          yield* host.resources.bind({ kind: "executable", selector: "/bin/bash", rights: ["invoke"], field: "executable" }).pipe(Effect.orDie),
          yield* path(host, "cwd", ".", ["read", "write"])
        ]
        // Confined: it needs the claim, and says so before anything starts.
        const confined = yield* tools["process.run"](input, yield* context(resources, { host: { profile: "native-contained" } })).pipe(Effect.flip)
        expect(String(confined)).toContain("claim in Hold")
        // Any other value, or none, is unconfined: it goes to the plain process runner.
        expect(unconfinedRuns).toEqual([])
        const others: ReadonlyArray<Record<string, string>> = [{}, { profile: "compatibility" }, { profile: "vm-enclosed" }]
        for (const parameters of others) {
          yield* tools["process.run"](input, yield* context(resources, { host: parameters }))
        }
        expect(unconfinedRuns).toEqual(["/bin/bash", "/bin/bash", "/bin/bash"])
        expect(yield* tools["process.run"](input, yield* context([resources[1]!]))).toBeInstanceOf(Refused)
      })
    )
  )
})
