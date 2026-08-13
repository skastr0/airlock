import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  ActionCallDecodeFailed,
  InvalidActionInput,
  NativeActionCatalog,
  type NativeActionCall,
  UnknownNativeAction,
  decodeAndLowerNativeAction,
  mapNativeActionPathSelectors,
  nativeAction
} from "../src/actions/index.ts"

const lower = (input: unknown) =>
  decodeAndLowerNativeAction("test/native-action", input)

describe("native action catalog", () => {
  it.effect("keeps the practical native vocabulary complete and classified", () =>
    Effect.gen(function* () {
      expect(NativeActionCatalog.map((action) => action.name)).toEqual([
        "file.inspect", "file.read", "file.list", "file.glob", "file.stat",
        "file.write", "file.remove", "file.move", "file.copy", "file.mkdir",
        "process.run", "http.stage"
      ])
      expect(yield* nativeAction("http.stage")).toMatchObject({ node: "RequestExternal" })

      const missing = yield* nativeAction("shell.eval").pipe(Effect.flip)
      expect(missing).toBeInstanceOf(UnknownNativeAction)
    })
  )

  it.effect("lowers observation, mutation, and external actions to inert nodes", () =>
    Effect.gen(function* () {
      const stat = yield* lower({ action: "file.stat", path: "/srv/app", realm: "machine" })
      expect(stat.nodes[0]).toMatchObject({
        _tag: "Capture",
        action: "file.stat",
        locator: "stat:/srv/app;followSymlinks=false",
        requirements: [{ kind: "path", realm: "machine", selector: "/srv/app", rights: ["read"] }]
      })

      const copy = yield* lower({
        action: "file.copy", source: "/srv/build/a", destination: "/srv/release/a"
      })
      expect(copy.nodes[0]).toMatchObject({
        _tag: "Apply",
        action: "file.copy",
        source: "/srv/build/a",
        target: "/srv/release/a",
        requirements: [
          { selector: "/srv/build/a", rights: ["read"] },
          { selector: "/srv/release/a", rights: ["write"] }
        ]
      })

      const stage = yield* lower({
        action: "http.stage", endpoint: "https://api.example.test/jobs", method: "POST",
        headers: { "content-type": "application/json", "x-trace": "action-test" },
        body: "{\"job\":\"check\"}"
      })
      expect(stage.nodes[0]).toMatchObject({
        _tag: "RequestExternal",
        endpoint: "https://api.example.test/jobs",
        method: "POST",
        headers: { "content-type": "application/json", "x-trace": "action-test" },
        body: "{\"job\":\"check\"}",
        requirements: [{ kind: "endpoint", rights: ["connect", "emit"] }]
      })

      const stagedArtifact = yield* lower({
        action: "http.stage",
        endpoint: "https://api.example.test/jobs",
        method: "PUT",
        bodyArtifact: "artifact/request-body"
      })
      expect(stagedArtifact.nodes[0]).toMatchObject({
        _tag: "RequestExternal",
        method: "PUT",
        headers: {},
        bodyArtifact: "artifact/request-body"
      })
    })
  )

  it.effect("preserves the structured process contract without an argv field", () =>
    Effect.gen(function* () {
      const lowered = yield* lower({
        action: "process.run",
        executable: "/usr/bin/tar",
        args: ["-xf", "release.tar"],
        descendantExecutables: ["/bin/sh"],
        cwd: "/srv/releases",
        env: { LANG: "C" },
        stdin: "discard",
        stdout: "capture",
        stderr: "capture",
        timeoutMs: 30_000,
        outputLimitBytes: 16_384,
        cellProfile: "native-contained"
      })
      const invoke = lowered.nodes[0]!
      expect(invoke).toMatchObject({
        _tag: "Invoke",
        executable: "/usr/bin/tar",
        args: ["-xf", "release.tar"],
        descendantExecutables: ["/bin/sh"],
        cwd: "/srv/releases",
        stdin: "discard",
        stdout: "capture",
        stderr: "capture",
        timeoutMs: 30_000,
        outputLimitBytes: 16_384,
        cellProfile: "native-contained"
      })
      expect("argv" in invoke).toBe(false)
      expect(invoke.requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "executable",
          selector: "/usr/bin/tar",
          rights: ["invoke"]
        }),
        expect.objectContaining({
          kind: "executable",
          selector: "/bin/sh",
          rights: ["execute"]
        })
      ]))

      const textInput = yield* lower({
        action: "process.run",
        executable: "/usr/bin/cat",
        args: [],
        cwd: "/srv/releases",
        stdin: { kind: "text", value: "hello from Airlock" }
      })
      expect(textInput.nodes[0]).toMatchObject({
        _tag: "Invoke",
        stdin: { kind: "text", value: "hello from Airlock" }
      })

      const artifactInput = yield* lower({
        action: "process.run",
        executable: "/usr/bin/cat",
        args: [],
        cwd: "/srv/releases",
        stdin: { kind: "artifact", id: "artifact/stdin" }
      })
      expect(artifactInput.nodes[0]).toMatchObject({
        _tag: "Invoke",
        stdin: { kind: "artifact", id: "artifact/stdin" }
      })
    })
  )

  it.effect("rejects malformed or authority-ambiguous action calls", () =>
    Effect.gen(function* () {
      const followingSymlinks = yield* lower({
        action: "file.stat",
        path: "/srv/app",
        followSymlinks: true
      }).pipe(Effect.flip)
      expect(followingSymlinks).toBeInstanceOf(InvalidActionInput)
      expect(followingSymlinks).toMatchObject({ field: "followSymlinks" })

      const ambiguousWrite = yield* lower({
        action: "file.write", path: "/srv/app/config", content: "a", sourceArtifact: "artifact/config"
      }).pipe(Effect.flip)
      expect(ambiguousWrite).toBeInstanceOf(InvalidActionInput)
      expect(ambiguousWrite).toMatchObject({ field: "content/sourceArtifact" })

      const relativeExecutable = yield* lower({
        action: "process.run", executable: "tar", args: [], cwd: "/srv/app"
      }).pipe(Effect.flip)
      expect(relativeExecutable).toBeInstanceOf(InvalidActionInput)
      expect(relativeExecutable).toMatchObject({ field: "executable" })

      const invalidProfile = yield* lower({
        action: "process.run",
        executable: "/usr/bin/tar",
        args: [],
        cwd: "/srv/app",
        cellProfile: "almost-contained"
      }).pipe(Effect.flip)
      expect(invalidProfile).toBeInstanceOf(ActionCallDecodeFailed)

      const ambiguousBareStdin = yield* lower({
        action: "process.run",
        executable: "/usr/bin/cat",
        args: [],
        cwd: "/srv/app",
        stdin: "artifact/stdin"
      }).pipe(Effect.flip)
      expect(ambiguousBareStdin).toBeInstanceOf(ActionCallDecodeFailed)

      const descendantRootRepeat = yield* lower({
        action: "process.run",
        executable: "/usr/bin/tar",
        descendantExecutables: ["/usr/bin/tar"],
        args: [],
        cwd: "/srv/app"
      }).pipe(Effect.flip)
      expect(descendantRootRepeat).toBeInstanceOf(InvalidActionInput)
      expect(descendantRootRepeat).toMatchObject({ field: "descendantExecutables[0]" })

      const descendantNul = yield* lower({
        action: "process.run",
        executable: "/usr/bin/tar",
        descendantExecutables: ["/usr/bin/tar\u0000child"],
        args: [],
        cwd: "/srv/app"
      }).pipe(Effect.flip)
      expect(descendantNul).toBeInstanceOf(InvalidActionInput)
      expect(descendantNul).toMatchObject({ field: "descendantExecutables[0]" })

      const ambiguousBody = yield* lower({
        action: "http.stage",
        endpoint: "https://api.example.test/jobs",
        method: "POST",
        body: "inline",
        bodyArtifact: "artifact/request-body"
      }).pipe(Effect.flip)
      expect(ambiguousBody).toBeInstanceOf(InvalidActionInput)
      expect(ambiguousBody).toMatchObject({ field: "body/bodyArtifact" })

      const malformed = yield* lower({ action: "unknown.action" }).pipe(Effect.flip)
      expect(malformed).toBeInstanceOf(ActionCallDecodeFailed)
    })
  )

  it.effect("maps every native filesystem path field and no other selector", () =>
    Effect.gen(function* () {
      const bind = (selector: string) => Effect.succeed(`/bound${selector}`)
      for (const action of [
        "file.inspect",
        "file.read",
        "file.list",
        "file.stat",
        "file.write",
        "file.remove",
        "file.mkdir"
      ] as const) {
        const base = { action, path: "/path", realm: "local" } as const
        const call = action === "file.read"
          ? { ...base, format: "text" as const }
          : action === "file.stat"
            ? { ...base, followSymlinks: false }
            : action === "file.write"
              ? { ...base, content: "value" }
              : action === "file.mkdir"
                ? { ...base, parents: false }
                : base
        const mapped = yield* mapNativeActionPathSelectors(call as NativeActionCall, bind)
        expect("path" in mapped && mapped.path, action).toBe("/bound/path")
      }
      for (const action of ["file.copy", "file.move"] as const) {
        const mapped = yield* mapNativeActionPathSelectors({
          action,
          source: "/source",
          destination: "/destination",
          realm: "local"
        }, bind)
        expect(mapped, action).toMatchObject({
          source: "/bound/source",
          destination: "/bound/destination"
        })
      }
      const process = yield* mapNativeActionPathSelectors({
        action: "process.run",
        executable: "/usr/bin/true",
        args: ["/argument/stays"],
        descendantExecutables: ["/usr/bin/helper"],
        cwd: "/work",
        env: {},
        cellProfile: "native-contained",
        stdin: "discard",
        stdout: "capture",
        stderr: "capture",
        outputLimitBytes: 1024,
        readable: [
          { kind: "path", realm: "local", selector: "/read", rights: ["read"] },
          { kind: "endpoint", realm: "external", selector: "https://unchanged.invalid/", rights: ["connect"] }
        ],
        writable: [
          { kind: "path", realm: "local", selector: "/write", rights: ["write"] }
        ],
        realm: "local"
      }, bind)
      expect(process).toMatchObject({
        cwd: "/bound/work",
        executable: "/usr/bin/true",
        args: ["/argument/stays"],
        descendantExecutables: ["/usr/bin/helper"],
        readable: [
          { selector: "/bound/read" },
          { selector: "https://unchanged.invalid/" }
        ],
        writable: [{ selector: "/bound/write" }]
      })

      const relativeCwd = yield* mapNativeActionPathSelectors(
        { ...process, cwd: "." },
        bind
      )
      expect(relativeCwd.cwd).toBe(".")

      const copy = yield* mapNativeActionPathSelectors({
        action: "file.copy",
        source: "/from",
        destination: "/to",
        realm: "local"
      }, bind)
      expect(copy).toMatchObject({
        source: "/bound/from",
        destination: "/bound/to"
      })

      const glob = yield* mapNativeActionPathSelectors({
        action: "file.glob",
        root: "/root",
        pattern: "**/*.ts",
        realm: "local"
      }, bind)
      expect(glob).toMatchObject({ root: "/bound/root", pattern: "**/*.ts" })

      const external = yield* mapNativeActionPathSelectors({
        action: "http.stage",
        endpoint: "https://unchanged.invalid/path",
        method: "GET",
        headers: {},
        holdMillis: 30_000,
        realm: "external"
      }, bind)
      expect(external.endpoint).toBe("https://unchanged.invalid/path")
    })
  )

})
