#!/usr/bin/env bun
/**
 * Cross-platform Vitest entrypoint.
 *
 * Linux's flock(2) adapter uses Bun FFI, so Linux workers must run under Bun.
 * The launcher is built into fresh temporary state and injected explicitly;
 * repository artifacts are neither required nor replaced. macOS retains the
 * existing Node-worker execution used by its suite.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repository = resolve(import.meta.dir, "..")
const forwarded = process.argv.slice(2)
const environment = { ...process.env }

if (process.platform === "linux") {
  const buildRoot = mkdtempSync(join(tmpdir(), "airlock-linux-test-"))
  const launcher = join(buildRoot, "airlock-linux-launcher")
  const build = Bun.spawnSync({
    cmd: ["/bin/sh", "scripts/build-linux-launcher.sh", launcher],
    cwd: repository,
    env: environment,
    stdout: "pipe",
    stderr: "pipe"
  })
  if (build.exitCode !== 0) {
    process.stderr.write(new TextDecoder().decode(build.stderr))
    process.exit(build.exitCode)
  }
  environment.AIRLOCK_LINUX_LAUNCHER = launcher
}

const command = process.platform === "linux"
  ? [process.execPath, "--bun", "x", "vitest", "run"]
  : [process.execPath, "x", "vitest", "run"]
const result = Bun.spawnSync({
  cmd: [
    ...command,
    "--testTimeout",
    "30000",
    "--hookTimeout",
    "30000",
    ...forwarded
  ],
  cwd: repository,
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit"
})
process.exit(result.exitCode)
