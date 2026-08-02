import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  InvalidToolDefinition,
  SECRET_REFERENCE_PREFIX,
  ToolActionLoweringRequest,
  ToolDefinitionDocument,
  ToolDefinitionLocation,
  ToolGrantAssertionRejected,
  ToolEnqueueContractRejected,
  ToolRequestLoweringRejected,
  ToolSecretPlacementRejected,
  ToolTemplateRejected,
  decodeToolDefinition,
  lowerToolAction
} from "../src/tools/index.ts"

const location = new ToolDefinitionLocation({
  kind: "project",
  directory: "/srv/app/.airlock/tools"
})

const load = (definition: unknown) =>
  decodeToolDefinition(
    new ToolDefinitionDocument({
      location,
      file: "/srv/app/.airlock/tools/tasks.airlock-tool.json",
      json: JSON.stringify(definition)
    })
  )

const enqueueAction = (overrides: Record<string, unknown> = {}) => ({
  name: "tasks.create",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      project: { type: "string" }
    },
    required: ["title", "project"],
    additionalProperties: false
  },
  lowering: "enqueue",
  effectFootprint: ["enqueue"],
  emissionEffect: "mutate",
  request: {
    method: "POST",
    endpoint: { _tag: "Literal", value: "https://api.example.test/v2/tasks" },
    headers: {
      authorization: { _tag: "Secret", path: ["credentials", "example"] },
      "content-type": { _tag: "Literal", value: "application/json" },
      "x-airlock-project": { _tag: "Input", path: ["project"] }
    },
    body: { _tag: "Input", path: ["title"] },
    holdMillis: 30_000
  },
  resultDecoder: "none",
  ...overrides
})

const v2Definition = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "airlock/tool-definition/v2",
  id: "example.tasks",
  version: "1.0.0",
  executables: [],
  actions: [enqueueAction()],
  ...overrides
})

const withRequest = (request: Record<string, unknown>) =>
  v2Definition({
    actions: [
      enqueueAction({
        request: { ...(enqueueAction().request as Record<string, unknown>), ...request }
      })
    ]
  })

const invokeAction = {
  name: "extract",
  inputSchema: { type: "object", required: ["archive"] },
  args: [
    { _tag: "Literal", value: "-xf" },
    { _tag: "Input", path: ["archive"] }
  ],
  cwd: { _tag: "Literal", value: "/srv/app" },
  lowering: "invoke",
  effectFootprint: ["invoke"],
  resultDecoder: "exit-status"
}

const request = (
  loaded: Effect.Effect.Success<ReturnType<typeof load>>,
  input: Readonly<Record<string, unknown>>,
  action = "tasks.create"
) =>
  new ToolActionLoweringRequest({
    loaded,
    action,
    input,
    cellProfile: "native-contained"
  })

describe("tool definition v2: enqueue lowering", () => {
  it.effect("maps a validated action input onto one staged external intent", () =>
    Effect.gen(function* () {
      const loaded = yield* load(v2Definition())
      const lowered = yield* lowerToolAction(
        request(loaded, { title: "ship the RFC", project: "airlock" })
      )

      expect(lowered.call).toMatchObject({
        action: "http.stage",
        method: "POST",
        endpoint: "https://api.example.test/v2/tasks",
        headers: {
          "content-type": "application/json",
          "x-airlock-project": "airlock"
        },
        body: "ship the RFC",
        holdMillis: 30_000,
        realm: "external"
      })
      expect(lowered.resultDecoder).toBe("none")
      expect(lowered.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/)

      // The only Plan node an enqueue action can produce is RequestExternal,
      // whose runtime lowering is StageExternal -> AppendReceipt. No dispatch.
      expect(lowered.lowering.action).toBe("http.stage")
      expect(lowered.lowering.nodes).toHaveLength(1)
      expect(lowered.lowering.nodes[0]).toMatchObject({
        _tag: "RequestExternal",
        action: "http.stage",
        endpoint: "https://api.example.test/v2/tasks",
        method: "POST"
      })
      expect(lowered.lowering.nodes[0]?.requirements).toEqual([
        {
          kind: "endpoint",
          realm: "external",
          selector: "https://api.example.test/v2/tasks",
          rights: ["connect", "emit"]
        }
      ])
    })
  )

  it.effect("lowers a Secret template to an opaque reference carrying no bytes", () =>
    Effect.gen(function* () {
      const loaded = yield* load(v2Definition())
      const lowered = yield* lowerToolAction(
        request(loaded, { title: "no bytes here", project: "airlock" })
      )
      const call = lowered.call
      if (call.action !== "http.stage") throw new Error("expected an http.stage call")

      expect(call.headers.authorization).toBe(
        `${SECRET_REFERENCE_PREFIX}credentials.example`
      )
      // Nothing in the definition or the lowered intent can carry credential
      // bytes: the reference names a path, and resolution happens only inside
      // trusted staging when the private dispatch document is constructed.
      expect(JSON.stringify(lowered)).not.toContain("Bearer ")
      expect(JSON.stringify(loaded.definition)).not.toContain("Bearer ")
    })
  )

  it.effect("refuses a Secret template in an agent-visible position", () =>
    Effect.gen(function* () {
      const secretEndpoint = yield* load(
        withRequest({ endpoint: { _tag: "Secret", path: ["credentials", "example"] } })
      ).pipe(Effect.flip)
      expect(secretEndpoint).toBeInstanceOf(ToolSecretPlacementRejected)
      expect(secretEndpoint).toMatchObject({
        action: "tasks.create",
        field: "actions.tasks.create.request.endpoint"
      })
    })
  )

  it.effect("refuses Artifact templates in a request until runtime binding exists", () =>
    Effect.gen(function* () {
      const artifactBody = yield* load(
        withRequest({ body: { _tag: "Artifact", path: ["payload"] } })
      ).pipe(Effect.flip)
      expect(artifactBody).toBeInstanceOf(InvalidToolDefinition)
      expect(artifactBody).toMatchObject({ field: "actions.tasks.create.request.body" })
    })
  )

  it.effect("requires a total request contract before an action becomes callable", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
        ["no request", { request: undefined }, "actions.tasks.create.request"],
        [
          "no emission effect",
          { emissionEffect: undefined },
          "actions.tasks.create.emissionEffect"
        ],
        [
          "footprint omits enqueue",
          { effectFootprint: ["capture"] },
          "actions.tasks.create.effectFootprint"
        ],
        [
          "footprint claims a local effect",
          { effectFootprint: ["enqueue", "invoke"] },
          "actions.tasks.create.effectFootprint"
        ],
        [
          "decodes a local result",
          { resultDecoder: "json-stdout" },
          "actions.tasks.create.resultDecoder"
        ]
      ]
      for (const [name, override, field] of cases) {
        const error = yield* load(
          v2Definition({ actions: [enqueueAction(override)] })
        ).pipe(Effect.flip)
        expect(error, name).toBeInstanceOf(ToolEnqueueContractRejected)
        expect(error, name).toMatchObject({ field })
      }
    })
  )

  it.effect("refuses endpoints that admission could not match as a selector", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["/v2/tasks", "must be an absolute URL"],
        ["file:///etc/passwd", "must use the http or https scheme"],
        ["https://user:pass@api.example.test/v2", "must not carry userinfo"]
      ]
      for (const [value, reason] of cases) {
        const error = yield* load(
          withRequest({ endpoint: { _tag: "Literal", value } })
        ).pipe(Effect.flip)
        expect(error, value).toBeInstanceOf(ToolEnqueueContractRejected)
        expect(error, value).toMatchObject({
          field: "actions.tasks.create.request.endpoint",
          reason
        })
      }

      // An Input-bound endpoint cannot smuggle the request elsewhere either.
      const loaded = yield* load(
        v2Definition({
          actions: [
            enqueueAction({
              inputSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  project: { type: "string" },
                  endpoint: { type: "string" }
                },
                required: ["title", "project", "endpoint"],
                additionalProperties: false
              },
              request: {
                ...(enqueueAction().request as Record<string, unknown>),
                endpoint: { _tag: "Input", path: ["endpoint"] }
              }
            })
          ]
        })
      )
      const relocated = yield* lowerToolAction(
        new ToolActionLoweringRequest({
          loaded,
          action: "tasks.create",
          input: {
            title: "t",
            project: "p",
            endpoint: "https://token:secret@api.example.test/v2/tasks"
          },
          cellProfile: "native-contained"
        })
      ).pipe(Effect.flip)
      expect(relocated).toBeInstanceOf(ToolRequestLoweringRejected)
      expect(relocated).toMatchObject({ field: "request.endpoint" })
    })
  )

  it.effect("validates the declared input schema before producing an intent", () =>
    Effect.gen(function* () {
      const loaded = yield* load(v2Definition())
      const missing = yield* lowerToolAction(
        request(loaded, { project: "airlock" })
      ).pipe(Effect.flip)
      expect(missing).toBeInstanceOf(ToolTemplateRejected)
      expect(missing).toMatchObject({
        field: "request.body",
        reason: "missing"
      })

      const extra = yield* lowerToolAction(
        request(loaded, { title: "t", project: "p", commit: "auto" })
      ).pipe(Effect.flip)
      expect(extra).toMatchObject({
        _tag: "ToolInputRejected",
        path: "$.commit"
      })
    })
  )
})

describe("tool definition v2: authority stays grant-side", () => {
  it.effect("refuses a definition that names a consequence class or grant property", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["class", { class: "read" }],
        ["dispatchClass", { dispatchClass: "read" }],
        ["commit", { commit: "auto" }],
        ["autoCommit", { autoCommit: true }],
        ["endpointGrants", { endpointGrants: [{ selector: "https://api.example.test/*" }] }]
      ]
      for (const [name, override] of cases) {
        const error = yield* load(
          v2Definition({ actions: [enqueueAction(override)] })
        ).pipe(Effect.flip)
        expect(error, name).toBeInstanceOf(ToolGrantAssertionRejected)
        expect(error, name).toMatchObject({ id: "example.tasks" })
      }

      const atDocumentRoot = yield* load(v2Definition({ commit: "auto" })).pipe(Effect.flip)
      expect(atDocumentRoot).toBeInstanceOf(ToolGrantAssertionRejected)
    })
  )

  it.effect("lets a definition narrow the consequence but never widen it", () =>
    Effect.gen(function* () {
      for (const declared of ["read", "mutate"]) {
        const loaded = yield* load(
          v2Definition({ actions: [enqueueAction({ emissionEffect: declared })] })
        )
        const action = loaded.definition.actions[0]!
        expect("emissionEffect" in action ? action.emissionEffect : undefined).toBe(declared)
      }

      // The supervisor's floor has no spelling on the definition side: the
      // only way to accept it is to say nothing, so no declaration can widen.
      for (const widened of ["irreversible-send", "auto", "send"]) {
        const error = yield* load(
          v2Definition({ actions: [enqueueAction({ emissionEffect: widened })] })
        ).pipe(Effect.flip)
        expect(error, widened).toBeInstanceOf(ToolEnqueueContractRejected)
        expect(error, widened).toMatchObject({
          field: "actions.tasks.create.emissionEffect"
        })
      }
    })
  )

  it.effect("does not mistake an action's own input schema for a grant assertion", () =>
    Effect.gen(function* () {
      const loaded = yield* load(
        v2Definition({
          actions: [
            enqueueAction({
              inputSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  project: { type: "string" },
                  class: { type: "string" },
                  commit: { type: "string" }
                },
                required: ["title", "project"],
                additionalProperties: false
              }
            })
          ]
        })
      )
      expect(loaded.definition.actions[0]?.name).toBe("tasks.create")
    })
  )

  it.effect("keeps emissionEffect a description the definition cannot widen", () =>
    Effect.gen(function* () {
      const loaded = yield* load(v2Definition())
      const action = loaded.definition.actions[0]!
      expect("emissionEffect" in action ? action.emissionEffect : undefined).toBe("mutate")
      const lowered = yield* lowerToolAction(
        request(loaded, { title: "t", project: "p" })
      )
      // The declaration travels forward, because the effective class is the
      // stricter of it and the grant's class — that is the narrowing seam, and
      // it can only ever make a dispatch less permitted.
      expect(lowered.emissionEffect).toBe("mutate")
      // The Plan-bound intent itself carries no class, no commit mode, and no
      // grant: the declaration never reaches the RequestExternal node.
      const plannedEncoded = JSON.stringify({
        call: lowered.call,
        lowering: lowered.lowering
      })
      expect(plannedEncoded).not.toContain("emissionEffect")
      const encoded = JSON.stringify(lowered)
      expect(encoded).not.toContain("\"commit\"")
      expect(encoded).not.toContain("dispatchClass")
      expect(encoded).not.toContain("irreversible-send")
    })
  )
})

describe("tool definition v2: the v1 surface is unchanged", () => {
  it.effect("keeps v1 documents on the invoke-only gate", () =>
    Effect.gen(function* () {
      const v1 = {
        schemaVersion: "airlock/tool-definition/v1",
        id: "unix.archive",
        version: "1.0.0",
        executables: [{ realm: "machine", selector: "/usr/bin/tar" }],
        actions: [{ ...invokeAction, lowering: "enqueue", effectFootprint: ["enqueue"] }]
      }
      const gated = yield* load(v1).pipe(Effect.flip)
      expect(gated).toBeInstanceOf(InvalidToolDefinition)
      expect(gated).toMatchObject({
        field: "actions.extract.lowering",
        reason: "v1 definitions support only invoke lowering"
      })
    })
  )

  it.effect("refuses v2 action vocabulary carried by a v1 document", () =>
    Effect.gen(function* () {
      for (const field of ["request", "emissionEffect"] as const) {
        const v1 = {
          schemaVersion: "airlock/tool-definition/v1",
          id: "unix.archive",
          version: "1.0.0",
          executables: [{ realm: "machine", selector: "/usr/bin/tar" }],
          actions: [{
            ...invokeAction,
            [field]: field === "request"
              ? (enqueueAction().request as Record<string, unknown>)
              : "read"
          }]
        }
        const error = yield* load(v1).pipe(Effect.flip)
        expect(error, field).toBeInstanceOf(InvalidToolDefinition)
        expect(error, field).toMatchObject({
          field: `actions.extract.${field}`,
          reason: "requires schemaVersion airlock/tool-definition/v2"
        })
      }
    })
  )

  it.effect("lowers a v2 invoke action exactly as v1 does", () =>
    Effect.gen(function* () {
      const loaded = yield* load(
        v2Definition({
          executables: [{ realm: "machine", selector: "/usr/bin/tar" }],
          actions: [invokeAction]
        })
      )
      const lowered = yield* lowerToolAction(
        new ToolActionLoweringRequest({
          loaded,
          action: "extract",
          input: { archive: "state.tgz" },
          executable: "/usr/bin/tar",
          cellProfile: "native-contained"
        })
      )
      expect(lowered.call).toMatchObject({
        action: "process.run",
        executable: "/usr/bin/tar",
        args: ["-xf", "state.tgz"],
        cwd: "/srv/app",
        realm: "machine"
      })
    })
  )

  it.effect("requires an executable only when a definition exports an invoke action", () =>
    Effect.gen(function* () {
      const enqueueOnly = yield* load(v2Definition())
      expect(enqueueOnly.definition.executables).toEqual([])

      const mixed = yield* load(
        v2Definition({ actions: [enqueueAction(), invokeAction] })
      ).pipe(Effect.flip)
      expect(mixed).toBeInstanceOf(InvalidToolDefinition)
      expect(mixed).toMatchObject({
        field: "executables",
        reason: "must declare at least one compatible executable selector"
      })
    })
  )
})
