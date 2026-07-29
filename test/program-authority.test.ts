import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  AdmissionPolicy,
  type ExecutionAuthority
} from "../src/admission/index.ts"
import {
  canonicalizeProgramAction,
  draftForAction,
  ProgramActionExecutor,
  ProgramActionResult,
  ProgramAdmissionLive,
  ProgramPlanExecutorLive,
  ProgramPlanRuntime
} from "../src/program/index.ts"

const policy = new AdmissionPolicy({
  schemaVersion: "airlock/admission-policy/v1",
  profile: "native-contained",
  principal: "agent/program-authority-test",
  realm: "local",
  admittedBy: "operator/test",
  pathAllowlist: ["/work/**"],
  executableAllowlist: [],
  endpointAllowlist: []
})

describe("Program execution authority handoff", () => {
  it.effect("passes the admitted Plan together with grants and node bindings", () => {
    const observed: ExecutionAuthority[] = []
    const runtime = Layer.succeed(ProgramPlanRuntime, ProgramPlanRuntime.of({
      execute: (_request, authority) => {
        observed.push(authority)
        return Effect.succeed(new ProgramActionResult({
          value: { state: "observed" },
          artifacts: []
        }))
      }
    }))
    const executor = ProgramPlanExecutorLive.pipe(
      Layer.provideMerge(ProgramAdmissionLive(policy)),
      Layer.provideMerge(runtime)
    )

    return Effect.gen(function* () {
      const call = yield* canonicalizeProgramAction("file.read", {
        action: "file.read",
        path: "/work/input.txt",
        format: "text",
        realm: "local"
      })
      const request = yield* draftForAction(call, 0, "authority-handoff")
      const service = yield* ProgramActionExecutor
      const result = yield* service.execute(request)

      expect(result.value).toEqual({ state: "observed" })
      expect(observed).toHaveLength(1)
      expect(observed[0]?.schemaVersion).toBe("airlock/execution-authority/v1")
      expect(observed[0]?.admission.grants).toHaveLength(1)
      expect(observed[0]?.admission.plan.handles).toHaveLength(1)
      expect(observed[0]?.bindings[0]?.handles[0]?.grantId).toBe(
        observed[0]?.admission.grants[0]?.id
      )
    }).pipe(Effect.provide(executor))
  })
})
