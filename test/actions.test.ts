import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  ActionCallDecodeFailed,
  InvalidActionInput,
  NativeActionCatalog,
  UnknownNativeAction,
  decodeAndLowerNativeAction,
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
})
