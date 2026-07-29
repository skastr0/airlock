import { BunContext } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
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
import * as AirlockHome from "../src/AirlockHome.ts"
import { admit, AdmissionPolicy } from "../src/admission/index.ts"
import { CellLive } from "../src/cell/index.ts"
import { Hold } from "../src/Hold.ts"
import { HoldLive } from "../src/HoldLive.ts"
import { Ledger, LedgerLive } from "../src/Ledger.ts"
import { Outbox, OutboxLive } from "../src/Outbox.ts"
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
  ResourceRequirement
} from "../src/plan/index.ts"
import { MacosPlatformLive } from "../src/platform/macos/index.ts"
import { ProcessRunnerLive } from "../src/process/Process.ts"
import {
  Runtime,
  RuntimeConfig,
  RuntimeConfigLive,
  RuntimeLive
} from "../src/runtime/index.ts"

/**
 * A fixed tar fixture is test input, not an Airlock implementation of tar.
 * The acting program below extracts it with the host's existing /usr/bin/tar.
 */
const stateArchiveBase64 =
  "H4sIAA3XaWoAA+2ZTY/SQByHu5sYs3jWi5cJd4d5LzXuAY3JssGsLqxvl00Ds8oGWpwWQ2L8DJ5MvPtFHQSB8LJsDVMj/T/JZEoz7Uxbfp2nLb7EnmsIIb6U6HetJjVhYlJPljmiknHGJRdUIkK5z4iHiPORWYZJGho7lA/Dbu+jNn3dDpPUxCvtbLOrqxv2MzkUNKv/F+48uOsdet6LsI3OmugtmjJe5x3Zwmz5ZMv498/b7bLWap1PF8db/LDl3lKTg/n6++24j8PBoKfxwMSfdRRGbe0dHHrfHh7p6Enj+w4OEtjEy3B0osOONpX20BgdpZ2u2XUfW/NPyVL+feEzD412PZB1FDz/nKB+2u3rY+pXJWeUsQArUQ2qPJC8JH3UqD+tnT87qb9+jkdhmhq8Lq7HtVf12vUoOX3/RlRbpxclEaCm3ajx7qaNFjJe+tfnoajgivs+tuV/nJel+V9K5SHpfmiFzz+u4MtEJ0k3jhJXfWT3P3v5FfhfLoD/FRpcmRugq/vAX/gfpwL8Lw/W+19Alb0SFPxv78Gz1LsTwez+JwUT4H95MPa/5tlFA/c7zvqw50MJkcn/bEPwv1wA/ys0i/7n6j6wNf8r/qcUA//LhQ3+RyRRNAD/23uws9TP2ZZ/m/el/AslfZj/88DoJI2N7qAkHvYghYVj4flv9iIYXydxtMM+Mvs/s0oA/p8P4P+FZiH/Ky+Cd3UfyOz/jPoC/D8XNvg/Iz5X4P/7z0L+Hc3+t/B/zpa///i+hPk/D76Uu53y4/Kfx4BH0z9B+SskEgAAYK/5BbxcCpYAMAAA"

const originalSoul = "live soul\n"
const restoredSoul = "restored soul\n"
const endpoint = "https://realm.example.invalid/v1/machines/alice/replace"
const externalBody = JSON.stringify({
  action: "replace-machine",
  image: "fixture-image",
  name: "alice"
})
const externalHeaders = {
  "content-type": "application/json",
  "x-airlock-proof": "vouch"
}

const node = (value: string) => NodeId.make(value)
const requirement = (value: string) => RequirementId.make(value)
const artifact = (value: string) => ArtifactId.make(value)

const receiptEvidence = Schema.Struct({
  nodeId: Schema.String,
  state: Schema.String,
  sequence: Schema.Number,
  resourceIdentities: Schema.Array(Schema.String),
  inputDigests: Schema.Array(Schema.String),
  outputArtifacts: Schema.Array(Schema.String)
})

export class VouchProofReport extends Schema.Class<VouchProofReport>(
  "VouchProofReport"
)({
  schemaVersion: Schema.Literal("airlock/vouch-proof/v1"),
  platform: Schema.String,
  workspace: Schema.String,
  planId: Schema.String,
  profile: Schema.Literal("native-contained"),
  grantCount: Schema.Number,
  handleCount: Schema.Number,
  receipts: Schema.Array(receiptEvidence),
  cell: Schema.Struct({
    executable: Schema.String,
    args: Schema.Array(Schema.String),
    exitCode: Schema.Number,
    network: Schema.Literal("deny"),
    readAuthority: Schema.Literal("ambient-host-read"),
    delta: Schema.Array(
      Schema.Struct({ path: Schema.String, kind: Schema.String })
    )
  }),
  liveState: Schema.Struct({
    observedBeforeApply: Schema.String,
    afterApply: Schema.String,
    restoredSessionPresent: Schema.Boolean
  }),
  outbox: Schema.Struct({
    status: Schema.Literal("staged"),
    dispatchCalls: Schema.Number,
    endpoint: Schema.String,
    method: Schema.String,
    headerNames: Schema.Array(Schema.String),
    bodyBytes: Schema.Number,
    privateDispatchPreserved: Schema.Boolean,
    privateDispatchMode: Schema.Number
  }),
  undo: Schema.Struct({
    target: Schema.String,
    soulAfterUndo: Schema.String,
    restoredSessionPresentAfterUndo: Schema.Boolean
  }),
  ledger: Schema.Array(
    Schema.Struct({
      effect: Schema.String,
      act: Schema.String,
      ref: Schema.String
    })
  )
}) {}

const assert: (
  condition: boolean,
  message: string
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Vouch proof failed: ${message}`)
}

const makeFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-vouch-proof-")))
  const workspace = join(root, "workspace")
  const hermes = join(workspace, "hermes")
  const archive = join(workspace, "hermes-state.tgz")
  const home = join(root, "airlock-home")
  mkdirSync(hermes, { recursive: true })
  writeFileSync(join(hermes, "SOUL.md"), originalSoul)
  writeFileSync(archive, Buffer.from(stateArchiveBase64, "base64"))
  return { root, workspace, hermes, archive, home }
}

const makeDraft = (
  workspace: string,
  archivePath: string,
  soulPath: string
) => {
  const captureArchive = requirement("capture-archive-path")
  const invokeTar = requirement("invoke-tar")
  const observeSoul = requirement("observe-live-soul")
  const mergeWorkspace = requirement("merge-workspace")
  const stageReplacement = requirement("stage-replacement")
  const archiveArtifact = artifact("vouch/archive")
  const tarStderr = artifact("vouch/tar-stderr")
  const cellDelta = artifact("vouch/restore-delta")
  const beforeApply = artifact("vouch/live-before-apply")

  const requirements = [
    new ResourceRequirement({
      id: captureArchive,
      kind: "path",
      realm: "host",
      selector: archivePath,
      rights: ["read"]
    }),
    new ResourceRequirement({
      id: invokeTar,
      kind: "executable",
      realm: "host",
      selector: "/usr/bin/tar",
      rights: ["execute"]
    }),
    new ResourceRequirement({
      id: observeSoul,
      kind: "path",
      realm: "host",
      selector: soulPath,
      rights: ["read"]
    }),
    new ResourceRequirement({
      id: mergeWorkspace,
      kind: "path",
      realm: "host",
      selector: workspace,
      rights: ["write"]
    }),
    new ResourceRequirement({
      id: stageReplacement,
      kind: "endpoint",
      realm: "replacement-controller",
      selector: endpoint,
      rights: ["emit"]
    })
  ]

  const capture = new CaptureNode({
    id: node("capture-archive"),
    dependsOn: [],
    requires: [captureArchive],
    produces: [archiveArtifact],
    source: "file",
    locator: archivePath
  })
  const invoke = new InvokeNode({
    id: node("extract-private"),
    dependsOn: [capture.id],
    requires: [invokeTar],
    produces: [tarStderr, cellDelta],
    executable: "/usr/bin/tar",
    args: ["-xzf", "-", "-C", "hermes"],
    cwd: workspace,
    env: {
      COPYFILE_DISABLE: "1",
      LANG: "C"
    },
    stdin: archiveArtifact,
    stderrArtifact: tarStderr,
    deltaArtifact: cellDelta,
    stdout: "discard",
    stderr: "capture",
    outputLimitBytes: 262_144,
    timeoutMs: 30_000,
    cellProfile: "native-contained"
  })
  const observe = new CaptureNode({
    id: node("observe-live-before-apply"),
    dependsOn: [invoke.id],
    requires: [observeSoul],
    produces: [beforeApply],
    source: "file",
    locator: soulPath
  })
  const apply = new ApplyNode({
    id: node("merge-private-restore"),
    dependsOn: [observe.id],
    requires: [mergeWorkspace],
    produces: [],
    operation: "merge",
    target: workspace,
    sourceArtifact: cellDelta
  })
  const request = new RequestExternalNode({
    id: node("stage-machine-replacement"),
    dependsOn: [apply.id],
    requires: [stageReplacement],
    produces: [],
    method: "POST",
    endpoint,
    headers: externalHeaders,
    body: externalBody,
    holdMillis: 300_000
  })

  return {
    draft: new PlanDraft({
      schemaVersion: "airlock/plan-draft/v1",
      id: PlanId.make("plan/vouch-state-restore-proof"),
      actionReference: "examples.vouch.restore",
      nodes: [capture, invoke, observe, apply, request],
      requirements,
      definitionDigests: []
    }),
    artifacts: { beforeApply, cellDelta }
  }
}

/**
 * Executes the Vouch-derived proof through one composed Effect runtime.
 * Fixture setup and evidence reads are test-harness authority; every acting
 * operation is represented by the admitted Airlock Plan.
 */
export const runVouchProof = async (): Promise<VouchProofReport> => {
  assert(process.platform === "darwin", "the native-contained proof requires macOS")
  assert(typeof Bun !== "undefined", "the proof requires Bun")
  assert(existsSync("/usr/bin/sandbox-exec"), "sandbox-exec is unavailable")
  assert(existsSync("/usr/bin/tar"), "/usr/bin/tar is unavailable")

  const fixture = makeFixture()
  const soulPath = join(fixture.hermes, "SOUL.md")
  const restoredSession = join(fixture.hermes, "sessions", "session.json")
  const { draft, artifacts } = makeDraft(
    fixture.workspace,
    fixture.archive,
    soulPath
  )
  const policy = new AdmissionPolicy({
    schemaVersion: "airlock/admission-policy/v1",
    profile: "native-contained",
    principal: "agent:vouch-proof",
    realm: "host",
    admittedBy: "airlock:vouch-proof",
    grantTtlMillis: 300_000,
    pathAllowlist: [`${fixture.workspace}/**`],
    executableAllowlist: ["/usr/bin/tar"],
    endpointAllowlist: [endpoint]
  })

  const runtimeLayer = RuntimeLive.pipe(
    Layer.provideMerge(CellLive),
    Layer.provideMerge(ProcessRunnerLive),
    Layer.provideMerge(MacosPlatformLive),
    Layer.provideMerge(HoldLive),
    Layer.provideMerge(OutboxLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(AirlockHome.layer(fixture.home)),
    Layer.provideMerge(
      RuntimeConfigLive(
        new RuntimeConfig({
          workspace: fixture.workspace,
          profile: "native-contained"
        })
      )
    ),
    Layer.provideMerge(BunContext.layer)
  )

  let dispatchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) => {
    dispatchCalls += 1
    return Promise.reject(new Error("Vouch proof forbids dispatch"))
  }) as typeof fetch

  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const admitted = yield* admit(draft, policy)
        const runtime = yield* Runtime
        const run = yield* runtime.execute(admitted.plan)

        assert(run.state === "succeeded", `runtime ended ${run.state}`)
        assert(
          run.receipts.every((receipt) => receipt.state === "succeeded"),
          "not every Plan node succeeded"
        )
        assert(
          run.receipts.every(
            (receipt) => receipt.resourceIdentities.length === 1
          ),
          "every node must carry its admitted resource identity"
        )

        const beforeApply = run.artifacts.find(
          (entry) => entry.artifact.id === artifacts.beforeApply
        )
        assert(beforeApply !== undefined, "live-before-Apply Capture is missing")
        const observedBeforeApply = new TextDecoder().decode(beforeApply!.bytes)
        assert(
          observedBeforeApply === originalSoul,
          "Invoke mutated live state before Apply"
        )

        const delta = run.artifacts.find(
          (entry) => entry.artifact.id === artifacts.cellDelta
        )
        const cellReceipt = delta?.cellReceipt
        assert(cellReceipt !== undefined, "Cell delta receipt is missing")
        assert(
          cellReceipt!.process.executable === "/usr/bin/tar",
          "the Cell did not invoke /usr/bin/tar"
        )
        assert(
          cellReceipt!.processReceipt.exitCode === 0,
          "tar did not exit successfully"
        )
        assert(
          cellReceipt!.network === "deny",
          "restore Cell did not deny network"
        )
        assert(
          cellReceipt!.delta.length === 1 &&
            cellReceipt!.delta[0]?.path === "hermes" &&
            cellReceipt!.delta[0]?.kind === "modified",
          "restore must propose one generic top-level directory delta"
        )

        const afterApply = readFileSync(soulPath, "utf8")
        assert(afterApply === restoredSoul, "Apply did not install restored state")
        assert(existsSync(restoredSession), "restored session is missing")

        const outbox = yield* Outbox
        const pending = yield* outbox.pending
        assert(pending.length === 1, "expected one staged external intent")
        const staged = pending[0]!
        assert(staged.status === "staged", "external intent was not left staged")
        assert(
          staged.intent.endpoint === endpoint,
          "staged endpoint does not match the admitted endpoint"
        )
        assert(
          staged.intent.bodyBytes === Buffer.byteLength(externalBody),
          "Runtime did not preserve the external body"
        )
        assert(
          JSON.stringify(staged.intent.headerNames) ===
            JSON.stringify(Object.keys(externalHeaders).sort()),
          "Runtime did not preserve external header names"
        )

        const dispatchPath = join(
          fixture.home,
          "outbox",
          `${staged.id}.staged`,
          "dispatch.json"
        )
        const privateDispatch = JSON.parse(readFileSync(dispatchPath, "utf8")) as {
          readonly body?: string
          readonly headers?: Record<string, string>
          readonly method?: string
          readonly url?: string
        }
        const privateDispatchPreserved =
          privateDispatch.url === endpoint &&
          privateDispatch.method === "POST" &&
          privateDispatch.body === externalBody &&
          JSON.stringify(privateDispatch.headers) ===
            JSON.stringify(externalHeaders)
        assert(
          privateDispatchPreserved,
          "owner-only dispatch material did not preserve admitted request bytes"
        )
        const privateDispatchMode = statSync(dispatchPath).mode & 0o777
        assert(
          privateDispatchMode === 0o600,
          "private dispatch material is not owner-only"
        )
        assert(dispatchCalls === 0, "staging touched the wire")

        const hold = yield* Hold
        const undo = yield* hold.undoLast
        const soulAfterUndo = readFileSync(soulPath, "utf8")
        const restoredSessionPresentAfterUndo = existsSync(restoredSession)
        assert(soulAfterUndo === originalSoul, "undo did not restore prior state")
        assert(
          !restoredSessionPresentAfterUndo,
          "undo retained a session introduced by restore"
        )

        const ledger = yield* Ledger
        const entries = yield* ledger.entries
        assert(
          entries.some(
            (entry) => entry.effect === "mutation" && entry.act === "overwrite"
          ),
          "Hold merge receipt is absent from Ledger"
        )
        assert(
          entries.some(
            (entry) => entry.effect === "emission" && entry.act === "stage"
          ),
          "Outbox staging receipt is absent from Ledger"
        )
        assert(
          entries.some(
            (entry) => entry.effect === "mutation" && entry.act === "undo"
          ),
          "undo receipt is absent from Ledger"
        )

        return new VouchProofReport({
          schemaVersion: "airlock/vouch-proof/v1",
          platform: process.platform,
          workspace: fixture.workspace,
          planId: admitted.plan.id,
          profile: "native-contained",
          grantCount: admitted.grants.length,
          handleCount: admitted.plan.handles.length,
          receipts: run.receipts.map((receipt) => ({
            nodeId: receipt.nodeId,
            state: receipt.state,
            sequence: receipt.sequence,
            resourceIdentities: [...receipt.resourceIdentities],
            inputDigests: [...receipt.inputDigests],
            outputArtifacts: [...receipt.outputArtifacts]
          })),
          cell: {
            executable: cellReceipt!.process.executable,
            args: [...cellReceipt!.process.args],
            exitCode: cellReceipt!.processReceipt.exitCode!,
            network: cellReceipt!.network,
            readAuthority: cellReceipt!.readAuthority,
            delta: cellReceipt!.delta.map((candidate) => ({
              path: candidate.path,
              kind: candidate.kind
            }))
          },
          liveState: {
            observedBeforeApply,
            afterApply,
            restoredSessionPresent: true
          },
          outbox: {
            status: staged.status,
            dispatchCalls,
            endpoint: staged.intent.endpoint,
            method: staged.intent.method,
            headerNames: [...staged.intent.headerNames],
            bodyBytes: staged.intent.bodyBytes,
            privateDispatchPreserved,
            privateDispatchMode
          },
          undo: {
            target: undo.target,
            soulAfterUndo,
            restoredSessionPresentAfterUndo
          },
          ledger: entries.map((entry) => ({
            effect: entry.effect,
            act: entry.act,
            ref: entry.ref
          }))
        })
      }).pipe(Effect.provide(runtimeLayer))
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

if (import.meta.main) {
  const report = await runVouchProof()
  const encoded = Schema.encodeSync(VouchProofReport)(report)
  console.log(JSON.stringify(encoded, null, 2))
}
