import { describe, expect, it } from "@effect/vitest"
import { readFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import {
  ApplyNode,
  ArtifactId,
  CaptureNode,
  InvokeNode,
  NodeId,
  PlanDraft,
  PlanId,
  RequestExternalNode,
  RequirementId,
  ResourceRequirement,
  orderPlan
} from "../src/plan/index.ts"
import {
  parseSync,
  type CallExpression,
  type Expression,
  type Program,
  type Statement
} from "../src/language/index.ts"
import type {
  LanguageRecord,
  LanguageValue
} from "../src/language/evaluator.ts"
import {
  InlineArtifact,
  ProgramActionExecutor,
  ProgramActionRequest,
  ProgramActionResult,
  ProgramRequest,
  ProgramRunner,
  ProgramRunnerLive
} from "../src/program/index.ts"

const corpusRoot = new URL("../examples/vouch/", import.meta.url)
const readCorpus = (name: string) => readFile(new URL(name, corpusRoot), "utf8")

const calls = (program: Program): ReadonlyArray<CallExpression> => {
  const found: CallExpression[] = []
  const visit = (expression: Expression): void => {
    if (expression.kind === "CallExpression") {
      found.push(expression)
      visit(expression.callee)
      expression.arguments.forEach(visit)
    } else if (expression.kind === "ListExpression") expression.items.forEach(visit)
    else if (expression.kind === "RecordExpression") expression.entries.forEach((entry) => visit(entry.value))
    else if (expression.kind === "UnaryExpression") visit(expression.operand)
    else if (expression.kind === "BinaryExpression") { visit(expression.left); visit(expression.right) }
    else if (expression.kind === "FieldExpression") visit(expression.object)
    else if (expression.kind === "IndexExpression") { visit(expression.object); visit(expression.index) }
  }
  const visitStatement = (statement: Statement): void => {
    if (statement.kind === "LetStatement") visit(statement.value)
    else if (statement.kind === "ExpressionStatement") visit(statement.expression)
    else if (statement.kind === "AssertStatement") { visit(statement.test); if (statement.message) visit(statement.message) }
    else if (statement.kind === "ReturnStatement") { if (statement.value) visit(statement.value) }
    else if (statement.kind === "IfStatement") { visit(statement.test); statement.consequent.forEach(visitStatement); statement.alternate?.forEach(visitStatement) }
    else if (statement.kind === "ForStatement") {
      if (statement.iteration === "list") visit(statement.source)
      else {
        visit(statement.from)
        visit(statement.to)
      }
      statement.body.forEach(visitStatement)
    }
  }
  program.body.forEach(visitStatement)
  return found
}

const fieldNames = (call: CallExpression): ReadonlyArray<string> => {
  const argument = call.arguments[0]
  if (argument?.kind !== "RecordExpression") return []
  return argument.entries.map((entry) => entry.key)
}

const callName = (call: CallExpression): string | undefined => {
  const visit = (expression: Expression): string | undefined => {
    if (expression.kind === "IdentifierExpression") return expression.name
    if (expression.kind === "FieldExpression") {
      const prefix = visit(expression.object)
      return prefix === undefined ? undefined : `${prefix}.${expression.field}`
    }
    return undefined
  }
  return visit(call.callee)
}

const callNames = (program: Program): ReadonlyArray<string> => calls(program).flatMap((call) => {
  const name = callName(call)
  return name === undefined ? [] : [name]
})

const exampleSources = ["snapshot.air", "restore.air", "replace.air", "host-workflow.air"] as const

const canonicalActions = new Set([
  "file.inspect",
  "file.read",
  "file.list",
  "file.glob",
  "file.stat",
  "file.write",
  "file.remove",
  "file.move",
  "file.copy",
  "file.mkdir",
  "process.run",
  "http.stage"
])

const aliasActions = new Set(["run", "capture", "apply", "request_external"])

const responseValue = (request: ProgramActionRequest): LanguageValue => {
  const input = request.call.input as Record<string, unknown>
  const text = (value: unknown) => String(value ?? "")
  const number = (value: unknown) => Number(value ?? 0)
  switch (request.call.action) {
    case "file.inspect":
    case "file.stat":
      return {
        path: text(input.path),
        kind: "file",
        bytes: 4_096,
        mode: 0o600,
        device: 1,
        inode: 2
      } as LanguageValue
    case "file.read":
      if (input.format === "json") {
        return { phase: "state_restored", ok: true, extracted: 3 } as LanguageValue
      }
      if (input.format === "bytes") return [115, 101, 101, 100] as LanguageValue
      return "seed"
    case "file.list":
      return [
        {
          name: "seed.txt",
          stat: {
            path: text(input.path),
            kind: "file",
            bytes: 1,
            mode: 0o600,
            device: 1,
            inode: 2
          }
        }
      ] as LanguageValue
    case "file.glob":
      return ["seed.txt"] as LanguageValue
    case "file.write":
      return {
        state: "applied",
        action: "file.write",
        act_id: "act-write",
        target: text(input.path),
        previous_held: true,
        bytes: typeof input.content === "string" ? input.content.length : 0
      } as LanguageValue
    case "file.copy":
      return {
        state: "applied",
        action: "file.copy",
        act_id: "act-copy",
        source: text(input.source),
        target: text(input.destination),
        previous_held: true,
        bytes: 1
      } as LanguageValue
    case "file.move":
      return {
        state: "applied",
        action: "file.move",
        install_act_id: "act-move-install",
        remove_act_id: "act-move-remove",
        source: text(input.source),
        target: text(input.destination)
      } as LanguageValue
    case "file.remove":
      return {
        state: "applied",
        action: "file.remove",
        act_id: "act-remove",
        target: text(input.path),
        previous_held: true
      } as LanguageValue
    case "file.mkdir":
      return {
        state: "applied",
        action: "file.mkdir",
        path: text(input.path),
        act_ids: []
      } as LanguageValue
    case "process.run": {
      const executable = String(input.executable ?? "")
      const args = Array.isArray(input.args) ? input.args.map(String) : []
      const stdout =
        executable.includes("/wc")
          ? "2"
          : executable.includes("/printf")
            ? args.join(" ")
            : executable.includes("/tar")
              ? "tar-ok"
              : executable.includes("openshell")
                ? "openshell-ok"
                : "ok"
      return {
        state: "succeeded",
        action: "process.run",
        process_outcome: "exited",
        exit_code: 0,
        signal: null,
        stdout,
        stderr: "",
        stdout_artifact: { id: `artifact/stdout/${request.callDigest}` },
        stderr_artifact: { id: `artifact/stderr/${request.callDigest}` },
        plan_id: request.draft.id
      } as LanguageValue
    }
    case "http.stage":
      return {
        state: "staged",
        action: "http.stage",
        emission_id: `emi-${request.draft.id}`,
        method: text(input.method),
        endpoint: text(input.endpoint),
        hold_millis: number(input.holdMillis)
      } as LanguageValue
    default:
      throw new Error(`unsupported action ${request.call.action}`)
  }
}

const runExample = async (
  name: string,
  bindings: Readonly<Record<string, LanguageValue>>
) => {
  const requests: ProgramActionRequest[] = []
  const executor = Layer.succeed(ProgramActionExecutor, {
    execute: (request: ProgramActionRequest) => {
      requests.push(request)
      const value = responseValue(request)
      const record =
        typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          !(
            "kind" in value &&
            value.kind === "Duration"
          )
          ? value as LanguageRecord
          : undefined
      const stdoutArtifactRecord =
        record !== undefined &&
          typeof record.stdout_artifact === "object" &&
          record.stdout_artifact !== null &&
          !Array.isArray(record.stdout_artifact) &&
          !(
            "kind" in record.stdout_artifact &&
            record.stdout_artifact.kind === "Duration"
          )
          ? record.stdout_artifact as LanguageRecord
          : undefined
      const stdoutArtifact =
        stdoutArtifactRecord !== undefined &&
          typeof stdoutArtifactRecord.id === "string" &&
          typeof record?.stdout === "string"
          ? new InlineArtifact({
              id: ArtifactId.make(stdoutArtifactRecord.id),
              bytes: new TextEncoder().encode(record.stdout as string),
              mediaType: "text/plain",
              provenance: `stub:${request.callDigest}`
            })
          : undefined
      return Effect.succeed(new ProgramActionResult({
        value,
        artifacts:
          stdoutArtifact === undefined ? [] : [stdoutArtifact]
      }))
    }
  })
  const layer = ProgramRunnerLive.pipe(Layer.provide(executor))
  const source = await readCorpus(name)
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* ProgramRunner
      return yield* runner.run(new ProgramRequest({
        source,
        bindings
      }))
    }).pipe(Effect.provide(layer))
  )
  return { requests, result, source }
}

describe("Vouch-derived generic shell replacement corpus", () => {
  it("keeps the checked-in examples on canonical Airlock actions", async () => {
    const programs = await Promise.all(exampleSources.map(async (name) => parseSync(await readCorpus(name))))
    for (const program of programs) {
      for (const name of callNames(program)) {
        expect(aliasActions.has(name)).toBe(false)
        expect(canonicalActions.has(name)).toBe(true)
      }
    }
  })

  it("runs the checked-in examples through a stub executor and observes canonical requests", async () => {
    const snapshot = await runExample("snapshot.air", {
      openshell: "/usr/bin/openshell",
      workspace: "/work",
      sandbox_name: "sandbox-a",
      hermes_home: "/work/hermes",
      remote_archive: "/remote/state.tgz",
      sandbox_archive: "/sandbox/state.tgz",
      local_archive: "/work/state.tgz"
    })
    expect(snapshot.requests.map((request) => request.call.action)).toEqual([
      "process.run",
      "process.run",
      "process.run",
      "file.inspect"
    ])
    expect(snapshot.requests[0]!.call.input).toMatchObject({
      descendantExecutables: [],
      cwd: "/work",
      stdin: "discard",
      timeoutMs: 150_000,
      cellProfile: "compatibility"
    })
    expect(snapshot.requests[1]!.call.input).toMatchObject({
      descendantExecutables: [],
      cwd: "/work",
      stdin: "discard",
      timeoutMs: 45_000,
      cellProfile: "compatibility"
    })

    const restore = await runExample("restore.air", {
      openshell: "/usr/bin/openshell",
      workspace: "/work",
      local_archive: "/work/state.tgz",
      remote_archive: "/remote/state.tgz",
      sandbox_name: "sandbox-a",
      state_home: "/work/state",
      restore_receipt: "/work/restore.receipt.json"
    })
    expect(restore.requests.map((request) => request.call.action)).toEqual([
      "file.inspect",
      "process.run",
      "process.run",
      "file.read"
    ])
    expect(restore.requests[1]!.call.input).toMatchObject({
      cwd: "/work",
      stdin: "discard",
      timeoutMs: 120_000,
      cellProfile: "compatibility"
    })
    expect(restore.requests[2]!.call.input).toMatchObject({
      descendantExecutables: [],
      cwd: "/work",
      stdin: "discard",
      timeoutMs: 210_000,
      cellProfile: "compatibility"
    })
    expect(restore.requests[3]!.call.input).toMatchObject({
      path: "/work/restore.receipt.json",
      format: "json"
    })

    const replace = await runExample("replace.air", {
      sandbox_inventory: "/work/inventory.json",
      sandbox_name: "sandbox-a",
      local_archive: "/work/state.tgz",
      durable_backup: "/work/durable/state.tgz",
      realm_endpoint: "https://realm.example.test/replace",
      image: "nemo",
      airlock_program: "/usr/bin/airlock",
      snapshot_program: "/opt/airlock/snapshot.air",
      restore_program: "/opt/airlock/restore.air",
      workspace: "/work"
    })
    expect(replace.requests.map((request) => request.call.action)).toEqual([
      "file.inspect",
      "process.run",
      "file.copy",
      "http.stage",
      "process.run"
    ])
    expect(replace.requests[1]!.call.input).toMatchObject({
      cwd: "/work",
      stdin: "discard",
      timeoutMs: 300_000,
      cellProfile: "compatibility"
    })
    expect(replace.requests[2]!.call.input).toMatchObject({
      source: "/work/state.tgz",
      destination: "/work/durable/state.tgz"
    })
    expect(replace.requests[3]!.call.input).toMatchObject({
      endpoint: "https://realm.example.test/replace",
      holdMillis: 30_000,
      body: "{\"action\":\"replace-machine\",\"name\":\"sandbox-a\",\"image\":\"nemo\"}"
    })

    const hostWorkflow = await runExample("host-workflow.air", {
      workspace: "/work",
      state_dir: "/work/state",
      backup_dir: "/work/backup",
      snapshot: "/work/snapshot.tgz",
      staged_backup: "/work/staged-backup.tgz",
      final_backup: "/work/final-backup.tgz",
      stale_file: "/work/stale.txt",
      tar_descendants: [],
      endpoint: "https://example.test/stage"
    })
    for (const request of hostWorkflow.requests) {
      expect(canonicalActions.has(request.call.action)).toBe(true)
      expect(aliasActions.has(request.call.action)).toBe(false)
    }
    expect(
      hostWorkflow.requests.some(
        (request) => request.call.action === "http.stage"
      ),
      JSON.stringify({
        actions: hostWorkflow.requests.map(
          (request) => request.call.action
        ),
        result: hostWorkflow.result
      })
    ).toBe(true)
    expect(hostWorkflow.requests.some((request) => request.call.action === "process.run")).toBe(true)
  })

  it.effect("lowers the lifecycle to the closed generic plan algebra", () =>
    Effect.gen(function* () {
      const node = (value: string) => NodeId.make(value)
      const requirement = (value: string) => RequirementId.make(value)
      const archive = ArtifactId.make("artifact/state-archive")
      const requirements = [
        new ResourceRequirement({ id: requirement("state-read"), kind: "path", realm: "remote", selector: "state/**", rights: ["read"] }),
        new ResourceRequirement({ id: requirement("backup-write"), kind: "path", realm: "local", selector: "backups/**", rights: ["write"] }),
        new ResourceRequirement({ id: requirement("controller"), kind: "executable", realm: "local", selector: "controller", rights: ["invoke"] }),
        new ResourceRequirement({ id: requirement("realm"), kind: "endpoint", realm: "remote", selector: "realm", rights: ["emit"] })
      ]
      const capture = new CaptureNode({ id: node("capture-archive"), dependsOn: [], requires: [requirement("state-read")], produces: [archive], source: "file", locator: "managed://state/archive" })
      const snapshot = new InvokeNode({
        id: node("snapshot"), dependsOn: [capture.id], requires: [requirement("controller")], produces: [],
        executable: "/usr/bin/python3", args: ["-I", "-S", "sqlite-safe-snapshot.py"],
        stdout: "capture", stderr: "capture", outputLimitBytes: 1_048_576,
        timeoutMs: 150_000, cellProfile: "native-contained"
      })
      const retain = new ApplyNode({ id: node("retain-backup"), dependsOn: [snapshot.id], requires: [requirement("backup-write")], produces: [], operation: "write", target: "backups/state.tgz", sourceArtifact: archive })
      const replace = new RequestExternalNode({ id: node("replace-machine"), dependsOn: [retain.id], requires: [requirement("realm")], produces: [], method: "POST", endpoint: "realm://machine", holdMillis: 30_000 })
      const restore = new InvokeNode({
        id: node("restore"), dependsOn: [replace.id], requires: [requirement("controller")], produces: [],
        executable: "/usr/bin/python3", args: ["-I", "-S", "safe-restore.py"],
        stdout: "capture", stderr: "capture", outputLimitBytes: 1_048_576,
        timeoutMs: 210_000, cellProfile: "native-contained"
      })
      const draft = new PlanDraft({ schemaVersion: "airlock/plan-draft/v1", id: PlanId.make("plan/state-preserving-replacement"), actionReference: "corpus.state-preserving-replacement", nodes: [restore, retain, capture, replace, snapshot], requirements, definitionDigests: [] })
      expect((yield* orderPlan(draft)).map((item) => item._tag)).toEqual(["Capture", "Invoke", "Apply", "RequestExternal", "Invoke"])
    })
  )
})
