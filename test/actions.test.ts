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
        body: "{\"job\":\"check\"}"
      })
      expect(stage.nodes[0]).toMatchObject({
        _tag: "RequestExternal",
        endpoint: "https://api.example.test/jobs",
        method: "POST",
        requirements: [{ kind: "endpoint", rights: ["connect", "emit"] }]
      })
    })
  )

  it.effect("preserves the structured process contract without an argv field", () =>
    Effect.gen(function* () {
      const lowered = yield* lower({
        action: "process.run",
        executable: "/usr/bin/tar",
        args: ["-xf", "release.tar"],
        cwd: "/srv/releases",
        env: { LANG: "C" },
        stdin: "discard",
        stdout: "capture",
        stderr: "capture",
        timeoutMs: 30_000,
        outputLimitBytes: 16_384
      })
      const invoke = lowered.nodes[0]!
      expect(invoke).toMatchObject({
        _tag: "Invoke",
        executable: "/usr/bin/tar",
        args: ["-xf", "release.tar"],
        cwd: "/srv/releases",
        stdin: "discard",
        stdout: "capture",
        stderr: "capture",
        timeoutMs: 30_000,
        outputLimitBytes: 16_384
      })
      expect("argv" in invoke).toBe(false)
    })
  )

  it.effect("rejects malformed or authority-ambiguous action calls", () =>
    Effect.gen(function* () {
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

      const malformed = yield* lower({ action: "unknown.action" }).pipe(Effect.flip)
      expect(malformed).toBeInstanceOf(ActionCallDecodeFailed)
    })
  )
})
