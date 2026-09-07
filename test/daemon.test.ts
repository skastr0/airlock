import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import {
  AdmissionPolicyV2,
  BoxGrant,
  EndpointGrantPolicy,
  type BoxGrantDaemonOp,
  type BoxGrantSha256
} from "../src/admission/index.ts"
import {
  checkDaemonLiveness,
  daemonTick,
  DaemonHealthCheckFailed,
  DaemonHealthRequest,
  DaemonHealthResponse,
  DaemonProtocolRejected,
  handleDaemonRequest,
  requireDaemonHealth
} from "../src/daemon/index.ts"
import { ActId, EmissionId, ReapReport } from "../src/domain.ts"
import { Hold } from "../src/Hold.ts"
import {
  EmissionDispatchUncertain,
  Outbox,
  OutboxEmission,
  StagedDispatchAuthorization,
  type DispatchProvenance
} from "../src/Outbox.ts"
import {
  HttpIntentSummary,
  RedactedEmissionRequest
} from "../src/outbox/Contract.ts"
import {
  SealVerificationFailed,
  VerifiedSeal
} from "../src/seal/index.ts"

const sealDigest = `sha256:${"a".repeat(64)}` as BoxGrantSha256
const otherDigest = `sha256:${"b".repeat(64)}` as BoxGrantSha256
const instant = (value: string) => DateTime.unsafeMake(new Date(value))
const at = instant("2026-01-01T00:00:00.000Z")

const seal = (daemonOps: ReadonlyArray<BoxGrantDaemonOp>) =>
  new VerifiedSeal({
    sealPath: "/supervisor/seal",
    grant: new BoxGrant({
      schemaVersion: "airlock/box-grant/v1",
      admission: new AdmissionPolicyV2({
        schemaVersion: "airlock/admission-policy/v2",
        profile: "native-contained",
        principal: "agent/daemon-test",
        realm: "local",
        admittedBy: "operator/daemon-test",
        pathAllowlist: [],
        executableAllowlist: [],
        endpointGrants: [new EndpointGrantPolicy({
          selector: "https://status.example/*",
          methods: ["GET"],
          class: "read",
          commit: "auto"
        })]
      }),
      verbs: [],
      nativeActions: [],
      catalog: [],
      daemonOps,
      binaryDigest: otherDigest
    }),
    grantDigest: sealDigest,
    binaryPath: "/fixture/airlock",
    binaryDigest: otherDigest,
    catalog: []
  })

const emission = (
  suffix: string,
  options: {
    readonly digest?: BoxGrantSha256
    readonly holdUntil?: ReturnType<typeof instant>
    readonly authorized?: boolean
    readonly grantSelector?: string
  } = {}
) => {
  const endpoint = `https://status.example/${suffix}`
  return new OutboxEmission({
    id: EmissionId.make(`emi_${suffix.padEnd(8, "x")}`),
    status: "staged",
    intent: new HttpIntentSummary({
      kind: "http",
      method: "GET",
      endpoint,
      headerNames: [],
      bodyBytes: 0
    }),
    request: new RedactedEmissionRequest({
      method: "GET",
      url: endpoint,
      headers: {}
    }),
    stagedAt: at,
    holdUntil: options.holdUntil ?? at,
    ...(options.authorized === false
      ? {}
      : {
        authorization: new StagedDispatchAuthorization({
          sealDigest: options.digest ?? sealDigest,
          grantId: `grant/${suffix}`,
          grantSelector: options.grantSelector ?? "https://status.example/*",
          dispatchClass: "read",
          endpoint
        })
      })
  })
}

type FakeOutboxOptions = {
  readonly pending?: () => ReadonlyArray<OutboxEmission>
  readonly onPendingAuthorized?: (digest: string) => void
  readonly onCommit?: (
    id: EmissionId,
    provenance: DispatchProvenance | undefined
  ) => Effect.Effect<OutboxEmission, EmissionDispatchUncertain>
  readonly onFlush?: () => void
}

const fakeOutbox = (options: FakeOutboxOptions = {}) => Outbox.of({
  stage: () => Effect.die("unused stage"),
  inspect: () => Effect.die("unused inspect"),
  commit: (id, provenance) => options.onCommit?.(id, provenance) ??
    Effect.die("unexpected commit"),
  cancel: () => Effect.die("unused cancel"),
  response: () => Effect.die("unused response"),
  pending: Effect.sync(() => options.pending?.() ?? []),
  pendingAuthorized: (digest) => Effect.sync(() => {
    options.onPendingAuthorized?.(digest)
    // Deliberately return the fixture verbatim. The daemon must retain its own
    // exact-seal/read/staged defense rather than trust a handwritten fixture.
    return options.pending?.() ?? []
  }),
  flush: Effect.sync(() => {
    options.onFlush?.()
    return { committed: [], failed: [], waiting: 0 }
  })
})

const fakeHold = (
  onReap: (olderThanMillis: number) => Effect.Effect<ReapReport> = () =>
    Effect.succeed(new ReapReport({ reaped: [], at }))
) => Hold.of({
  remove: () => Effect.die("unused remove"),
  overwrite: () => Effect.die("unused overwrite"),
  retireRuntimePrivate: () => Effect.die("unused retire"),
  replaceFrom: () => Effect.die("unused replace"),
  replaceByStaging: () => Effect.die("unused stage replacement"),
  replaceChecked: () => Effect.die("daemon cannot apply reviewed changes"),
  undoChecked: () => Effect.die("daemon cannot undo reviewed changes"),
  checkedStatus: () => Effect.die("unused checked status"),
  recoverChecked: () => Effect.die("daemon cannot recover reviewed changes"),
  acknowledgeChecked: () => Effect.die("unused checked acknowledgement"),
  undo: () => Effect.die("unused undo"),
  undoLast: Effect.die("unused undoLast"),
  held: Effect.die("unused held"),
  reap: onReap
})

const provide = <A, E>(
  effect: Effect.Effect<A, E, Outbox | Hold>,
  outbox: ReturnType<typeof fakeOutbox>,
  hold: ReturnType<typeof fakeHold> = fakeHold()
) => effect.pipe(
  Effect.provideService(Outbox, outbox),
  Effect.provideService(Hold, hold)
)

describe("Daemon supervisor component", () => {
  it.effect("commits only matching sealed read evidence and reverifies immediately before every terminal call", () => {
    const first = emission("first")
    const second = emission("second")
    const wrongSeal = emission("wrongseal", { digest: otherDigest })
    const manual = emission("manual", { authorized: false })
    const sequence: Array<string> = []
    const provenance: Array<DispatchProvenance | undefined> = []
    const reaped = ActId.make("act_reaped-fixture")
    const outbox = fakeOutbox({
      pending: () => [first, wrongSeal, manual, second],
      onPendingAuthorized: (digest) => {
        expect(digest).toBe(sealDigest)
      },
      onCommit: (id, value) => Effect.sync(() => {
        sequence.push(`commit:${id}`)
        provenance.push(value)
        return id === first.id ? first : second
      })
    })
    const hold = fakeHold((olderThanMillis) => Effect.sync(() => {
      sequence.push(`reap:${olderThanMillis}`)
      return new ReapReport({ reaped: [reaped], at })
    }))
    const reverify = () => Effect.sync(() => {
      sequence.push("reverify")
    })

    return provide(daemonTick({
      seal: seal(["commit", "reap"]),
      reapOlderThanMillis: 60_000,
      reverify
    }), outbox, hold).pipe(
      Effect.tap((report) => Effect.sync(() => {
        expect(sequence).toEqual([
          "reverify",
          `commit:${first.id}`,
          "reverify",
          `commit:${second.id}`,
          "reverify",
          "reap:60000"
        ])
        expect(report.attempted).toEqual([first.id, second.id])
        expect(report.committed).toEqual([first.id, second.id])
        expect(report.failed).toEqual([])
        expect(report.waiting).toBe(0)
        expect(report.reaped).toEqual([reaped])
        expect(provenance).toEqual([
          expect.objectContaining({
            committedBy: "policy-auto",
            grantId: "grant/first",
            grantSelector: "https://status.example/*",
            dispatchClass: "read",
            endpoint: first.intent.endpoint
          }),
          expect.objectContaining({
            committedBy: "policy-auto",
            grantId: "grant/second",
            dispatchClass: "read",
            endpoint: second.intent.endpoint
          })
        ])
      }))
    )
  })

  it.effect("rejects persisted evidence whose selector is not authorized by the signed admission policy", () => {
    const forged = emission("forged", {
      // The digest and endpoint look valid, but this selector was never signed.
      grantSelector: "https://attacker.example/*"
    })
    let commits = 0
    let reverifications = 0
    const outbox = fakeOutbox({
      pending: () => [forged],
      onCommit: () => {
        commits += 1
        return Effect.die("forged evidence must not commit")
      }
    })

    return provide(daemonTick({
      seal: seal(["commit"]),
      reverify: () => Effect.sync(() => { reverifications += 1 })
    }), outbox).pipe(
      Effect.tap((report) => Effect.sync(() => {
        expect(commits).toBe(0)
        expect(reverifications).toBe(0)
        expect(report.attempted).toEqual([])
        expect(report.committed).toEqual([])
      }))
    )
  })

  it.effect("does nothing when the seal grants no daemon operations", () => {
    let discoveries = 0
    let terminalCalls = 0
    let reverifications = 0
    const outbox = fakeOutbox({
      pending: () => [emission("ignored")],
      onPendingAuthorized: () => { discoveries += 1 },
      onCommit: () => {
        terminalCalls += 1
        return Effect.die("must not commit")
      },
      onFlush: () => { terminalCalls += 1 }
    })
    const hold = fakeHold(() => {
      terminalCalls += 1
      return Effect.die("must not reap")
    })

    return provide(daemonTick({
      seal: seal([]),
      reapOlderThanMillis: 0,
      reverify: () => Effect.sync(() => { reverifications += 1 })
    }), outbox, hold).pipe(
      Effect.tap((report) => Effect.sync(() => {
        expect(discoveries).toBe(0)
        expect(terminalCalls).toBe(0)
        expect(reverifications).toBe(0)
        expect(report).toMatchObject({
          attempted: [], committed: [], failed: [], waiting: 0, reaped: []
        })
      }))
    )
  })

  it.effect("stops the tick on seal failure before the next terminal call", () => {
    const first = emission("stopone")
    const second = emission("stoptwo")
    const sequence: Array<string> = []
    let checks = 0
    const outbox = fakeOutbox({
      pending: () => [first, second],
      onCommit: (id) => Effect.sync(() => {
        sequence.push(`commit:${id}`)
        return id === first.id ? first : second
      })
    })
    const failure = new SealVerificationFailed({
      phase: "reverify",
      path: "/supervisor/seal/box-grant.json",
      reason: "snapshot-mismatch"
    })

    return provide(daemonTick({
      seal: seal(["commit", "reap"]),
      reapOlderThanMillis: 0,
      reverify: () => Effect.suspend(() => {
        checks += 1
        sequence.push("reverify")
        return checks === 2 ? Effect.fail(failure) : Effect.void
      })
    }), outbox, fakeHold(() => {
      sequence.push("reap")
      return Effect.die("must stop before reap")
    })).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toBe(failure)
        expect(sequence).toEqual([
          "reverify",
          `commit:${first.id}`,
          "reverify"
        ])
      }))
    )
  })

  it.effect("defines flush as an authorized due scan, never as blanket Outbox flush", () => {
    const due = emission("flushdue", {
      holdUntil: instant("1900-01-01T00:00:00.000Z")
    })
    const waiting = emission("flushwait", {
      holdUntil: instant("2999-01-01T00:00:00.000Z")
    })
    let legacyFlushCalls = 0
    const committed: Array<EmissionId> = []
    const outbox = fakeOutbox({
      pending: () => [due, waiting],
      onCommit: (id) => Effect.sync(() => {
        committed.push(id)
        return due
      }),
      onFlush: () => { legacyFlushCalls += 1 }
    })

    return provide(daemonTick({
      seal: seal(["flush"]),
      reverify: () => Effect.void
    }), outbox).pipe(
      Effect.tap((report) => Effect.sync(() => {
        expect(committed).toEqual([due.id])
        expect(legacyFlushCalls).toBe(0)
        expect(report.attempted).toEqual([due.id])
        expect(report.waiting).toBe(1)
      }))
    )
  })

  it.effect("records an uncertain commit and relies on pending discovery not to retry it", () => {
    const item = emission("uncertain")
    let staged = true
    let commits = 0
    const outbox = fakeOutbox({
      pending: () => staged ? [item] : [],
      onCommit: (id) => Effect.suspend(() => {
        commits += 1
        staged = false
        return Effect.fail(new EmissionDispatchUncertain({
          id,
          reason: "transport-failed"
        }))
      })
    })
    const config = {
      seal: seal(["commit"]),
      reverify: () => Effect.void
    }

    return provide(
      daemonTick(config).pipe(
        Effect.flatMap((first) => daemonTick(config).pipe(
          Effect.map((second) => ({ first, second }))
        ))
      ),
      outbox
    ).pipe(
      Effect.tap(({ first, second }) => Effect.sync(() => {
        expect(commits).toBe(1)
        expect(first.failed).toEqual([
          expect.objectContaining({
            id: item.id,
            errorTag: "EmissionDispatchUncertain"
          })
        ])
        expect(second.attempted).toEqual([])
      }))
    )
  })

  it("keeps the local protocol health-only, strict, and seal-bound", async () => {
    const request = new DaemonHealthRequest({ request: "health" })
    const response = await Effect.runPromise(handleDaemonRequest(request, {
      grantDigest: sealDigest,
      ready: true
    }))
    expect(response).toEqual(new DaemonHealthResponse({
      grantDigest: sealDigest,
      ready: true
    }))

    const rejected = await Effect.runPromise(handleDaemonRequest({
      request: "health",
      profile: "compatibility"
    }, { grantDigest: sealDigest, ready: true }).pipe(Effect.flip))
    expect(rejected).toBeInstanceOf(DaemonProtocolRejected)

    const mismatch = await Effect.runPromise(requireDaemonHealth(
      response,
      otherDigest
    ).pipe(Effect.flip))
    expect(mismatch).toBeInstanceOf(DaemonHealthCheckFailed)
    expect(mismatch.reason).toBe("grant-digest-mismatch")

    let sent: DaemonHealthRequest | undefined
    const alive = await Effect.runPromise(checkDaemonLiveness({
      request: (value) => Effect.sync(() => {
        sent = value
        return response
      })
    }, sealDigest))
    expect(sent).toEqual(request)
    expect(alive.ready).toBe(true)
  })

  it("contains neither a second wire site nor a second unlink site", () => {
    const source = [
      "src/daemon/Daemon.ts",
      "src/daemon/Protocol.ts",
      "src/daemon/index.ts"
    ].map((path) => readFileSync(path, "utf8")).join("\n")
    expect(source).not.toContain("fetch" + "(")
    expect(source).not.toContain(".remove" + "(")
  })
})
