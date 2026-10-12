import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import {
  BoxGrant,
  BoxGrantVerb,
  decodeAndHashBoxGrant,
  decodeBoxGrant,
  hashBoxGrant
} from "../src/core/admission/index.ts"
import { ToolPolicy } from "../src/core/session/ToolPolicy.ts"
import { run } from "./support/CoreTest.ts"

const sha = (hex: string) => `sha256:${hex.repeat(64)}`

const policy = {
  schemaVersion: "airlock/tool-policy/v1" as const,
  toolGrants: [
    { id: "read", tool: "file.read", when: "now" },
    { id: "write", tool: "file.write", when: "approved" }
  ],
  resources: { path: ["/workspace"] },
  budget: { maxCalls: 16, maxInputBytes: 65_536 }
}

const document = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "airlock/box-grant/v2",
  policy,
  verbs: ["run", "eval", "pending"],
  binaryDigest: sha("a"),
  ...overrides
})

const allVerbs = [
  "describe", "review", "run", "eval", "pending", "inspect", "ledger", "doctor", "capabilities"
]

const decoded = (input: unknown) => Effect.runPromise(decodeBoxGrant(input))
const rejected = async (input: unknown) =>
  Result.isFailure(await Effect.runPromise(Effect.result(decodeBoxGrant(input))))
const digestOf = async (input: unknown) => run(hashBoxGrant(await decoded(input)))

describe("box grant v2", () => {
  it("nests the tool policy every sealed program is held to", async () => {
    const grant = await decoded(document())

    expect(grant).toBeInstanceOf(BoxGrant)
    expect(grant.policy).toBeInstanceOf(ToolPolicy)
    expect(grant.schemaVersion).toBe("airlock/box-grant/v2")
    expect(grant.policy.toolGrants.map(({ tool }) => tool)).toEqual(["file.read", "file.write"])
  })

  it("hashes decoded semantic content independently of JSON key order and verb order", async () => {
    const first = await digestOf(JSON.parse(JSON.stringify(document())))
    const reordered = await digestOf(JSON.parse(JSON.stringify({
      binaryDigest: sha("a"),
      verbs: ["run", "eval", "pending"],
      policy: {
        budget: { maxInputBytes: 65_536, maxCalls: 16 },
        resources: { path: ["/workspace"] },
        toolGrants: [
          { when: "now", tool: "file.read", id: "read" },
          { when: "approved", tool: "file.write", id: "write" }
        ],
        schemaVersion: "airlock/tool-policy/v1"
      },
      schemaVersion: "airlock/box-grant/v2"
    })))
    expect(reordered).toBe(first)

    expect(await digestOf(document({ verbs: ["pending", "eval", "run"] })))
      .toBe(await digestOf(document({ verbs: ["eval", "pending", "run"] })))

    const combined = await run(decodeAndHashBoxGrant(document()))
    expect(combined.digest).toBe(await run(hashBoxGrant(combined.grant)))
    expect(combined.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("names a widened policy by a different digest", async () => {
    const signed = await digestOf(document())
    const widened = [
      document({ policy: { ...policy, toolGrants: [...policy.toolGrants, { id: "rm", tool: "file.remove", when: "now" }] } }),
      document({ policy: { ...policy, resources: { path: ["/"] } } }),
      document({ policy: { ...policy, budget: { ...policy.budget, maxCalls: 17 } } }),
      document({ policy: { ...policy, toolGrants: [{ ...policy.toolGrants[0], when: "now" }, { ...policy.toolGrants[1], when: "now" }] } }),
      document({ verbs: ["run", "eval", "pending", "inspect"] })
    ]
    for (const candidate of widened) expect(await digestOf(candidate)).not.toBe(signed)
  })

  it("refuses a grant in the v1 shape and one that carries a definition catalog", async () => {
    expect(await rejected({
      schemaVersion: "airlock/box-grant/v1",
      admission: {
        schemaVersion: "airlock/admission-policy/v2",
        profile: "native-contained",
        principal: "agent/test",
        realm: "local",
        admittedBy: "supervisor/test",
        pathAllowlist: ["/workspace/**"],
        executableAllowlist: [],
        executableEdges: [],
        endpointGrants: []
      },
      verbs: ["run"],
      nativeActions: ["file.read"],
      daemonOps: [],
      binaryDigest: sha("a")
    })).toBe(true)
    expect(await rejected(document({ schemaVersion: "airlock/box-grant/v1" }))).toBe(true)
    for (const removed of ["admission", "nativeActions", "daemonOps", "catalog"]) {
      expect(await rejected({ ...document(), [removed]: [] }), removed).toBe(true)
    }
  })

  it("keeps verbs closed to the current command list", async () => {
    expect(BoxGrantVerb.literals).toEqual(allVerbs)
    const all = await decoded(document({ verbs: allVerbs }))
    expect(all.verbs).toEqual(allVerbs)

    for (const verb of [
      "approve-plan", "commit", "cancel", "undo", "reap",
      "change", "shell", "serve", "exec", "rm", "write", "send", "flush",
      "held", "actions", "schema", "runs", "run-receipt"
    ]) expect(await rejected(document({ verbs: ["run", verb] })), verb).toBe(true)
  })

  it("rejects duplicate verbs instead of normalizing them", async () => {
    expect(await rejected(document({ verbs: ["run", "run"] }))).toBe(true)
  })

  it("requires a lowercase sha256 binary digest", async () => {
    expect(await rejected(document({ binaryDigest: "a".repeat(64) }))).toBe(true)
    expect(await rejected(document({ binaryDigest: `sha256:${"A".repeat(64)}` }))).toBe(true)
    expect(await rejected(document({ binaryDigest: `sha256:${"a".repeat(63)}` }))).toBe(true)
    expect(await rejected(document({ binaryDigest: `sha256:${"g".repeat(64)}` }))).toBe(true)

    const { binaryDigest: _binaryDigest, ...missing } = document()
    expect(await rejected(missing)).toBe(true)
  })

  it("strictly rejects excess fields at every authority-bearing level", async () => {
    expect(await rejected({ ...document(), mintedVerb: "root" })).toBe(true)
    expect(await rejected(document({ policy: { ...policy, verbs: ["commit"] } }))).toBe(true)
    expect(await rejected(document({ policy: { ...policy, budget: { ...policy.budget, unlimited: true } } }))).toBe(true)
    expect(await rejected(document({ policy: { ...policy, resources: { path: ["/workspace"], everything: ["/"] } } }))).toBe(true)
    expect(await rejected(document({
      policy: { ...policy, toolGrants: [{ ...policy.toolGrants[0], escalate: true }] }
    }))).toBe(true)
    const { policy: _policy, ...unpoliced } = document()
    expect(await rejected(unpoliced)).toBe(true)
  })

  it("keeps grant minting separate from .air programs", async () => {
    // Construction evidence: the agent-origin source plane neither imports
    // the grant component nor carries its versioned document vocabulary. Its
    // bytes can be inputs to a run, but cannot become this supervisor type.
    const language = "src/core/language"
    const agentPlane = readdirSync(language)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(language, name), "utf8")).join("\n")
    expect(agentPlane).toContain("parse")
    expect(agentPlane).not.toContain("BoxGrant")
    expect(agentPlane).not.toContain("airlock/box-grant/")

    // A wrapper of another shape cannot mint authority by carrying grant
    // fields: strict decoding accepts only the dedicated supervisor envelope.
    expect(await rejected({
      schemaVersion: "airlock/program/v1",
      id: "attempt",
      verbs: ["commit"],
      policy,
      binaryDigest: sha("a")
    })).toBe(true)
    expect(await rejected({
      source: 'return grant({ verbs: ["commit"] })',
      ...document()
    })).toBe(true)
  })
})
