#!/usr/bin/env bun
/**
 * Required Bun/macOS evidence gate.
 *
 * Vitest workers run under Node, so a green Vitest run cannot execute the
 * ProcessRunner tests or construct a native Cell itself. Keep those boundaries
 * explicit here: execute the Bun test file, require its complete expected test
 * count, then Schema-decode the native Cell construction proof.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Schema } from "effect"

const repository = resolve(import.meta.dir, "..")
const decoder = new TextDecoder()
const expectedProcessTests = 11

const run = (args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdout = decoder.decode(result.stdout)
  const stderr = decoder.decode(result.stderr)
  if (result.exitCode !== 0) {
    throw new Error(
      `Bun integration command failed (${args.join(" ")}):\n${stderr || stdout}`
    )
  }
  return { stdout, stderr }
}

const processResult = run(["test", "test/process.test.ts"])
const processOutput = `${processResult.stdout}\n${processResult.stderr}`
const processSummary = new RegExp(
  `(?:^|\\n)\\s*${expectedProcessTests} pass\\s*(?:\\n|$)`
)
if (
  !processSummary.test(processOutput) ||
  !processOutput.includes(`Ran ${expectedProcessTests} tests across 1 file.`)
) {
  throw new Error(
    `ProcessRunner evidence was incomplete; expected exactly ${expectedProcessTests} passing Bun tests.\n${processOutput}`
  )
}
console.log(
  JSON.stringify({
    gate: "bun-process-runner",
    status: "passed",
    tests: expectedProcessTests
  })
)

if (process.platform !== "darwin") {
  console.log(
    JSON.stringify({
      gate: "macos-native-cell",
      status: "skipped",
      reason: `intentional platform skip: host is ${process.platform}, expected darwin`
    })
  )
  process.exit(0)
}

if (!existsSync("/usr/bin/sandbox-exec")) {
  throw new Error(
    "macOS native Cell evidence is required, but /usr/bin/sandbox-exec is unavailable"
  )
}

const CellProof = Schema.Struct({
  proof: Schema.Literal("airlock-cell-native-contained-v1"),
  ok: Schema.Literal(true),
  platform: Schema.Literal("darwin"),
  assertions: Schema.Struct({
    liveWriteDenied: Schema.Literal(true),
    privateWriteSucceeded: Schema.Literal(true),
    loopbackDenied: Schema.Literal(true),
    sourceUnchanged: Schema.Literal(true),
    deltaObserved: Schema.Literal(true),
    driftAbsent: Schema.Literal(true)
  }),
  evidence: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
})

const cellResult = run(["run", "scripts/prove-cell.ts"])
const proofLine = cellResult.stdout
  .trim()
  .split("\n")
  .findLast((line) => line.trim().startsWith("{"))
if (proofLine === undefined) {
  throw new Error(
    `native Cell proof emitted no JSON evidence:\n${cellResult.stderr || cellResult.stdout}`
  )
}

Schema.decodeUnknownSync(CellProof)(JSON.parse(proofLine))
console.log(
  JSON.stringify({
    gate: "macos-native-cell",
    status: "passed",
    assertions: 6
  })
)
