#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import {
  ProcessCancelled,
  ProcessOutputLimitExceeded,
  ProcessRequest,
  ProcessRunner,
  ProcessRunnerLive,
  ProcessTimedOut
} from "../src/process/Process.ts"

const repository = fileURLToPath(new URL("../", import.meta.url))
const fixtureProgram = join(
  repository,
  "examples",
  "vouch",
  "host-workflow.air"
)
const endpoint =
  "https://realm.example.invalid/v1/runtime-events?sensitive=query"

const NodeSummary = Schema.Union(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    dependsOn: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    id: Schema.String,
    _tag: Schema.String,
    dependsOn: Schema.Array(Schema.String)
  })
)

const PlanSummary = Schema.Struct({
  id: Schema.String,
  actionReference: Schema.String,
  nodes: Schema.Array(NodeSummary)
})

const ProcessResult = Schema.Struct({
  state: Schema.String,
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  receipts: Schema.Array(
    Schema.Struct({
      node_id: Schema.String,
      sequence: Schema.Number,
      state: Schema.String,
      error_tag: Schema.NullOr(Schema.String),
      output_artifacts: Schema.Array(Schema.String)
    })
  )
})

const NativeStat = Schema.Struct({
  path: Schema.String,
  kind: Schema.String,
  bytes: Schema.Number,
  mode: Schema.Number,
  device: Schema.Number,
  inode: Schema.Number
})

const WorkflowValue = Schema.Struct({
  tree: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      stat: NativeStat
    })
  ),
  state_entries: Schema.Array(Schema.String),
  backup_directory: Schema.Struct({
    state: Schema.String,
    action: Schema.String,
    path: Schema.String,
    act_ids: Schema.Array(Schema.String)
  }),
  packed: ProcessResult,
  archive: NativeStat,
  members: Schema.String,
  member_count: Schema.String,
  argv: Schema.String,
  copied: Schema.Struct({
    state: Schema.String,
    act_id: Schema.String,
    source: Schema.String,
    target: Schema.String,
    previous_held: Schema.Boolean,
    bytes: Schema.Number
  }),
  moved: Schema.Struct({
    state: Schema.String,
    install_act_id: Schema.String,
    remove_act_id: Schema.String,
    source: Schema.String,
    target: Schema.String
  }),
  removed: Schema.Struct({
    state: Schema.String,
    act_id: Schema.String,
    target: Schema.String,
    kind: Schema.String
  }),
  staged: Schema.Struct({
    state: Schema.String,
    action: Schema.String,
    emission_id: Schema.String,
    method: Schema.String,
    endpoint: Schema.String,
    hold_millis: Schema.Number
  })
})

const CliProgramReport = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/program-run/v1"),
  profile: Schema.Literal("native-contained"),
  workspace: Schema.String,
  result: Schema.Struct({
    result: WorkflowValue,
    plans: Schema.Array(PlanSummary),
    // The supervisor CLI may publish either artifact summaries or the
    // Schema-encoded Program artifacts. This proof does not consume them;
    // artifact flow is asserted through the process results above.
    artifacts: Schema.Array(Schema.Unknown)
  })
})

const Held = Schema.Struct({
  id: Schema.String,
  act: Schema.String,
  target: Schema.String,
  kind: Schema.String,
  hasPayload: Schema.Boolean,
  status: Schema.String,
  at: Schema.String
})

const Pending = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  intent: Schema.Struct({
    kind: Schema.String,
    method: Schema.String,
    endpoint: Schema.String,
    headerNames: Schema.Array(Schema.String),
    bodyBytes: Schema.Number
  })
})

const ProcessBoundaryEvidence = Schema.Struct({
  timeout: Schema.Struct({
    tag: Schema.Literal("ProcessTimedOut"),
    pid: Schema.Number,
    elapsedMs: Schema.Number
  }),
  cancellation: Schema.Struct({
    tag: Schema.Literal("ProcessCancelled"),
    pid: Schema.Number,
    elapsedMs: Schema.Number
  }),
  outputBound: Schema.Struct({
    tag: Schema.Literal("ProcessOutputLimitExceeded"),
    pid: Schema.Number,
    capturedBytes: Schema.Number
  })
})

export class VouchOperationsProofReport extends Schema.Class<VouchOperationsProofReport>(
  "VouchOperationsProofReport"
)({
  schemaVersion: Schema.Literal("airlock/vouch-operations-proof/v1"),
  platform: Schema.String,
  workspace: Schema.String,
  sourcePatterns: Schema.Array(
    Schema.Struct({
      operation: Schema.String,
      sourceLines: Schema.String,
      airlock: Schema.String
    })
  ),
  workflow: Schema.Struct({
    planCount: Schema.Number,
    nodeKinds: Schema.Array(Schema.String),
    treeEntries: Schema.Array(Schema.String),
    matchedStateEntries: Schema.Number,
    snapshotBytes: Schema.Number,
    members: Schema.Array(Schema.String),
    memberCount: Schema.Number,
    argv: Schema.Array(Schema.String),
    finalBackupBytes: Schema.Number,
    staleRemoved: Schema.Boolean
  }),
  processBoundaries: ProcessBoundaryEvidence,
  holdUndo: Schema.Struct({
    target: Schema.String,
    hadPayload: Schema.Boolean,
    restoredLegacyBytes: Schema.String
  }),
  outbox: Schema.Struct({
    state: Schema.Literal("staged"),
    pendingCount: Schema.Number,
    endpoint: Schema.String,
    headerNames: Schema.Array(Schema.String),
    bodyBytes: Schema.Number
  })
}) {}

const assert: (
  condition: boolean,
  message: string
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Vouch operations proof failed: ${message}`)
}

const nodeKind = (node: typeof NodeSummary.Type): string =>
  "kind" in node ? node.kind : node._tag

const json = <A, I>(
  schema: Schema.Schema<A, I, never>,
  raw: string
): A => Schema.decodeUnknownSync(schema)(JSON.parse(raw))

const runCli = (
  args: ReadonlyArray<string>,
  home: string,
  policy: string
) => {
  const result = spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: repository,
    env: {
      ...process.env,
      AIRLOCK_HOME: home,
      AIRLOCK_POLICY_FILE: policy
    },
    encoding: "utf8",
    timeout: 60_000
  })
  assert(
    result.status === 0,
    `airlock ${args[0] ?? ""} failed: ${result.stderr || result.stdout}`
  )
  return result.stdout
}

const makeFixture = () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "airlock-vouch-operations-"))
  )
  const workspace = join(root, "workspace")
  const state = join(workspace, "state")
  const sessions = join(state, "sessions")
  const backups = join(workspace, "backups")
  const snapshot = join(workspace, "snapshot.tgz")
  const stagedBackup = join(backups, ".snapshot.partial.tgz")
  const finalBackup = join(backups, "hermes-state.tgz")
  const stale = join(workspace, "stale-runtime.pid")
  const home = join(root, "airlock-home")
  const policy = join(root, "policy.json")
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(state, "SOUL.md"), "agent soul\n")
  writeFileSync(join(sessions, "session.json"), '{"id":"session-1"}\n')
  writeFileSync(snapshot, "legacy snapshot bytes\n")
  writeFileSync(stale, "999999\n")
  writeFileSync(policy, JSON.stringify({
    schemaVersion: "airlock/admission-policy/v1",
    profile: "native-contained",
    principal: "agent:vouch-operations-proof",
    realm: "local",
    admittedBy: "operator:vouch-operations-proof",
    grantTtlMillis: 300_000,
    pathAllowlist: [`${workspace}/**`],
    executableAllowlist: [
      "/usr/bin/printf",
      "/usr/bin/tar",
      "/usr/bin/wc"
    ],
    endpointAllowlist: [endpoint]
  }))
  return {
    root,
    workspace,
    state,
    backups,
    snapshot,
    stagedBackup,
    finalBackup,
    stale,
    home,
    policy
  }
}

const processRequest = (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options: {
    readonly timeoutMs?: number
    readonly outputLimitBytes?: number
  } = {}
) =>
  new ProcessRequest({
    executable,
    args: [...args],
    cwd,
    env: {},
    stdin: "discard",
    stdout: "capture",
    stderr: "capture",
    outputLimitBytes: options.outputLimitBytes ?? 4_096,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs })
  })

const processBoundaryProof = (workspace: string) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner

    const timeoutStarted = Date.now()
    const timedOut = yield* runner.run(
      processRequest("/bin/sleep", ["5"], workspace, { timeoutMs: 25 }),
      { killGraceMs: 10 }
    ).pipe(Effect.flip)
    assert(
      timedOut instanceof ProcessTimedOut,
      `expected ProcessTimedOut, got ${timedOut._tag}`
    )

    const controller = new AbortController()
    const cancellationStarted = Date.now()
    const cancelTimer = setTimeout(() => controller.abort(), 25)
    const cancelled = yield* runner.run(
      processRequest("/bin/sleep", ["5"], workspace),
      { signal: controller.signal, killGraceMs: 10 }
    ).pipe(Effect.flip)
    clearTimeout(cancelTimer)
    assert(
      cancelled instanceof ProcessCancelled,
      `expected ProcessCancelled, got ${cancelled._tag}`
    )

    const bounded = yield* runner.run(
      processRequest("/usr/bin/yes", [], workspace, {
        outputLimitBytes: 128,
        timeoutMs: 2_000
      }),
      { killGraceMs: 10 }
    ).pipe(Effect.flip)
    assert(
      bounded instanceof ProcessOutputLimitExceeded,
      `expected ProcessOutputLimitExceeded, got ${bounded._tag}`
    )

    return {
      timeout: {
        tag: "ProcessTimedOut" as const,
        pid: timedOut.receipt.pid,
        elapsedMs: Date.now() - timeoutStarted
      },
      cancellation: {
        tag: "ProcessCancelled" as const,
        pid: cancelled.receipt.pid,
        elapsedMs: Date.now() - cancellationStarted
      },
      outputBound: {
        tag: "ProcessOutputLimitExceeded" as const,
        pid: bounded.receipt.pid,
        capturedBytes:
          bounded.receipt.stdout.byteLength +
          bounded.receipt.stderr.byteLength
      }
    }
  }).pipe(Effect.provide(ProcessRunnerLive))

export const runVouchOperationsProof =
  async (): Promise<VouchOperationsProofReport> => {
    assert(process.platform === "darwin", "native-contained proof requires macOS")
    for (const executable of [
      "/bin/sleep",
      "/usr/bin/printf",
      "/usr/bin/sandbox-exec",
      "/usr/bin/tar",
      "/usr/bin/wc",
      "/usr/bin/yes"
    ]) {
      assert(existsSync(executable), `${executable} is unavailable`)
    }

    const fixture = makeFixture()
    const bindings = {
      workspace: fixture.workspace,
      state_dir: fixture.state,
      backup_dir: fixture.backups,
      snapshot: fixture.snapshot,
      staged_backup: fixture.stagedBackup,
      final_backup: fixture.finalBackup,
      stale_file: fixture.stale,
      endpoint
    }
    const rawWorkflow = runCli([
      "run",
      fixtureProgram,
      "--workspace",
      fixture.workspace,
      "--profile",
      "native-contained",
      "--bindings",
      JSON.stringify(bindings)
    ], fixture.home, fixture.policy)
    const workflow = json(CliProgramReport, rawWorkflow)
    const value = workflow.result.result

    assert(value.packed.state === "succeeded", "tar snapshot did not succeed")
    assert(value.packed.receipts.length === 2, "tar did not produce Invoke+Apply receipts")
    assert(value.members.includes("state/SOUL.md"), "archive omitted SOUL.md")
    assert(
      value.members.includes("state/sessions/session.json"),
      "archive omitted session state"
    )
    assert(!existsSync(fixture.stale), "stale file was not held")
    assert(existsSync(fixture.finalBackup), "final backup was not installed")
    assert(!existsSync(fixture.stagedBackup), "move retained its source")

    const held = json(
      Schema.Array(Held),
      runCli(["held"], fixture.home, fixture.policy)
    )
    const snapshotHold = held.find(
      (candidate) =>
        candidate.target === fixture.snapshot ||
        candidate.target.endsWith("/workspace/snapshot.tgz")
    )
    assert(snapshotHold !== undefined, "snapshot overwrite is absent from Hold")
    assert(snapshotHold!.hasPayload, "prior snapshot bytes were not retained")

    runCli(["undo", snapshotHold!.id], fixture.home, fixture.policy)
    const restoredLegacyBytes = readFileSync(fixture.snapshot, "utf8")
    assert(
      restoredLegacyBytes === "legacy snapshot bytes\n",
      "targeted undo did not restore the prior snapshot"
    )

    const pending = json(
      Schema.Array(Pending),
      runCli(["pending"], fixture.home, fixture.policy)
    )
    assert(pending.length === 1, `expected one staged intent, got ${pending.length}`)
    assert(pending[0]!.status === "staged", "external intent is not inert")

    const processBoundaries = await Effect.runPromise(
      processBoundaryProof(fixture.workspace)
    )
    const members = value.members.trim().split("\n").filter(Boolean)
    const memberCount = Number(value.member_count.trim())
    assert(
      memberCount === members.length,
      "stdout artifact pipeline produced the wrong member count"
    )

    const argv = value.argv.trim().split("\n")
    const expectedArgv = [
      "--gateway",
      "local",
      "--gateway-endpoint",
      "unix:///tmp/gateway.sock",
      "sandbox",
      "exec",
      "--name",
      "alice",
      "--no-tty",
      "--timeout",
      "180",
      "--",
      "/usr/bin/python3",
      "-I",
      "-S"
    ]
    assert(
      JSON.stringify(argv) === JSON.stringify(expectedArgv),
      "structured argv atoms changed in transit"
    )

    return new VouchOperationsProofReport({
      schemaVersion: "airlock/vouch-operations-proof/v1",
      platform: process.platform,
      workspace: fixture.workspace,
      sourcePatterns: [
        {
          operation: "bounded process group",
          sourceLines: "box-runtime-v1.py:2888-2947",
          airlock: "ProcessRequest + ProcessRunner receipt"
        },
        {
          operation: "structured OpenShell argv",
          sourceLines: "box-runtime-v1.py:2989-3024",
          airlock: "Invoke executable + argv atoms"
        },
        {
          operation: "state snapshot and transfer staging",
          sourceLines: "box-runtime-v1.py:5853-5953",
          airlock: "Capture + Invoke(tar) + Apply + file copy/move"
        },
        {
          operation: "state restore and receipt",
          sourceLines: "box-runtime-v1.py:5956-6027",
          airlock: "Invoke(existing tool/helper) + Apply + receipt"
        },
        {
          operation: "state-preserving replacement",
          sourceLines: "box-runtime-v1.py:6041-6129",
          airlock: "bounded composition + Hold + RequestExternal"
        }
      ],
      workflow: {
        planCount: workflow.result.plans.length,
        nodeKinds: workflow.result.plans.flatMap((plan) =>
          plan.nodes.map(nodeKind)
        ),
        treeEntries: value.tree.map((entry) => entry.name),
        matchedStateEntries: value.state_entries.length,
        snapshotBytes: value.archive.bytes,
        members,
        memberCount,
        argv,
        finalBackupBytes: statSync(fixture.finalBackup).size,
        staleRemoved: !existsSync(fixture.stale)
      },
      processBoundaries,
      holdUndo: {
        target: snapshotHold!.target,
        hadPayload: snapshotHold!.hasPayload,
        restoredLegacyBytes
      },
      outbox: {
        state: "staged",
        pendingCount: pending.length,
        endpoint: pending[0]!.intent.endpoint,
        headerNames: [...pending[0]!.intent.headerNames],
        bodyBytes: pending[0]!.intent.bodyBytes
      }
    })
  }

if (import.meta.main) {
  const report = await runVouchOperationsProof()
  const encoded = Schema.encodeSync(VouchOperationsProofReport)(report)
  console.log(JSON.stringify(encoded, null, 2))
}
