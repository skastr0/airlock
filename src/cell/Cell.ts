import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync
} from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import {
  PrivateWorkspaceRequest,
  type NativeWorkspaceError
} from "../platform/NativeWorkspace.ts"
import {
  CellUnavailable,
  NativeCellBackend,
  type NativeExecutableBinding
} from "./NativeCellBackend.ts"
import {
  ProcessRequest,
  ProcessReceipt,
  type ProcessError,
  type ProcessRunOptions
} from "../process/Process.ts"

/**
 * Shared host-native Cell seam. Contracts, workspace identity, delta, and drift
 * stay here; each platform backend owns its containment mechanism. This is
 * native-contained, never a claim of VM enclosure or complete execution
 * closure. The active capability report names the backend's exact limits.
 */

export const CellNetwork = Schema.Literal("deny", "allow")
export type CellNetwork = typeof CellNetwork.Type

/** Host-native profiles fence writes but deliberately retain ambient host reads. */
export const CellReadAuthority = Schema.Literal("ambient-host-read")
export type CellReadAuthority = typeof CellReadAuthority.Type

export const WorkspaceEntryKind = Schema.Literal("file", "directory", "symlink", "other")
export type WorkspaceEntryKind = typeof WorkspaceEntryKind.Type

export class WorkspaceEntryFingerprint extends Schema.Class<WorkspaceEntryFingerprint>(
  "WorkspaceEntryFingerprint"
)({
  path: Schema.String,
  kind: WorkspaceEntryKind,
  bytes: Schema.Number,
  mode: Schema.Number,
  digest: Schema.String
}) {}

/** A deterministic top-level view, including recursive content fingerprints. */
export class WorkspaceFingerprint extends Schema.Class<WorkspaceFingerprint>(
  "WorkspaceFingerprint"
)({
  root: Schema.String,
  entries: Schema.Array(WorkspaceEntryFingerprint),
  digest: Schema.String
}) {}

export const WorkspaceDeltaKind = Schema.Literal("created", "modified", "deleted")
export type WorkspaceDeltaKind = typeof WorkspaceDeltaKind.Type

/** A proposal only. Cell never applies it to the live workspace. */
export class WorkspaceDeltaCandidate extends Schema.Class<WorkspaceDeltaCandidate>(
  "WorkspaceDeltaCandidate"
)({
  path: Schema.String,
  kind: WorkspaceDeltaKind,
  baseline: Schema.optional(WorkspaceEntryFingerprint),
  private: Schema.optional(WorkspaceEntryFingerprint)
}) {}

/** Evidence that the live workspace changed while the Cell was running. */
export class WorkspaceDrift extends Schema.Class<WorkspaceDrift>("WorkspaceDrift")({
  path: Schema.String,
  baseline: Schema.optional(WorkspaceEntryFingerprint),
  live: Schema.optional(WorkspaceEntryFingerprint)
}) {}

export class CellRequest extends Schema.Class<CellRequest>("CellRequest")({
  sourceWorkspace: Schema.String,
  privateWorkspace: Schema.String,
  process: ProcessRequest,
  descendantExecutables: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => []
  }),
  tempPaths: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  network: Schema.optionalWith(CellNetwork, { default: () => "deny" as const })
}) {}

export class CellExecutableBinding extends Schema.Class<CellExecutableBinding>(
  "CellExecutableBinding"
)({
  role: Schema.Literal("root", "descendant"),
  requested: Schema.String,
  launch: Schema.String,
  allowedPaths: Schema.Array(Schema.String),
  workspaceRebased: Schema.Boolean
}) {}

export class CellReceipt extends Schema.Class<CellReceipt>("CellReceipt")({
  sourceWorkspace: Schema.String,
  privateWorkspace: Schema.String,
  privateTempDirectory: Schema.optional(Schema.String),
  network: CellNetwork,
  readAuthority: CellReadAuthority,
  process: ProcessRequest,
  processReceipt: ProcessReceipt,
  executableBindings: Schema.optionalWith(
    Schema.Array(CellExecutableBinding),
    { default: () => [] }
  ),
  baseline: WorkspaceFingerprint,
  live: WorkspaceFingerprint,
  private: WorkspaceFingerprint,
  delta: Schema.Array(WorkspaceDeltaCandidate),
  drift: Schema.Array(WorkspaceDrift)
}) {}

export class CellContractViolation extends Schema.TaggedError<CellContractViolation>()(
  "CellContractViolation",
  { field: Schema.String, reason: Schema.String }
) {}

export { CellUnavailable } from "./NativeCellBackend.ts"

export class WorkspaceFingerprintFailed extends Schema.TaggedError<WorkspaceFingerprintFailed>()(
  "WorkspaceFingerprintFailed",
  { root: Schema.String, cause: Schema.String }
) {}

export type CellPreparationError = NativeWorkspaceError | CellUnavailable

export type CellError =
  | CellContractViolation
  | CellUnavailable
  | WorkspaceFingerprintFailed
  | CellPreparationError
  | ProcessError

export interface CellRunOptions extends ProcessRunOptions {}

/**
 * A native-contained execution candidate. Its only output is a private delta
 * proposal and drift evidence; Hold remains the unique live mutation owner.
 */
export class Cell extends Context.Tag("airlock/Cell")<
  Cell,
  {
    readonly run: (
      request: CellRequest,
      options?: CellRunOptions
    ) => Effect.Effect<CellReceipt, CellError>
    /** Rebinds the live workspace immediately before an Apply consumes a delta. */
    readonly revalidate: (
      receipt: CellReceipt
    ) => Effect.Effect<ReadonlyArray<WorkspaceDrift>, WorkspaceFingerprintFailed>
  }
>() {}

const hash = (parts: ReadonlyArray<string | Uint8Array>) => {
  const digest = createHash("sha256")
  for (const part of parts) digest.update(part)
  return digest.digest("hex")
}

const kindOf = (mode: number): WorkspaceEntryKind => {
  if ((mode & 0o170000) === 0o100000) return "file"
  if ((mode & 0o170000) === 0o040000) return "directory"
  if ((mode & 0o170000) === 0o120000) return "symlink"
  return "other"
}

/** Never follows symlinks while recording the workspace's content identity. */
const fingerprintEntry = (absolutePath: string, displayPath: string): WorkspaceEntryFingerprint => {
  const stat = lstatSync(absolutePath)
  const kind = kindOf(stat.mode)
  const prefix = `${kind}\0${stat.mode}\0${stat.size}\0`
  const content =
    kind === "file"
      ? readFileSync(absolutePath)
      : kind === "directory"
        ? readdirSync(absolutePath)
            .sort()
            .map((entry) => {
              const child = fingerprintEntry(`${absolutePath}${sep}${entry}`, entry)
              return `${entry}\0${child.digest}\0`
            })
            .join("")
        : kind === "symlink"
          ? readlinkSync(absolutePath, "utf8")
          : ""
  const digest = hash([prefix, content])
  return new WorkspaceEntryFingerprint({
    path: displayPath,
    kind,
    bytes: stat.size,
    mode: stat.mode,
    digest
  })
}

export const fingerprintWorkspace = (
  root: string,
  excludedTopLevel: ReadonlySet<string> = new Set()
): Effect.Effect<WorkspaceFingerprint, WorkspaceFingerprintFailed> =>
  Effect.try({
    try: () => {
      const canonical = realpathSync(root)
      const entries = readdirSync(canonical)
        .filter((entry) => !excludedTopLevel.has(entry))
        .sort()
        .map((entry) => fingerprintEntry(`${canonical}${sep}${entry}`, entry))
      return new WorkspaceFingerprint({
        root: canonical,
        entries,
        digest: hash(entries.map((entry) => `${entry.path}\0${entry.digest}\0`))
      })
    },
    catch: (cause) =>
      new WorkspaceFingerprintFailed({
        root,
        cause: cause instanceof Error ? cause.message : String(cause)
      })
  })

const byPath = (fingerprint: WorkspaceFingerprint) =>
  new Map(fingerprint.entries.map((entry) => [entry.path, entry]))

const differs = (left: WorkspaceEntryFingerprint | undefined, right: WorkspaceEntryFingerprint | undefined) =>
  left?.digest !== right?.digest || left?.kind !== right?.kind || left?.mode !== right?.mode

const candidates = (baseline: WorkspaceFingerprint, privateView: WorkspaceFingerprint) => {
  const initial = byPath(baseline)
  const proposed = byPath(privateView)
  const paths = [...new Set([...initial.keys(), ...proposed.keys()])].sort()
  return paths.flatMap((path) => {
    const before = initial.get(path)
    const after = proposed.get(path)
    if (!differs(before, after)) return []
    return [
      new WorkspaceDeltaCandidate({
        path,
        kind: before === undefined ? "created" : after === undefined ? "deleted" : "modified",
        ...(before === undefined ? {} : { baseline: before }),
        ...(after === undefined ? {} : { private: after })
      })
    ]
  })
}

const driftEvidence = (baseline: WorkspaceFingerprint, live: WorkspaceFingerprint) => {
  const initial = byPath(baseline)
  const observed = byPath(live)
  const paths = [...new Set([...initial.keys(), ...observed.keys()])].sort()
  return paths.flatMap((path) => {
    const before = initial.get(path)
    const after = observed.get(path)
    if (!differs(before, after)) return []
    return [
      new WorkspaceDrift({
        path,
        ...(before === undefined ? {} : { baseline: before }),
        ...(after === undefined ? {} : { live: after })
      })
    ]
  })
}

const isSameOrWithin = (candidate: string, ancestor: string) => {
  const path = relative(ancestor, candidate)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(".." + "/"))
}

const assertion = (condition: boolean, field: string, reason: string) =>
  condition ? Effect.void : Effect.fail(new CellContractViolation({ field, reason }))

export const validateCellRequest = (request: CellRequest) =>
  Effect.gen(function* () {
    const source = resolve(request.sourceWorkspace)
    const privateWorkspace = resolve(request.privateWorkspace)
    yield* assertion(source !== privateWorkspace, "privateWorkspace", "must differ from sourceWorkspace")
    yield* assertion(
      !isSameOrWithin(privateWorkspace, source) && !isSameOrWithin(source, privateWorkspace),
      "privateWorkspace",
      "must not overlap sourceWorkspace"
    )
    yield* assertion(
      resolve(request.process.cwd) === source,
      "process.cwd",
      "must be sourceWorkspace; Cell rewrites it to privateWorkspace"
    )
    yield* assertion(
      request.process.stdin !== "inherit" &&
        request.process.stdout !== "inherit" &&
        request.process.stderr !== "inherit",
      "process.stdio",
      "native-contained execution forbids inherited stdin, stdout, and stderr descriptors"
    )
    yield* assertion(
      request.process.executable.startsWith("/") &&
        !request.process.executable.includes("\0"),
      "process.executable",
      "must be an absolute executable identity without NUL"
    )
    for (const [index, tempPath] of request.tempPaths.entries()) {
      const temporary = resolve(tempPath)
      yield* assertion(tempPath.startsWith("/"), `tempPaths[${index}]`, "must be absolute")
      yield* assertion(temporary !== "/", `tempPaths[${index}]`, "must not grant the filesystem root")
      yield* assertion(
        !isSameOrWithin(temporary, source) && !isSameOrWithin(source, temporary),
        `tempPaths[${index}]`,
        "must not overlap sourceWorkspace"
      )
      yield* assertion(
        !isSameOrWithin(temporary, privateWorkspace) && !isSameOrWithin(privateWorkspace, temporary),
        `tempPaths[${index}]`,
        "must not overlap privateWorkspace"
      )
    }
    for (const [index, executable] of request.descendantExecutables.entries()) {
      yield* assertion(
        executable.startsWith("/"),
        `descendantExecutables[${index}]`,
        "must be an absolute executable path"
      )
      yield* assertion(
        !executable.includes("\0"),
        `descendantExecutables[${index}]`,
        "must not contain NUL"
      )
      yield* assertion(
        executable !== request.process.executable,
        `descendantExecutables[${index}]`,
        "must not repeat the root executable"
      )
      yield* assertion(
        request.descendantExecutables.indexOf(executable) === index,
        `descendantExecutables[${index}]`,
        "must not contain duplicate executable identities"
      )
    }
    return {
      source,
      privateWorkspace,
      tempPaths: request.tempPaths.map((path) => resolve(path))
    }
  })

const runCell = (
  backend: Context.Tag.Service<typeof NativeCellBackend>,
  request: CellRequest,
  options: CellRunOptions = {}
) =>
  Effect.gen(function* () {
    const paths = yield* validateCellRequest(request)
    const sourceWorkspace = yield* Effect.try({
      try: () => realpathSync(paths.source),
      catch: (cause) =>
        new WorkspaceFingerprintFailed({
          root: paths.source,
          cause: cause instanceof Error ? cause.message : String(cause)
        })
    })
    const baseline = yield* fingerprintWorkspace(paths.source)
    const prepared = yield* backend.preparePrivateWorkspace(
      new PrivateWorkspaceRequest({ source: paths.source, destination: paths.privateWorkspace })
    )
    // Host policy engines compare physical paths or filesystem objects, so the
    // private view is rebound after preparation rather than trusting spelling.
    const privateWorkspace = yield* Effect.try({
      try: () => realpathSync(prepared.destination),
      catch: (cause) =>
        new WorkspaceFingerprintFailed({
          root: prepared.destination,
          cause: cause instanceof Error ? cause.message : String(cause)
        })
    })
    const canonicalTemps = yield* Effect.forEach(paths.tempPaths, (path, index) =>
      Effect.try({
        try: () => {
          const canonical = realpathSync(path)
          if (!lstatSync(canonical).isDirectory()) {
            throw new Error("must be a directory")
          }
          return canonical
        },
        catch: (cause) =>
          new CellContractViolation({
            field: `tempPaths[${index}]`,
            reason: `${path} must resolve to an existing directory before it is granted: ${cause instanceof Error ? cause.message : String(cause)}`
          })
      })
    )
    const privateTempName = `.airlock-runtime-tmp-${crypto.randomUUID()}`
    const privateTempDirectory = join(privateWorkspace, privateTempName)
    yield* Effect.try({
      try: () => mkdirSync(privateTempDirectory, { mode: 0o700 }),
      catch: (cause) =>
        new CellContractViolation({
          field: "process.env",
          reason:
            `could not create private runtime temp directory: ` +
            `${cause instanceof Error ? cause.message : String(cause)}`
        })
    })
    const executableBindings = yield* Effect.forEach(
      [...new Set([
        request.process.executable,
        ...request.descendantExecutables
      ])],
      (executable) =>
        Effect.try({
          try: () => {
            const requested = resolve(executable)
            let relativeExecutable: string | undefined
            if (isSameOrWithin(requested, paths.source)) {
              relativeExecutable = relative(paths.source, requested)
            } else if (existsSync(requested)) {
              const canonical = realpathSync(requested)
              if (isSameOrWithin(canonical, sourceWorkspace)) {
                relativeExecutable = relative(sourceWorkspace, canonical)
              }
            }

            if (relativeExecutable !== undefined) {
              const contained = join(privateWorkspace, relativeExecutable)
              let cursor = privateWorkspace
              for (const component of relativeExecutable.split(sep)) {
                if (component.length === 0) continue
                cursor = join(cursor, component)
                if (!existsSync(cursor)) break
                if (lstatSync(cursor).isSymbolicLink()) {
                  throw new Error(
                    `${executable} crosses a symlink inside the private workspace`
                  )
                }
              }
              const canonicalContained = existsSync(contained)
                ? realpathSync(contained)
                : contained
              if (!isSameOrWithin(canonicalContained, privateWorkspace)) {
                throw new Error(
                  `${executable} resolves outside the private workspace`
                )
              }
              return {
                requested: executable,
                launch: canonicalContained,
                allowedPaths: [contained, canonicalContained],
                workspaceRebased: true
              }
            }

            const canonical = realpathSync(requested)
            return {
              requested: executable,
              launch: executable,
              allowedPaths: [requested, canonical],
              workspaceRebased: false
            }
          },
          catch: (cause) =>
            new CellContractViolation({
              field: "descendantExecutables",
              reason:
                `${executable} must resolve before execution: ` +
                `${cause instanceof Error ? cause.message : String(cause)}`
            })
        })
    )
    const rootExecutable = executableBindings.find(
      (binding) => binding.requested === request.process.executable
    )
    if (rootExecutable === undefined) {
      return yield* new CellContractViolation({
        field: "process.executable",
        reason: "root executable did not bind into the executable edge set"
      })
    }
    const backendBindings: ReadonlyArray<NativeExecutableBinding> = executableBindings.map(
      (binding) => ({
        role: binding.requested === rootExecutable.requested ? "root" : "descendant",
        requested: binding.requested,
        launch: binding.launch,
        allowedPaths: [...new Set(binding.allowedPaths)],
        workspaceRebased: binding.workspaceRebased
      })
    )
    const processReceipt = yield* backend.launchContained({
      sourceWorkspace,
      privateWorkspace,
      tempPaths: canonicalTemps,
      privateTempDirectory,
      network: request.network,
      process: request.process,
      rootExecutable: {
        role: "root",
        requested: rootExecutable.requested,
        launch: rootExecutable.launch,
        allowedPaths: [...new Set(rootExecutable.allowedPaths)],
        workspaceRebased: rootExecutable.workspaceRebased
      },
      executableBindings: backendBindings
    }, options)
    const [live, privateView] = yield* Effect.all([
      fingerprintWorkspace(paths.source),
      fingerprintWorkspace(
        privateWorkspace,
        new Set([privateTempName])
      )
    ])
    return new CellReceipt({
      sourceWorkspace,
      privateWorkspace,
      privateTempDirectory,
      network: request.network,
      readAuthority: "ambient-host-read",
      process: request.process,
      processReceipt,
      executableBindings: backendBindings.map(
        (binding) =>
          new CellExecutableBinding({
            role: binding.role,
            requested: binding.requested,
            launch: binding.launch,
            allowedPaths: binding.allowedPaths,
            workspaceRebased: binding.workspaceRebased
          })
      ),
      baseline,
      live,
      private: privateView,
      delta: candidates(baseline, privateView),
      drift: driftEvidence(baseline, live)
    })
  }).pipe(Effect.withSpan("Cell.run"))

export const CellLayer = Layer.effect(
  Cell,
  Effect.gen(function* () {
    const backend = yield* NativeCellBackend
    return Cell.of({
      run: (request, options) => runCell(backend, request, options),
      revalidate: (receipt) =>
        fingerprintWorkspace(receipt.sourceWorkspace).pipe(
          Effect.map((live) => driftEvidence(receipt.baseline, live))
        )
    })
  })
)
