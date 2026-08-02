#!/usr/bin/env bun
/**
 * Live proof of the external-read slice.
 *
 * What it exercises: a `RequestExternal` intent lowered from either the native
 * `http.stage` action or a v2 `enqueue` tool definition, staged through the
 * Outbox, and — only when the supervisor policy pre-authorized it — committed
 * through the ordinary `Outbox.commit`, with the receipt naming the grant, the
 * class, the dispatched endpoint, and bounded response metadata.
 *
 * The counterparty is the fixture provider in `test/support`: a local HTTP
 * server on an ephemeral port. No vendor, no provider adapter, no network.
 *
 * Every proof below is run, not asserted from reading: each one either observes
 * the fixture provider receive a request or observes that it never did.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunContext } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  AdmissionPolicyV2,
  type AdmissionPolicyDocument,
  EndpointGrantPolicy
} from "../src/admission/index.ts"
import { layer as airlockHomeLayer } from "../src/AirlockHome.ts"
import { CellLive } from "../src/cell/index.ts"
import { LedgerLive } from "../src/Ledger.ts"
import { HoldLive } from "../src/HoldLive.ts"
import { MacosPlatformLive } from "../src/platform/macos/index.ts"
import { NativeFileSystemLive, NativeFilesystemConfig } from "../src/native/index.ts"
import { Outbox, OutboxLive } from "../src/Outbox.ts"
import { ProcessRunnerLive } from "../src/process/Process.ts"
import {
  ProgramExecutionWithToolsLive,
  ProgramRequest,
  ProgramRunner
} from "../src/program/index.ts"
import {
  RuntimeConfig,
  RuntimeConfigLive,
  RuntimeLive
} from "../src/runtime/index.ts"
import {
  type ExportedToolAction,
  ToolDefinitionDocument,
  ToolDefinitionLocation,
  ToolDefinitionRegistry,
  decodeToolDefinition,
  exportToolActions
} from "../src/tools/index.ts"
import {
  FIXTURE_LARGE_RESPONSE_BYTES,
  startFixtureEndpointProvider
} from "../test/support/FixtureEndpointProvider.ts"

const repository = fileURLToPath(new URL("../", import.meta.url))
const exampleDefinitionFile = join(
  repository,
  "examples",
  "tools",
  "fixture-status.airlock-tool.json"
)

/** The bound `Outbox` enforces; the proof reads it from the receipt, not from here. */
const EXPECTED_RESPONSE_LIMIT_BYTES = 65_536

const failures: Array<string> = []
const notes: Array<string> = []

const check = (name: string, condition: boolean, detail: string) => {
  if (condition) {
    notes.push(`ok    ${name} — ${detail}`)
    return
  }
  failures.push(`FAIL  ${name} — ${detail}`)
}

const grant = (
  fields: Partial<ConstructorParameters<typeof EndpointGrantPolicy>[0]> & {
    readonly selector: string
  }
) => new EndpointGrantPolicy(fields as ConstructorParameters<typeof EndpointGrantPolicy>[0])

const policyOf = (
  grants: ReadonlyArray<EndpointGrantPolicy>
): AdmissionPolicyDocument =>
  new AdmissionPolicyV2({
    schemaVersion: "airlock/admission-policy/v2",
    profile: "native-contained",
    principal: "agent:external-read-proof",
    realm: "local",
    admittedBy: "proof",
    pathAllowlist: [],
    executableAllowlist: [],
    endpointGrants: grants
  })

type ProgramOutcome = {
  readonly ok: boolean
  readonly state: string
  readonly result: unknown
  readonly diagnostics: unknown
  readonly ledger: ReadonlyArray<string>
  readonly outboxStates: ReadonlyArray<string>
}

const readExampleTools = Effect.gen(function* () {
  const loaded = yield* decodeToolDefinition(
    new ToolDefinitionDocument({
      location: new ToolDefinitionLocation({
        kind: "project",
        directory: join(repository, "examples", "tools")
      }),
      file: exampleDefinitionFile,
      json: readFileSync(exampleDefinitionFile, "utf8")
    })
  )
  return yield* exportToolActions(
    new ToolDefinitionRegistry({ definitions: [loaded] }),
    new Set<string>()
  )
})

const runProgram = async (
  policy: AdmissionPolicyDocument,
  source: string,
  tools: ReadonlyArray<ExportedToolAction> = []
): Promise<ProgramOutcome> => {
  const home = mkdtempSync(join(tmpdir(), "airlock-external-read-"))
  const workspace = mkdtempSync(join(tmpdir(), "airlock-external-work-"))
  const PlatformAndHome = airlockHomeLayer(home).pipe(
    Layer.provideMerge(BunContext.layer)
  )
  const LedgerLayer = LedgerLive.pipe(Layer.provideMerge(PlatformAndHome))
  const StateLayer = Layer.mergeAll(
    LedgerLayer,
    HoldLive.pipe(Layer.provideMerge(LedgerLayer)),
    OutboxLive.pipe(Layer.provideMerge(LedgerLayer))
  )
  const NativeLayer = NativeFileSystemLive(
    new NativeFilesystemConfig({ workspace })
  ).pipe(Layer.provideMerge(StateLayer))
  const MainLayer = CellLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NativeLayer,
        Layer.mergeAll(ProcessRunnerLive, MacosPlatformLive)
      )
    )
  )
  const managed = ManagedRuntime.make(MainLayer)
  try {
    return await managed.runPromise(
      Effect.gen(function* () {
        const runtimeLayer = RuntimeLive.pipe(
          Layer.provideMerge(RuntimeConfigLive(new RuntimeConfig({
            workspace,
            profile: "native-contained",
            runJournalDirectory: join(home, "runs"),
            environment: {}
          }))),
          Layer.provideMerge(
            NativeFileSystemLive(new NativeFilesystemConfig({ workspace }))
          )
        )
        const programLayer = ProgramExecutionWithToolsLive(
          policy,
          new Map(tools.map((tool) => [tool.name, tool])),
          "native-contained"
        ).pipe(Layer.provideMerge(runtimeLayer))
        const runner = yield* ProgramRunner.pipe(Effect.provide(programLayer))
        const run = yield* runner.run(new ProgramRequest({ source })).pipe(
          Effect.either
        )
        const outbox = yield* Outbox
        const staged = yield* outbox.pending
        const ledgerText = yield* Effect.tryPromise({
          try: async () => {
            try {
              return readFileSync(join(home, "ledger.jsonl"), "utf8")
            } catch {
              return ""
            }
          },
          catch: () => new Error("ledger unreadable")
        }).pipe(Effect.orElseSucceed(() => ""))
        return {
          ok: run._tag === "Right",
          result: run._tag === "Right" ? run.right.result : undefined,
          state: run._tag === "Right" ? run.right.state : "failed",
          diagnostics: run._tag === "Right"
            ? { state: run.right.state, failure: run.right.failure }
            : run.left,
          ledger: ledgerText.split("\n").filter((line) => line.length > 0),
          outboxStates: staged.map((emission) => emission.status)
        } satisfies ProgramOutcome
      })
    )
  } finally {
    await managed.dispose()
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const main = async () => {
  const provider = await startFixtureEndpointProvider()
  const origin = provider.origin
  const readGrant = grant({
    selector: `${origin}/v1/*`,
    methods: ["GET"],
    class: "read",
    commit: "auto"
  })
  const tools = await Effect.runPromise(readExampleTools)

  try {
    // ---------------------------------------------------------------- positive
    {
      const before = provider.requests.length
      const outcome = await runProgram(
        policyOf([readGrant]),
        `return http.stage({ endpoint: "${origin}/v1/status", method: "GET", holdMillis: 0 })`
      )
      const result = asRecord(outcome.result)
      const observed = provider.requests.slice(before)
      check(
        "positive/committed",
        result["state"] === "committed",
        `state=${String(result["state"])}`
      )
      check(
        "positive/reached the provider",
        observed.some((entry) =>
          entry.method === "GET" && entry.path === "/v1/status"
        ),
        `provider saw ${JSON.stringify(observed.map((entry) => `${entry.method} ${entry.path}`))}`
      )
      check(
        "positive/receipt names the committing authority",
        result["committed_by"] === "policy-auto",
        `committed_by=${String(result["committed_by"])}`
      )
      check(
        "positive/receipt names the dispatch class",
        result["dispatch_class"] === "read",
        `dispatch_class=${String(result["dispatch_class"])}`
      )
      check(
        "positive/receipt names the grant identity",
        typeof result["grant_id"] === "string" &&
          (result["grant_id"] as string).startsWith("grant/") &&
          result["grant_selector"] === readGrant.selector,
        `grant_id=${String(result["grant_id"])} selector=${String(result["grant_selector"])}`
      )
      check(
        "positive/receipt names the actual endpoint",
        result["dispatched_endpoint"] === `${origin}/v1/status`,
        `dispatched_endpoint=${String(result["dispatched_endpoint"])}`
      )
      check(
        "positive/receipt carries redacted response metadata",
        result["status"] === 200 &&
          result["response_truncated"] === false &&
          result["response_limit_bytes"] === EXPECTED_RESPONSE_LIMIT_BYTES &&
          typeof result["response_bytes"] === "number",
        `status=${String(result["status"])} bytes=${String(result["response_bytes"])} truncated=${String(result["response_truncated"])} limit=${String(result["response_limit_bytes"])}`
      )
      const body = typeof result["response_body"] === "string"
        ? (JSON.parse(result["response_body"] as string) as Record<string, unknown>)
        : {}
      check(
        "positive/response body is a bounded artifact the program can read",
        typeof result["response_artifact"] === "string" && body["state"] === "green",
        `artifact=${String(result["response_artifact"])} body.state=${String(body["state"])}`
      )
      check(
        "positive/ledger records the authority and grant",
        outcome.ledger.some((line) =>
          line.includes("\"act\":\"commit\"") &&
          line.includes("by=policy-auto") &&
          line.includes("class=read")
        ),
        `ledger lines=${outcome.ledger.length}`
      )
    }

    // ------------------------------------------- negative: unclassified stays staged
    {
      const before = provider.requests.length
      const outcome = await runProgram(
        // A grant with neither class nor commit is the v1 posture: the floor.
        policyOf([grant({ selector: `${origin}/v1/tasks` })]),
        `return http.stage({ endpoint: "${origin}/v1/tasks", method: "POST", body: "{}", holdMillis: 0 })`
      )
      const result = asRecord(outcome.result)
      check(
        "unclassified/stays staged",
        result["state"] === "staged" && result["committed_by"] === undefined,
        `state=${String(result["state"])} committed_by=${String(result["committed_by"])}`
      )
      check(
        "unclassified/never reached the provider",
        provider.requests.slice(before).length === 0,
        `provider saw ${provider.requests.length - before} request(s)`
      )
      check(
        "unclassified/intent is durably retained for a supervisor",
        outcome.outboxStates.length === 1 && outcome.outboxStates[0] === "staged",
        `outbox=${JSON.stringify(outcome.outboxStates)}`
      )
    }

    // ------------------------------------- negative: no grant at all is refused
    {
      const before = provider.requests.length
      const outcome = await runProgram(
        policyOf([readGrant]),
        `return http.stage({ endpoint: "${origin}/internal/audit", method: "GET", holdMillis: 0 })`
      )
      const diagnostics = JSON.stringify(outcome.diagnostics ?? outcome.result)
      check(
        "ungranted/refused before staging",
        diagnostics.includes("AdmissionDenied") &&
          diagnostics.includes("/internal/audit"),
        diagnostics.slice(0, 220)
      )
      check(
        "ungranted/never reached the provider",
        provider.requests.slice(before).length === 0,
        `provider saw ${provider.requests.length - before} request(s)`
      )
    }

    // ------------------------ negative: a program-selected class is a typed refusal
    {
      const outcome = await runProgram(
        policyOf([readGrant]),
        `return http.stage({ endpoint: "${origin}/v1/status", method: "GET", holdMillis: 0, class: "read" })`
      )
      const diagnostics = JSON.stringify(outcome.diagnostics ?? outcome.result)
      check(
        "program-class/typed refusal",
        diagnostics.includes("ProgramActionDecodeFailed"),
        diagnostics.slice(0, 220)
      )
    }
    {
      const smuggled = await Effect.runPromise(
        decodeToolDefinition(
          new ToolDefinitionDocument({
            location: new ToolDefinitionLocation({
              kind: "project",
              directory: join(repository, "examples", "tools")
            }),
            file: "/proof/smuggled.airlock-tool.json",
            json: JSON.stringify({
              ...JSON.parse(readFileSync(exampleDefinitionFile, "utf8")),
              actions: [
                {
                  ...JSON.parse(readFileSync(exampleDefinitionFile, "utf8"))
                    .actions[0],
                  commit: "auto"
                }
              ]
            })
          })
        ).pipe(Effect.flip, Effect.either)
      )
      const tag = smuggled._tag === "Right" ? smuggled.right._tag : "no-refusal"
      check(
        "definition-class/typed refusal",
        tag === "ToolGrantAssertionRejected",
        `refusal=${tag}`
      )
    }

    // ------------------ negative: a mutating footprint is never auto-committed
    {
      const before = provider.requests.length
      const outcome = await runProgram(
        policyOf([grant({
          selector: `${origin}/v1/tasks`,
          methods: ["POST"],
          class: "mutate"
        })]),
        `return http.stage({ endpoint: "${origin}/v1/tasks", method: "POST", body: "{}", holdMillis: 0 })`
      )
      const result = asRecord(outcome.result)
      check(
        "mutate-grant/stays staged",
        result["state"] === "staged",
        `state=${String(result["state"])}`
      )
      check(
        "mutate-grant/never reached the provider",
        provider.requests.slice(before).length === 0,
        `provider saw ${provider.requests.length - before} request(s)`
      )
    }
    {
      // The definition declares `mutate`; the grant classes the same endpoint
      // `read` with `commit: "auto"`. The effective class is the stricter of
      // the two, so this intent must stay staged.
      const before = provider.requests.length
      const outcome = await runProgram(
        policyOf([readGrant]),
        `return fixture_status.reconcile({ endpoint: "${origin}/v1/status" })`,
        tools
      )
      const result = asRecord(outcome.result)
      check(
        "declared-mutate/narrows a read grant to staged",
        result["state"] === "staged",
        `state=${String(result["state"])} diagnostics=${String(JSON.stringify(outcome.diagnostics)).slice(0, 160)}`
      )
      check(
        "declared-mutate/never reached the provider",
        provider.requests.slice(before).length === 0,
        `provider saw ${provider.requests.length - before} request(s)`
      )
    }
    {
      // The same declaration in its honest `read` form does auto-commit, which
      // is what makes the previous proof a narrowing rather than a dead path.
      const before = provider.requests.length
      const outcome = await runProgram(
        policyOf([readGrant]),
        `return fixture_status.read({ endpoint: "${origin}/v1/status" })`,
        tools
      )
      const result = asRecord(outcome.result)
      check(
        "declared-read/auto-commits through the same grant",
        result["state"] === "committed" && result["dispatch_class"] === "read",
        `state=${String(result["state"])} diagnostics=${String(JSON.stringify(outcome.diagnostics)).slice(0, 160)}`
      )
      check(
        "declared-read/reached the provider",
        provider.requests.slice(before).some((entry) => entry.path === "/v1/status"),
        `provider saw ${provider.requests.length - before} request(s)`
      )
    }
    {
      // A policy that tries to pre-authorize a non-read class is refused as an
      // invalid contract, so the narrowing above has no way around it.
      const outcome = await runProgram(
        policyOf([grant({
          selector: `${origin}/v1/tasks`,
          methods: ["POST"],
          class: "mutate",
          commit: "auto"
        })]),
        `return http.stage({ endpoint: "${origin}/v1/tasks", method: "POST", body: "{}", holdMillis: 0 })`
      )
      const diagnostics = JSON.stringify(outcome.diagnostics ?? outcome.result)
      check(
        "auto-on-mutate/policy refused as an invalid contract",
        diagnostics.includes("AdmissionContractInvalid") &&
          diagnostics.includes("legal only on class"),
        diagnostics.slice(0, 220)
      )
    }

    // ------------------------------- negative: an oversized response is bounded
    {
      const before = provider.requests.length
      const outcome = await runProgram(
        policyOf([readGrant]),
        `return http.stage({ endpoint: "${origin}/v1/large", method: "GET", holdMillis: 0 })`
      )
      const result = asRecord(outcome.result)
      check(
        "oversized/committed and reached the provider",
        result["state"] === "committed" &&
          provider.requests.slice(before).some((entry) => entry.path === "/v1/large"),
        `state=${String(result["state"])}`
      )
      check(
        "oversized/capture stops at the bound",
        result["response_bytes"] === EXPECTED_RESPONSE_LIMIT_BYTES &&
          result["response_truncated"] === true,
        `bytes=${String(result["response_bytes"])} of ${FIXTURE_LARGE_RESPONSE_BYTES} truncated=${String(result["response_truncated"])}`
      )
      const bodyLength = typeof result["response_body"] === "string"
        ? (result["response_body"] as string).length
        : -1
      check(
        "oversized/artifact carries only the bounded bytes",
        bodyLength === EXPECTED_RESPONSE_LIMIT_BYTES,
        `artifact bytes=${bodyLength}`
      )
    }
  } finally {
    await provider.stop()
  }

  for (const note of notes) console.log(note)
  for (const failure of failures) console.error(failure)
  console.log(
    `\n${notes.length} passed, ${failures.length} failed (fixture provider at ${origin})`
  )
  if (failures.length > 0) process.exit(1)
}

await main()
