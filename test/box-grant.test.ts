import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"
import {
  AdmissionPolicy,
  AdmissionPolicyV2,
  BoxGrant,
  decodeAndHashBoxGrant,
  decodeBoxGrant,
  hashBoxGrant
} from "../src/admission/index.ts"
import { NativeActionCatalog } from "../src/actions/index.ts"

const sha = (hex: string) => `sha256:${hex.repeat(64)}`

const admissionV1 = {
  schemaVersion: "airlock/admission-policy/v1" as const,
  profile: "native-contained" as const,
  principal: "agent/test",
  realm: "local",
  admittedBy: "supervisor/test",
  pathAllowlist: ["/workspace/**"],
  executableAllowlist: ["/usr/bin/git"],
  endpointAllowlist: []
}

const admissionV2 = {
  schemaVersion: "airlock/admission-policy/v2" as const,
  profile: "native-contained" as const,
  principal: "agent/test",
  realm: "local",
  admittedBy: "supervisor/test",
  pathAllowlist: ["/workspace/**"],
  executableAllowlist: ["/usr/bin/git"],
  endpointGrants: []
}

const document = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "airlock/box-grant/v1",
  admission: admissionV1,
  verbs: ["run", "held", "pending"],
  nativeActions: ["file.read", "process.run"],
  catalog: [{ id: "builtin/core@1", sha256: sha("b") }],
  daemonOps: ["commit", "reap"],
  binaryDigest: sha("a"),
  ...overrides
})

const decoded = (input: unknown) => Effect.runPromise(decodeBoxGrant(input))
const rejected = async (input: unknown) =>
  Either.isLeft(await Effect.runPromise(Effect.either(decodeBoxGrant(input))))

describe("box grant v1", () => {
  it("nests either admission-policy wire version", async () => {
    const v1 = await decoded(document())
    const v2 = await decoded(document({ admission: admissionV2 }))

    expect(v1).toBeInstanceOf(BoxGrant)
    expect(v1.admission).toBeInstanceOf(AdmissionPolicy)
    expect(v2.admission).toBeInstanceOf(AdmissionPolicyV2)
    expect(v1.schemaVersion).toBe("airlock/box-grant/v1")
  })

  it("hashes decoded semantic content independently of JSON object key order", async () => {
    const first = await decoded(JSON.parse(JSON.stringify(document())))
    const second = await decoded(JSON.parse(JSON.stringify({
      binaryDigest: sha("a"),
      daemonOps: ["commit", "reap"],
      catalog: [{ sha256: sha("b"), id: "builtin/core@1" }],
      nativeActions: ["file.read", "process.run"],
      verbs: ["run", "held", "pending"],
      admission: {
        endpointAllowlist: [],
        executableAllowlist: ["/usr/bin/git"],
        pathAllowlist: ["/workspace/**"],
        admittedBy: "supervisor/test",
        realm: "local",
        principal: "agent/test",
        profile: "native-contained",
        schemaVersion: "airlock/admission-policy/v1"
      },
      schemaVersion: "airlock/box-grant/v1"
    })))

    expect(hashBoxGrant(second)).toBe(hashBoxGrant(first))

    const reorderedSets = await decoded(document({
      verbs: ["pending", "held", "run"],
      nativeActions: ["process.run", "file.read"],
      catalog: [
        { id: "z/catalog", sha256: sha("c") },
        { id: "a/catalog", sha256: sha("b") }
      ],
      daemonOps: ["reap", "commit"]
    }))
    const orderedSets = await decoded(document({
      verbs: ["held", "pending", "run"],
      nativeActions: ["file.read", "process.run"],
      catalog: [
        { id: "a/catalog", sha256: sha("b") },
        { id: "z/catalog", sha256: sha("c") }
      ],
      daemonOps: ["commit", "reap"]
    }))
    expect(hashBoxGrant(reorderedSets)).toBe(hashBoxGrant(orderedSets))

    const combined = await Effect.runPromise(decodeAndHashBoxGrant(document()))
    expect(combined.digest).toBe(hashBoxGrant(combined.grant))
    expect(combined.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("requires catalog while accepting an explicitly empty pinned set", async () => {
    const empty = await decoded(document({ catalog: [] }))
    expect(empty.catalog).toEqual([])

    const { catalog: _catalog, ...missing } = document()
    expect(await rejected(missing)).toBe(true)
  })

  it("keeps verbs, native actions, and daemon operations closed", async () => {
    const currentVerbs = [
      "rm", "write", "undo", "held", "reap",
      "send", "pending", "commit", "cancel", "flush",
      "doctor", "capabilities", "actions", "schema", "exec", "run", "eval",
      "ledger", "runs", "run-receipt", "serve"
    ]
    const all = await decoded(document({
      verbs: currentVerbs,
      nativeActions: NativeActionCatalog.map(({ name }) => name),
      daemonOps: ["commit", "reap", "flush", "hold-expiry"]
    }))
    expect(all.verbs).toEqual(currentVerbs)
    expect(all.nativeActions).toHaveLength(12)

    expect(await rejected(document({ verbs: ["run", "shell"] }))).toBe(true)
    expect(await rejected(document({ nativeActions: ["file.read", "plugin.run"] }))).toBe(true)
    expect(await rejected(document({ daemonOps: ["commit", "dispatch"] }))).toBe(true)
  })

  it("rejects duplicate set members and duplicate catalog identities", async () => {
    const cases = [
      document({ verbs: ["run", "run"] }),
      document({ nativeActions: ["file.read", "file.read"] }),
      document({ daemonOps: ["commit", "commit"] }),
      document({ catalog: [
        { id: "same", sha256: sha("b") },
        { id: "same", sha256: sha("c") }
      ] }),
      document({ catalog: [
        { id: "one", sha256: sha("b") },
        { id: "two", sha256: sha("b") }
      ] })
    ]
    for (const candidate of cases) expect(await rejected(candidate)).toBe(true)
  })

  it("requires lowercase sha256 pins and a binary digest", async () => {
    expect(await rejected(document({ binaryDigest: "a".repeat(64) }))).toBe(true)
    expect(await rejected(document({ binaryDigest: `sha256:${"A".repeat(64)}` }))).toBe(true)
    expect(await rejected(document({ binaryDigest: `sha256:${"a".repeat(63)}` }))).toBe(true)
    expect(await rejected(document({
      catalog: [{ id: "bad", sha256: `sha256:${"g".repeat(64)}` }]
    }))).toBe(true)

    const { binaryDigest: _binaryDigest, ...missing } = document()
    expect(await rejected(missing)).toBe(true)
  })

  it("strictly rejects excess fields at every authority-bearing level", async () => {
    expect(await rejected({ ...document(), mintedVerb: "root" })).toBe(true)
    expect(await rejected(document({
      admission: { ...admissionV1, verbs: ["reap"] }
    }))).toBe(true)
    expect(await rejected(document({
      catalog: [{ id: "builtin/core@1", sha256: sha("b"), path: "/tmp/plugin" }]
    }))).toBe(true)
    expect(await rejected(document({
      admission: { ...admissionV2, endpointAllowlist: ["https://widen.example/*"] }
    }))).toBe(true)
  })

  it("keeps grant minting separate from tool definitions and .air programs", async () => {
    // Construction evidence: the two agent-origin source planes neither import
    // the grant component nor carry its versioned document vocabulary. Their
    // bytes can be inputs to admission, but cannot become this supervisor type.
    const agentPlane = [
      "src/tools/Definitions.ts",
      "src/tools/Lowering.ts",
      "src/program/Program.ts",
      "src/language/ast.ts",
      "src/language/parser.ts"
    ].map((path) => readFileSync(path, "utf8")).join("\n")
    expect(agentPlane).not.toContain("BoxGrant")
    expect(agentPlane).not.toContain("airlock/box-grant/v1")

    // A tool/.air-shaped wrapper cannot mint authority by carrying grant
    // arrays: strict decoding accepts only the dedicated supervisor envelope.
    expect(await rejected({
      schemaVersion: "airlock/tool-definition/v2",
      id: "attempt",
      verbs: ["reap"],
      nativeActions: ["file.remove"],
      catalog: [{ id: "attacker", sha256: sha("c") }],
      daemonOps: ["commit"],
      binaryDigest: sha("a"),
      admission: admissionV1
    })).toBe(true)
    expect(await rejected({
      source: 'return grant({ verbs: ["reap"] })',
      ...document()
    })).toBe(true)
  })
})
