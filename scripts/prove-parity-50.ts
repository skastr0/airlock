#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"

const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)))
const agentEntrypoint = join(repository, "src", "agent-cli.ts")
const repetitions = 5

export const ParityCaseId = Schema.Literal(
  "capture-observe",
  "managed-files",
  "structured-argv",
  "environment",
  "text-stdin",
  "artifact-pipeline",
  "failure-branch",
  "bounded-control",
  "native-rewrite",
  "native-create"
)
export type ParityCaseId = typeof ParityCaseId.Type

const AgentProfile = Schema.Literal("compatibility", "native-contained")
type AgentProfile = typeof AgentProfile.Type

const GitCommitSha = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{40}$/)
)

export const ParitySourceProvenance = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("git-checkout"),
    root: Schema.String,
    headSha: GitCommitSha,
    workingTreeDirty: Schema.Boolean
  }),
  Schema.Struct({
    kind: Schema.Literal("unversioned-source-tree"),
    root: Schema.String,
    commitIdentity: Schema.Literal("unavailable"),
    workingTreeState: Schema.Literal("unavailable"),
    reason: Schema.Literal(
      "repository-local .git metadata is absent; no commit identity or worktree state is claimed"
    )
  })
)
export type ParitySourceProvenance = typeof ParitySourceProvenance.Type

const CompactArtifact = Schema.Struct({
  id: Schema.String,
  mediaType: Schema.String,
  byteLength: Schema.Number,
  provenance: Schema.String
})

const CompactPlan = Schema.Struct({
  id: Schema.String,
  actionReference: Schema.String,
  nodeCount: Schema.Number
})

const AgentProgramReport = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/program-run/v1"),
  profile: AgentProfile,
  workspace: Schema.String,
  result: Schema.Struct({
    state: Schema.Literal("succeeded", "failed", "partial"),
    result: Schema.Unknown,
    plans: Schema.Array(CompactPlan),
    counts: Schema.Struct({
      plans: Schema.Number,
      actions: Schema.Number,
      artifacts: Schema.Number
    }),
    artifacts: Schema.Array(CompactArtifact),
    failure: Schema.optional(Schema.Struct({
      action: Schema.String,
      phase: Schema.String,
      causeTag: Schema.optional(Schema.String),
      reason: Schema.String
    }))
  })
})
type AgentProgramReport = typeof AgentProgramReport.Type

export class ParityCaseDefinitionEvidence extends Schema.Class<ParityCaseDefinitionEvidence>(
  "ParityCaseDefinitionEvidence"
)({
  caseId: ParityCaseId,
  profile: AgentProfile,
  description: Schema.String,
  coverage: Schema.Array(Schema.String)
}) {}

export class ParityExecutionOutcome extends Schema.Class<ParityExecutionOutcome>(
  "ParityExecutionOutcome"
)({
  caseId: ParityCaseId,
  repetition: Schema.Number,
  profile: AgentProfile,
  success: Schema.Literal(true),
  cliExitCode: Schema.Literal(0),
  durationMillis: Schema.Number,
  reportState: Schema.Literal("succeeded"),
  planCount: Schema.Number,
  actionCount: Schema.Number,
  artifactCount: Schema.Number,
  reportBytes: Schema.Number,
  assertions: Schema.Array(Schema.String)
}) {}

export class Parity50Evidence extends Schema.Class<Parity50Evidence>(
  "Parity50Evidence"
)({
  schemaVersion: Schema.Literal("airlock/parity-50-proof/v2"),
  source: ParitySourceProvenance,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  environment: Schema.Struct({
    platform: Schema.Literal("darwin"),
    architecture: Schema.String,
    macosVersion: Schema.String,
    macosBuild: Schema.String,
    bunVersion: Schema.String,
    agentEntrypoint: Schema.String
  }),
  matrix: Schema.Struct({
    uniqueCaseCount: Schema.Literal(10),
    repetitionsPerCase: Schema.Literal(5),
    executionCount: Schema.Literal(50),
    successCount: Schema.Literal(50),
    compatibilityExecutions: Schema.Literal(40),
    nativeContainedExecutions: Schema.Literal(10),
    cases: Schema.Array(ParityCaseDefinitionEvidence)
  }),
  latency: Schema.Struct({
    wallClockMillis: Schema.Number,
    totalInvocationMillis: Schema.Number,
    minimumMillis: Schema.Number,
    medianMillis: Schema.Number,
    p95Millis: Schema.Number,
    maximumMillis: Schema.Number,
    meanMillis: Schema.Number
  }),
  coverage: Schema.Array(Schema.String),
  limitations: Schema.Array(Schema.String),
  outcomes: Schema.Array(ParityExecutionOutcome)
}) {}

class ParityProofFailed extends Schema.TaggedError<ParityProofFailed>()(
  "ParityProofFailed",
  {
    phase: Schema.Literal(
      "preflight",
      "fixture",
      "agent-subprocess",
      "report-decode",
      "assertion",
      "evidence"
    ),
    caseId: Schema.optional(ParityCaseId),
    repetition: Schema.optional(Schema.Number),
    reason: Schema.String
  }
) {}

interface CaseDefinition {
  readonly caseId: ParityCaseId
  readonly profile: AgentProfile
  readonly description: string
  readonly coverage: ReadonlyArray<string>
}

interface PreparedCase {
  readonly root: string
  readonly workspace: string
  readonly home: string
  readonly policy?: string
  readonly source: string
  readonly bindings: Readonly<Record<string, string | boolean | number>>
}

const caseDefinitions: ReadonlyArray<CaseDefinition> = [
  {
    caseId: "capture-observe",
    profile: "compatibility",
    description: "Inspect, read, stat, list, and glob a fresh workspace.",
    coverage: ["Capture", "file.inspect", "file.read", "file.stat", "file.list", "file.glob"]
  },
  {
    caseId: "managed-files",
    profile: "compatibility",
    description: "Create, write, copy, move, read, and remove managed files.",
    coverage: ["Apply", "Hold", "file.mkdir", "file.write", "file.copy", "file.move", "file.remove"]
  },
  {
    caseId: "structured-argv",
    profile: "compatibility",
    description: "Preserve hostile-looking text as one literal argv atom.",
    coverage: ["Invoke", "structured argv", "stdout capture"]
  },
  {
    caseId: "environment",
    profile: "compatibility",
    description: "Project one explicit environment value into an invoked Unix tool.",
    coverage: ["Invoke", "explicit environment", "stdout capture"]
  },
  {
    caseId: "text-stdin",
    profile: "compatibility",
    description: "Send explicit text stdin to an existing Unix executable.",
    coverage: ["Invoke", "text stdin", "stdout capture"]
  },
  {
    caseId: "artifact-pipeline",
    profile: "compatibility",
    description: "Connect two processes through a captured stdout artifact.",
    coverage: ["Invoke", "artifact stdin", "process graph", "stdout capture"]
  },
  {
    caseId: "failure-branch",
    profile: "compatibility",
    description: "Observe a nonzero process receipt and take a bounded fallback branch.",
    coverage: ["Invoke", "nonzero exit", "failure evidence", "if control"]
  },
  {
    caseId: "bounded-control",
    profile: "compatibility",
    description: "Execute a finite range of managed writes and a conditional read.",
    coverage: ["bounded for", "if control", "Apply", "Capture", "Hold"]
  },
  {
    caseId: "native-rewrite",
    profile: "native-contained",
    description: "Rewrite a live file in a private Cell and merge through Apply.",
    coverage: ["native-contained", "Cell", "Invoke", "Apply", "Hold", "network deny"]
  },
  {
    caseId: "native-create",
    profile: "native-contained",
    description: "Create a file in a private Cell and merge through Apply.",
    coverage: ["native-contained", "Cell", "Invoke", "Apply", "Hold", "network deny"]
  }
]

const caseSources: Readonly<Record<ParityCaseId, string>> = {
  "capture-observe": [
    'let inspected = file.inspect({ path: "input.txt" })',
    'let observed = file.read({ path: "input.txt", format: "text" })',
    'let metadata = file.stat({ path: "input.txt" })',
    'let entries = file.list({ path: "." })',
    'let matches = file.glob({ root: ".", pattern: "**/*.txt" })',
    "return { inspected: inspected, observed: observed, metadata: metadata, entries: entries, matches: matches }"
  ].join("\n"),
  "managed-files": [
    'let directory = file.mkdir({ path: "generated/deep", parents: true })',
    'let written = file.write({ path: "generated/deep/written.txt", content: "written bytes\\n" })',
    'let copied = file.copy({ source: "source.txt", destination: "generated/deep/copied.txt" })',
    'let moved = file.move({ source: "generated/deep/copied.txt", destination: "generated/final.txt" })',
    'let observed = file.read({ path: "generated/final.txt", format: "text" })',
    'let removed = file.remove({ path: "source.txt" })',
    "return { directory: directory.state, written: written.state, copied: copied.state, moved: moved.state, observed: observed, removed: removed.state }"
  ].join("\n"),
  "structured-argv": [
    'let invoked = process.run({ executable: "/usr/bin/printf", args: ["%s", "literal; touch should-not-exist"], cwd: workspace, stdin: "discard", stdout: "capture", stderr: "capture", cellProfile: "compatibility" })',
    "return { state: invoked.state, exit_code: invoked.exit_code, stdout: invoked.stdout }"
  ].join("\n"),
  "environment": [
    'let invoked = process.run({ executable: "/usr/bin/printenv", args: ["AIRLOCK_PARITY_VALUE"], cwd: workspace, env: { AIRLOCK_PARITY_VALUE: "explicit-value" }, stdin: "discard", stdout: "capture", stderr: "capture", cellProfile: "compatibility" })',
    "return { state: invoked.state, exit_code: invoked.exit_code, stdout: invoked.stdout }"
  ].join("\n"),
  "text-stdin": [
    'let invoked = process.run({ executable: "/bin/cat", args: [], cwd: workspace, stdin: { kind: "text", value: "stdin payload\\n" }, stdout: "capture", stderr: "capture", cellProfile: "compatibility" })',
    "return { state: invoked.state, exit_code: invoked.exit_code, stdout: invoked.stdout }"
  ].join("\n"),
  "artifact-pipeline": [
    'let produced = process.run({ executable: "/usr/bin/printf", args: ["%s", "artifact payload\\n"], cwd: workspace, stdin: "discard", stdout: "capture", stderr: "capture", cellProfile: "compatibility" })',
    'let transformed = process.run({ executable: "/usr/bin/tr", args: ["a-z", "A-Z"], cwd: workspace, stdin: { kind: "artifact", id: produced.stdout_artifact.id }, stdout: "capture", stderr: "capture", cellProfile: "compatibility" })',
    "return { first_state: produced.state, second_state: transformed.state, output: transformed.stdout }"
  ].join("\n"),
  "failure-branch": [
    'let attempted = process.run({ executable: "/usr/bin/false", args: [], cwd: workspace, stdin: "discard", stdout: "capture", stderr: "capture", cellProfile: "compatibility" })',
    "if attempted.exit_code == 0 {",
    '  return { branch: "unexpected-success", process_state: attempted.state, exit_code: attempted.exit_code }',
    "} else {",
    '  return { branch: "fallback", process_state: attempted.state, exit_code: attempted.exit_code }',
    "}"
  ].join("\n"),
  "bounded-control": [
    "for index in 0..3 {",
    '  let written = file.write({ path: "bounded.txt", content: "bounded iteration\\n" })',
    '  assert written.state == "applied", "bounded write failed"',
    "}",
    "if enabled {",
    '  let observed = file.read({ path: "bounded.txt", format: "text" })',
    '  return { branch: "enabled", iterations: 3, observed: observed }',
    "} else {",
    '  return { branch: "disabled", iterations: 0, observed: "" }',
    "}"
  ].join("\n"),
  "native-rewrite":
    'return process.run({ executable: "/bin/cp", args: ["replacement.txt", "live.txt"], cwd: workspace, stdin: "discard", stdout: "capture", stderr: "capture", cellProfile: "native-contained" })',
  "native-create":
    'return process.run({ executable: "/usr/bin/touch", args: ["native-created.txt"], cwd: workspace, stdin: "discard", stdout: "capture", stderr: "capture", cellProfile: "native-contained" })'
}

const failureReason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const proofFailure = (
  phase: ParityProofFailed["phase"],
  cause: unknown,
  context: {
    readonly caseId?: ParityCaseId
    readonly repetition?: number
  } = {}
) =>
  new ParityProofFailed({
    phase,
    reason: failureReason(cause),
    ...(context.caseId === undefined ? {} : { caseId: context.caseId }),
    ...(context.repetition === undefined ? {} : { repetition: context.repetition })
  })

const assert: (
  condition: boolean,
  message: string
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

const commandText = (
  executable: string,
  args: ReadonlyArray<string>
): string => {
  const result = spawnSync(executable, [...args], {
    cwd: repository,
    encoding: "utf8",
    timeout: 30_000
  })
  assert(result.error === undefined, `${executable} failed to start: ${failureReason(result.error)}`)
  assert(
    result.status === 0,
    `${executable} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
  )
  return result.stdout.trim()
}

const nativeExecutableFor = (caseId: ParityCaseId): string | undefined =>
  caseId === "native-rewrite"
    ? "/bin/cp"
    : caseId === "native-create"
      ? "/usr/bin/touch"
      : undefined

const prepareCase = (
  definition: CaseDefinition,
  repetition: number
): PreparedCase => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `airlock-parity-50-${definition.caseId}-${repetition}-`))
  )
  const workspace = join(root, "workspace")
  const home = join(root, "airlock-home")
  mkdirSync(workspace)

  switch (definition.caseId) {
    case "capture-observe": {
      mkdirSync(join(workspace, "nested"))
      writeFileSync(join(workspace, "input.txt"), "capture payload\n")
      writeFileSync(join(workspace, "nested", "item.txt"), "nested payload\n")
      writeFileSync(join(workspace, "notes.md"), "not a glob match\n")
      break
    }
    case "managed-files": {
      writeFileSync(join(workspace, "source.txt"), "source bytes\n")
      break
    }
    case "native-rewrite": {
      writeFileSync(join(workspace, "live.txt"), "before\n")
      writeFileSync(join(workspace, "replacement.txt"), "after\n")
      break
    }
    default:
      break
  }

  const canonicalWorkspace = realpathSync(workspace)
  const executable = nativeExecutableFor(definition.caseId)
  const policy = executable === undefined
    ? undefined
    : join(root, "policy.json")

  if (policy !== undefined) {
    writeFileSync(policy, JSON.stringify({
      schemaVersion: "airlock/admission-policy/v1",
      profile: "native-contained",
      principal: `agent:parity-50:${definition.caseId}`,
      realm: "local",
      admittedBy: "operator:parity-50-proof",
      pathAllowlist: [`${canonicalWorkspace}/**`],
      executableAllowlist: [executable],
      executableEdges: [],
      endpointAllowlist: []
    }))
  }

  return {
    root,
    workspace: canonicalWorkspace,
    home,
    ...(policy === undefined ? {} : { policy }),
    source: caseSources[definition.caseId],
    bindings: {
      workspace: canonicalWorkspace,
      enabled: true,
      repetition
    }
  }
}

const decodeResult = <A, I>(
  schema: Schema.Schema<A, I, never>,
  report: AgentProgramReport
): A => Schema.decodeUnknownSync(schema)(report.result.result)

const validateCase = (
  definition: CaseDefinition,
  prepared: PreparedCase,
  report: AgentProgramReport
): ReadonlyArray<string> => {
  assert(report.profile === definition.profile, "agent report changed the supervisor-pinned profile")
  assert(report.workspace === prepared.workspace, "agent report changed the canonical workspace")
  assert(report.result.state === "succeeded", `program ended ${report.result.state}`)
  assert(report.result.counts.plans === report.result.plans.length, "plan count projection drifted")
  assert(report.result.counts.artifacts === report.result.artifacts.length, "artifact count projection drifted")

  switch (definition.caseId) {
    case "capture-observe": {
      const value = decodeResult(
        Schema.Struct({
          inspected: Schema.Struct({ kind: Schema.String, bytes: Schema.Number }),
          observed: Schema.String,
          metadata: Schema.Struct({ kind: Schema.String, bytes: Schema.Number }),
          entries: Schema.Array(Schema.Struct({ name: Schema.String })),
          matches: Schema.Array(Schema.String)
        }),
        report
      )
      assert(value.observed === "capture payload\n", "file.read returned unexpected bytes")
      assert(value.inspected.kind === "file" && value.inspected.bytes === 16, "file.inspect evidence changed")
      assert(value.metadata.kind === "file" && value.metadata.bytes === 16, "file.stat evidence changed")
      assert(
        value.entries.map(({ name }) => name).sort().join(",") === "input.txt,nested,notes.md",
        "file.list returned unexpected entries"
      )
      assert(value.matches.length === 2, "file.glob did not return both text files")
      return ["captured bytes", "captured identity and metadata", "listed and globbed workspace"]
    }
    case "managed-files": {
      const value = decodeResult(
        Schema.Struct({
          directory: Schema.String,
          written: Schema.String,
          copied: Schema.String,
          moved: Schema.String,
          observed: Schema.String,
          removed: Schema.String
        }),
        report
      )
      assert(
        [value.directory, value.written, value.copied, value.moved, value.removed]
          .every((state) => state === "applied"),
        "one managed mutation did not apply"
      )
      assert(value.observed === "source bytes\n", "managed move changed file bytes")
      assert(!existsSync(join(prepared.workspace, "source.txt")), "managed remove left its source live")
      assert(!existsSync(join(prepared.workspace, "generated", "deep", "copied.txt")), "managed move left its source live")
      assert(
        readFileSync(join(prepared.workspace, "generated", "final.txt"), "utf8") === "source bytes\n",
        "managed move did not install its target"
      )
      return ["all mutations applied", "removed sources absent", "moved target bytes preserved"]
    }
    case "structured-argv": {
      const value = decodeResult(
        Schema.Struct({
          state: Schema.String,
          exit_code: Schema.Number,
          stdout: Schema.String
        }),
        report
      )
      assert(value.state === "succeeded" && value.exit_code === 0, "structured process did not succeed")
      assert(value.stdout === "literal; touch should-not-exist", "argv atom changed in transit")
      assert(!existsSync(join(prepared.workspace, "should-not-exist")), "argv text was interpreted as a command")
      return ["literal argv preserved", "exit code captured", "no command-string interpretation"]
    }
    case "environment": {
      const value = decodeResult(
        Schema.Struct({
          state: Schema.String,
          exit_code: Schema.Number,
          stdout: Schema.String
        }),
        report
      )
      assert(value.state === "succeeded" && value.exit_code === 0, "environment process did not succeed")
      assert(value.stdout === "explicit-value\n", "explicit environment value was not projected")
      return ["explicit environment projected", "stdout captured"]
    }
    case "text-stdin": {
      const value = decodeResult(
        Schema.Struct({
          state: Schema.String,
          exit_code: Schema.Number,
          stdout: Schema.String
        }),
        report
      )
      assert(value.state === "succeeded" && value.exit_code === 0, "stdin process did not succeed")
      assert(value.stdout === "stdin payload\n", "text stdin changed in transit")
      return ["text stdin preserved", "stdout captured"]
    }
    case "artifact-pipeline": {
      const value = decodeResult(
        Schema.Struct({
          first_state: Schema.String,
          second_state: Schema.String,
          output: Schema.String
        }),
        report
      )
      assert(
        value.first_state === "succeeded" && value.second_state === "succeeded",
        "artifact pipeline process failed"
      )
      assert(value.output === "ARTIFACT PAYLOAD\n", "artifact stdin pipeline changed output")
      assert(report.result.counts.plans === 2, "artifact pipeline did not lower to two plans")
      return ["two Invoke plans completed", "stdout artifact became stdin", "transformed output captured"]
    }
    case "failure-branch": {
      const value = decodeResult(
        Schema.Struct({
          branch: Schema.String,
          process_state: Schema.String,
          exit_code: Schema.Number
        }),
        report
      )
      assert(value.branch === "fallback", "nonzero process selected the wrong branch")
      assert(value.process_state === "failed" && value.exit_code === 1, "nonzero process evidence changed")
      return ["nonzero exit preserved", "failed process evidence returned", "fallback branch selected"]
    }
    case "bounded-control": {
      const value = decodeResult(
        Schema.Struct({
          branch: Schema.String,
          iterations: Schema.Number,
          observed: Schema.String
        }),
        report
      )
      assert(value.branch === "enabled" && value.iterations === 3, "bounded control selected the wrong result")
      assert(value.observed === "bounded iteration\n", "bounded write/read bytes changed")
      assert(report.result.counts.actions === 4, "bounded control did not execute three writes and one read")
      return ["finite range executed three times", "conditional branch selected", "managed bytes captured"]
    }
    case "native-rewrite": {
      const value = decodeResult(
        Schema.Struct({
          state: Schema.String,
          exit_code: Schema.Number,
          receipts: Schema.Array(Schema.Struct({
            sequence: Schema.Number,
            state: Schema.String
          }))
        }),
        report
      )
      assert(value.state === "succeeded" && value.exit_code === 0, "native rewrite failed")
      assert(value.receipts.length === 2, "native rewrite omitted Invoke or Apply receipt")
      assert(report.result.plans[0]?.nodeCount === 2, "native rewrite did not lower to Invoke plus Apply")
      assert(readFileSync(join(prepared.workspace, "live.txt"), "utf8") === "after\n", "native delta was not applied live")
      return ["native Cell process succeeded", "Invoke and Apply receipted", "live bytes merged through Hold"]
    }
    case "native-create": {
      const value = decodeResult(
        Schema.Struct({
          state: Schema.String,
          exit_code: Schema.Number,
          receipts: Schema.Array(Schema.Struct({
            sequence: Schema.Number,
            state: Schema.String
          }))
        }),
        report
      )
      assert(value.state === "succeeded" && value.exit_code === 0, "native create failed")
      assert(value.receipts.length === 2, "native create omitted Invoke or Apply receipt")
      assert(report.result.plans[0]?.nodeCount === 2, "native create did not lower to Invoke plus Apply")
      assert(existsSync(join(prepared.workspace, "native-created.txt")), "native-created file was not applied live")
      return ["native Cell process succeeded", "Invoke and Apply receipted", "created file merged through Hold"]
    }
  }
}

const runOne = (
  definition: CaseDefinition,
  repetition: number
): Effect.Effect<ParityExecutionOutcome, ParityProofFailed> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => prepareCase(definition, repetition),
      catch: (cause) => proofFailure("fixture", cause, {
        caseId: definition.caseId,
        repetition
      })
    })

    const environment: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment["AIRLOCK_POLICY_FILE"]
    delete environment["AIRLOCK_AGENT_PROFILE"]
    environment["AIRLOCK_HOME"] = prepared.home
    environment["AIRLOCK_AGENT_PROFILE"] = definition.profile
    environment["NO_COLOR"] = "1"
    if (prepared.policy !== undefined) {
      environment["AIRLOCK_POLICY_FILE"] = prepared.policy
    }

    const started = Date.now()
    const executed = yield* Effect.try({
      try: () =>
        spawnSync(
          process.execPath,
          [
            agentEntrypoint,
            "eval",
            "--compact",
            "--workspace",
            prepared.workspace,
            "--bindings",
            JSON.stringify(prepared.bindings),
            "--source",
            prepared.source
          ],
          {
            cwd: repository,
            env: environment,
            encoding: "utf8",
            timeout: 45_000,
            maxBuffer: 4 * 1024 * 1024
          }
        ),
      catch: (cause) => proofFailure("agent-subprocess", cause, {
        caseId: definition.caseId,
        repetition
      })
    })
    const durationMillis = Date.now() - started

    if (executed.error !== undefined) {
      return yield* Effect.fail(proofFailure("agent-subprocess", executed.error, {
        caseId: definition.caseId,
        repetition
      }))
    }
    if (executed.status !== 0) {
      const diagnostic = (executed.stderr || executed.stdout).trim().slice(-4_000)
      return yield* Effect.fail(proofFailure(
        "agent-subprocess",
        `exit ${executed.status ?? "null"}: ${diagnostic}`,
        { caseId: definition.caseId, repetition }
      ))
    }

    const report = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(AgentProgramReport)(
          JSON.parse(executed.stdout)
        ),
      catch: (cause) => proofFailure("report-decode", cause, {
        caseId: definition.caseId,
        repetition
      })
    })
    const assertions = yield* Effect.try({
      try: () => validateCase(definition, prepared, report),
      catch: (cause) => proofFailure("assertion", cause, {
        caseId: definition.caseId,
        repetition
      })
    })

    return new ParityExecutionOutcome({
      caseId: definition.caseId,
      repetition,
      profile: definition.profile,
      success: true,
      cliExitCode: 0,
      durationMillis,
      reportState: "succeeded",
      planCount: report.result.counts.plans,
      actionCount: report.result.counts.actions,
      artifactCount: report.result.counts.artifacts,
      reportBytes: Buffer.byteLength(executed.stdout),
      assertions: [...assertions]
    })
  })

const percentile = (
  sorted: ReadonlyArray<number>,
  fraction: number
): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0

const preflight = () => {
  assert(process.platform === "darwin", "the parity-50 proof requires macOS")
  assert(existsSync(agentEntrypoint), `agent entrypoint is missing: ${agentEntrypoint}`)
  for (const executable of [
    "/bin/cat",
    "/bin/cp",
    "/usr/bin/false",
    "/usr/bin/printenv",
    "/usr/bin/printf",
    "/usr/bin/sandbox-exec",
    "/usr/bin/touch",
    "/usr/bin/tr"
  ]) {
    assert(existsSync(executable), `required executable is unavailable: ${executable}`)
  }
  assert(caseDefinitions.length === 10, "case matrix must contain exactly ten cases")
  assert(new Set(caseDefinitions.map(({ caseId }) => caseId)).size === 10, "case ids must be unique")
  assert(
    caseDefinitions.filter(({ profile }) => profile === "native-contained").length >= 2,
    "case matrix must contain at least two native-contained cases"
  )

  const source: ParitySourceProvenance = existsSync(join(repository, ".git"))
    ? (() => {
        const gitRoot = realpathSync(
          commandText("/usr/bin/git", ["rev-parse", "--show-toplevel"])
        )
        assert(
          gitRoot === repository,
          `repository-local .git resolved to a different worktree root: ${gitRoot}`
        )
        return {
          kind: "git-checkout" as const,
          root: repository,
          headSha: Schema.decodeUnknownSync(GitCommitSha)(
            commandText("/usr/bin/git", ["rev-parse", "HEAD"])
          ),
          workingTreeDirty:
            commandText("/usr/bin/git", ["status", "--short"]).length > 0
        }
      })()
    : {
        kind: "unversioned-source-tree",
        root: repository,
        commitIdentity: "unavailable",
        workingTreeState: "unavailable",
        reason:
          "repository-local .git metadata is absent; no commit identity or worktree state is claimed"
      }

  return {
    source,
    macosVersion: commandText("/usr/bin/sw_vers", ["-productVersion"]),
    macosBuild: commandText("/usr/bin/sw_vers", ["-buildVersion"])
  }
}

export const runParity50Proof = (): Promise<Parity50Evidence> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const metadata = yield* Effect.try({
        try: preflight,
        catch: (cause) => proofFailure("preflight", cause)
      })
      const startedAt = new Date()
      const tasks = Array.from({ length: repetitions }, (_, index) => index + 1)
        .flatMap((repetition) =>
          caseDefinitions.map((definition) => ({ definition, repetition }))
        )
      const outcomes = yield* Effect.forEach(
        tasks,
        ({ definition, repetition }) => runOne(definition, repetition),
        { concurrency: 1 }
      )
      const finishedAt = new Date()
      const durations = outcomes.map(({ durationMillis }) => durationMillis)
      const sortedDurations = [...durations].sort((left, right) => left - right)
      const totalInvocationMillis = durations.reduce((sum, value) => sum + value, 0)
      const successCount = outcomes.filter(({ success }) => success).length
      assert(outcomes.length === 50, `expected 50 outcomes, got ${outcomes.length}`)
      assert(successCount === 50, `expected 50 successes, got ${successCount}`)

      const evidence = new Parity50Evidence({
        schemaVersion: "airlock/parity-50-proof/v2",
        source: metadata.source,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        environment: {
          platform: "darwin",
          architecture: process.arch,
          macosVersion: metadata.macosVersion,
          macosBuild: metadata.macosBuild,
          bunVersion: process.versions.bun ?? "unknown",
          agentEntrypoint
        },
        matrix: {
          uniqueCaseCount: 10,
          repetitionsPerCase: 5,
          executionCount: 50,
          successCount: 50,
          compatibilityExecutions: 40,
          nativeContainedExecutions: 10,
          cases: caseDefinitions.map((definition) =>
            new ParityCaseDefinitionEvidence({
              ...definition,
              coverage: [...definition.coverage]
            })
          )
        },
        latency: {
          wallClockMillis: finishedAt.getTime() - startedAt.getTime(),
          totalInvocationMillis,
          minimumMillis: sortedDurations[0] ?? 0,
          medianMillis: percentile(sortedDurations, 0.5),
          p95Millis: percentile(sortedDurations, 0.95),
          maximumMillis: sortedDurations.at(-1) ?? 0,
          meanMillis: Number((totalInvocationMillis / outcomes.length).toFixed(2))
        },
        coverage: [
          "Capture through inspect/read/stat/list/glob",
          "managed Apply through mkdir/write/copy/move/remove and Hold",
          "structured executable and argv atoms",
          "explicit environment and text stdin",
          "captured artifact-to-stdin process composition",
          "nonzero process evidence with bounded fallback branching",
          "finite range and conditional control",
          "native-contained private Cell Invoke plus live Apply"
        ],
        limitations: [
          "50 means ten deterministic scripted cases repeated five times, not fifty unique tasks.",
          "No model generated these programs and no model task-completion rate is measured.",
          "There is no direct-shell A/B baseline, latency comparison, or task-quality comparison.",
          "There is no held-out corpus or independent task selection.",
          "Compatibility executions provide structured coverage and receipts, not containment.",
          "The two native-contained cases cover only the published regular-file macOS envelope.",
          "Network dispatch, PTY/job control, daemons, live databases, and special files are outside this proof."
        ],
        outcomes: [...outcomes]
      })

      return yield* Effect.try({
        try: () => {
          const encoded = Schema.encodeSync(Parity50Evidence)(evidence)
          return Schema.decodeUnknownSync(Parity50Evidence)(encoded)
        },
        catch: (cause) => proofFailure("evidence", cause)
      })
    })
  )

if (import.meta.main) {
  try {
    const report = await runParity50Proof()
    const encoded = Schema.encodeSync(Parity50Evidence)(report)
    const decoded = Schema.decodeUnknownSync(Parity50Evidence)(encoded)
    console.log(JSON.stringify(decoded, null, 2))
  } catch (cause) {
    console.error(failureReason(cause))
    process.exitCode = 1
  }
}
