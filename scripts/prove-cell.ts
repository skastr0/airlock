/**
 * A runnable construction proof for the native-contained macOS Cell.
 *
 * This is deliberately an integration artifact, not a second Cell API: the
 * contracts and invariants remain in `src/cell`. The script creates only
 * disposable OS-temporary state and reports the observed boundary evidence as
 * one JSON value so CI and a human can independently inspect the claim.
 */
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cell, CellLive, CellRequest } from "../src/cell/index.ts"
import { MacosPlatformLive } from "../src/platform/macos/index.ts"
import { ProcessRequest, ProcessRunnerLive } from "../src/process/Process.ts"

const CellTestLive = CellLive.pipe(Layer.provide(Layer.merge(MacosPlatformLive, ProcessRunnerLive)))

type Proof = {
  readonly proof: "airlock-cell-native-contained-v1"
  readonly ok: boolean
  readonly platform: string
  readonly assertions: Readonly<Record<string, boolean>>
  readonly evidence?: Readonly<Record<string, unknown>>
  readonly error?: string
}

const emit = (proof: Proof) => process.stdout.write(`${JSON.stringify(proof)}\n`)

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

const fail = (error: unknown): never => {
  emit({
    proof: "airlock-cell-native-contained-v1",
    ok: false,
    platform: process.platform,
    assertions: {},
    error: error instanceof Error ? error.message : String(error)
  })
  process.exitCode = 1
  throw error
}

if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
  const reason = process.platform !== "darwin" ? "proof requires macOS" : "sandbox-exec is unavailable"
  emit({
    proof: "airlock-cell-native-contained-v1",
    ok: false,
    platform: process.platform,
    assertions: {},
    error: reason
  })
  process.exitCode = 2
} else {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") })
  try {
    const root = mkdtempSync(join(tmpdir(), "airlock-cell-proof-"))
    const source = join(root, "source")
    const privateWorkspace = join(root, "private")
    const explicitTemp = join(root, "explicit-temp")
    mkdirSync(source)
    mkdirSync(explicitTemp)
    writeFileSync(join(source, "unchanged.txt"), "baseline")

    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const cell = yield* Cell
        return yield* cell.run(
          new CellRequest({
            sourceWorkspace: source,
            privateWorkspace,
            tempPaths: [explicitTemp],
            network: "deny",
            process: command(
              source,
              [
                'if printf live > "$AIRLOCK_LIVE/forbidden.txt"; then echo live-write; else echo live-denied; fi',
                'printf private > "$AIRLOCK_PRIVATE/created.txt"',
                `if /usr/bin/curl --connect-timeout 1 --max-time 1 -fsS http://127.0.0.1:${server.port}/ >/dev/null; then echo network-open; else echo network-denied; fi`
              ].join("; "),
              { AIRLOCK_LIVE: source, AIRLOCK_PRIVATE: privateWorkspace }
            )
          })
        )
      }).pipe(Effect.provide(CellTestLive))
    )

    const output = new TextDecoder().decode(receipt.processReceipt.stdout)
    const assertions = {
      liveWriteDenied: output.includes("live-denied") && !existsSync(join(source, "forbidden.txt")),
      privateWriteSucceeded:
        existsSync(join(privateWorkspace, "created.txt")) &&
        readFileSync(join(privateWorkspace, "created.txt"), "utf8") === "private",
      loopbackDenied: output.includes("network-denied"),
      sourceUnchanged: readFileSync(join(source, "unchanged.txt"), "utf8") === "baseline",
      deltaObserved: receipt.delta.some((item) => item.path === "created.txt" && item.kind === "created"),
      driftAbsent: receipt.drift.length === 0
    }
    const ok = Object.values(assertions).every(Boolean)
    emit({
      proof: "airlock-cell-native-contained-v1",
      ok,
      platform: process.platform,
      assertions,
      evidence: {
        root,
        privateWorkspace: receipt.privateWorkspace,
        processExitCode: receipt.processReceipt.exitCode,
        processOutput: output.trim(),
        delta: receipt.delta.map(({ path, kind }) => ({ path, kind })),
        drift: receipt.drift.map(({ path }) => path)
      }
    })
    if (!ok) process.exitCode = 1
  } catch (error) {
    fail(error)
  } finally {
    server.stop(true)
  }
}
