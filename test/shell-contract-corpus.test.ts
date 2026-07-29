import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { readFile } from "node:fs/promises"
import {
  ActionCallDecodeFailed,
  decodeAndLowerNativeAction
} from "../src/actions/index.ts"
import { AdmissionPolicy, admit } from "../src/admission/index.ts"
import {
  LanguageValueSchema,
  type LanguageValue
} from "../src/language/evaluator.ts"
import { ArtifactId, orderPlan } from "../src/plan/index.ts"
import {
  InlineArtifact,
  ProgramActionExecutor,
  ProgramActionResult,
  type ProgramActionRequest,
  ProgramRequest,
  ProgramRunner,
  ProgramRunnerLive,
  UnknownProgramAction,
  canonicalizeProgramAction,
  decodeProgramAction,
  draftForAction
} from "../src/program/index.ts"

const ContractFamily = Schema.Literal(
  "observation",
  "file-mutation",
  "structured-invocation",
  "text-data",
  "archive-compression",
  "git",
  "build-test",
  "language-toolchain",
  "artifact-stream",
  "staged-http"
)

const PlanNodeKind = Schema.Literal(
  "Capture",
  "Invoke",
  "Apply",
  "RequestExternal"
)

const ContractArtifact = Schema.Struct({
  id: Schema.String,
  text: Schema.String
})

const ContractCase = Schema.Struct({
  id: Schema.String,
  family: ContractFamily,
  intent: Schema.String,
  action: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  artifacts: Schema.optionalWith(Schema.Array(ContractArtifact), {
    default: () => []
  }),
  expectedPlanNodes: Schema.Array(PlanNodeKind)
})

const UnsupportedCase = Schema.Struct({
  id: Schema.String,
  programAction: Schema.String,
  publishedClass: Schema.String,
  reason: Schema.String
})

const ShellContractCorpus = Schema.Struct({
  schemaVersion: Schema.Literal("airlock/shell-contract-corpus/v1"),
  evidenceKind: Schema.Literal(
    "contract-coverage-not-executed-task-evidence"
  ),
  cases: Schema.Array(ContractCase),
  unsupported: Schema.Array(UnsupportedCase)
})

const corpusFile = new URL(
  "./fixtures/shell-contract-corpus.json",
  import.meta.url
)

const loadCorpus = Effect.tryPromise({
  try: () => readFile(corpusFile, "utf8"),
  catch: (cause) =>
    new Error(
      `cannot read shell contract corpus: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    )
}).pipe(
  Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(ShellContractCorpus)))
)

const expectedFamilies: ReadonlyArray<typeof ContractFamily.Type> = [
  "observation",
  "file-mutation",
  "structured-invocation",
  "text-data",
  "archive-compression",
  "git",
  "build-test",
  "language-toolchain",
  "artifact-stream",
  "staged-http"
]

const actionName = (
  action: Readonly<Record<string, unknown>>
): string => {
  const value = action["action"]
  if (typeof value !== "string") {
    throw new Error("contract fixture action must have a string action tag")
  }
  return value
}

const actionInput = (
  action: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => {
  const { action: _action, ...input } = action
  return input
}

const inlineArtifacts = (
  scenario: typeof ContractCase.Type
): ReadonlyArray<InlineArtifact> =>
  scenario.artifacts.map(
    (artifact) =>
      new InlineArtifact({
        id: ArtifactId.make(artifact.id),
        bytes: new TextEncoder().encode(artifact.text),
        mediaType: "application/octet-stream",
        provenance: `contract-fixture:${scenario.id}`
      })
  )

const compatibilityPolicy = new AdmissionPolicy({
  schemaVersion: "airlock/admission-policy/v1",
  profile: "compatibility",
  principal: "agent:shell-contract-corpus",
  realm: "local",
  admittedBy: "test:shell-contract-corpus",
  pathAllowlist: [],
  executableAllowlist: [],
  endpointAllowlist: []
})

describe("representative shell-to-Airlock contract corpus", () => {
  it.effect(
    "labels 50+ distinct Unix-informed shapes as contract coverage, not execution evidence",
    () =>
      Effect.gen(function* () {
        const corpus = yield* loadCorpus
        expect(corpus.evidenceKind).toBe(
          "contract-coverage-not-executed-task-evidence"
        )
        expect(corpus.cases.length).toBeGreaterThanOrEqual(50)

        const ids = corpus.cases.map((scenario) => scenario.id)
        const intents = corpus.cases.map((scenario) => scenario.intent)
        expect(new Set(ids).size).toBe(ids.length)
        expect(new Set(intents).size).toBe(intents.length)
        expect(
          [...new Set(corpus.cases.map((scenario) => scenario.family))].sort()
        ).toEqual([...expectedFamilies].sort())

        for (const family of expectedFamilies) {
          expect(
            corpus.cases.filter((scenario) => scenario.family === family)
              .length,
            `missing representative cases for ${family}`
          ).toBeGreaterThan(0)
        }
        expect(
          corpus.cases.filter(
            (scenario) => scenario.family === "artifact-stream"
          ).length
        ).toBeGreaterThanOrEqual(5)
        expect(
          corpus.cases.filter(
            (scenario) => actionName(scenario.action) === "process.run"
          ).length
        ).toBeGreaterThanOrEqual(30)
      })
  )

  it.effect(
    "decodes every accepted shape through the language and native schemas, validates its Plan, and closes admission",
    () =>
      Effect.gen(function* () {
        const corpus = yield* loadCorpus
        const captured: ProgramActionRequest[] = []
        const ExecutorLive = Layer.succeed(
          ProgramActionExecutor,
          ProgramActionExecutor.of({
            execute: (request) => {
              captured.push(request)
              return Effect.succeed(
                new ProgramActionResult({
                  value: {
                    state: "contract-covered",
                    action: request.call.action
                  },
                  artifacts: []
                })
              )
            }
          })
        )
        const runner = yield* ProgramRunner.pipe(
          Effect.provide(
            ProgramRunnerLive.pipe(Layer.provide(ExecutorLive))
          )
        )
        const admittedAt = new Date("2026-01-01T00:00:00.000Z")

        for (const [index, scenario] of corpus.cases.entries()) {
          const name = actionName(scenario.action)
          const input = actionInput(scenario.action)
          const languageInput = yield* Schema.decodeUnknown(
            LanguageValueSchema
          )(input)
          const decoded = yield* decodeProgramAction(name, [
            languageInput as LanguageValue
          ])
          const canonical = yield* canonicalizeProgramAction(name, decoded)
          const lowering = yield* decodeAndLowerNativeAction(
            `shell-contract:${scenario.id}`,
            scenario.action
          )

          expect(lowering.action, scenario.id).toBe(name)
          expect(lowering.nodes, scenario.id).toHaveLength(1)
          expect(lowering.nodes[0]?._tag, scenario.id).toBe(
            scenario.expectedPlanNodes[0]
          )

          const artifacts = inlineArtifacts(scenario)
          const direct = yield* draftForAction(
            canonical,
            index,
            "shell-contract-corpus",
            artifacts
          )
          const directNodes = yield* orderPlan(direct.draft)
          expect(
            directNodes.map((node) => node._tag),
            scenario.id
          ).toEqual(scenario.expectedPlanNodes)
          const directAdmission = yield* admit(
            direct.draft,
            compatibilityPolicy,
            admittedAt
          )
          expect(
            directAdmission.plan.nodes.map((node) => node._tag),
            scenario.id
          ).toEqual(scenario.expectedPlanNodes)

          captured.length = 0
          const source = `return ${name}(${JSON.stringify(input)})`
          const run = yield* runner.run(
            new ProgramRequest({ source, artifacts })
          )
          expect(run.state, scenario.id).toBe("succeeded")
          expect(captured, scenario.id).toHaveLength(1)

          const request = captured[0]!
          const programNodes = yield* orderPlan(request.draft)
          expect(
            programNodes.map((node) => node._tag),
            scenario.id
          ).toEqual(scenario.expectedPlanNodes)
          expect(request.call.input, scenario.id).toEqual(canonical)
          expect(
            (yield* admit(
              request.draft,
              compatibilityPolicy,
              admittedAt
            )).plan.actionReference,
            scenario.id
          ).toBe(request.draft.actionReference)

          if (canonical.action === "process.run") {
            const invoke = programNodes.find(
              (node) => node._tag === "Invoke"
            )
            expect(invoke, scenario.id).toBeDefined()
            if (invoke?._tag !== "Invoke") {
              return yield* Effect.die(
                new Error(`${scenario.id} did not lower to Invoke`)
              )
            }
            expect(invoke.executable, scenario.id).toBe(
              canonical.executable
            )
            expect(invoke.args, scenario.id).toEqual(canonical.args)
            expect(
              Object.prototype.hasOwnProperty.call(invoke, "command"),
              scenario.id
            ).toBe(false)
            expect(
              Object.prototype.hasOwnProperty.call(invoke, "commandString"),
              scenario.id
            ).toBe(false)
            expect(
              Object.prototype.hasOwnProperty.call(invoke, "argv"),
              scenario.id
            ).toBe(false)
          }
        }
      })
  )

  it.effect(
    "rejects only explicitly published unsupported core action classes",
    () =>
      Effect.gen(function* () {
        const corpus = yield* loadCorpus
        expect(corpus.unsupported.length).toBeGreaterThan(0)
        expect(
          new Set(corpus.unsupported.map((scenario) => scenario.id)).size
        ).toBe(corpus.unsupported.length)

        for (const scenario of corpus.unsupported) {
          expect(scenario.publishedClass.trim().length).toBeGreaterThan(0)
          expect(scenario.reason.trim().length).toBeGreaterThan(0)

          const language = yield* decodeProgramAction(
            scenario.programAction,
            []
          ).pipe(Effect.either)
          expect(language._tag, scenario.id).toBe("Left")
          if (language._tag === "Left") {
            expect(language.left, scenario.id).toBeInstanceOf(
              UnknownProgramAction
            )
          }

          const native = yield* decodeAndLowerNativeAction(
            `unsupported:${scenario.id}`,
            { action: scenario.programAction }
          ).pipe(Effect.either)
          expect(native._tag, scenario.id).toBe("Left")
          if (native._tag === "Left") {
            expect(native.left, scenario.id).toBeInstanceOf(
              ActionCallDecodeFailed
            )
          }
        }
      })
  )
})
