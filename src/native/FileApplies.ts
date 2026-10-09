import { Effect } from "effect"
import { type Refused, refused } from "../core/airlock/Implement.ts"
import type { ToolContract } from "../core/contract/ToolContract.ts"
import { ActId } from "../core/domain.ts"
import type { HeldCallReference, HeldCalls } from "../host/HeldCalls.ts"
import type { FileCopy, FileMkdir, FileMove, FileRemove, FileWrite } from "./FileContracts.ts"
import type { NativeFileSystem } from "./NativeFileSystem.ts"

/**
 * The local implementations of the five apply tools. Each runs as one held
 * call: everything it displaces goes into Hold under the call's reference,
 * so the whole call can be put back. A call whose work fails is reversed and
 * refused. A call that cannot be proven reversed fails, which the kernel
 * records as uncertain; it is never tried again.
 */

type Applies = {
  readonly "file.write": typeof FileWrite
  readonly "file.remove": typeof FileRemove
  readonly "file.copy": typeof FileCopy
  readonly "file.move": typeof FileMove
  readonly "file.mkdir": typeof FileMkdir
}

/** One function per apply contract: the decoded input and the call's held reference in, the output out. */
export type FileApplies = {
  readonly [Name in keyof Applies]: (
    input: ToolContract.ShapeOf<Applies[Name]>["input"],
    held: HeldCallReference
  ) => Effect.Effect<ToolContract.OutputOf<Applies[Name]> | Refused, unknown>
}

export const fileApplies = (services: {
  readonly fs: NativeFileSystem["Service"]
  readonly calls: HeldCalls["Service"]
  /** The bytes of an artifact of this run. Artifacts are host state. */
  readonly artifact: (id: string) => Effect.Effect<Uint8Array, unknown>
}): FileApplies => {
  const { fs, calls } = services
  const held = <A, B>(
    tool: string,
    reference: HeldCallReference,
    work: Effect.Effect<A, unknown>,
    output: (applied: A) => B
  ): Effect.Effect<B | Refused, unknown> =>
    Effect.map(calls.run(reference, work), (outcome) =>
      outcome._tag === "done" ? output(outcome.value) : refused(`${tool} changed nothing: ${outcome.reason}`))

  return {
    "file.write": (input, reference) =>
      held(
        "file.write",
        reference,
        input.content !== undefined
          ? fs.writeText(input.path, input.content)
          : Effect.flatMap(services.artifact(input.sourceArtifact!), (bytes) => fs.writeBytes(input.path, bytes)),
        (written) => ({
          act_id: ActId.make(written.receipt.id),
          target: written.receipt.target,
          previous_held: written.receipt.previousHeld,
          bytes: written.bytes
        })
      ),
    "file.remove": (input, reference) =>
      held("file.remove", reference, fs.remove(input.path), (removed) => ({
        act_id: removed.id,
        target: removed.target,
        kind: removed.kind
      })),
    "file.copy": (input, reference) =>
      held("file.copy", reference, fs.copy(input.source, input.destination), (copied) => ({
        act_id: ActId.make(copied.receipt.id),
        source: copied.receipt.source,
        target: copied.receipt.target,
        previous_held: copied.receipt.previousHeld,
        bytes: copied.bytes
      })),
    "file.move": (input, reference) =>
      held("file.move", reference, fs.move(input.source, input.destination), (moved) => ({
        install_act_id: ActId.make(moved.install.receipt.id),
        remove_act_id: ActId.make(moved.sourceRemoval.id),
        source: moved.sourceRemoval.target,
        target: moved.install.receipt.target
      })),
    "file.mkdir": (input, reference) =>
      held("file.mkdir", reference, fs.mkdir(input.path, { parents: input.parents }), (made) => ({
        path: made.path,
        act_ids: made.installs.map((install) => ActId.make(install.receipt.id))
      }))
  }
}
