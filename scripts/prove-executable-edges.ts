/**
 * Required Bun/macOS proof for exact executable-edge enforcement. Vitest runs
 * under Node in this repository, so these Seatbelt facts must be exercised by
 * the real Bun process used by the release binary.
 */
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
import { Cell, CellLive, CellRequest } from "../src/cell/index.ts"
import { MacosPlatformLive } from "../src/platform/macos/index.ts"
import {
  ProcessRequest,
  ProcessRunnerLive
} from "../src/process/Process.ts"

const CellProofLive = CellLive.pipe(
  Layer.provide(Layer.merge(MacosPlatformLive, ProcessRunnerLive))
)
const decoded = new TextDecoder()

const request = (
  sourceWorkspace: string,
  privateWorkspace: string,
  script: string,
  descendantExecutables: ReadonlyArray<string>
) =>
  new CellRequest({
    sourceWorkspace,
    privateWorkspace,
    descendantExecutables: [...descendantExecutables],
    process: new ProcessRequest({
      executable: "/bin/sh",
      args: ["-c", script],
      cwd: sourceWorkspace,
      env: { AIRLOCK_PRIVATE: privateWorkspace },
      stdout: "capture",
      stderr: "capture",
      outputLimitBytes: 64 * 1024,
      timeoutMs: 5_000
    })
  })

const emit = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`)

if (
  process.platform !== "darwin" ||
  !existsSync("/usr/bin/sandbox-exec")
) {
  emit({
    proof: "airlock-executable-edges-v1",
    ok: false,
    platform: process.platform,
    skipped: true,
    reason: "proof requires macOS sandbox-exec"
  })
  process.exitCode = 2
} else {
  const root = mkdtempSync(join(tmpdir(), "airlock-executable-edges-"))
  const source = join(root, "source")
  mkdirSync(source)
  const shebang = join(source, "agent-script")
  writeFileSync(
    shebang,
    '#!/bin/sh\nprintf shebang-ran > "$AIRLOCK_PRIVATE/shebang-ran"\n'
  )
  chmodSync(shebang, 0o700)

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cell = yield* Cell

        const deniedPrivate = join(root, "denied-private")
        const denied = yield* cell.run(
          request(
            source,
            deniedPrivate,
            'if /usr/bin/touch "$AIRLOCK_PRIVATE/descendant"; then printf allowed; else printf denied; fi',
            ["/bin/bash"]
          )
        )

        const allowedPrivate = join(root, "allowed-private")
        const allowed = yield* cell.run(
          request(
            source,
            allowedPrivate,
            'if /usr/bin/touch "$AIRLOCK_PRIVATE/descendant"; then printf allowed; else printf denied; fi',
            ["/bin/bash", "/usr/bin/touch"]
          )
        )

        const deniedShebangPrivate = join(root, "denied-shebang-private")
        const deniedShebang = yield* cell.run(
          new CellRequest({
            sourceWorkspace: source,
            privateWorkspace: deniedShebangPrivate,
            process: new ProcessRequest({
              executable: shebang,
              args: [],
              cwd: source,
              env: { AIRLOCK_PRIVATE: deniedShebangPrivate },
              stdout: "capture",
              stderr: "capture",
              outputLimitBytes: 64 * 1024,
              timeoutMs: 5_000
            })
          })
        )

        const allowedShebangPrivate = join(root, "allowed-shebang-private")
        const allowedShebang = yield* cell.run(
          new CellRequest({
            sourceWorkspace: source,
            privateWorkspace: allowedShebangPrivate,
            descendantExecutables: ["/bin/sh", "/bin/bash"],
            process: new ProcessRequest({
              executable: shebang,
              args: [],
              cwd: source,
              env: { AIRLOCK_PRIVATE: allowedShebangPrivate },
              stdout: "capture",
              stderr: "capture",
              outputLimitBytes: 64 * 1024,
              timeoutMs: 5_000
            })
          })
        )

        return {
          denied,
          deniedPrivate,
          allowed,
          allowedPrivate,
          deniedShebang,
          deniedShebangPrivate,
          allowedShebang,
          allowedShebangPrivate
        }
      }).pipe(Effect.provide(CellProofLive))
    )

    const assertions = {
      unlistedDescendantDenied:
        decoded.decode(result.denied.processReceipt.stdout) === "denied" &&
        !existsSync(join(result.deniedPrivate, "descendant")),
      listedDescendantAllowed:
        decoded.decode(result.allowed.processReceipt.stdout) === "allowed" &&
        existsSync(join(result.allowedPrivate, "descendant")),
      unlistedShebangChainDenied:
        result.deniedShebang.processReceipt.exitCode !== 0 &&
        !existsSync(join(result.deniedShebangPrivate, "shebang-ran")),
      listedShebangChainAllowed:
        result.allowedShebang.processReceipt.exitCode === 0 &&
        readFileSync(
          join(result.allowedShebangPrivate, "shebang-ran"),
          "utf8"
        ) === "shebang-ran",
      deniedReceiptOmitsTouch:
        result.denied.executableBindings.every(
          (binding) => binding.requested !== "/usr/bin/touch"
        ),
      allowedReceiptBindsTouchAsDescendant:
        result.allowed.executableBindings.some(
          (binding) =>
            binding.requested === "/usr/bin/touch" &&
            binding.role === "descendant"
        ),
      workspaceRootRebased:
        result.allowedShebang.executableBindings.some(
          (binding) =>
            binding.requested === shebang &&
            binding.role === "root" &&
            binding.workspaceRebased &&
            binding.launch.startsWith(
              `${result.allowedShebang.privateWorkspace}/`
            )
        )
    }
    const ok = Object.values(assertions).every(Boolean)
    emit({
      proof: "airlock-executable-edges-v1",
      ok,
      platform: process.platform,
      assertions,
      evidence: {
        root,
        deniedDescendantError: decoded
          .decode(result.denied.processReceipt.stderr)
          .trim(),
        deniedShebangError: decoded
          .decode(result.deniedShebang.processReceipt.stderr)
          .trim()
      }
    })
    if (!ok) process.exitCode = 1
  } catch (cause) {
    emit({
      proof: "airlock-executable-edges-v1",
      ok: false,
      platform: process.platform,
      error: cause instanceof Error ? cause.message : String(cause)
    })
    process.exitCode = 1
  }
}
