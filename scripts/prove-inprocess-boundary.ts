/**
 * A bounded macOS/Bun proof of the native Cell's in-process interpretation
 * boundary.
 *
 * Seatbelt can fence process-exec edges, live workspace writes, and network.
 * It does not turn an admitted interpreter into a semantic verifier: /bin/bash
 * may read and interpret an agent-owned BASH_ENV without another exec. That is
 * expected behavior inside the admitted root process, not a containment-test
 * failure. The resulting writes must still remain inside the private view.
 */
import { Effect, Layer, Schema } from "effect"
import {
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

const ProofId = Schema.Literal("airlock-inprocess-boundary-macos-v1")
const BoundaryStatement = Schema.Literal(
  "declared exec-edge fencing does not mediate code interpreted in-process by an admitted executable"
)

class BoundaryAssertions extends Schema.Class<BoundaryAssertions>(
  "BoundaryAssertions"
)({
  processSucceeded: Schema.Boolean,
  bashEnvSourced: Schema.Boolean,
  onlyRootExecutableBound: Schema.Boolean,
  privateWriteSucceeded: Schema.Boolean,
  liveWriteDenied: Schema.Boolean,
  networkDenied: Schema.Boolean,
  sourceUnchanged: Schema.Boolean,
  deltaObserved: Schema.Boolean,
  driftAbsent: Schema.Boolean
}) {}

class ExecutableBindingEvidence extends Schema.Class<ExecutableBindingEvidence>(
  "ExecutableBindingEvidence"
)({
  role: Schema.Literal("root", "descendant"),
  requested: Schema.String,
  launch: Schema.String,
  allowedPaths: Schema.Array(Schema.String),
  workspaceRebased: Schema.Boolean
}) {}

class BoundaryEvidence extends Schema.Class<BoundaryEvidence>(
  "BoundaryEvidence"
)({
  fixtureRoot: Schema.String,
  sourceWorkspace: Schema.String,
  privateWorkspace: Schema.String,
  agentOwnedBashEnv: Schema.String,
  declaredDescendantExecutables: Schema.Array(Schema.String),
  executableBindings: Schema.Array(ExecutableBindingEvidence),
  processExitCode: Schema.NullOr(Schema.Number),
  processStdout: Schema.String,
  processStderr: Schema.String,
  networkRequestsObserved: Schema.Number,
  delta: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literal("created", "modified", "deleted")
    })
  ),
  drift: Schema.Array(Schema.String)
}) {}

class ProofSucceeded extends Schema.TaggedClass<ProofSucceeded>(
  "ProofSucceeded"
)("Succeeded", {
  proof: ProofId,
  ok: Schema.Literal(true),
  platform: Schema.String,
  boundary: BoundaryStatement,
  assertions: BoundaryAssertions,
  evidence: BoundaryEvidence
}) {}

class ProofFailed extends Schema.TaggedClass<ProofFailed>("ProofFailed")(
  "Failed",
  {
    proof: ProofId,
    ok: Schema.Literal(false),
    platform: Schema.String,
    boundary: BoundaryStatement,
    errorTag: Schema.String,
    reason: Schema.String
  }
) {}

const ProofResult = Schema.Union(ProofSucceeded, ProofFailed)
type ProofResult = typeof ProofResult.Type

class ProofUnavailable extends Schema.TaggedError<ProofUnavailable>(
  "ProofUnavailable"
)("ProofUnavailable", {
  reason: Schema.String
}) {}

class ProofSetupFailed extends Schema.TaggedError<ProofSetupFailed>(
  "ProofSetupFailed"
)("ProofSetupFailed", {
  phase: Schema.String,
  reason: Schema.String
}) {}

class ProofAssertionFailed extends Schema.TaggedError<ProofAssertionFailed>(
  "ProofAssertionFailed"
)("ProofAssertionFailed", {
  failed: Schema.Array(Schema.String)
}) {}

const CellProofLive = CellLive.pipe(
  Layer.provide(Layer.merge(MacosPlatformLive, ProcessRunnerLive))
)
const decoded = new TextDecoder()

const reasonOf = (cause: unknown): string => {
  if (cause instanceof ProofAssertionFailed) {
    return `failed assertions: ${cause.failed.join(", ")}`
  }
  if (cause instanceof ProofSetupFailed || cause instanceof ProofUnavailable) {
    return cause.reason
  }
  if (cause instanceof Error) return cause.message
  return String(cause)
}

const tagOf = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause._tag === "string"
    ? cause._tag
    : "UnknownProofFailure"

const emit = (proof: ProofResult): void => {
  const encoded = Schema.encodeSync(ProofResult)(proof)
  process.stdout.write(`${JSON.stringify(encoded)}\n`)
}

const acquireLoopbackServer = Effect.acquireRelease(
  Effect.try({
    try: () => {
      let requests = 0
      const server = Bun.serve({
        port: 0,
        fetch: () => {
          requests += 1
          return new Response("reachable")
        }
      })
      return {
        server,
        requestsObserved: () => requests
      }
    },
    catch: (cause) =>
      new ProofSetupFailed({
        phase: "loopback-server",
        reason: cause instanceof Error ? cause.message : String(cause)
      })
  }),
  ({ server }) => Effect.sync(() => server.stop(true))
)

const prepareFixture = Effect.try({
  try: () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "airlock-inprocess-boundary-")
    )
    const sourceWorkspace = join(fixtureRoot, "source")
    const privateWorkspace = join(fixtureRoot, "private")
    const agentOwnedBashEnv = join(sourceWorkspace, "agent-owned.bashenv")
    mkdirSync(sourceWorkspace)
    const bashEnvSource = [
      "printf 'bash-env-sourced\\n'",
      "printf 'private-from-bash-env\\n' > \"${AIRLOCK_PRIVATE}/inprocess.txt\"",
      "if printf 'forbidden-live-write\\n' > \"${AIRLOCK_LIVE}/forbidden.txt\"; then",
      "  printf 'live-write-open\\n'",
      "else",
      "  printf 'live-write-denied\\n'",
      "fi",
      "if : > \"/dev/tcp/127.0.0.1/${AIRLOCK_PORT}\"; then",
      "  printf 'network-open\\n'",
      "else",
      "  printf 'network-denied\\n'",
      "fi"
    ].join("\n")
    writeFileSync(agentOwnedBashEnv, bashEnvSource)
    return {
      fixtureRoot,
      sourceWorkspace,
      privateWorkspace,
      agentOwnedBashEnv,
      bashEnvSource
    }
  },
  catch: (cause) =>
    new ProofSetupFailed({
      phase: "fixture",
      reason: cause instanceof Error ? cause.message : String(cause)
    })
})

const proof = Effect.scoped(
  Effect.gen(function* () {
    if (
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
    ) {
      return yield* new ProofUnavailable({
        reason: "proof requires macOS with /usr/bin/sandbox-exec"
      })
    }

    const loopback = yield* acquireLoopbackServer
    const fixture = yield* prepareFixture
    const cell = yield* Cell
    const declaredDescendantExecutables: Array<string> = []
    const receipt = yield* cell.run(
      new CellRequest({
        sourceWorkspace: fixture.sourceWorkspace,
        privateWorkspace: fixture.privateWorkspace,
        descendantExecutables: declaredDescendantExecutables,
        network: "deny",
        process: new ProcessRequest({
          executable: "/bin/bash",
          args: ["-c", ":"],
          cwd: fixture.sourceWorkspace,
          env: {
            AIRLOCK_LIVE: fixture.sourceWorkspace,
            AIRLOCK_PRIVATE: fixture.privateWorkspace,
            AIRLOCK_PORT: String(loopback.server.port),
            BASH_ENV: fixture.agentOwnedBashEnv
          },
          stdout: "capture",
          stderr: "capture",
          outputLimitBytes: 64 * 1024,
          timeoutMs: 5_000
        })
      })
    )

    const stdout = decoded.decode(receipt.processReceipt.stdout)
    const stderr = decoded.decode(receipt.processReceipt.stderr)
    const privateMarker = join(
      receipt.privateWorkspace,
      "inprocess.txt"
    )
    const liveMarker = join(fixture.sourceWorkspace, "forbidden.txt")
    const assertions = new BoundaryAssertions({
      processSucceeded: receipt.processReceipt.exitCode === 0,
      bashEnvSourced: stdout.includes("bash-env-sourced"),
      onlyRootExecutableBound:
        declaredDescendantExecutables.length === 0 &&
        receipt.executableBindings.length === 1 &&
        receipt.executableBindings[0]?.role === "root" &&
        receipt.executableBindings[0]?.requested === "/bin/bash",
      privateWriteSucceeded:
        existsSync(privateMarker) &&
        readFileSync(privateMarker, "utf8") === "private-from-bash-env\n",
      liveWriteDenied:
        stdout.includes("live-write-denied") && !existsSync(liveMarker),
      networkDenied:
        stdout.includes("network-denied") &&
        loopback.requestsObserved() === 0,
      sourceUnchanged:
        readFileSync(fixture.agentOwnedBashEnv, "utf8") ===
        fixture.bashEnvSource,
      deltaObserved: receipt.delta.some(
        ({ path, kind }) =>
          path === "inprocess.txt" && kind === "created"
      ),
      driftAbsent: receipt.drift.length === 0
    })
    const failed = Object.entries(assertions)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
    if (failed.length > 0) {
      return yield* new ProofAssertionFailed({ failed })
    }

    return new ProofSucceeded({
      proof: "airlock-inprocess-boundary-macos-v1",
      ok: true,
      platform: process.platform,
      boundary:
        "declared exec-edge fencing does not mediate code interpreted in-process by an admitted executable",
      assertions,
      evidence: new BoundaryEvidence({
        fixtureRoot: fixture.fixtureRoot,
        sourceWorkspace: fixture.sourceWorkspace,
        privateWorkspace: receipt.privateWorkspace,
        agentOwnedBashEnv: fixture.agentOwnedBashEnv,
        declaredDescendantExecutables,
        executableBindings: receipt.executableBindings.map(
          (binding) =>
            new ExecutableBindingEvidence({
              role: binding.role,
              requested: binding.requested,
              launch: binding.launch,
              allowedPaths: [...binding.allowedPaths],
              workspaceRebased: binding.workspaceRebased
            })
        ),
        processExitCode: receipt.processReceipt.exitCode,
        processStdout: stdout.trim(),
        processStderr: stderr.trim(),
        networkRequestsObserved: loopback.requestsObserved(),
        delta: receipt.delta.map(({ path, kind }) => ({ path, kind })),
        drift: receipt.drift.map(({ path }) => path)
      })
    })
  }).pipe(Effect.provide(CellProofLive))
)

await Effect.runPromise(
  proof.pipe(
    Effect.match({
      onFailure: (cause) => {
        emit(
          new ProofFailed({
            proof: "airlock-inprocess-boundary-macos-v1",
            ok: false,
            platform: process.platform,
            boundary:
              "declared exec-edge fencing does not mediate code interpreted in-process by an admitted executable",
            errorTag: tagOf(cause),
            reason: reasonOf(cause)
          })
        )
        process.exitCode = cause instanceof ProofUnavailable ? 2 : 1
      },
      onSuccess: (result) => emit(result)
    })
  )
)
