import { describe, expect, it } from "@effect/vitest"
import { readFile } from "node:fs/promises"
import { Effect } from "effect"
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
    else if (statement.kind === "ForStatement") { visit(statement.from); visit(statement.to); statement.body.forEach(visitStatement) }
  }
  program.body.forEach(visitStatement)
  return found
}

const fieldNames = (call: CallExpression): ReadonlyArray<string> => {
  const argument = call.arguments[0]
  if (argument?.kind !== "RecordExpression") return []
  return argument.entries.map((entry) => entry.key)
}

const calleeName = (call: CallExpression): string | undefined =>
  call.callee.kind === "IdentifierExpression" ? call.callee.name : undefined

describe("Vouch-derived generic shell replacement corpus", () => {
  it("parses all lifecycle scripts without a shell escape or project-native action", async () => {
    const scripts = await Promise.all(["snapshot.air", "restore.air", "replace.air"].map(readCorpus))
    for (const source of scripts) {
      expect(() => parseSync(source)).not.toThrow()
      expect(source).not.toMatch(/\b(?:archive\.(?:extract|create)|sandbox\.(?:upload|exec)|vouch\.)/)
      expect(source).not.toContain("$HOME")
      expect(source).not.toContain("`")
    }
  })

  it("makes every opaque tool invocation structurally inspectable before admission", async () => {
    const programs = await Promise.all(["snapshot.air", "restore.air", "replace.air"].map(async (name) => parseSync(await readCorpus(name))))
    const runCalls = programs.flatMap(calls).filter((call) => calleeName(call) === "run")
    expect(runCalls.length).toBeGreaterThanOrEqual(7)
    for (const call of runCalls) {
      expect(fieldNames(call)).toEqual(expect.arrayContaining([
        "executable", "args", "stdin", "stdout", "stderr", "timeout", "cellProfile"
      ]))
    }
    const requestCalls = programs.flatMap(calls).filter((call) => calleeName(call) === "request_external")
    expect(requestCalls).toHaveLength(2)
    for (const call of requestCalls) expect(fieldNames(call)).toEqual(expect.arrayContaining(["method", "endpoint", "hold", "body"]))
  })

  it.effect("lowers the lifecycle to the closed generic plan algebra", () =>
    Effect.gen(function* () {
      const node = (value: string) => NodeId.make(value)
      const requirement = (value: string) => RequirementId.make(value)
      const archive = ArtifactId.make("artifact/state-archive")
      const requirements = [
        new ResourceRequirement({ id: requirement("state-read"), kind: "path", realm: "remote", selector: "state/**", rights: ["read"] }),
        new ResourceRequirement({ id: requirement("backup-write"), kind: "path", realm: "local", selector: "backups/**", rights: ["write"] }),
        new ResourceRequirement({ id: requirement("controller"), kind: "executable", realm: "local", selector: "controller", rights: ["execute"] }),
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
