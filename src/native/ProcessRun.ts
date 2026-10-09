import { Clock, Effect } from "effect"
import * as nodePath from "node:path"
import { type Refused, refused } from "../core/airlock/Implement.ts"
import type { ToolContract } from "../core/contract/ToolContract.ts"
import { type Cell, CellRequest } from "../cell/Cell.ts"
import { preflightDeltaMerge } from "../cell/DeltaMerge.ts"
import type { Hold } from "../Hold.ts"
import type { HeldCallReference, HeldCalls } from "../host/HeldCalls.ts"
import {
  ProcessCancelled,
  ProcessInputBytes,
  ProcessInputText,
  ProcessOutputLimitExceeded,
  type ProcessReceipt,
  ProcessRequest,
  type ProcessRunner,
  ProcessTimedOut
} from "../process/Process.ts"
import { type ArtifactStore, artifactsOf } from "./Artifacts.ts"
import type { ProcessRun } from "./ProcessContract.ts"

/**
 * The local implementation of `process.run`.
 *
 * Unconfined, the process runs on the machine as it is: what it changes is
 * unknown and cannot be put back, which is why such a call always waits for a
 * person. Confined, it runs in a Cell against a private copy of the working
 * directory with the network denied; what it changed there reaches the live
 * directory only if it exited cleanly and the live directory has not moved,
 * and only through Hold under the call's reference, so the whole call can be
 * put back.
 */

type Input = ToolContract.ShapeOf<typeof ProcessRun>["input"]
type Output = ToolContract.OutputOf<typeof ProcessRun>

export interface ProcessRunContext {
  /** From the grant, never from the call. Absent means unconfined. */
  readonly confined: boolean
  /** The call's claim in Hold. Required to merge a confined run. */
  readonly held?: HeldCallReference
  readonly signal?: AbortSignal
  /** Epoch milliseconds after which the process may not start and nothing may be merged. */
  readonly validUntil?: number
}

const text = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export const processRun = (services: {
  readonly process: ProcessRunner["Service"]
  readonly cell: Cell["Service"]
  readonly hold: Hold["Service"]
  readonly calls: HeldCalls["Service"]
  /** The one directory a confined process works on. Host state. */
  readonly workspace: string
  /** The environment every process starts from; the call's entries are added to it. */
  readonly environment: Readonly<Record<string, string>>
  readonly artifacts: ArtifactStore
}) =>
(input: Input, context: ProcessRunContext): Effect.Effect<Output | Refused, unknown> =>
  Effect.gen(function* () {
    const artifacts = artifactsOf(services.artifacts)
    const cwd = nodePath.resolve(services.workspace, input.cwd)
    if (context.confined && cwd !== nodePath.resolve(services.workspace)) {
      return refused("process.run did not start: a confined process works in the workspace root")
    }
    if (context.validUntil !== undefined && (yield* Clock.currentTimeMillis) >= context.validUntil) {
      return refused("process.run did not start: the grant expired")
    }
    if (context.confined && context.held === undefined) {
      return yield* Effect.fail("a confined process.run needs the call's claim in Hold")
    }
    const stdin = input.stdin !== undefined
      ? new ProcessInputText({ _tag: "text", text: input.stdin })
      : input.stdinArtifact !== undefined
        ? new ProcessInputBytes({ _tag: "bytes", bytes: yield* artifacts.read(input.stdinArtifact) })
        : "discard" as const
    const request = new ProcessRequest({
      executable: input.executable,
      args: input.args,
      cwd,
      env: { ...services.environment, ...input.env },
      stdin,
      stdout: input.stdout,
      stderr: input.stderr,
      outputLimitBytes: input.outputLimitBytes,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    })
    const options = context.signal === undefined ? {} : { signal: context.signal }

    const report = (
      outcome: Output["outcome"],
      receipt: ProcessReceipt,
      merged: Output["merged"]
    ): Effect.Effect<Output, unknown> =>
      Effect.gen(function* () {
        const kept = (stream: "capture" | "discard", bytes: Uint8Array) =>
          stream === "capture" ? artifacts.keep(bytes, "application/octet-stream") : Effect.succeed(null)
        return {
          outcome,
          exit_code: receipt.exitCode,
          signal: receipt.signal,
          stdout: input.stdout === "capture" ? text(receipt.stdout) : null,
          stderr: input.stderr === "capture" ? text(receipt.stderr) : null,
          stdout_artifact: yield* kept(input.stdout, receipt.stdout),
          stderr_artifact: yield* kept(input.stderr, receipt.stderr),
          merged
        }
      })

    /** A timeout, an overflow and a cancellation are results the process produced. */
    const stopped = (error: unknown) =>
      error instanceof ProcessTimedOut
        ? { outcome: "timed-out" as const, receipt: error.receipt }
        : error instanceof ProcessOutputLimitExceeded
          ? { outcome: "output-limit" as const, receipt: error.receipt }
          : error instanceof ProcessCancelled
            ? { outcome: "cancelled" as const, receipt: error.receipt }
            : undefined
    const notStarted = (error: unknown) =>
      refused(`process.run did not start: ${
        typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "failed"
      }`)

    if (!context.confined) {
      const ran = yield* services.process.run(request, options).pipe(Effect.result)
      if (ran._tag === "Success") return yield* report("exited", ran.success, null)
      const evidence = stopped(ran.failure)
      return evidence === undefined ? notStarted(ran.failure) : yield* report(evidence.outcome, evidence.receipt, null)
    }

    const privateWorkspace = nodePath.join(
      nodePath.dirname(nodePath.resolve(services.workspace)),
      `.airlock-cell-${crypto.randomUUID()}`
    )
    // The private copy goes to Hold whatever happens; only its reaper deletes.
    const retire = services.hold.retireRuntimePrivate(privateWorkspace).pipe(Effect.ignore)
    return yield* Effect.gen(function* () {
      const ran = yield* services.cell.run(new CellRequest({
        sourceWorkspace: nodePath.resolve(services.workspace),
        privateWorkspace,
        process: request,
        descendantExecutables: input.descendantExecutables,
        network: "deny"
      }), options).pipe(Effect.result)
      if (ran._tag === "Failure") {
        const evidence = stopped(ran.failure)
        return evidence === undefined ? notStarted(ran.failure) : yield* report(evidence.outcome, evidence.receipt, [])
      }
      const receipt = ran.success
      const clean = receipt.processReceipt.exitCode === 0 && receipt.processReceipt.signal === null
      if (!clean || receipt.delta.length === 0) return yield* report("exited", receipt.processReceipt, [])

      let why = "the changes could not be applied"
      const merged = yield* services.calls.run(
        context.held!,
        Effect.gen(function* () {
          const entries = yield* preflightDeltaMerge(services.cell, services.workspace, receipt).pipe(
            Effect.tapError((error) => Effect.sync(() => { why = error.reason }))
          )
          for (const entry of entries) {
            yield* entry.candidate.kind === "deleted"
              ? services.hold.remove(entry.target)
              : services.hold.replaceFrom(entry.target, entry.source!)
          }
          return entries.map((entry) => ({ path: entry.candidate.path, kind: entry.candidate.kind }))
        }),
        // The process may have run for a long time: checked again before each act.
        context.validUntil === undefined ? {} : { validUntil: context.validUntil }
      )
      if (merged._tag === "refused") {
        return refused(`process.run changed nothing: ${merged.expired ? "the grant expired before the merge" : why} (${merged.reason})`)
      }
      return yield* report("exited", receipt.processReceipt, merged.value)
    }).pipe(Effect.ensuring(retire))
  })
