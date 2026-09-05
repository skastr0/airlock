#!/usr/bin/env bun
/**
 * Required host-native Bun evidence gate.
 *
 * ProcessRunner depends on Bun's subprocess semantics. Linux additionally uses
 * Bun FFI for its host primitives and compiles a fresh native launcher; macOS
 * retains its explicit proof scripts. A green generic test command cannot
 * silently substitute for either boundary.
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

if (process.platform === "linux") {
  const expectedNativeTests = 13
  const nativeResult = run([
    "scripts/run-tests.ts",
    "test/linux-native.test.ts"
  ])
  const nativeOutput = `${nativeResult.stdout}\n${nativeResult.stderr}`
  if (
    !nativeOutput.includes(`Tests  ${expectedNativeTests} passed`) &&
    !nativeOutput.includes(`Tests   ${expectedNativeTests} passed`)
  ) {
    throw new Error(
      `Linux native evidence was incomplete; expected exactly ${expectedNativeTests} passing tests.\n${nativeOutput}`
    )
  }
  console.log(JSON.stringify({
    gate: "linux-native-contained",
    status: "passed",
    tests: expectedNativeTests
  }))
  process.exit(0)
}

if (process.platform !== "darwin") {
  console.log(JSON.stringify({
    gate: "host-native-cell",
    status: "skipped",
    reason: `unsupported host platform: ${process.platform}`
  }))
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
    privateTempIsolated: Schema.Literal(true),
    privateTempExcludedFromDelta: Schema.Literal(true),
    driftAbsent: Schema.Literal(true)
  }),
  evidence: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
})

const ExecutableEdgesProof = Schema.Struct({
  proof: Schema.Literal("airlock-executable-edges-v1"),
  ok: Schema.Literal(true),
  platform: Schema.Literal("darwin"),
  assertions: Schema.Struct({
    unlistedDescendantDenied: Schema.Literal(true),
    listedDescendantAllowed: Schema.Literal(true),
    unlistedShebangChainDenied: Schema.Literal(true),
    listedShebangChainAllowed: Schema.Literal(true),
    deniedReceiptOmitsTouch: Schema.Literal(true),
    allowedReceiptBindsTouchAsDescendant: Schema.Literal(true),
    workspaceRootRebased: Schema.Literal(true)
  })
})

const InProcessBoundaryProof = Schema.Struct({
  _tag: Schema.Literal("Succeeded"),
  proof: Schema.Literal("airlock-inprocess-boundary-macos-v1"),
  ok: Schema.Literal(true),
  platform: Schema.Literal("darwin"),
  boundary: Schema.Literal(
    "declared exec-edge fencing does not mediate code interpreted in-process by an admitted executable"
  ),
  assertions: Schema.Struct({
    processSucceeded: Schema.Literal(true),
    bashEnvSourced: Schema.Literal(true),
    onlyRootExecutableBound: Schema.Literal(true),
    privateWriteSucceeded: Schema.Literal(true),
    liveWriteDenied: Schema.Literal(true),
    networkDenied: Schema.Literal(true),
    sourceUnchanged: Schema.Literal(true),
    deltaObserved: Schema.Literal(true),
    driftAbsent: Schema.Literal(true)
  })
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
    assertions: 8
  })
)

const edgeResult = run(["run", "scripts/prove-executable-edges.ts"])
const edgeProofLine = edgeResult.stdout
  .trim()
  .split("\n")
  .findLast((line) => line.trim().startsWith("{"))
if (edgeProofLine === undefined) {
  throw new Error(
    `executable-edge proof emitted no JSON evidence:\n${edgeResult.stderr || edgeResult.stdout}`
  )
}
Schema.decodeUnknownSync(ExecutableEdgesProof)(
  JSON.parse(edgeProofLine)
)
console.log(
  JSON.stringify({
    gate: "macos-executable-edges",
    status: "passed",
    assertions: 7
  })
)

const inProcessResult = run(["run", "scripts/prove-inprocess-boundary.ts"])
const inProcessProofLine = inProcessResult.stdout
  .trim()
  .split("\n")
  .findLast((line) => line.trim().startsWith("{"))
if (inProcessProofLine === undefined) {
  throw new Error(
    `in-process boundary proof emitted no JSON evidence:\n${inProcessResult.stderr || inProcessResult.stdout}`
  )
}
Schema.decodeUnknownSync(InProcessBoundaryProof)(
  JSON.parse(inProcessProofLine)
)
console.log(
  JSON.stringify({
    gate: "macos-inprocess-boundary",
    status: "passed",
    assertions: 9
  })
)
