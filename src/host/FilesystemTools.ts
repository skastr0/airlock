import { Clock, DateTime, Effect } from "effect"
import { type Refused, refused } from "../core/airlock/Implement.ts"
import type { BoundResource, HeldReference, HostParameters } from "../core/contract/ToolHost.ts"
import type { WireToken } from "../core/outbox/Outbox.ts"
import { fileApplies } from "../native/FileApplies.ts"
import { fileCaptures } from "../native/FileCaptures.ts"
import { httpTools } from "../native/HttpTools.ts"
import { processRun } from "../native/ProcessRun.ts"
import { FileContracts, HttpGet, HttpStage, ProcessRun } from "../native/index.ts"
import { heldCallReference } from "./FilesystemRecovery.ts"
import type { FilesystemProfile } from "./FilesystemHost.ts"

/** The filesystem tools: files, commands and web requests on this machine. Which of them a session may call is the policy's business. */
export const FilesystemContracts = [...FileContracts, ProcessRun, HttpGet, HttpStage] as const

/**
 * Every filesystem tool, as the record of implementations the kernel calls.
 * Plain glue: each entry takes what admission established for the call and
 * hands it to the implementation. A path, an executable or an endpoint is
 * never read from the call's input here; it is the resource admission bound
 * for that field. A call that arrives without one is refused.
 */

/** What the kernel hands an implementation, as far as the filesystem tools use it. */
export interface FilesystemCallContext {
  readonly signal: AbortSignal
  readonly wireToken: WireToken
  /** The call's claim in Hold, prepared by the kernel before an apply or an invoke. */
  readonly held?: HeldReference
  /** From the grant that admitted the call. */
  readonly host: HostParameters
  /** The call's resources as admission bound them, in declaration order. */
  readonly resources: ReadonlyArray<BoundResource>
  /** When the grant runs out. Bounds forward work only; putting a call back ignores it. */
  readonly validUntil?: DateTime.Utc
}

type Services =
  & Parameters<typeof fileApplies>[0]
  & Parameters<typeof processRun>[0]
  & Parameters<typeof httpTools>[0]
  & { readonly confiningProfiles: ReadonlyArray<Exclude<FilesystemProfile, "compatibility">> }

const one = (context: FilesystemCallContext, field: string) =>
  context.resources.find((resource) => resource.binding.field === field)?.binding.selector
const each = (context: FilesystemCallContext, field: string) =>
  context.resources
    .filter((resource) => resource.binding.field === field)
    .sort((a, b) => (a.binding.index ?? 0) - (b.binding.index ?? 0))
    .map((resource) => resource.binding.selector)

const deadline = (context: FilesystemCallContext) =>
  context.validUntil === undefined ? undefined : DateTime.toEpochMillis(context.validUntil)

const unbound = (tool: string, field: string) =>
  Effect.succeed(refused(`${tool} did nothing: the call has no admitted ${field}`))
const unclaimed = (tool: string) =>
  Effect.fail(`${tool} was dispatched without a claim in Hold`)

export const filesystemTools = (services: Services) => {
  const captures = fileCaptures(services.files)
  const applies = fileApplies(services)
  const run = processRun(services)
  const http = httpTools(services)

  /** A capture or an apply on the one bound path named by `field`. */
  const onPath = <Input, Output>(
    tool: string,
    field: keyof Input & string,
    act: (input: Input, context: FilesystemCallContext) => Effect.Effect<Output, unknown>
  ) =>
  (input: Input, context: FilesystemCallContext): Effect.Effect<Output | Refused, unknown> => {
    const path = one(context, field)
    return path === undefined ? unbound(tool, field) : act({ ...input, [field]: path }, context)
  }
  /** An apply on a bound source and a bound destination. */
  const onTwoPaths = <Input extends { readonly source: string; readonly destination: string }, Output>(
    tool: string,
    act: (input: Input, context: FilesystemCallContext) => Effect.Effect<Output, unknown>
  ) =>
  (input: Input, context: FilesystemCallContext): Effect.Effect<Output | Refused, unknown> => {
    const source = one(context, "source")
    const destination = one(context, "destination")
    if (source === undefined) return unbound(tool, "source")
    if (destination === undefined) return unbound(tool, "destination")
    return act({ ...input, source, destination }, context)
  }
  const held = <Input, Output>(
    tool: string,
    act: (input: Input, reference: ReturnType<typeof heldCallReference>, validUntil?: number) => Effect.Effect<Output, unknown>
  ) =>
  (input: Input, context: FilesystemCallContext): Effect.Effect<Output, unknown> =>
    context.held === undefined ? unclaimed(tool) : act(input, heldCallReference(context.held), deadline(context))

  /** The one request of an HTTP call is its forward act. */
  const live = <Input, Output>(
    tool: string,
    act: (input: Input, context: FilesystemCallContext) => Effect.Effect<Output, unknown>
  ) =>
  (input: Input, context: FilesystemCallContext): Effect.Effect<Output | Refused, unknown> =>
    Effect.flatMap(Clock.currentTimeMillis, (now): Effect.Effect<Output | Refused, unknown> => {
      const until = deadline(context)
      return until !== undefined && now >= until
        ? Effect.succeed(refused(`${tool} sent nothing: the grant expired`))
        : act(input, context)
    })

  return {
    "file.inspect": onPath("file.inspect", "path", captures["file.inspect"]),
    "file.stat": onPath("file.stat", "path", captures["file.stat"]),
    "file.read": onPath("file.read", "path", captures["file.read"]),
    "file.list": onPath("file.list", "path", captures["file.list"]),
    "file.glob": onPath("file.glob", "root", captures["file.glob"]),
    "file.write": onPath("file.write", "path", held("file.write", applies["file.write"])),
    "file.remove": onPath("file.remove", "path", held("file.remove", applies["file.remove"])),
    "file.mkdir": onPath("file.mkdir", "path", held("file.mkdir", applies["file.mkdir"])),
    "file.copy": onTwoPaths("file.copy", held("file.copy", applies["file.copy"])),
    "file.move": onTwoPaths("file.move", held("file.move", applies["file.move"])),
    "process.run": (input: Parameters<typeof run>[0], context: FilesystemCallContext) => {
      const executable = one(context, "executable")
      const cwd = one(context, "cwd")
      if (executable === undefined) return unbound("process.run", "executable")
      if (cwd === undefined) return unbound("process.run", "cwd")
      const profile = context.host["profile"]
      return run(
        { ...input, executable, cwd, descendantExecutables: each(context, "descendantExecutables") },
        {
          // Unconfined unless the grant names a profile this machine provides.
          confined: services.confiningProfiles.some((confining) => confining === profile),
          signal: context.signal,
          ...(context.validUntil === undefined ? {} : { validUntil: deadline(context)! }),
          ...(context.held === undefined ? {} : { held: heldCallReference(context.held) })
        }
      )
    },
    "http.get": live("http.get", http["http.get"]),
    "http.stage": live("http.stage", http["http.stage"])
  }
}
