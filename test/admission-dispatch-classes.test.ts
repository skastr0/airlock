import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Schema } from "effect"
import {
  AdmissionContractInvalid,
  AdmissionDenied,
  AdmissionPolicy,
  AdmissionPolicyDocument,
  AdmissionPolicyV2,
  type DispatchClass,
  EndpointGrantPolicy,
  admit,
  canonicalizeEndpoint,
  endpointGrantsOf,
  policyDispatchDecision,
  refuseGrantAssertion,
  stricterDispatchClass
} from "../src/admission/index.ts"
import {
  NodeId,
  PlanDraft,
  PlanId,
  RequestExternalNode,
  RequirementId,
  ResourceRequirement
} from "../src/plan/index.ts"

const endpoint = "https://status.internal.example/v1/health"
const readSelector = "https://status.internal.example/v1/*"

const grant = (overrides: Partial<ConstructorParameters<typeof EndpointGrantPolicy>[0]> = {}) =>
  new EndpointGrantPolicy({ selector: readSelector, ...overrides })

const readGrant = grant({ methods: ["GET"], class: "read", commit: "auto" })

const policyV2 = (
  grants: ReadonlyArray<EndpointGrantPolicy>,
  overrides: Partial<ConstructorParameters<typeof AdmissionPolicyV2>[0]> = {}
) =>
  new AdmissionPolicyV2({
    schemaVersion: "airlock/admission-policy/v2",
    profile: "native-contained",
    principal: "agent/test",
    realm: "macos/local",
    admittedBy: "operator/test",
    pathAllowlist: [],
    executableAllowlist: [],
    endpointGrants: grants,
    ...overrides
  })

const policyV1 = (endpointAllowlist: ReadonlyArray<string>) =>
  new AdmissionPolicy({
    schemaVersion: "airlock/admission-policy/v1",
    profile: "native-contained",
    principal: "agent/test",
    realm: "macos/local",
    admittedBy: "operator/test",
    pathAllowlist: [],
    executableAllowlist: [],
    endpointAllowlist
  })

const externalDraft = (
  node: Partial<ConstructorParameters<typeof RequestExternalNode>[0]> = {}
) => {
  const request = new RequestExternalNode({
    id: NodeId.make("external"),
    dependsOn: [],
    requires: [RequirementId.make("endpoint/remote")],
    produces: [],
    method: "GET",
    endpoint,
    holdMillis: 5_000,
    ...node
  })
  const requirement = new ResourceRequirement({
    id: RequirementId.make("endpoint/remote"),
    kind: "endpoint",
    realm: "remote/status.internal.example",
    selector: request.endpoint,
    rights: ["connect", "emit"]
  })
  return new PlanDraft({
    schemaVersion: "airlock/plan-draft/v1",
    id: PlanId.make("plan/dispatch-class"),
    actionReference: "test.dispatch-class",
    nodes: [request],
    requirements: [requirement],
    definitionDigests: []
  })
}

describe("admission policy v2: endpoint grants", () => {
  it.effect("keeps v1 documents decoding and leaves their endpoint semantics untouched", () =>
    Effect.gen(function* () {
      const document = {
        schemaVersion: "airlock/admission-policy/v1",
        profile: "native-contained",
        principal: "agent/test",
        realm: "macos/local",
        admittedBy: "operator/test",
        pathAllowlist: [],
        executableAllowlist: [],
        endpointAllowlist: [readSelector]
      }
      const decoded = yield* Schema.decodeUnknown(AdmissionPolicyDocument)(document)
      expect(decoded).toBeInstanceOf(AdmissionPolicy)
      expect(endpointGrantsOf(decoded)).toEqual([])

      // v1 matching is still the raw string prefix, byte for byte. A v1
      // document therefore keeps admitting exactly what it admitted before,
      // including a traversal URL the v2 canonical match refuses. It is never
      // auto-committed, because v1 has no class vocabulary at all.
      const traversal = "https://status.internal.example/v1/../admin"
      const admitted = yield* admit(externalDraft({ endpoint: traversal }), policyV1([readSelector]))
      expect(admitted.plan.handles).toHaveLength(1)
      expect(policyDispatchDecision(policyV1([readSelector]), {
        url: endpoint,
        method: "GET"
      })).toMatchObject({ _tag: "AwaitSupervisor" })

      // Same policy digest inputs as before: a v1 digest is not disturbed by
      // the v2 field existing.
      const again = yield* admit(externalDraft({ endpoint: traversal }), policyV1([readSelector]))
      expect(again.policyDigest).toBe(admitted.policyDigest)

      // A v1 document that names v2 grants does not acquire them: the version
      // literal decides, and a v1 policy carries no class vocabulary.
      const smuggled = yield* Schema.decodeUnknown(AdmissionPolicyDocument)({
        ...document,
        endpointGrants: [{ selector: readSelector, class: "read", commit: "auto", methods: ["GET"] }]
      })
      expect(endpointGrantsOf(smuggled)).toEqual([])
      expect(policyDispatchDecision(smuggled, { url: endpoint, method: "GET" }))
        .toMatchObject({ _tag: "AwaitSupervisor" })
    })
  )

  it.effect("leaves compatibility exactly as broad as it is under v1", () =>
    Effect.gen(function* () {
      // Compatibility ignores the endpoint allowlist today; a v2 document does
      // not silently tighten it. Grant shape is still validated, because an
      // invalid grant is a supervisor mistake in any profile.
      const compatible = yield* admit(
        externalDraft({ method: "POST", endpoint: "https://elsewhere.example/anything" }),
        policyV2([readGrant], { profile: "compatibility" })
      )
      expect(compatible.plan.handles).toHaveLength(1)

      const invalid = yield* admit(
        externalDraft(),
        policyV2([grant({ class: "mutate", commit: "auto", methods: ["GET"] })], {
          profile: "compatibility"
        })
      ).pipe(Effect.flip)
      expect(invalid).toBeInstanceOf(AdmissionContractInvalid)
    })
  )

  it.effect("decodes v2 documents and defaults an unclassified grant to the staged floor", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(AdmissionPolicyDocument)({
        schemaVersion: "airlock/admission-policy/v2",
        profile: "native-contained",
        principal: "agent/test",
        realm: "macos/local",
        admittedBy: "operator/test",
        pathAllowlist: [],
        executableAllowlist: [],
        endpointGrants: [{ selector: readSelector }]
      })
      expect(decoded).toBeInstanceOf(AdmissionPolicyV2)
      const grants = endpointGrantsOf(decoded)
      expect(grants[0]).toMatchObject({
        selector: readSelector,
        class: "irreversible-send",
        commit: "supervisor"
      })
      expect(grants[0]?.methods).toBeUndefined()

      // Unclassified behaves exactly as today: admitted, and staged.
      const admitted = yield* admit(externalDraft(), decoded)
      expect(admitted.plan.handles).toHaveLength(1)
      expect(policyDispatchDecision(decoded, { url: endpoint, method: "GET" }))
        .toMatchObject({ _tag: "AwaitSupervisor" })
    })
  )

  it.effect("auto-commits only an unambiguous read-class grant whose method fits", () =>
    Effect.gen(function* () {
      const policy = policyV2([readGrant])
      yield* admit(externalDraft(), policy)
      expect(policyDispatchDecision(policy, { url: endpoint, method: "GET" })).toMatchObject({
        _tag: "AutoCommit",
        selector: readSelector,
        effectiveClass: "read"
      })

      // A method outside the grant is refused at admission, so it can never
      // reach a dispatch decision at all.
      const wrongMethod = yield* admit(
        externalDraft({ method: "POST" }),
        policy
      ).pipe(Effect.flip)
      expect(wrongMethod).toMatchObject({
        _tag: "AdmissionDenied",
        requirementId: "endpoint/remote"
      })
      expect(policyDispatchDecision(policy, { url: endpoint, method: "POST" }))
        .toMatchObject({ _tag: "AwaitSupervisor" })

      // Overlapping grants only auto-commit when every fitting grant agrees.
      const overlapped = policyV2([
        readGrant,
        grant({ selector: "https://status.internal.example/v1/health", methods: ["GET"] })
      ])
      expect(policyDispatchDecision(overlapped, { url: endpoint, method: "GET" }))
        .toMatchObject({ _tag: "AwaitSupervisor" })
    })
  )

  it.effect("refuses auto-commit for URLs that only string-prefix-match a read grant", () =>
    Effect.gen(function* () {
      const policy = policyV2([readGrant])
      const prefix = readSelector.slice(0, -1)
      // Identity changes under canonicalization: no grant fits, so admission
      // denies outright rather than admitting and leaving the intent staged.
      const uncanonical = [
        "https://status.internal.example/v1/../admin",
        "https://status.internal.example/v1/%2e%2e/admin"
      ]
      // Query and fragment never participate in the match, so these are still
      // admitted under the grant — they simply never auto-commit.
      const outsideTheMatch = [
        "https://status.internal.example/v1/health?redirect=https://elsewhere.example",
        "https://status.internal.example/v1/health#/../admin"
      ]
      for (const url of [...uncanonical, ...outsideTheMatch]) {
        expect(url.startsWith(prefix)).toBe(true)
        expect(policyDispatchDecision(policy, { url, method: "GET" })).toMatchObject({
          _tag: "AwaitSupervisor"
        })
      }
      // Userinfo is refused unconditionally, prefix match or not.
      const userinfo = "https://attacker@status.internal.example/v1/health"
      expect(policyDispatchDecision(policy, { url: userinfo, method: "GET" })).toMatchObject({
        _tag: "AwaitSupervisor"
      })

      for (const url of [...uncanonical, userinfo]) {
        const denied = yield* admit(externalDraft({ endpoint: url }), policy).pipe(Effect.flip)
        expect(denied).toBeInstanceOf(AdmissionDenied)
      }
      for (const url of outsideTheMatch) {
        const admitted = yield* admit(externalDraft({ endpoint: url }), policy)
        expect(admitted.plan.handles).toHaveLength(1)
      }
    })
  )

  it.effect("rejects a grant that pre-authorizes commit for anything but a read", () =>
    Effect.gen(function* () {
      for (const dispatchClass of ["mutate", "irreversible-send"] as const) {
        const invalid = yield* admit(
          externalDraft(),
          policyV2([grant({ methods: ["GET"], class: dispatchClass, commit: "auto" })])
        ).pipe(Effect.flip)
        expect(invalid).toBeInstanceOf(AdmissionContractInvalid)
        expect(invalid).toMatchObject({ field: "policy.endpointGrants[0].commit" })
      }

      const implicitMethods = yield* admit(
        externalDraft(),
        policyV2([grant({ class: "read", commit: "auto" })])
      ).pipe(Effect.flip)
      expect(implicitMethods).toMatchObject({
        _tag: "AdmissionContractInvalid",
        field: "policy.endpointGrants[0].methods"
      })

      const uncanonicalSelector = yield* admit(
        externalDraft(),
        policyV2([grant({ selector: "https://status.internal.example/v1/../*" })])
      ).pipe(Effect.flip)
      expect(uncanonicalSelector).toMatchObject({
        _tag: "AdmissionContractInvalid",
        field: "policy.endpointGrants[0].selector"
      })
    })
  )

  it.effect("narrows by effective class and never widens one", () =>
    Effect.gen(function* () {
      const auto = policyV2([readGrant])
      // A definition honestly declaring mutate under a read/auto grant stays
      // staged: the effective class is the stricter of the two.
      expect(policyDispatchDecision(auto, {
        url: endpoint,
        method: "GET",
        declaredEmissionEffect: "mutate"
      })).toMatchObject({ _tag: "AwaitSupervisor" })
      expect(policyDispatchDecision(auto, {
        url: endpoint,
        method: "GET",
        declaredEmissionEffect: "read"
      })).toMatchObject({ _tag: "AutoCommit" })

      // No declared value ever converts a supervisor commit into an auto one.
      const supervised = policyV2([grant({ methods: ["GET"], class: "mutate" })])
      for (const declared of ["read", "mutate", "irreversible-send"] as const) {
        expect(policyDispatchDecision(supervised, {
          url: endpoint,
          method: "GET",
          declaredEmissionEffect: declared
        })).toMatchObject({ _tag: "AwaitSupervisor" })
      }

      expect(stricterDispatchClass("read", "mutate")).toBe("mutate")
      expect(stricterDispatchClass("irreversible-send", "read")).toBe("irreversible-send")
      expect(stricterDispatchClass("read", "read")).toBe("read")
    })
  )

  it.effect("enforces the grant hold window and inline body budget at admission", () =>
    Effect.gen(function* () {
      const bounded = policyV2([
        grant({ methods: ["GET", "POST"], hold: { minMillis: 1_000, maxMillis: 10_000 } })
      ])
      yield* admit(externalDraft({ holdMillis: 1_000 }), bounded)
      yield* admit(externalDraft({ holdMillis: 10_000 }), bounded)
      const tooShort = yield* admit(externalDraft({ holdMillis: 999 }), bounded).pipe(Effect.flip)
      expect(tooShort).toMatchObject({
        _tag: "AdmissionDenied",
        requirementId: "endpoint/remote"
      })
      const tooLong = yield* admit(externalDraft({ holdMillis: 10_001 }), bounded).pipe(Effect.flip)
      expect(tooLong).toBeInstanceOf(AdmissionDenied)

      const budgeted = policyV2([
        grant({ methods: ["POST"], budget: { maxBodyBytes: 8 } })
      ])
      yield* admit(externalDraft({ method: "POST", body: "12345678" }), budgeted)
      const tooLarge = yield* admit(
        externalDraft({ method: "POST", body: "123456789" }),
        budgeted
      ).pipe(Effect.flip)
      expect(tooLarge).toBeInstanceOf(AdmissionDenied)
    })
  )
})

describe("dispatch class ratchet", () => {
  it("keeps the class vocabulary out of every program-side module", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url))
    const modules = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") && !entry.startsWith("admission/"))
    expect(modules.length).toBeGreaterThan(20)
    for (const module of modules) {
      const source = readFileSync(`${srcDir}/${module}`, "utf8")
      for (const token of [
        "DispatchClass",
        "EndpointGrantPolicy",
        "dispatchDecision",
        "irreversible-send"
      ]) {
        expect([module, source.includes(token)]).toEqual([module, false])
      }
    }
  })

  it.effect("gives a Plan node no field in which to name a class", () =>
    Effect.gen(function* () {
      const smuggled = yield* Schema.decodeUnknown(RequestExternalNode)({
        _tag: "RequestExternal",
        id: "external",
        dependsOn: [],
        requires: ["endpoint/remote"],
        produces: [],
        method: "GET",
        endpoint,
        holdMillis: 1_000,
        class: "read",
        commit: "auto",
        dispatchClass: "read"
      })
      expect(Object.keys(smuggled)).not.toContain("class")
      expect(Object.keys(smuggled)).not.toContain("commit")
      expect(Object.keys(smuggled)).not.toContain("dispatchClass")
    })
  )

  it("refuses agent-side text that names a grant-side property", () => {
    const definition = {
      schemaVersion: "airlock/tool-definition/v2",
      actions: [{ name: "tasks.create", request: { method: "POST" }, commit: "auto" }]
    }
    const refused = refuseGrantAssertion(definition, "definition")
    expect(refused).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DispatchClassAssertionRejected",
        field: "definition.actions[0].commit"
      }
    })

    const nested = refuseGrantAssertion({ a: { b: [{ dispatchClass: "read" }] } }, "input")
    expect(nested).toMatchObject({ _tag: "Left", left: { field: "input.a.b[0].dispatchClass" } })

    const honest = refuseGrantAssertion(
      {
        schemaVersion: "airlock/tool-definition/v2",
        actions: [{ name: "tasks.create", emissionEffect: "mutate" }]
      },
      "definition"
    )
    expect(Either.isRight(honest)).toBe(true)
  })

  it("canonicalizes endpoints the same way for every decision", () => {
    expect(canonicalizeEndpoint("https://STATUS.Internal.example/v1/health")).toMatchObject({
      _tag: "Right",
      right: { target: "https://status.internal.example/v1/health" }
    })
    for (const [url, reason] of [
      ["https://status.internal.example/v1/../admin", "not-canonical"],
      ["https://status.internal.example:443/v1/health", "not-canonical"],
      ["https://u:p@status.internal.example/v1", "userinfo-present"],
      ["file:///etc/passwd", "unsupported-scheme"],
      ["not a url", "unparseable"]
    ] as const) {
      expect(canonicalizeEndpoint(url)).toMatchObject({ _tag: "Left", left: { reason } })
    }
  })

  it("types the declared emission effect as a narrowing input only", () => {
    const declared: DispatchClass = "read"
    expect(stricterDispatchClass(declared, "irreversible-send")).toBe("irreversible-send")
  })
})
