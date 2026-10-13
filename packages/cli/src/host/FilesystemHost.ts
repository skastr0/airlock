import { Effect, FileSystem, Result, Schema } from "effect"
import { lstat } from "node:fs/promises"
import * as nodePath from "node:path"
import { canonicalJson } from "@skastr0/airlock"
import { endpointResources } from "@skastr0/airlock"
import {
  type BoundResource,
  type BoundScope,
  HostGrantRefused,
  type HostRecovery,
  ResourceBinding,
  type ResourceBindRequest,
  ResourceRefused,
  type ResourceResolver,
  type ToolHost
} from "@skastr0/airlock"
import { bindPhysicalPathSelector } from "../native/PhysicalPathSelector.ts"

/**
 * The host for the filesystem tools: this machine.
 *
 * A path or an executable a call names is bound to the physical object it
 * means before any grant is matched: symlinked ancestors are resolved, a
 * symlink leaf is refused, and the object's device and inode are part of the
 * binding. A path that does not exist yet is bound through its nearest
 * existing directory. Grant scopes are resolved the same way, once, when the
 * policy loads, so a scope and a call can never disagree about spelling.
 *
 * What this host can put back decides what may run without approval: reads,
 * and file changes, which go through Hold. A process may run without approval
 * only inside a confining profile this machine provides, because only then
 * is what it changed merged back through Hold.
 */

/** How a process is confined. `compatibility` does not confine. */
export const FilesystemProfile = Schema.Literals(["compatibility", "native-contained", "vm-enclosed"])
export type FilesystemProfile = typeof FilesystemProfile.Type

/** The only host parameters a grant may carry, and only for a tool that starts a process. */
const InvokeParameters = Schema.Struct({ profile: Schema.optionalKey(FilesystemProfile) })

type PathCapability = { readonly kind: "path"; readonly physical: string }
type ExecutableCapability = { readonly kind: "executable"; readonly physical: string }
type PathScope = ReadonlyArray<string>

const refuse = (field: string, reason: string) => new ResourceRefused({ field, reason })

/** Evidence is read again at dispatch and when persisted; nothing may change it in between. */
const frozen = <A>(value: A): A => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) frozen(inner)
    Object.freeze(value)
  }
  return value
}

const identityOf = (physical: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const info = await lstat(physical)
        return { device: info.dev, inode: info.ino, kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" }
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: () => "unreadable" as const
  })

export interface FilesystemHostOptions {
  /** Relative path selectors resolve against this directory. Host state, never a call's. */
  readonly workspace: string
  /** The confining profiles this machine can actually provide. */
  readonly confiningProfiles: ReadonlyArray<Exclude<FilesystemProfile, "compatibility">>
  readonly recovery: HostRecovery
}

export const filesystemHost = (
  options: FilesystemHostOptions
): Effect.Effect<ToolHost, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = new WeakMap<object, PathCapability>()
    const executables = new WeakMap<object, ExecutableCapability>()
    /** Only a root, bound with `invoke`, may be the parent of a descendant. */
    const roots = new WeakSet<object>()
    const pathScopes = new WeakMap<object, PathScope>()
    const executableScopes = new WeakMap<object, ReadonlySet<string>>()

    const physicalOf = (field: string, selector: string) =>
      bindPhysicalPathSelector(options.workspace, selector).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError((error) => refuse(field, `path cannot be bound: ${error.operation}`))
      )

    const evidence = (request: ResourceBindRequest, selector: string, identity: Schema.Json) =>
      Schema.decodeUnknownEffect(ResourceBinding, { onExcessProperty: "error" })({
        field: request.field,
        ...(request.index === undefined ? {} : { index: request.index }),
        kind: request.kind,
        rights: [...request.rights],
        selector,
        identity
      }).pipe(
        Effect.map(frozen),
        Effect.mapError(() => refuse(request.field, "binding evidence is invalid or too large"))
      )

    const bindPath = Effect.fnUntraced(function* (request: ResourceBindRequest) {
      if (request.parent !== undefined || !request.rights.every((right) => right === "read" || right === "write")) {
        return yield* refuse(request.field, "path binding has invalid rights or a parent")
      }
      const physical = yield* physicalOf(request.field, request.selector)
      const found = yield* identityOf(physical).pipe(Effect.mapError(() => refuse(request.field, "path cannot be inspected")))
      if (found?.kind === "other") return yield* refuse(request.field, "path is neither a file nor a directory")
      let identity: Schema.Json
      if (found !== undefined) {
        identity = { path: physical, ...found }
      } else {
        // Nothing is there yet. Only a call that may write can name it, and
        // it is bound through the directory that will hold it.
        if (!request.rights.includes("write")) return yield* refuse(request.field, "path does not exist")
        let parent = nodePath.dirname(physical)
        let holder = yield* identityOf(parent).pipe(Effect.mapError(() => refuse(request.field, "path cannot be inspected")))
        while (holder === undefined && parent !== nodePath.dirname(parent)) {
          parent = nodePath.dirname(parent)
          holder = yield* identityOf(parent).pipe(Effect.mapError(() => refuse(request.field, "path cannot be inspected")))
        }
        if (holder === undefined || holder.kind !== "directory") {
          return yield* refuse(request.field, "path has no existing directory above it")
        }
        identity = {
          path: physical,
          absent: true,
          parent: { path: parent, device: holder.device, inode: holder.inode },
          leaf: nodePath.relative(parent, physical)
        }
      }
      const binding = yield* evidence(request, physical, identity)
      const resource: BoundResource = Object.freeze({ binding, capability: Object.freeze({ kind: "path", physical }) })
      paths.set(resource, { kind: "path", physical })
      return resource
    })

    const bindExecutable = Effect.fnUntraced(function* (request: ResourceBindRequest) {
      const root = request.rights.length === 1 && request.rights[0] === "invoke"
      const descendant = request.rights.length === 1 && request.rights[0] === "execute"
      if (!root && !descendant) return yield* refuse(request.field, "executable binding has invalid rights")
      if (root !== (request.parent === undefined)) {
        return yield* refuse(request.field, "an executable root has no parent and a descendant has exactly one")
      }
      if (request.parent !== undefined && !roots.has(request.parent)) {
        return yield* refuse(request.field, "descendant parent is not an executable root bound by this host")
      }
      if (!nodePath.isAbsolute(request.selector)) return yield* refuse(request.field, "executable must be an absolute path")
      // An executable is named by the file that will run, so a symlinked
      // spelling is followed here and the file it reaches is what is bound.
      const physical = yield* fs.realPath(request.selector).pipe(
        Effect.mapError(() => refuse(request.field, "executable does not exist"))
      )
      const found = yield* identityOf(physical).pipe(Effect.mapError(() => refuse(request.field, "executable cannot be inspected")))
      if (found?.kind !== "file") return yield* refuse(request.field, "executable is not a file")
      const parent = request.parent === undefined ? undefined : executables.get(request.parent)!.physical
      const binding = yield* evidence(request, physical, {
        path: physical,
        device: found.device,
        inode: found.inode,
        ...(parent === undefined ? {} : { parent })
      })
      const resource: BoundResource = Object.freeze({ binding, capability: Object.freeze({ kind: "executable", physical }) })
      executables.set(resource, { kind: "executable", physical })
      if (root) roots.add(resource)
      return resource
    })

    const bind = (request: ResourceBindRequest): Effect.Effect<BoundResource, ResourceRefused> =>
      request.kind === "path"
        ? bindPath(request)
        : request.kind === "executable"
          ? bindExecutable(request)
          : endpointResources.bind(request)

    const resources: ResourceResolver = {
      kinds: ["path", "executable", "endpoint"],
      scope: ({ kind, selectors }) =>
        Effect.gen(function* () {
          if (kind === "endpoint") return yield* endpointResources.scope({ kind, selectors })
          if (kind === "path") {
            const roots: Array<string> = []
            for (const selector of selectors) {
              // `/dir/**` and `/dir` both mean the directory and everything under it.
              const root = selector.endsWith("/**") ? selector.slice(0, -3) : selector
              if (!nodePath.isAbsolute(root)) return yield* refuse("resources.path", "scope must be an absolute path")
              roots.push(yield* physicalOf("resources.path", root))
            }
            const scope: BoundScope = Object.freeze({ kind, capability: Object.freeze([...roots]) })
            pathScopes.set(scope, roots)
            return scope
          }
          const allowed = new Set<string>()
          for (const selector of selectors) {
            if (!nodePath.isAbsolute(selector)) return yield* refuse("resources.executable", "scope must be an absolute path")
            allowed.add(yield* fs.realPath(selector).pipe(
              Effect.mapError(() => refuse("resources.executable", "scope names an executable that does not exist"))
            ))
          }
          const scope: BoundScope = Object.freeze({ kind, capability: Object.freeze([...allowed]) })
          executableScopes.set(scope, allowed)
          return scope
        }),
      bind,
      within: (resource, scope) => {
        if (scope.kind === "endpoint") return endpointResources.within(resource, scope)
        if (scope.kind === "path") {
          const path = paths.get(resource)
          const roots = pathScopes.get(scope)
          return path !== undefined && roots !== undefined &&
            roots.some((root) => path.physical === root || path.physical.startsWith(root === "/" ? "/" : `${root}/`))
        }
        const executable = executables.get(resource)
        return executable !== undefined && executableScopes.get(scope)?.has(executable.physical) === true
      },
      rebind: ({ binding, parent }) =>
        Effect.gen(function* () {
          const bound = yield* bind({ ...binding, ...(parent === undefined ? {} : { parent }) })
          if (canonicalJson(bound.binding) !== canonicalJson(binding)) {
            return yield* refuse(binding.field, "the object this names changed since admission")
          }
          return bound
        })
    }

    const validateGrant: ToolHost["validateGrant"] = ({ contract, grant }) => {
      const no = (reason: string) => Result.fail(new HostGrantRefused({ tool: grant.tool, reason }))
      if (grant.tool !== contract.tag) return no("grant names a different tool")
      const parameters = grant.host ?? {}
      if (contract.effect !== "invoke") {
        if (Object.keys(parameters).length > 0) return no("only a tool that starts a process takes host parameters")
        // Reads change nothing and file changes go through Hold; a request
        // leaves the machine, and nothing here can call it back.
        return grant.when === "now" && contract.effect === "request"
          ? no("a request always waits for approval")
          : Result.succeed(undefined)
      }
      const decoded = Schema.decodeUnknownResult(InvokeParameters, { onExcessProperty: "error" })(parameters)
      if (Result.isFailure(decoded)) return no("host parameters must be { profile } with a known profile")
      const profile = decoded.success.profile
      if (profile !== undefined && profile !== "compatibility" && !options.confiningProfiles.includes(profile)) {
        return no(`this machine cannot confine a process with ${profile}`)
      }
      if (grant.when === "now" && (profile === undefined || profile === "compatibility")) {
        return no("an unconfined process always waits for approval; name a confining profile to run it now")
      }
      return Result.succeed(undefined)
    }

    return { resources, validateGrant, recovery: options.recovery } satisfies ToolHost
  })
