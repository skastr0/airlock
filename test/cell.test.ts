import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Cell,
  CellLive,
  CellRequest,
  renderSeatbeltProfile,
  validateCellRequest
} from "../src/cell/index.ts"
import { MacosPlatformLive } from "../src/platform/macos/index.ts"
import { ProcessRequest, ProcessRunnerLive } from "../src/process/Process.ts"

const darwinBun = globalThis.process.platform === "darwin" && typeof Bun !== "undefined"

const CellTestLive = CellLive.pipe(
  Layer.provide(Layer.merge(MacosPlatformLive, ProcessRunnerLive))
)

const command = (source: string, script: string, env: Record<string, string>) =>
  new ProcessRequest({
    executable: "/bin/sh",
    args: ["-c", script],
    cwd: source,
    env,
    stdout: "capture",
    stderr: "capture",
    outputLimitBytes: 64 * 1024,
    timeoutMs: 5_000
  })

describe("Cell construction", () => {
  it("renders a deny-network Seatbelt profile with JSON-escaped path literals", () => {
    const privateWorkspace = '/private/airlock/"quoted"'
    const profile = renderSeatbeltProfile(
      privateWorkspace,
      ["/private/airlock-temp"],
      "deny",
      ["/bin/echo"]
    )

    expect(profile).toContain(`(subpath ${JSON.stringify(privateWorkspace)})`)
    expect(profile).toContain('(allow file-read*)')
    expect(profile).toContain(
      `(allow process-exec (literal ${JSON.stringify("/bin/echo")}))`
    )
    expect(profile).not.toContain("(allow process*)")
    expect(profile).toContain("(deny network*)")
    expect(profile).not.toContain("(allow network*)")
  })

  it.effect("rejects private workspaces that overlap the live workspace before platform work", () =>
    validateCellRequest(
      new CellRequest({
        sourceWorkspace: "/workspace",
        privateWorkspace: "/workspace/private",
        process: command("/workspace", "true", {})
      })
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("CellContractViolation")
          expect(error.field).toBe("privateWorkspace")
        })
      ),
      Effect.asVoid
    )
  )

  it.effect("rejects a root executable repeated as its own descendant", () =>
    Effect.gen(function* () {
      const error = yield* validateCellRequest(
        new CellRequest({
          sourceWorkspace: "/workspace",
          privateWorkspace: "/private-workspace",
          descendantExecutables: ["/bin/sh"],
          process: command("/workspace", "true", {})
        })
      ).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "CellContractViolation",
        field: "descendantExecutables[0]"
      })
    })
  )
})

describe.skipIf(!darwinBun)("macOS native-contained Cell", () => {
  it.effect("denies live writes and network while retaining private workspace writes and delta evidence", () =>
    Effect.gen(function* () {
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response("reachable")
      })
      const root = mkdtempSync(join(tmpdir(), "airlock-cell-"))
      const source = join(root, "source")
      const privateWorkspace = join(root, "private")
      const explicitTemp = join(root, "explicit-temp")
      mkdirSync(source)
      mkdirSync(explicitTemp)
      writeFileSync(join(source, "unchanged.txt"), "baseline")
      try {
        const cell = yield* Cell
        const receipt = yield* cell.run(
          new CellRequest({
            sourceWorkspace: source,
            privateWorkspace,
            tempPaths: [explicitTemp],
            network: "deny",
            descendantExecutables: ["/bin/bash", "/usr/bin/curl"],
            process: command(
              source,
              [
                'if printf live > "$AIRLOCK_LIVE/forbidden.txt"; then echo live-write; else echo live-denied; fi',
                'printf private > "$AIRLOCK_PRIVATE/created.txt"',
                'printf temporary > "$AIRLOCK_TEMP/temp.txt"',
                `if /usr/bin/curl --connect-timeout 1 --max-time 1 -fsS http://127.0.0.1:${server.port}/ >/dev/null; then echo network-open; else echo network-denied; fi`
              ].join("; "),
              {
                AIRLOCK_LIVE: source,
                AIRLOCK_PRIVATE: privateWorkspace,
                AIRLOCK_TEMP: explicitTemp
              }
            )
          })
        )

        const output = new TextDecoder().decode(receipt.processReceipt.stdout)
        expect(output).toContain("live-denied")
        expect(output).toContain("network-denied")
        expect(readFileSync(join(source, "unchanged.txt"), "utf8")).toBe("baseline")
        expect(() => readFileSync(join(source, "forbidden.txt"), "utf8")).toThrow()
        expect(readFileSync(join(privateWorkspace, "created.txt"), "utf8")).toBe("private")
        expect(readFileSync(join(explicitTemp, "temp.txt"), "utf8")).toBe("temporary")
        expect(receipt.delta).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "created.txt", kind: "created" })])
        )
        expect(receipt.drift).toEqual([])
        expect(receipt.readAuthority).toBe("ambient-host-read")
      } finally {
        server.stop(true)
      }
    }).pipe(Effect.provide(CellTestLive))
  )

  it.effect("rejects a request whose declared cwd could bypass the workspace rewrite", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "airlock-cell-"))
      const source = join(root, "source")
      mkdirSync(source)
      const cell = yield* Cell
      const error = yield* cell
        .run(
          new CellRequest({
            sourceWorkspace: source,
            privateWorkspace: join(root, "private"),
            process: command(root, "true", {})
          })
        )
        .pipe(Effect.flip)
      expect(error._tag).toBe("CellContractViolation")
    }).pipe(Effect.provide(CellTestLive))
  )

  it.effect("denies unlisted descendant execs and permits explicit executable edges", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "airlock-cell-edges-"))
      const source = join(root, "source")
      mkdirSync(source)
      const deniedPrivate = join(root, "denied-private")
      const allowedPrivate = join(root, "allowed-private")
      const cell = yield* Cell

      const denied = yield* cell.run(
        new CellRequest({
          sourceWorkspace: source,
          privateWorkspace: deniedPrivate,
          descendantExecutables: ["/bin/bash"],
          process: command(
            source,
            'if /usr/bin/touch "$AIRLOCK_PRIVATE/descendant"; then printf allowed; else printf denied; fi',
            { AIRLOCK_PRIVATE: deniedPrivate }
          )
        })
      )
      expect(new TextDecoder().decode(denied.processReceipt.stdout)).toBe("denied")
      expect(existsSync(join(deniedPrivate, "descendant"))).toBe(false)

      const allowed = yield* cell.run(
        new CellRequest({
          sourceWorkspace: source,
          privateWorkspace: allowedPrivate,
          descendantExecutables: ["/bin/bash", "/usr/bin/touch"],
          process: command(
            source,
            'if /usr/bin/touch "$AIRLOCK_PRIVATE/descendant"; then printf allowed; else printf denied; fi',
            { AIRLOCK_PRIVATE: allowedPrivate }
          )
        })
      )
      expect(new TextDecoder().decode(allowed.processReceipt.stdout)).toBe("allowed")
      expect(existsSync(join(allowedPrivate, "descendant"))).toBe(true)
    }).pipe(Effect.provide(CellTestLive))
  )

  it.effect("requires an admitted shebang chain instead of laundering interpreter authority", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "airlock-cell-shebang-"))
      const source = join(root, "source")
      const deniedPrivate = join(root, "denied-private")
      const allowedPrivate = join(root, "allowed-private")
      mkdirSync(source)
      const script = join(source, "agent-script")
      writeFileSync(
        script,
        '#!/bin/sh\nprintf shebang-ran > "$AIRLOCK_PRIVATE/shebang-ran"\n'
      )
      chmodSync(script, 0o700)

      const cell = yield* Cell
      const denied = yield* cell.run(
        new CellRequest({
          sourceWorkspace: source,
          privateWorkspace: deniedPrivate,
          process: new ProcessRequest({
            executable: script,
            args: [],
            cwd: source,
            env: { AIRLOCK_PRIVATE: deniedPrivate },
            stdout: "capture",
            stderr: "capture",
            outputLimitBytes: 64 * 1024,
            timeoutMs: 5_000
          })
        })
      )

      expect(denied.processReceipt.exitCode).not.toBe(0)
      expect(existsSync(join(deniedPrivate, "shebang-ran"))).toBe(false)

      const allowed = yield* cell.run(
        new CellRequest({
          sourceWorkspace: source,
          privateWorkspace: allowedPrivate,
          descendantExecutables: ["/bin/sh", "/bin/bash"],
          process: new ProcessRequest({
            executable: script,
            args: [],
            cwd: source,
            env: { AIRLOCK_PRIVATE: allowedPrivate },
            stdout: "capture",
            stderr: "capture",
            outputLimitBytes: 64 * 1024,
            timeoutMs: 5_000
          })
        })
      )
      expect(allowed.processReceipt.exitCode).toBe(0)
      expect(readFileSync(join(allowedPrivate, "shebang-ran"), "utf8")).toBe(
        "shebang-ran"
      )
    }).pipe(Effect.provide(CellTestLive))
  )
})
