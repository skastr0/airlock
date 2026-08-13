import { Effect, Schema } from "effect"
import * as nodePath from "node:path"
import { ArtifactId, CellProfile, HandleKind, Right } from "../plan/index.ts"

/**
 * Native action vocabulary is a pure lowering seam. It describes requested
 * work but imports no filesystem, process, network, Hold, or Outbox adapter.
 * Authority is still only introduced by Plan admission.
 */

export const NativeActionName = Schema.Literal(
  "file.inspect",
  "file.read",
  "file.list",
  "file.glob",
  "file.stat",
  "file.write",
  "file.remove",
  "file.move",
  "file.copy",
  "file.mkdir",
  "process.run",
  "http.stage"
)
export type NativeActionName = typeof NativeActionName.Type

export const ObservationActionName = Schema.Literal(
  "file.inspect",
  "file.read",
  "file.list",
  "file.glob",
  "file.stat"
)
export type ObservationActionName = typeof ObservationActionName.Type

export const MutationActionName = Schema.Literal(
  "file.write",
  "file.remove",
  "file.move",
  "file.copy",
  "file.mkdir"
)
export type MutationActionName = typeof MutationActionName.Type

export class ResourceNeed extends Schema.Class<ResourceNeed>("ResourceNeed")({
  kind: HandleKind,
  realm: Schema.String,
  selector: Schema.String,
  rights: Schema.Array(Right)
}) {}

const PathCall = { path: Schema.String, realm: Schema.optionalWith(Schema.String, { default: () => "local" }) }

export const FileInspectAction = Schema.Struct({ action: Schema.Literal("file.inspect"), ...PathCall })
export type FileInspectAction = typeof FileInspectAction.Type

export const FileReadAction = Schema.Struct({
  action: Schema.Literal("file.read"),
  ...PathCall,
  format: Schema.optionalWith(Schema.Literal("text", "bytes", "json"), { default: () => "text" as const })
})
export type FileReadAction = typeof FileReadAction.Type

export const FileListAction = Schema.Struct({ action: Schema.Literal("file.list"), ...PathCall })
export type FileListAction = typeof FileListAction.Type

export const FileGlobAction = Schema.Struct({
  action: Schema.Literal("file.glob"),
  root: Schema.String,
  pattern: Schema.String,
  realm: Schema.optionalWith(Schema.String, { default: () => "local" })
})
export type FileGlobAction = typeof FileGlobAction.Type

export const FileStatAction = Schema.Struct({
  action: Schema.Literal("file.stat"),
  ...PathCall,
  followSymlinks: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type FileStatAction = typeof FileStatAction.Type

export const FileWriteAction = Schema.Struct({
  action: Schema.Literal("file.write"),
  ...PathCall,
  content: Schema.optional(Schema.String),
  sourceArtifact: Schema.optional(ArtifactId)
})
export type FileWriteAction = typeof FileWriteAction.Type

export const FileRemoveAction = Schema.Struct({ action: Schema.Literal("file.remove"), ...PathCall })
export type FileRemoveAction = typeof FileRemoveAction.Type

export const FileMoveAction = Schema.Struct({
  action: Schema.Literal("file.move"),
  source: Schema.String,
  destination: Schema.String,
  realm: Schema.optionalWith(Schema.String, { default: () => "local" })
})
export type FileMoveAction = typeof FileMoveAction.Type

export const FileCopyAction = Schema.Struct({
  action: Schema.Literal("file.copy"),
  source: Schema.String,
  destination: Schema.String,
  realm: Schema.optionalWith(Schema.String, { default: () => "local" })
})
export type FileCopyAction = typeof FileCopyAction.Type

export const FileMkdirAction = Schema.Struct({
  action: Schema.Literal("file.mkdir"),
  ...PathCall,
  parents: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type FileMkdirAction = typeof FileMkdirAction.Type

/**
 * Process input is structurally disjoint. A bare branded string was ambiguous
 * with the "discard" and "inherit" literals at the wire boundary, while text
 * and artifact input have different provenance and lowering requirements.
 */
export const ProcessStdin = Schema.Union(
  Schema.Literal("discard", "inherit"),
  Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("artifact"), id: ArtifactId })
)
export type ProcessStdin = typeof ProcessStdin.Type

export const ProcessRunAction = Schema.Struct({
  action: Schema.Literal("process.run"),
  /** Absolute executable identity; argument atoms live separately in `args`. */
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  /**
   * Exact executable identities this root may spawn as descendants. The
   * root executable remains separate and is always the Invoke authority.
   */
  descendantExecutables: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => []
  }),
  cwd: Schema.String,
  env: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { default: () => ({}) }
  ),
  cellProfile: Schema.optionalWith(CellProfile, { default: () => "compatibility" as const }),
  timeoutMs: Schema.optional(Schema.Number),
  /** Text is frozen as an artifact before Plan lowering; artifact ids stay explicit. */
  stdin: Schema.optionalWith(ProcessStdin, {
    default: () => "discard" as const
  }),
  stdout: Schema.optionalWith(Schema.Literal("capture", "discard", "inherit"), {
    default: () => "capture" as const
  }),
  stderr: Schema.optionalWith(Schema.Literal("capture", "discard", "inherit"), {
    default: () => "capture" as const
  }),
  outputLimitBytes: Schema.optionalWith(Schema.Number, { default: () => 1_048_576 }),
  readable: Schema.optionalWith(Schema.Array(ResourceNeed), { default: () => [] }),
  writable: Schema.optionalWith(Schema.Array(ResourceNeed), { default: () => [] }),
  realm: Schema.optionalWith(Schema.String, { default: () => "local" })
})
export type ProcessRunAction = typeof ProcessRunAction.Type

export const HttpStageAction = Schema.Struct({
  action: Schema.Literal("http.stage"),
  endpoint: Schema.String,
  method: Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE"),
  headers: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { default: () => ({}) }
  ),
  body: Schema.optional(Schema.String),
  bodyArtifact: Schema.optional(ArtifactId),
  holdMillis: Schema.optionalWith(Schema.Number, { default: () => 30_000 }),
  realm: Schema.optionalWith(Schema.String, { default: () => "external" })
})
export type HttpStageAction = typeof HttpStageAction.Type

export const NativeActionCall = Schema.Union(
  FileInspectAction,
  FileReadAction,
  FileListAction,
  FileGlobAction,
  FileStatAction,
  FileWriteAction,
  FileRemoveAction,
  FileMoveAction,
  FileCopyAction,
  FileMkdirAction,
  ProcessRunAction,
  HttpStageAction
)
export type NativeActionCall = typeof NativeActionCall.Type

/** A trusted adapter may bind filesystem selectors before inert lowering. */
export type NativePathSelectorBinder<E = never, R = never> = (
  selector: string
) => Effect.Effect<string, E, R>

/** The compatibility/default binder deliberately preserves every spelling. */
export const unchangedNativePathSelector: NativePathSelectorBinder = (selector) =>
  Effect.succeed(selector)

/**
 * Exhaustive ownership of every filesystem path field in the native action
 * union. Endpoint and executable identities are deliberately not path fields.
 * Equal raw selectors are bound once per call so one draft cannot acquire two
 * physical names for the same requested path.
 */
export const mapNativeActionPathSelectors = <
  A extends NativeActionCall,
  E,
  R
>(
  call: A,
  bind: NativePathSelectorBinder<E, R>
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const cached = new Map<string, string>()
    const path = (selector: string): Effect.Effect<string, E, R> => {
      const existing = cached.get(selector)
      if (existing !== undefined) return Effect.succeed(existing)
      return bind(selector).pipe(
        Effect.tap((bound) => Effect.sync(() => cached.set(selector, bound)))
      )
    }
    const resources = (needs: ReadonlyArray<ResourceNeed>) =>
      Effect.forEach(
        needs,
        (need) => need.kind === "path"
          ? path(need.selector).pipe(
              Effect.map((selector) => new ResourceNeed({ ...need, selector }))
            )
          : Effect.succeed(need),
        { concurrency: 1 }
      )
    const mapped = <B extends NativeActionCall>(value: B): A => value as unknown as A

    switch (call.action) {
      case "file.inspect":
      case "file.read":
      case "file.list":
      case "file.stat":
      case "file.write":
      case "file.remove":
      case "file.mkdir":
        return mapped({ ...call, path: yield* path(call.path) })
      case "file.glob":
        return mapped({ ...call, root: yield* path(call.root) })
      case "file.move":
      case "file.copy":
        return mapped({
          ...call,
          source: yield* path(call.source),
          destination: yield* path(call.destination)
        })
      case "process.run":
        return mapped({
          ...call,
          cwd: nodePath.isAbsolute(call.cwd)
            ? yield* path(call.cwd)
            : call.cwd,
          readable: yield* resources(call.readable),
          writable: yield* resources(call.writable)
        })
      case "http.stage":
        return call
      default: {
        const unreachable: never = call
        return unreachable
      }
    }
  })

/**
 * Canonical Schema ownership for each native action. Discovery and decoding
 * both read from these definitions; the CLI never hand-maintains a parallel
 * description of action fields.
 */
export const NativeActionSchemas = {
  "file.inspect": FileInspectAction,
  "file.read": FileReadAction,
  "file.list": FileListAction,
  "file.glob": FileGlobAction,
  "file.stat": FileStatAction,
  "file.write": FileWriteAction,
  "file.remove": FileRemoveAction,
  "file.move": FileMoveAction,
  "file.copy": FileCopyAction,
  "file.mkdir": FileMkdirAction,
  "process.run": ProcessRunAction,
  "http.stage": HttpStageAction
} as const

export const nativeActionSchema = (
  name: NativeActionName
): (typeof NativeActionSchemas)[NativeActionName] =>
  NativeActionSchemas[name]

export class CaptureLowering extends Schema.TaggedClass<CaptureLowering>()("Capture", {
  action: ObservationActionName,
  locator: Schema.String,
  requirements: Schema.Array(ResourceNeed)
}) {}

export class ApplyLowering extends Schema.TaggedClass<ApplyLowering>()("Apply", {
  action: MutationActionName,
  requirements: Schema.Array(ResourceNeed),
  target: Schema.String,
  source: Schema.optional(Schema.String),
  sourceArtifact: Schema.optional(ArtifactId),
  content: Schema.optional(Schema.String),
  parents: Schema.optional(Schema.Boolean)
}) {}

export class InvokeLowering extends Schema.TaggedClass<InvokeLowering>()("Invoke", {
  action: Schema.Literal("process.run"),
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  descendantExecutables: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
  cellProfile: CellProfile,
  timeoutMs: Schema.optional(Schema.Number),
  stdin: ProcessStdin,
  stdout: Schema.Literal("capture", "discard", "inherit"),
  stderr: Schema.Literal("capture", "discard", "inherit"),
  outputLimitBytes: Schema.Number,
  requirements: Schema.Array(ResourceNeed)
}) {}

export class RequestExternalLowering extends Schema.TaggedClass<RequestExternalLowering>()(
  "RequestExternal",
  {
    action: Schema.Literal("http.stage"),
    endpoint: Schema.String,
    method: Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE"),
    headers: Schema.Record({ key: Schema.String, value: Schema.String }),
    body: Schema.optional(Schema.String),
    bodyArtifact: Schema.optional(ArtifactId),
    holdMillis: Schema.Number,
    requirements: Schema.Array(ResourceNeed)
  }
) {}

export const LoweredActionNode = Schema.Union(
  CaptureLowering,
  ApplyLowering,
  InvokeLowering,
  RequestExternalLowering
)
export type LoweredActionNode = typeof LoweredActionNode.Type

export class NativeActionLowering extends Schema.Class<NativeActionLowering>("NativeActionLowering")({
  action: NativeActionName,
  nodes: Schema.Array(LoweredActionNode)
}) {}

export class ActionCallDecodeFailed extends Schema.TaggedError<ActionCallDecodeFailed>()(
  "ActionCallDecodeFailed",
  { source: Schema.String, message: Schema.String }
) {}

export class UnknownNativeAction extends Schema.TaggedError<UnknownNativeAction>()(
  "UnknownNativeAction",
  { action: Schema.String }
) {}

export class InvalidActionInput extends Schema.TaggedError<InvalidActionInput>()(
  "InvalidActionInput",
  { action: NativeActionName, field: Schema.String, reason: Schema.String }
) {}

export type ActionLoweringError = InvalidActionInput

export class NativeActionDescriptor extends Schema.Class<NativeActionDescriptor>("NativeActionDescriptor")({
  name: NativeActionName,
  node: Schema.Literal("Capture", "Apply", "Invoke", "RequestExternal"),
  summary: Schema.String
}) {}

export const NativeActionCatalog: ReadonlyArray<NativeActionDescriptor> = [
  new NativeActionDescriptor({ name: "file.inspect", node: "Capture", summary: "Capture an identity-safe filesystem inspection." }),
  new NativeActionDescriptor({ name: "file.read", node: "Capture", summary: "Capture file bytes, text, or JSON." }),
  new NativeActionDescriptor({ name: "file.list", node: "Capture", summary: "Capture a directory listing." }),
  new NativeActionDescriptor({ name: "file.glob", node: "Capture", summary: "Capture a glob expansion rooted at an explicit path." }),
  new NativeActionDescriptor({ name: "file.stat", node: "Capture", summary: "Capture filesystem metadata without following symlinks by default." }),
  new NativeActionDescriptor({ name: "file.write", node: "Apply", summary: "Apply a held file write from content or an artifact." }),
  new NativeActionDescriptor({ name: "file.remove", node: "Apply", summary: "Apply a held removal." }),
  new NativeActionDescriptor({ name: "file.move", node: "Apply", summary: "Apply a managed move." }),
  new NativeActionDescriptor({ name: "file.copy", node: "Apply", summary: "Apply a managed copy." }),
  new NativeActionDescriptor({ name: "file.mkdir", node: "Apply", summary: "Apply managed directory creation." }),
  new NativeActionDescriptor({ name: "process.run", node: "Invoke", summary: "Invoke one structured executable + args contract inside a Cell." }),
  new NativeActionDescriptor({ name: "http.stage", node: "RequestExternal", summary: "Stage an HTTP intent; it cannot dispatch from this lowering." })
]

const pathNeed = (selector: string, realm: string, rights: ReadonlyArray<typeof Right.Type>) =>
  new ResourceNeed({ kind: "path", selector, realm, rights: [...rights] })

const executableNeed = (selector: string, realm: string) =>
  new ResourceNeed({ kind: "executable", selector, realm, rights: ["invoke"] })

const descendantExecutableNeed = (selector: string, realm: string) =>
  new ResourceNeed({ kind: "executable", selector, realm, rights: ["execute"] })

const endpointNeed = (selector: string, realm: string) =>
  new ResourceNeed({ kind: "endpoint", selector, realm, rights: ["connect", "emit"] })

const requireNonBlank = (action: NativeActionName, field: string, value: string) =>
  value.trim().length === 0
    ? Effect.fail(new InvalidActionInput({ action, field, reason: "must not be blank" }))
    : Effect.void

const uniqueNeeds = (needs: ReadonlyArray<ResourceNeed>) =>
  needs.filter(
    (need, index) =>
      needs.findIndex(
        (candidate) =>
          candidate.kind === need.kind &&
          candidate.realm === need.realm &&
          candidate.selector === need.selector &&
          candidate.rights.join("/") === need.rights.join("/")
      ) === index
  )

/**
 * Lowers a decoded native call to the four existing operational categories.
 * The result is inert: it has no plan ids, handles, adapters, or authority.
 */
export const lowerNativeAction = (
  call: NativeActionCall
): Effect.Effect<NativeActionLowering, ActionLoweringError> =>
  Effect.gen(function* () {
    switch (call.action) {
      case "file.inspect":
      case "file.list":
      case "file.stat": {
        yield* requireNonBlank(call.action, "path", call.path)
        if (call.action === "file.stat" && call.followSymlinks) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "followSymlinks",
            reason: "must be false; following symlinks is not part of the native contract"
          })
        }
        const locator =
          call.action === "file.inspect"
            ? `inspect:${call.path}`
            : call.action === "file.list"
              ? `list:${call.path}`
              : `stat:${call.path};followSymlinks=${call.followSymlinks}`
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new CaptureLowering({
              action: call.action,
              locator,
              requirements: [pathNeed(call.path, call.realm, ["read"])]
            })
          ]
        })
      }
      case "file.read": {
        yield* requireNonBlank(call.action, "path", call.path)
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new CaptureLowering({
              action: call.action,
              locator: `read:${call.format}:${call.path}`,
              requirements: [pathNeed(call.path, call.realm, ["read"])]
            })
          ]
        })
      }
      case "file.glob": {
        yield* requireNonBlank(call.action, "root", call.root)
        yield* requireNonBlank(call.action, "pattern", call.pattern)
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new CaptureLowering({
              action: call.action,
              locator: `glob:${call.root}:${call.pattern}`,
              requirements: [pathNeed(call.root, call.realm, ["read"])]
            })
          ]
        })
      }
      case "file.write": {
        yield* requireNonBlank(call.action, "path", call.path)
        const supplied = Number(call.content !== undefined) + Number(call.sourceArtifact !== undefined)
        if (supplied !== 1) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "content/sourceArtifact",
            reason: "provide exactly one content source"
          })
        }
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new ApplyLowering({
              action: call.action,
              target: call.path,
              content: call.content,
              sourceArtifact: call.sourceArtifact,
              requirements: [pathNeed(call.path, call.realm, ["write"])]
            })
          ]
        })
      }
      case "file.remove": {
        yield* requireNonBlank(call.action, "path", call.path)
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new ApplyLowering({
              action: call.action,
              target: call.path,
              requirements: [pathNeed(call.path, call.realm, ["write"])]
            })
          ]
        })
      }
      case "file.move":
      case "file.copy": {
        yield* requireNonBlank(call.action, "source", call.source)
        yield* requireNonBlank(call.action, "destination", call.destination)
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new ApplyLowering({
              action: call.action,
              source: call.source,
              target: call.destination,
              requirements: [
                pathNeed(
                  call.source,
                  call.realm,
                  call.action === "file.move" ? ["read", "write"] : ["read"]
                ),
                pathNeed(call.destination, call.realm, ["write"])
              ]
            })
          ]
        })
      }
      case "file.mkdir": {
        yield* requireNonBlank(call.action, "path", call.path)
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new ApplyLowering({
              action: call.action,
              target: call.path,
              parents: call.parents,
              requirements: [pathNeed(call.path, call.realm, ["write"])]
            })
          ]
        })
      }
      case "process.run": {
        yield* requireNonBlank(call.action, "executable", call.executable)
        yield* requireNonBlank(call.action, "cwd", call.cwd)
        if (!call.executable.startsWith("/")) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "executable",
            reason: "must be an absolute path; PATH lookup is not part of the action contract"
          })
        }
        const descendantExecutables = [...new Set(call.descendantExecutables)]
        if (descendantExecutables.length !== call.descendantExecutables.length) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "descendantExecutables",
            reason: "must not contain duplicate executable identities"
          })
        }
        for (const [index, descendant] of descendantExecutables.entries()) {
          if (!descendant.startsWith("/")) {
            return yield* new InvalidActionInput({
              action: call.action,
              field: `descendantExecutables[${index}]`,
              reason: "must be an absolute path"
            })
          }
          if (descendant.includes("\0")) {
            return yield* new InvalidActionInput({
              action: call.action,
              field: `descendantExecutables[${index}]`,
              reason: "must not contain NUL"
            })
          }
          if (descendant === call.executable) {
            return yield* new InvalidActionInput({
              action: call.action,
              field: `descendantExecutables[${index}]`,
              reason: "must not repeat the root executable identity"
            })
          }
        }
        if (!call.cwd.startsWith("/")) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "cwd",
            reason: "must be an absolute path; ambient working directories are not part of the action contract"
          })
        }
        if (call.timeoutMs !== undefined && call.timeoutMs <= 0) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "timeoutMs",
            reason: "must be positive when provided"
          })
        }
        if (!Number.isSafeInteger(call.outputLimitBytes) || call.outputLimitBytes < 0) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "outputLimitBytes",
            reason: "must be a non-negative safe integer"
          })
        }
        for (const [index, argument] of call.args.entries()) {
          if (argument.includes("\u0000")) {
            return yield* new InvalidActionInput({
              action: call.action,
              field: `args[${index}]`,
              reason: "must not contain NUL"
            })
          }
        }
        for (const [key, value] of Object.entries(call.env)) {
          if (key.length === 0 || key.includes("=") || key.includes("\u0000") || value.includes("\u0000")) {
            return yield* new InvalidActionInput({
              action: call.action,
              field: "env",
              reason: "environment keys cannot be blank, contain '=', or contain NUL; values cannot contain NUL"
            })
          }
        }
        const requirements = uniqueNeeds([
          executableNeed(call.executable, call.realm),
          ...descendantExecutables.map((selector) =>
            descendantExecutableNeed(selector, call.realm)
          ),
          pathNeed(call.cwd, call.realm, ["read"]),
          ...call.readable,
          ...call.writable
        ])
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new InvokeLowering({
              action: call.action,
              executable: call.executable,
              args: call.args,
              descendantExecutables,
              cwd: call.cwd,
              env: call.env,
              cellProfile: call.cellProfile,
              timeoutMs: call.timeoutMs,
              stdin: call.stdin,
              stdout: call.stdout,
              stderr: call.stderr,
              outputLimitBytes: call.outputLimitBytes,
              requirements
            })
          ]
        })
      }
      case "http.stage": {
        yield* requireNonBlank(call.action, "endpoint", call.endpoint)
        if (call.holdMillis < 0) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "holdMillis",
            reason: "must be non-negative"
          })
        }
        const supplied = Number(call.body !== undefined) + Number(call.bodyArtifact !== undefined)
        if (supplied > 1) {
          return yield* new InvalidActionInput({
            action: call.action,
            field: "body/bodyArtifact",
            reason: "provide at most one body source"
          })
        }
        return new NativeActionLowering({
          action: call.action,
          nodes: [
            new RequestExternalLowering({
              action: call.action,
              endpoint: call.endpoint,
              method: call.method,
              headers: call.headers,
              body: call.body,
              bodyArtifact: call.bodyArtifact,
              holdMillis: call.holdMillis,
              requirements: [endpointNeed(call.endpoint, call.realm)]
            })
          ]
        })
      }
    }
  })

export const decodeAndLowerNativeAction = (source: string, input: unknown) =>
  Schema.decodeUnknown(NativeActionCall, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(
      (error) => new ActionCallDecodeFailed({ source, message: error.message })
    ),
    Effect.flatMap(lowerNativeAction)
  )

export const nativeAction = (name: string): Effect.Effect<NativeActionDescriptor, UnknownNativeAction> => {
  const descriptor = NativeActionCatalog.find((candidate) => candidate.name === name)
  return descriptor === undefined
    ? Effect.fail(new UnknownNativeAction({ action: name }))
    : Effect.succeed(descriptor)
}
