#!/usr/bin/env bun
/**
 * Corpus harness: run one candidate Airlock program against one task spec in a
 * fully isolated realm, then classify the outcome.
 *
 * The harness is a measurement adapter, not an authority. It never mutates the
 * repository, never dispatches, and never selects a dispatch class: it only
 * materializes a fixture workspace, invokes the real agent entrypoint
 * (`src/agent-cli.ts`), and decodes the receipts that entrypoint already emits.
 *
 * Isolation is per attempt: a fresh temporary root holds both the workspace and
 * a private `AIRLOCK_HOME`, so Hold leases, Outbox state, the ledger, and the
 * run journal of one attempt never contend with another.
 */
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"

const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)))
const agentEntrypoint = join(repository, "src", "agent-cli.ts")

// ── task spec contract ──────────────────────────────────────────────────────

export const FixtureFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String
})

export const WorkspaceFixture = Schema.Struct({
  directories: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => []
  }),
  files: Schema.optionalWith(Schema.Array(FixtureFile), { default: () => [] })
})

/** Every expectation is decidable from bytes on disk or a decoded receipt. */
export const FileExpectation = Schema.Struct({
  path: Schema.String,
  exists: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  equals: Schema.optional(Schema.String),
  contains: Schema.optional(Schema.Array(Schema.String)),
  notContains: Schema.optional(Schema.Array(Schema.String)),
  minBytes: Schema.optional(Schema.Number)
})

export const ResultExpectation = Schema.Struct({
  /** Dotted path into the program result value; "" selects the whole value. */
  path: Schema.String,
  equals: Schema.optional(Schema.Unknown),
  contains: Schema.optional(Schema.String),
  minLength: Schema.optional(Schema.Number),
  minimum: Schema.optional(Schema.Number)
})

export const SuccessPredicate = Schema.Struct({
  programState: Schema.optionalWith(
    Schema.Literal("succeeded", "failed", "partial"),
    { default: () => "succeeded" as const }
  ),
  files: Schema.optionalWith(Schema.Array(FileExpectation), {
    default: () => []
  }),
  absent: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => []
  }),
  result: Schema.optionalWith(Schema.Array(ResultExpectation), {
    default: () => []
  }),
  outboxStagedCount: Schema.optional(Schema.Number),
  heldCountAtLeast: Schema.optional(Schema.Number)
})

export const CorpusTaskSpec = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/corpus-task/v1"),
  id: Schema.String,
  goal: Schema.String,
  workspaceFixture: WorkspaceFixture,
  /**
   * Bindings the supervisor supplies to the candidate program. `workspace` is
   * always overwritten with the canonical isolated workspace.
   */
  bindings: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) }
  ),
  notes: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  successPredicate: SuccessPredicate
})
export type CorpusTaskSpec = typeof CorpusTaskSpec.Type

// ── receipt contract already emitted by the agent entrypoint ────────────────

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

const ProgramFailure = Schema.Struct({
  action: Schema.String,
  phase: Schema.Literal(
    "language",
    "admission",
    "native-filesystem",
    "runtime",
    "outbox",
    "contract"
  ),
  causeTag: Schema.optional(Schema.String),
  reason: Schema.String
})

const AgentProgramReport = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/program-run/v1"),
  profile: Schema.Literal("compatibility", "native-contained", "vm-enclosed"),
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
    failure: Schema.optional(ProgramFailure)
  })
})
type AgentProgramReport = typeof AgentProgramReport.Type

// ── attempt record ──────────────────────────────────────────────────────────

/**
 * One closed vocabulary for "why did this attempt not pass". `parse` and
 * `contract` are pre-execution refusals, the middle four are typed runtime
 * seams, `predicate` means the program ran clean but did not satisfy the task,
 * and `cli`/`harness` cover the two ways the measurement itself can fail.
 */
export const FailureTaxonomy = Schema.Literal(
  "none",
  "parse",
  "contract",
  "admission",
  "native-filesystem",
  "runtime",
  "outbox",
  "predicate",
  "cli",
  "harness"
)
export type FailureTaxonomy = typeof FailureTaxonomy.Type

export const PredicateCheck = Schema.Struct({
  check: Schema.String,
  passed: Schema.Boolean,
  detail: Schema.String
})

export const ReceiptSummary = Schema.Struct({
  programState: Schema.optional(Schema.String),
  plans: Schema.Number,
  actions: Schema.Number,
  artifacts: Schema.Number,
  artifactBytes: Schema.Number,
  runJournalEntries: Schema.Number,
  outboxStaged: Schema.Number,
  held: Schema.Number
})

export class CorpusAttempt extends Schema.Class<CorpusAttempt>("CorpusAttempt")({
  schemaVersion: Schema.Literal("airlock/corpus-attempt/v1"),
  taskId: Schema.String,
  attemptId: Schema.String,
  programPath: Schema.String,
  programBytes: Schema.Number,
  profile: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  wallMillis: Schema.Number,
  isolation: Schema.Struct({
    root: Schema.String,
    workspace: Schema.String,
    airlockHome: Schema.String
  }),
  outcome: Schema.Literal("passed", "failed"),
  taxonomy: FailureTaxonomy,
  failure: Schema.optional(
    Schema.Struct({
      taxonomy: FailureTaxonomy,
      phase: Schema.optional(Schema.String),
      action: Schema.optional(Schema.String),
      causeTag: Schema.optional(Schema.String),
      reason: Schema.String
    })
  ),
  receipts: ReceiptSummary,
  predicate: Schema.Struct({
    total: Schema.Number,
    passed: Schema.Number,
    checks: Schema.Array(PredicateCheck)
  }),
  cli: Schema.Struct({
    exitCode: Schema.Union(Schema.Number, Schema.Null),
    stdoutBytes: Schema.Number,
    stderrExcerpt: Schema.String
  })
}) {}

export class CorpusReport extends Schema.Class<CorpusReport>("CorpusReport")({
  schemaVersion: Schema.Literal("airlock/corpus-report/v1"),
  generatedAt: Schema.String,
  attemptsDirectory: Schema.String,
  totals: Schema.Struct({
    attempts: Schema.Number,
    passed: Schema.Number,
    failed: Schema.Number,
    uniqueTasks: Schema.Number,
    tasksWithAtLeastOnePass: Schema.Number
  }),
  taxonomy: Schema.Array(
    Schema.Struct({ taxonomy: FailureTaxonomy, attempts: Schema.Number })
  ),
  latency: Schema.Struct({
    minimumMillis: Schema.Number,
    medianMillis: Schema.Number,
    p95Millis: Schema.Number,
    maximumMillis: Schema.Number,
    meanMillis: Schema.Number
  }),
  tasks: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      attempts: Schema.Number,
      passed: Schema.Number,
      firstPassAttempt: Schema.Union(Schema.Number, Schema.Null),
      taxonomy: Schema.Array(
        Schema.Struct({ taxonomy: FailureTaxonomy, attempts: Schema.Number })
      ),
      medianMillis: Schema.Number
    })
  )
}) {}

export class CorpusHarnessFailed extends Schema.TaggedError<CorpusHarnessFailed>()(
  "CorpusHarnessFailed",
  {
    phase: Schema.Literal("arguments", "task-spec", "fixture", "report"),
    reason: Schema.String
  }
) {}

// ── plain helpers ───────────────────────────────────────────────────────────

const failureReason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const harnessFailure = (
  phase: CorpusHarnessFailed["phase"],
  cause: unknown
) => new CorpusHarnessFailed({ phase, reason: failureReason(cause) })

const withinWorkspace = (workspace: string, relative: string): string => {
  if (isAbsolute(relative)) {
    throw new Error(`fixture and expectation paths must be relative: ${relative}`)
  }
  const resolved = resolve(workspace, relative)
  if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) {
    throw new Error(`path escapes the isolated workspace: ${relative}`)
  }
  return resolved
}

const readJsonFile = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"))

const selectPath = (value: unknown, path: string): unknown => {
  if (path.length === 0) return value
  let current = value
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const percentile = (
  sorted: ReadonlyArray<number>,
  fraction: number
): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0

const taxonomyForPhase = (
  phase: typeof ProgramFailure.Type.phase
): FailureTaxonomy => {
  switch (phase) {
    case "language":
      return "parse"
    case "contract":
      return "contract"
    case "admission":
      return "admission"
    case "native-filesystem":
      return "native-filesystem"
    case "outbox":
      return "outbox"
    case "runtime":
      return "runtime"
  }
}

/**
 * A program that never reaches a run result — a parse diagnostic, an unknown
 * action, a rejected CLI atom — is reported by the entrypoint as one tagged
 * error on stderr rather than as a program-run receipt. Classifying it as a
 * bare CLI failure would hide the two taxonomy buckets a repair loop most
 * needs, so the tag is mapped instead.
 */
const stderrDiagnostic = (
  stderr: string
): { readonly taxonomy: FailureTaxonomy; readonly causeTag?: string; readonly reason: string } | undefined => {
  const trimmed = stderr.trim()
  if (!trimmed.startsWith("{")) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.split("\n").at(-1) ?? trimmed)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object") return undefined
  const record = parsed as Record<string, unknown>
  const tag = typeof record["_tag"] === "string" ? record["_tag"] : undefined
  if (tag === undefined) return undefined
  const reason = [record["detail"], record["reason"], record["message"]].find(
    (candidate): candidate is string => typeof candidate === "string"
  ) ?? tag
  const taxonomy: FailureTaxonomy = tag === "LanguageDiagnostic" ||
      tag === "EvaluationError"
    ? "parse"
    : tag === "UnknownProgramAction" || tag === "ProgramActionDecodeFailed"
      ? "contract"
      : "cli"
  return { taxonomy, causeTag: tag, reason }
}

// ── isolation ───────────────────────────────────────────────────────────────

interface Isolation {
  readonly root: string
  readonly workspace: string
  readonly airlockHome: string
}

const prepareIsolation = (spec: CorpusTaskSpec): Isolation => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `airlock-corpus-${spec.id}-`))
  )
  const workspace = join(root, "workspace")
  const airlockHome = join(root, "airlock-home")
  mkdirSync(workspace)
  mkdirSync(airlockHome)
  const canonicalWorkspace = realpathSync(workspace)

  for (const directory of spec.workspaceFixture.directories) {
    mkdirSync(withinWorkspace(canonicalWorkspace, directory), {
      recursive: true
    })
  }
  for (const file of spec.workspaceFixture.files) {
    const target = withinWorkspace(canonicalWorkspace, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
  return { root, workspace: canonicalWorkspace, airlockHome }
}

const agentEnvironment = (
  isolation: Isolation,
  profile: string,
  policy: string | undefined
): Record<string, string> => {
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  delete environment["AIRLOCK_POLICY_FILE"]
  delete environment["AIRLOCK_AGENT_PROFILE"]
  environment["AIRLOCK_HOME"] = isolation.airlockHome
  environment["AIRLOCK_AGENT_PROFILE"] = profile
  environment["NO_COLOR"] = "1"
  if (policy !== undefined) environment["AIRLOCK_POLICY_FILE"] = policy
  return environment
}

/** Read-only agent-surface query used only to summarize receipts. */
const agentQuery = (
  environment: Record<string, string>,
  args: ReadonlyArray<string>
): ReadonlyArray<unknown> => {
  const executed = spawnSync(process.execPath, [agentEntrypoint, ...args], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  })
  if (executed.status !== 0) return []
  try {
    const parsed: unknown = JSON.parse(executed.stdout)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Counted through the agent surface so the number is the published receipt view. */
const runJournalEntries = (environment: Record<string, string>): number =>
  agentQuery(environment, ["runs", "--limit", "100"]).length

// ── predicate evaluation ────────────────────────────────────────────────────

interface Check {
  readonly check: string
  readonly passed: boolean
  readonly detail: string
}

const evaluatePredicate = (
  spec: CorpusTaskSpec,
  isolation: Isolation,
  report: AgentProgramReport | undefined,
  outboxStaged: number,
  held: number
): ReadonlyArray<Check> => {
  const predicate = spec.successPredicate
  const checks: Check[] = []
  const state = report?.result.state

  checks.push({
    check: `program.state == ${predicate.programState}`,
    passed: state === predicate.programState,
    detail: state === undefined ? "no decoded report" : `state=${state}`
  })

  for (const expectation of predicate.files) {
    const target = withinWorkspace(isolation.workspace, expectation.path)
    const present = existsSync(target)
    if (!expectation.exists) {
      checks.push({
        check: `file.absent ${expectation.path}`,
        passed: !present,
        detail: present ? "present" : "absent"
      })
      continue
    }
    if (!present) {
      checks.push({
        check: `file.exists ${expectation.path}`,
        passed: false,
        detail: "missing"
      })
      continue
    }
    const bytes = statSync(target).size
    checks.push({
      check: `file.exists ${expectation.path}`,
      passed: true,
      detail: `${bytes} bytes`
    })
    if (expectation.minBytes !== undefined) {
      checks.push({
        check: `file.minBytes ${expectation.path} >= ${expectation.minBytes}`,
        passed: bytes >= expectation.minBytes,
        detail: `${bytes} bytes`
      })
    }
    if (
      expectation.equals !== undefined ||
      expectation.contains !== undefined ||
      expectation.notContains !== undefined
    ) {
      const text = readFileSync(target, "utf8")
      if (expectation.equals !== undefined) {
        checks.push({
          check: `file.equals ${expectation.path}`,
          passed: text === expectation.equals,
          detail: text === expectation.equals
            ? "exact"
            : `got ${JSON.stringify(text.slice(0, 200))}`
        })
      }
      for (const needle of expectation.contains ?? []) {
        checks.push({
          check: `file.contains ${expectation.path} :: ${needle}`,
          passed: text.includes(needle),
          detail: text.includes(needle) ? "found" : "absent"
        })
      }
      for (const needle of expectation.notContains ?? []) {
        checks.push({
          check: `file.notContains ${expectation.path} :: ${needle}`,
          passed: !text.includes(needle),
          detail: text.includes(needle) ? "found" : "absent"
        })
      }
    }
  }

  for (const relative of predicate.absent) {
    const target = withinWorkspace(isolation.workspace, relative)
    const present = existsSync(target)
    checks.push({
      check: `workspace.absent ${relative}`,
      passed: !present,
      detail: present ? "present" : "absent"
    })
  }

  for (const expectation of predicate.result) {
    const selected = selectPath(report?.result.result, expectation.path)
    const label = expectation.path.length === 0 ? "<root>" : expectation.path
    if (expectation.equals !== undefined) {
      checks.push({
        check: `result.equals ${label}`,
        passed: sameJson(selected, expectation.equals),
        detail: JSON.stringify(selected ?? null).slice(0, 200)
      })
    }
    if (expectation.contains !== undefined) {
      const text = typeof selected === "string" ? selected : JSON.stringify(selected ?? null)
      checks.push({
        check: `result.contains ${label} :: ${expectation.contains}`,
        passed: text.includes(expectation.contains),
        detail: text.slice(0, 200)
      })
    }
    if (expectation.minLength !== undefined) {
      const length = Array.isArray(selected)
        ? selected.length
        : typeof selected === "string"
          ? selected.length
          : -1
      checks.push({
        check: `result.minLength ${label} >= ${expectation.minLength}`,
        passed: length >= expectation.minLength,
        detail: `length=${length}`
      })
    }
    if (expectation.minimum !== undefined) {
      const numeric = typeof selected === "number" ? selected : Number.NaN
      checks.push({
        check: `result.minimum ${label} >= ${expectation.minimum}`,
        passed: numeric >= expectation.minimum,
        detail: `value=${String(selected)}`
      })
    }
  }

  if (predicate.outboxStagedCount !== undefined) {
    checks.push({
      check: `outbox.staged == ${predicate.outboxStagedCount}`,
      passed: outboxStaged === predicate.outboxStagedCount,
      detail: `staged=${outboxStaged}`
    })
  }

  if (predicate.heldCountAtLeast !== undefined) {
    checks.push({
      check: `hold.held >= ${predicate.heldCountAtLeast}`,
      passed: held >= predicate.heldCountAtLeast,
      detail: `held=${held}`
    })
  }

  return checks
}

// ── single-task mode ────────────────────────────────────────────────────────

export interface AttemptOptions {
  readonly taskPath: string
  readonly programPath: string
  readonly profile: string
  readonly policy?: string
  readonly timeoutMillis: number
  readonly attemptId?: string
}

export const runAttempt = (
  options: AttemptOptions
): Effect.Effect<CorpusAttempt, CorpusHarnessFailed> =>
  Effect.gen(function* () {
    const spec = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(CorpusTaskSpec)(readJsonFile(options.taskPath)),
      catch: (cause) => harnessFailure("task-spec", cause)
    })
    const source = yield* Effect.try({
      try: () => readFileSync(options.programPath, "utf8"),
      catch: (cause) => harnessFailure("task-spec", cause)
    })
    const isolation = yield* Effect.try({
      try: () => prepareIsolation(spec),
      catch: (cause) => harnessFailure("fixture", cause)
    })

    const bindings = {
      ...spec.bindings,
      workspace: isolation.workspace
    }
    const environment = agentEnvironment(isolation, options.profile, options.policy)
    const startedAt = new Date()
    const executed = spawnSync(
      process.execPath,
      [
        agentEntrypoint,
        "run",
        options.programPath,
        "--compact",
        "--workspace",
        isolation.workspace,
        "--bindings",
        JSON.stringify(bindings)
      ],
      {
        cwd: repository,
        env: environment,
        encoding: "utf8",
        timeout: options.timeoutMillis,
        maxBuffer: 8 * 1024 * 1024
      }
    )
    const finishedAt = new Date()
    const wallMillis = finishedAt.getTime() - startedAt.getTime()

    let report: AgentProgramReport | undefined
    try {
      report = Schema.decodeUnknownSync(AgentProgramReport)(
        JSON.parse(executed.stdout)
      )
    } catch {
      report = undefined
    }

    const outboxStaged = agentQuery(environment, ["pending"]).length
    const held = agentQuery(environment, ["held"]).length

    const checks = report === undefined
      ? []
      : yield* Effect.try({
          try: () =>
            evaluatePredicate(spec, isolation, report, outboxStaged, held),
          catch: (cause) => harnessFailure("fixture", cause)
        })

    const failed = checks.filter((check) => !check.passed)
    const programFailure = report?.result.failure

    const diagnostic = report === undefined
      ? stderrDiagnostic(executed.stderr ?? "")
      : undefined

    const failure = report === undefined
      ? diagnostic ?? {
          taxonomy: "cli" as const,
          reason: executed.error !== undefined
            ? failureReason(executed.error)
            : `agent entrypoint exit ${executed.status ?? "null"} produced no decodable report`
        }
      : programFailure !== undefined
        ? {
            taxonomy: taxonomyForPhase(programFailure.phase),
            phase: programFailure.phase,
            action: programFailure.action,
            ...(programFailure.causeTag === undefined
              ? {}
              : { causeTag: programFailure.causeTag }),
            reason: programFailure.reason
          }
        : failed.length > 0
          ? {
              taxonomy: "predicate" as const,
              reason: failed
                .map((check) => `${check.check} (${check.detail})`)
                .join("; ")
            }
          : undefined

    const artifactBytes = (report?.result.artifacts ?? []).reduce(
      (sum, artifact) => sum + artifact.byteLength,
      0
    )

    return new CorpusAttempt({
      schemaVersion: "airlock/corpus-attempt/v1",
      taskId: spec.id,
      attemptId: options.attemptId ?? crypto.randomUUID(),
      programPath: options.programPath,
      programBytes: Buffer.byteLength(source),
      profile: options.profile,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      wallMillis,
      isolation,
      outcome: failure === undefined ? "passed" : "failed",
      taxonomy: failure?.taxonomy ?? "none",
      ...(failure === undefined ? {} : { failure }),
      receipts: {
        ...(report === undefined ? {} : { programState: report.result.state }),
        plans: report?.result.counts.plans ?? 0,
        actions: report?.result.counts.actions ?? 0,
        artifacts: report?.result.counts.artifacts ?? 0,
        artifactBytes,
        runJournalEntries: runJournalEntries(environment),
        outboxStaged,
        held
      },
      predicate: {
        total: checks.length,
        passed: checks.length - failed.length,
        checks: checks.map((check) => ({ ...check }))
      },
      cli: {
        exitCode: executed.status,
        stdoutBytes: Buffer.byteLength(executed.stdout ?? ""),
        stderrExcerpt: (executed.stderr ?? "").trim().slice(-1_000)
      }
    })
  })

// ── report mode ─────────────────────────────────────────────────────────────

const histogram = (
  attempts: ReadonlyArray<CorpusAttempt>
): ReadonlyArray<{ taxonomy: FailureTaxonomy; attempts: number }> => {
  const counts = new Map<FailureTaxonomy, number>()
  for (const attempt of attempts) {
    counts.set(attempt.taxonomy, (counts.get(attempt.taxonomy) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([taxonomy, count]) => ({ taxonomy, attempts: count }))
    .sort((left, right) => right.attempts - left.attempts)
}

export const buildReport = (
  attemptsDirectory: string
): Effect.Effect<CorpusReport, CorpusHarnessFailed> =>
  Effect.try({
    try: () => {
      const directory = resolve(attemptsDirectory)
      const files = readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
      const attempts = files.map((name) =>
        Schema.decodeUnknownSync(CorpusAttempt)(readJsonFile(join(directory, name)))
      )
      if (attempts.length === 0) {
        throw new Error(`no attempt JSON files under ${directory}`)
      }
      const durations = [...attempts.map(({ wallMillis }) => wallMillis)].sort(
        (left, right) => left - right
      )
      const taskIds = [...new Set(attempts.map(({ taskId }) => taskId))].sort()
      const tasks = taskIds.map((taskId) => {
        const forTask = attempts.filter((attempt) => attempt.taskId === taskId)
        const ordered = [...forTask].sort((left, right) =>
          left.startedAt.localeCompare(right.startedAt)
        )
        const firstPassIndex = ordered.findIndex(
          (attempt) => attempt.outcome === "passed"
        )
        const taskDurations = [...forTask.map(({ wallMillis }) => wallMillis)]
          .sort((left, right) => left - right)
        return {
          taskId,
          attempts: forTask.length,
          passed: forTask.filter((attempt) => attempt.outcome === "passed").length,
          firstPassAttempt: firstPassIndex === -1 ? null : firstPassIndex + 1,
          taxonomy: histogram(forTask),
          medianMillis: percentile(taskDurations, 0.5)
        }
      })
      const total = durations.reduce((sum, value) => sum + value, 0)

      return new CorpusReport({
        schemaVersion: "airlock/corpus-report/v1",
        generatedAt: new Date().toISOString(),
        attemptsDirectory: directory,
        totals: {
          attempts: attempts.length,
          passed: attempts.filter(({ outcome }) => outcome === "passed").length,
          failed: attempts.filter(({ outcome }) => outcome === "failed").length,
          uniqueTasks: taskIds.length,
          tasksWithAtLeastOnePass: tasks.filter(({ passed }) => passed > 0).length
        },
        taxonomy: histogram(attempts),
        latency: {
          minimumMillis: durations[0] ?? 0,
          medianMillis: percentile(durations, 0.5),
          p95Millis: percentile(durations, 0.95),
          maximumMillis: durations.at(-1) ?? 0,
          meanMillis: Number((total / attempts.length).toFixed(2))
        },
        tasks
      })
    },
    catch: (cause) => harnessFailure("report", cause)
  })

// ── sidechannel brief ───────────────────────────────────────────────────────

/**
 * The cold-start brief a candidate model receives. It is generated, never
 * hand-maintained: the action list and every schema block are the literal
 * stdout of the agent surface, so the brief cannot drift from the contract the
 * corpus actually runs against.
 */
const sidechannelSchemas = [
  "process.run",
  "file.read",
  "file.glob",
  "file.write",
  "http.stage"
] as const

const sidechannelSnippets = [
  { file: "02-control.air", caption: "Bounded control: assert, for, if, and a managed write." },
  { file: "05-pipeline.air", caption: "Two processes joined by a captured stdout artifact — no shell pipe." },
  { file: "10-http-stage.air", caption: "External intent is staged, never sent." }
] as const

const agentStdout = (
  environment: Record<string, string>,
  args: ReadonlyArray<string>
): string => {
  const executed = spawnSync(process.execPath, [agentEntrypoint, ...args], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (executed.status !== 0) {
    throw new Error(
      `airlock-agent ${args.join(" ")} exited ${executed.status ?? "null"}: ${(executed.stderr ?? "").trim().slice(-500)}`
    )
  }
  return executed.stdout.trimEnd()
}

export const emitSidechannel = (
  target: string
): Effect.Effect<string, CorpusHarnessFailed> =>
  Effect.try({
    try: () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "airlock-corpus-sidechannel-"))
      )
      const workspace = join(root, "workspace")
      const home = join(root, "airlock-home")
      mkdirSync(workspace)
      mkdirSync(home)
      const environment: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
      delete environment["AIRLOCK_POLICY_FILE"]
      delete environment["AIRLOCK_AGENT_PROFILE"]
      environment["AIRLOCK_HOME"] = home
      environment["NO_COLOR"] = "1"

      const actions = agentStdout(environment, ["actions", "--workspace", workspace])
      const schemas = sidechannelSchemas.map((name) => ({
        name,
        body: agentStdout(environment, ["schema", name])
      }))
      const snippets = sidechannelSnippets.map((snippet) => ({
        ...snippet,
        body: readFileSync(
          join(repository, "docs", "programs", "snippets", snippet.file),
          "utf8"
        ).trimEnd()
      }))

      const document = [
        "# Airlock cold-start brief",
        "",
        "You write one Airlock program (`.air`). A supervisor runs it for you and",
        "returns a JSON receipt. You have no shell, no repository, and no second",
        "way to reach the world: every effect is one of the actions below.",
        "",
        "## Actions",
        "",
        "The complete verb surface. Nothing else is callable.",
        "",
        "```json",
        actions,
        "```",
        "",
        "## Action input schemas",
        "",
        "Five schemas in full. The remaining verbs take the obvious subset of",
        "`path`, `source`, `destination`, `parents`, and `realm`.",
        "",
        ...schemas.flatMap(({ body, name }) => [
          `### ${name}`,
          "",
          "```json",
          body,
          "```",
          ""
        ]),
        "## Language",
        "",
        "The whole grammar:",
        "",
        "- `let <name> = <expression>` — bind a value. There is no assignment, so a",
        "  loop cannot accumulate into an outer variable.",
        "- `if <expression> { … } else { … }` — the `else` arm is optional.",
        "- `for <name> in <from>..<to> { … }` — finite integer range.",
        "- `for <name> in <captured list> { … }` — iterate a captured list.",
        "- `assert <expression>, \"message\"` — fail the run on a false test.",
        "- `return <expression>` — the program result.",
        "",
        "Values: strings, numbers, booleans, null, durations (`30s`, `5m`), lists",
        "(`[a, b]`), and records (`{ key: value }`). Field access `a.b`, index",
        "access `a[0]`, operators `|| && == != < <= > >= + - * / ! -`. String `+`",
        "concatenates.",
        "",
        "There are no functions, no `while`, no recursion, no imports, no shell",
        "strings, and no way to define a new action. An action call is always an",
        "identifier applied to one record literal.",
        "",
        "Bindings supplied by the supervisor appear as free identifiers. `workspace`",
        "is always bound to the absolute workspace path; use it for `cwd`. File",
        "paths in `file.*` actions are relative to the workspace.",
        "",
        "## Worked programs",
        "",
        ...snippets.flatMap(({ body, caption }) => [
          caption,
          "",
          "```",
          body,
          "```",
          ""
        ]),
        "## Reading a failure and repairing",
        "",
        "A failed run returns a receipt containing a `failure` record:",
        "",
        "```json",
        JSON.stringify(
          {
            state: "failed",
            failure: {
              action: "file.read",
              phase: "runtime",
              causeTag: "RuntimeNodeFailure",
              reason: "runtime node program/<plan>/0/node/0 finished failed"
            }
          },
          null,
          2
        ),
        "```",
        "",
        "Repair from the leaves, not from a guess:",
        "",
        "1. `causeTag` names the typed error that fired. It is the single most",
        "   specific fact available — read it first.",
        "2. `reason` is the leaf message underneath that tag.",
        "3. `phase` names the seam that refused: `language` (the program did not",
        "   parse or evaluate), `contract` (the call did not match the action",
        "   schema), `admission` (policy refused the resource), `native-filesystem`",
        "   or `runtime` (the effect itself failed), `outbox` (staging failed).",
        "4. `action` names the call that failed.",
        "",
        "Change only what the tag and reason implicate, then resubmit the whole",
        "program. A `phase` of `admission` is a refusal, not a bug to work around:",
        "no rewrite of the program can widen what the supervisor granted.",
        ""
      ].join("\n")

      const resolved = resolve(target)
      mkdirSync(dirname(resolved), { recursive: true })
      writeFileSync(resolved, document)
      return resolved
    },
    catch: (cause) => harnessFailure("report", cause)
  })

// ── argument plumbing (glue, deliberately plain) ────────────────────────────

const usage = [
  "corpus-harness — run one candidate program against one corpus task spec",
  "",
  "  single task:",
  "    bun run scripts/corpus-harness.ts --task <spec.json> --program <program.air> --json",
  "      [--profile compatibility|native-contained] [--policy <policy.json>]",
  "      [--timeout-ms 60000] [--attempt-id <id>] [--out <attempt.json>]",
  "",
  "  report over recorded attempts:",
  "    bun run scripts/corpus-harness.ts --report --attempts <directory> [--json]",
  "",
  "  regenerate the cold-start brief handed to a candidate model:",
  "    bun run scripts/corpus-harness.ts --emit-sidechannel examples/corpus/sidechannel.md"
].join("\n")

const parseArguments = (argv: ReadonlyArray<string>) => {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument ${token}\n\n${usage}`)
    }
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) {
      flags.add(name)
      continue
    }
    values.set(name, next)
    index += 1
  }
  return { values, flags }
}

const main = Effect.gen(function* () {
  const { values, flags } = yield* Effect.try({
    try: () => parseArguments(process.argv.slice(2)),
    catch: (cause) => harnessFailure("arguments", cause)
  })

  if (flags.has("help")) {
    console.log(usage)
    return
  }

  const sidechannelTarget = values.get("emit-sidechannel")
  if (sidechannelTarget !== undefined) {
    const written = yield* emitSidechannel(sidechannelTarget)
    console.log(written)
    return
  }

  if (flags.has("report")) {
    const directory = values.get("attempts")
    if (directory === undefined) {
      return yield* Effect.fail(
        harnessFailure("arguments", "--report requires --attempts <directory>")
      )
    }
    const report = yield* buildReport(directory)
    const encoded = Schema.encodeSync(CorpusReport)(report)
    if (flags.has("json") || !flags.has("text")) {
      console.log(JSON.stringify(encoded, null, 2))
      return
    }
    console.log(
      `${report.totals.passed}/${report.totals.attempts} attempts passed across ${report.totals.uniqueTasks} tasks`
    )
    return
  }

  const taskPath = values.get("task")
  const programPath = values.get("program")
  if (taskPath === undefined || programPath === undefined) {
    return yield* Effect.fail(
      harnessFailure("arguments", `--task and --program are required\n\n${usage}`)
    )
  }
  if (!existsSync(agentEntrypoint)) {
    return yield* Effect.fail(
      harnessFailure("arguments", `agent entrypoint is missing: ${agentEntrypoint}`)
    )
  }

  const attempt = yield* runAttempt({
    taskPath: resolve(taskPath),
    programPath: resolve(programPath),
    profile: values.get("profile") ?? "compatibility",
    ...(values.get("policy") === undefined
      ? {}
      : { policy: resolve(values.get("policy")!) }),
    timeoutMillis: Number(values.get("timeout-ms") ?? 60_000),
    ...(values.get("attempt-id") === undefined
      ? {}
      : { attemptId: values.get("attempt-id")! })
  })

  const encoded = Schema.encodeSync(CorpusAttempt)(attempt)
  const out = values.get("out")
  if (out !== undefined) {
    const target = resolve(out)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(encoded, null, 2)}\n`)
  }
  if (flags.has("json")) {
    console.log(JSON.stringify(encoded, null, 2))
  } else {
    console.log(
      [
        `task      ${attempt.taskId}`,
        `outcome   ${attempt.outcome} (${attempt.taxonomy})`,
        `predicate ${attempt.predicate.passed}/${attempt.predicate.total}`,
        `receipts  plans=${attempt.receipts.plans} actions=${attempt.receipts.actions} artifacts=${attempt.receipts.artifacts} staged=${attempt.receipts.outboxStaged} held=${attempt.receipts.held}`,
        `wall      ${attempt.wallMillis} ms`,
        `workspace ${attempt.isolation.workspace}`,
        ...(attempt.failure === undefined ? [] : [`reason    ${attempt.failure.reason}`])
      ].join("\n")
    )
  }
  if (attempt.outcome !== "passed") process.exitCode = 1
})

if (import.meta.main) {
  await Effect.runPromise(main).catch((cause: unknown) => {
    console.error(failureReason(cause))
    process.exitCode = 2
  })
}
