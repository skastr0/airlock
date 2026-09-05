/**
 * A runnable Linux proof of the two host primitives Airlock's managed
 * mutation path depends on.
 *
 * macOS gets `renamex_np(RENAME_EXCL)` and `O_EXLOCK`; Linux gets
 * `renameat2(RENAME_NOREPLACE)` and `flock(2)`. This script exercises both
 * through the shipped adapters — never a reimplementation — and reports the
 * observed evidence as one Schema-encoded JSON value.
 *
 * The sixteen contenders are the same `test/fixtures` process fixture the macOS
 * cross-process test drives, so the two platforms are held to one mechanism.
 *
 * What this does NOT prove: nothing here is a containment claim. The Linux
 * native-contained profile has its own direct-host test gate; this portable
 * proof exercises only the managed-mutation primitives.
 */
import { Effect, Schema } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises"
import { arch, release, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ExclusiveRename } from "../src/platform/ExclusiveRename.ts"
import { makeExclusiveFileLock } from "../src/platform/ExclusiveFileLock.ts"
import { LinuxExclusiveRenameLive } from "../src/platform/linux/LinuxExclusiveRename.ts"
import {
  LockContenderEvent,
  LockContenderResult
} from "../test/fixtures/exclusive-file-lock-contract.ts"

const ProofId = Schema.Literal("airlock-linux-beachhead-v1")
const BoundaryStatement = Schema.Literal(
  "renameat2(RENAME_NOREPLACE) and flock(2) supply the atomic no-replace rename and the recoverable kernel lease on Linux; neither is a containment claim"
)

const CONTENDER_COUNT = 16
const CONTENDER_HOLD_MILLIS = 50

class BoundaryAssertions extends Schema.Class<BoundaryAssertions>(
  "BoundaryAssertions"
)({
  renameIntoAbsentTargetSucceeded: Schema.Boolean,
  renameOntoLiveTargetReportedTargetExists: Schema.Boolean,
  liveTargetBytesPreserved: Schema.Boolean,
  refusedSourceBytesPreserved: Schema.Boolean,
  everyContenderCompleted: Schema.Boolean,
  contendersWereDistinctProcesses: Schema.Boolean,
  noIndependentOverlapObserved: Schema.Boolean,
  atMostOneHolderInside: Schema.Boolean,
  everyContenderEnteredAndExited: Schema.Boolean,
  leaseReclaimedAfterHolderKilled: Schema.Boolean
}) {}

class ContenderEvidence extends Schema.Class<ContenderEvidence>(
  "ContenderEvidence"
)({
  requested: Schema.Number,
  completed: Schema.Number,
  distinctPids: Schema.Number,
  events: Schema.Number,
  maximumHoldersInside: Schema.Number,
  overlapReports: Schema.Array(Schema.String),
  failures: Schema.Array(Schema.String)
}) {}

class HostEvidence extends Schema.Class<HostEvidence>("HostEvidence")({
  platform: Schema.String,
  kernelRelease: Schema.String,
  architecture: Schema.String,
  distribution: Schema.String,
  cLibrary: Schema.String,
  bunVersion: Schema.String,
  proofRoot: Schema.String,
  proofFilesystem: Schema.String
}) {}

class RenameEvidence extends Schema.Class<RenameEvidence>("RenameEvidence")({
  movedInto: Schema.String,
  collisionTag: Schema.String,
  liveTargetBytes: Schema.String,
  refusedSourceBytes: Schema.String
}) {}

class LeaseRecoveryEvidence extends Schema.Class<LeaseRecoveryEvidence>(
  "LeaseRecoveryEvidence"
)({
  killedHolderPid: Schema.Number,
  signal: Schema.Literal("SIGKILL"),
  reclaimedWithinMillis: Schema.Number
}) {}

const NonClaims = Schema.Array(Schema.String)

class ProofSucceeded extends Schema.TaggedClass<ProofSucceeded>(
  "ProofSucceeded"
)("Succeeded", {
  proof: ProofId,
  ok: Schema.Literal(true),
  boundary: BoundaryStatement,
  assertions: BoundaryAssertions,
  host: HostEvidence,
  rename: RenameEvidence,
  contenders: ContenderEvidence,
  leaseRecovery: LeaseRecoveryEvidence,
  nonClaims: NonClaims
}) {}

class ProofFailed extends Schema.TaggedClass<ProofFailed>("ProofFailed")(
  "Failed",
  {
    proof: ProofId,
    ok: Schema.Literal(false),
    boundary: BoundaryStatement,
    platform: Schema.String,
    errorTag: Schema.String,
    reason: Schema.String
  }
) {}

const ProofResult = Schema.Union(ProofSucceeded, ProofFailed)
type ProofResult = typeof ProofResult.Type

class ProofUnavailable extends Schema.TaggedError<ProofUnavailable>(
  "ProofUnavailable"
)("ProofUnavailable", {
  reason: Schema.String
}) {}

class ProofSetupFailed extends Schema.TaggedError<ProofSetupFailed>(
  "ProofSetupFailed"
)("ProofSetupFailed", {
  phase: Schema.String,
  reason: Schema.String
}) {}

class ProofAssertionFailed extends Schema.TaggedError<ProofAssertionFailed>(
  "ProofAssertionFailed"
)("ProofAssertionFailed", {
  failed: Schema.Array(Schema.String)
}) {}

const boundary =
  "renameat2(RENAME_NOREPLACE) and flock(2) supply the atomic no-replace rename and the recoverable kernel lease on Linux; neither is a containment claim" as const

const nonClaims = [
  "this portable proof does not exercise or attest the separate Linux native-contained profile",
  "this proves the two host primitives and their contention behaviour, not a shell-replacement corpus",
  "the evidence covers only the filesystem reported in host.proofFilesystem",
  "a filesystem whose rename does not implement RENAME_NOREPLACE is refused, never silently replaced"
] as const

const contenderFixture = fileURLToPath(
  new URL(
    "../test/fixtures/exclusive-file-lock-contender.ts",
    import.meta.url
  )
)

const reasonOf = (cause: unknown): string => {
  if (cause instanceof ProofAssertionFailed) {
    return `failed assertions: ${cause.failed.join(", ")}`
  }
  if (cause instanceof ProofSetupFailed || cause instanceof ProofUnavailable) {
    return cause.reason
  }
  if (cause instanceof Error) return cause.message
  return String(cause)
}

const tagOf = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause._tag === "string"
    ? cause._tag
    : "UnknownProofFailure"

const emit = (proof: ProofResult): void => {
  const encoded = Schema.encodeSync(ProofResult)(proof)
  process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`)
}

const readCommand = (binary: string, args: ReadonlyArray<string>): string => {
  try {
    return execFileSync(binary, [...args], { encoding: "utf8" }).trim()
  } catch {
    return "unavailable"
  }
}

const distribution = (): string => {
  try {
    const raw = execFileSync("/bin/cat", ["/etc/os-release"], {
      encoding: "utf8"
    })
    const line = raw
      .split("\n")
      .find((entry) => entry.startsWith("PRETTY_NAME="))
    return line === undefined
      ? "unavailable"
      : line.slice("PRETTY_NAME=".length).replaceAll('"', "")
  } catch {
    return "unavailable"
  }
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const waitFor = async (
  description: string,
  predicate: () => boolean,
  timeoutMillis = 10_000
) => {
  const deadline = Date.now() + timeoutMillis
  while (!predicate() && Date.now() < deadline) await delay(5)
  if (!predicate()) throw new Error(`timed out waiting for ${description}`)
}

const setup = Effect.tryPromise({
  try: async () => {
    const root = await mkdtemp(join(tmpdir(), "airlock-linux-beachhead-"))
    const renameRoot = join(root, "rename")
    const lockRoot = join(root, "locks")
    const evidenceRoot = join(root, "evidence")
    const recoveryRoot = join(root, "recovery")
    await Promise.all([
      mkdir(renameRoot),
      mkdir(lockRoot),
      mkdir(evidenceRoot),
      mkdir(recoveryRoot)
    ])
    return { root, renameRoot, lockRoot, evidenceRoot, recoveryRoot }
  },
  catch: (cause) =>
    new ProofSetupFailed({ phase: "fixture", reason: reasonOf(cause) })
})

/**
 * The rename half. A live target must survive a colliding move and the refused
 * source must still hold its own bytes: that pair is what makes every Airlock
 * mutation verb recoverable.
 */
const proveRename = (renameRoot: string) =>
  Effect.gen(function* () {
    const rename = yield* Effect.provide(
      ExclusiveRename,
      LinuxExclusiveRenameLive
    )
    const first = join(renameRoot, "first-source")
    const second = join(renameRoot, "second-source")
    const target = join(renameRoot, "target")
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(first, "first bytes")
        await writeFile(second, "second bytes")
      },
      catch: (cause) =>
        new ProofSetupFailed({ phase: "rename", reason: reasonOf(cause) })
    })

    const moved = yield* rename.moveNoReplace(first, target).pipe(Effect.exit)
    const collision = yield* rename
      .moveNoReplace(second, target)
      .pipe(Effect.flip, Effect.exit)

    const liveTargetBytes = yield* Effect.tryPromise({
      try: () => readFile(target, "utf8"),
      catch: (cause) =>
        new ProofSetupFailed({ phase: "read-target", reason: reasonOf(cause) })
    })
    const refusedSourceBytes = yield* Effect.tryPromise({
      try: () => readFile(second, "utf8"),
      catch: (cause) =>
        new ProofSetupFailed({ phase: "read-source", reason: reasonOf(cause) })
    })
    const collisionTag = collision._tag === "Success"
      ? collision.value._tag
      : "no-failure-observed"

    return {
      evidence: new RenameEvidence({
        movedInto: target,
        collisionTag,
        liveTargetBytes,
        refusedSourceBytes
      }),
      renameIntoAbsentTargetSucceeded: moved._tag === "Success",
      renameOntoLiveTargetReportedTargetExists:
        collisionTag === "ExclusiveRenameTargetExists",
      liveTargetBytesPreserved: liveTargetBytes === "first bytes",
      refusedSourceBytesPreserved: refusedSourceBytes === "second bytes"
    }
  })

/**
 * The lease half. Sixteen independent Bun processes contend for one inode; the
 * fixture's own O_EXCL sentinel is an independent overlap detector that does
 * not depend on the lock under test.
 */
const proveContention = (
  lockRoot: string,
  evidenceRoot: string
) =>
  Effect.tryPromise({
    try: async () => {
      const active = join(lockRoot, "active")
      const startGate = join(lockRoot, "start")
      const contenderIds = Array.from(
        { length: CONTENDER_COUNT },
        (_, index) => `contender-${index}`
      )
      const children = contenderIds.map((contenderId) => {
        const child = spawn(
          "bun",
          [
            contenderFixture,
            lockRoot,
            active,
            evidenceRoot,
            contenderId,
            startGate,
            String(CONTENDER_HOLD_MILLIS)
          ],
          { stdio: ["ignore", "ignore", "pipe"] }
        )
        return new Promise<number>((resolve, reject) => {
          child.once("error", reject)
          child.once("exit", (code) => resolve(code ?? -1))
        })
      })

      await waitFor("every contender to reach the start barrier", () =>
        contenderIds.every((contenderId) =>
          existsSync(join(evidenceRoot, `${contenderId}.ready`))
        )
      )
      await writeFile(startGate, "start")
      await Promise.race([
        Promise.all(children),
        delay(30_000).then(() => {
          throw new Error("contenders did not finish within 30 seconds")
        })
      ])

      const results = await Promise.all(
        contenderIds.map(async (contenderId) =>
          Schema.decodeUnknownSync(LockContenderResult)(
            JSON.parse(
              await readFile(
                join(evidenceRoot, `${contenderId}.result.json`),
                "utf8"
              )
            )
          )
        )
      )
      const events = (await readFile(join(evidenceRoot, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(LockContenderEvent)(JSON.parse(line))
        )

      let inside = 0
      let maximumHoldersInside = 0
      const phases = new Map<string, Array<"enter" | "exit">>()
      for (const event of events) {
        phases.set(event.contenderId, [
          ...(phases.get(event.contenderId) ?? []),
          event.phase
        ])
        inside += event.phase === "enter" ? 1 : -1
        maximumHoldersInside = Math.max(maximumHoldersInside, inside)
      }
      const overlapReports = (await readdir(evidenceRoot)).filter((entry) =>
        entry.startsWith("overlap-")
      )
      const completed = results.filter(
        (result) => result._tag === "Completed"
      )

      return {
        evidence: new ContenderEvidence({
          requested: CONTENDER_COUNT,
          completed: completed.length,
          distinctPids: new Set(results.map(({ pid }) => pid)).size,
          events: events.length,
          maximumHoldersInside,
          overlapReports,
          failures: results
            .filter((result) => result._tag === "Failed")
            .map((result) =>
              result._tag === "Failed"
                ? `${result.contenderId}: ${result.errorTag} ${result.reason}`
                : ""
            )
        }),
        everyContenderCompleted: completed.length === CONTENDER_COUNT,
        contendersWereDistinctProcesses:
          new Set(results.map(({ pid }) => pid)).size === CONTENDER_COUNT,
        noIndependentOverlapObserved: overlapReports.length === 0,
        atMostOneHolderInside: maximumHoldersInside === 1 && inside === 0,
        everyContenderEnteredAndExited:
          events.length === CONTENDER_COUNT * 2 &&
          contenderIds.every((contenderId) => {
            const phase = phases.get(contenderId)
            return phase?.length === 2 &&
              phase[0] === "enter" &&
              phase[1] === "exit"
          })
      }
    },
    catch: (cause) =>
      new ProofSetupFailed({ phase: "contention", reason: reasonOf(cause) })
  })

/**
 * Recoverability. A holder killed with SIGKILL never runs a release path, so a
 * successful reclaim is evidence that the kernel — not the owner JSON — owns
 * the lease.
 */
const proveLeaseRecovery = (recoveryRoot: string) =>
  Effect.tryPromise({
    try: async () => {
      const active = join(recoveryRoot, "active")
      const ready = join(recoveryRoot, "holder-ready")
      const holderSource = `
        import { dlopen, FFIType } from "bun:ffi"
        import { constants } from "node:fs"
        import { open, writeFile } from "node:fs/promises"
        const [active, ready] = process.argv.slice(1)
        const libc = dlopen("libc.so.6", {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
        })
        const handle = await open(
          active,
          constants.O_RDWR | constants.O_CREAT,
          0o600
        )
        if (libc.symbols.flock(handle.fd, 2 | 4) !== 0) process.exit(70)
        await writeFile(ready, String(process.pid))
        await Bun.sleep(60_000)
      `
      const holder = spawn("bun", ["-e", holderSource, "--", active, ready], {
        stdio: ["ignore", "ignore", "pipe"]
      })
      await waitFor("the holder to take the lease", () => existsSync(ready))
      const killedHolderPid = holder.pid ?? -1
      const exited = new Promise<void>((resolve) => {
        holder.once("exit", () => resolve())
      })
      holder.kill("SIGKILL")
      await exited

      const lock = makeExclusiveFileLock({
        root: recoveryRoot,
        active,
        released: join(recoveryRoot, "released"),
        abandoned: join(recoveryRoot, "abandoned"),
        timeoutMillis: 5_000,
        onError: (operation, target, cause) =>
          new Error(`${operation} ${target}: ${reasonOf(cause)}`)
      })
      const started = performance.now()
      await Effect.runPromise(lock.withLock(Effect.void))
      return {
        evidence: new LeaseRecoveryEvidence({
          killedHolderPid,
          signal: "SIGKILL",
          reclaimedWithinMillis: Math.round(performance.now() - started)
        }),
        leaseReclaimedAfterHolderKilled: true
      }
    },
    catch: (cause) =>
      new ProofSetupFailed({
        phase: "lease-recovery",
        reason: reasonOf(cause)
      })
  })

const proof = Effect.gen(function* () {
  if (process.platform !== "linux") {
    return yield* new ProofUnavailable({
      reason: `this proof requires linux, not ${process.platform}`
    })
  }
  if (process.versions.bun === undefined) {
    return yield* new ProofUnavailable({
      reason: "this proof requires the Bun runtime for native FFI"
    })
  }

  const fixture = yield* setup
  const rename = yield* proveRename(fixture.renameRoot)
  const contention = yield* proveContention(
    fixture.lockRoot,
    fixture.evidenceRoot
  )
  const recovery = yield* proveLeaseRecovery(fixture.recoveryRoot)

  const assertions = new BoundaryAssertions({
    renameIntoAbsentTargetSucceeded: rename.renameIntoAbsentTargetSucceeded,
    renameOntoLiveTargetReportedTargetExists:
      rename.renameOntoLiveTargetReportedTargetExists,
    liveTargetBytesPreserved: rename.liveTargetBytesPreserved,
    refusedSourceBytesPreserved: rename.refusedSourceBytesPreserved,
    everyContenderCompleted: contention.everyContenderCompleted,
    contendersWereDistinctProcesses: contention.contendersWereDistinctProcesses,
    noIndependentOverlapObserved: contention.noIndependentOverlapObserved,
    atMostOneHolderInside: contention.atMostOneHolderInside,
    everyContenderEnteredAndExited: contention.everyContenderEnteredAndExited,
    leaseReclaimedAfterHolderKilled: recovery.leaseReclaimedAfterHolderKilled
  })
  const failed = Object.entries(assertions)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name)
  if (failed.length > 0) return yield* new ProofAssertionFailed({ failed })

  const succeeded = new ProofSucceeded({
    proof: "airlock-linux-beachhead-v1",
    ok: true,
    boundary,
    assertions,
    host: new HostEvidence({
      platform: process.platform,
      kernelRelease: release(),
      architecture: arch(),
      distribution: distribution(),
      cLibrary: readCommand("/usr/bin/getconf", ["GNU_LIBC_VERSION"]),
      bunVersion: process.versions.bun,
      proofRoot: fixture.root,
      proofFilesystem: readCommand("/usr/bin/stat", [
        "-f",
        "-c",
        "%T",
        fixture.root
      ])
    }),
    rename: rename.evidence,
    contenders: contention.evidence,
    leaseRecovery: recovery.evidence,
    nonClaims: [...nonClaims]
  })

  yield* Effect.promise(() =>
    rm(fixture.root, { recursive: true, force: true })
  )
  return succeeded
})

await Effect.runPromise(
  proof.pipe(
    Effect.match({
      onFailure: (cause) => {
        emit(
          new ProofFailed({
            proof: "airlock-linux-beachhead-v1",
            ok: false,
            boundary,
            platform: process.platform,
            errorTag: tagOf(cause),
            reason: reasonOf(cause)
          })
        )
        process.exitCode = cause instanceof ProofUnavailable ? 2 : 1
      },
      onSuccess: (result) => emit(result)
    })
  )
)
