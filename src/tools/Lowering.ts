import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import {
  NativeActionLowering,
  ProcessRunAction,
  ResourceNeed,
  lowerNativeAction
} from "../actions/index.ts"
import { CellProfile, Digest } from "../plan/index.ts"
import {
  LoadedToolDefinition,
  ToolDefinition,
  ToolDefinitionId,
  ToolLoweringKind,
  ToolResultDecoder,
  type TemplateValue,
  type ToolActionDefinition,
  type ToolExecutableConstraint,
  type ToolResourceRequirement
} from "./Definitions.ts"

/**
 * Definitions remain inert data. This request supplies the executable identity
 * selected by a caller that already owns resolution and admission policy.
 * Lowering may compare that identity with a definition, but never discover,
 * select, open, or execute it.
 */
export class ToolActionLoweringRequest extends Schema.Class<ToolActionLoweringRequest>(
  "ToolActionLoweringRequest"
)({
  loaded: LoadedToolDefinition,
  action: Schema.String,
  /**
   * Deliberately opaque here: a definition's JSON Schema was decoded
   * elsewhere and this component does not interpret it a second time.
   * Template resolution reads only explicit own data properties.
   */
  input: Schema.Unknown,
  executable: Schema.String,
  cellProfile: CellProfile
}) {}

/** The canonical native call is still inert; admission must bind every need. */
export class ToolActionLoweringResult extends Schema.Class<ToolActionLoweringResult>(
  "ToolActionLoweringResult"
)({
  definitionId: ToolDefinitionId,
  definitionVersion: Schema.String,
  definitionDigest: Digest,
  actionName: Schema.String,
  resultDecoder: ToolResultDecoder,
  call: ProcessRunAction,
  lowering: NativeActionLowering
}) {}

export class UnknownToolAction extends Schema.TaggedError<UnknownToolAction>()(
  "UnknownToolAction",
  {
    definitionId: Schema.String,
    action: Schema.String
  }
) {}

export class UnsupportedToolActionLowering extends Schema.TaggedError<UnsupportedToolActionLowering>()(
  "UnsupportedToolActionLowering",
  {
    definitionId: Schema.String,
    action: Schema.String,
    lowering: ToolLoweringKind
  }
) {}

export const ToolExecutableRejectionReason = Schema.Literal(
  "must-be-absolute",
  "contains-nul",
  "not-declared",
  "ambiguous-realm"
)
export type ToolExecutableRejectionReason = typeof ToolExecutableRejectionReason.Type

export class ToolExecutableRejected extends Schema.TaggedError<ToolExecutableRejected>()(
  "ToolExecutableRejected",
  {
    definitionId: Schema.String,
    action: Schema.String,
    executable: Schema.String,
    reason: ToolExecutableRejectionReason
  }
) {}

export const ToolTemplateRejectionReason = Schema.Literal(
  "missing",
  "accessor-not-data",
  "non-scalar",
  "runtime-binding-required"
)
export type ToolTemplateRejectionReason = typeof ToolTemplateRejectionReason.Type

export class ToolTemplateRejected extends Schema.TaggedError<ToolTemplateRejected>()(
  "ToolTemplateRejected",
  {
    definitionId: Schema.String,
    action: Schema.String,
    field: Schema.String,
    path: Schema.Array(Schema.String),
    template: Schema.Literal("Input", "Artifact", "Secret"),
    reason: ToolTemplateRejectionReason,
    actual: Schema.optional(Schema.String)
  }
) {}

export class ToolDefinitionDigestFailed extends Schema.TaggedError<ToolDefinitionDigestFailed>()(
  "ToolDefinitionDigestFailed",
  {
    definitionId: Schema.String,
    reason: Schema.String
  }
) {}

export class ToolNativeLoweringRejected extends Schema.TaggedError<ToolNativeLoweringRejected>()(
  "ToolNativeLoweringRejected",
  {
    definitionId: Schema.String,
    action: Schema.String,
    field: Schema.String,
    reason: Schema.String
  }
) {}

export type ToolActionLoweringError =
  | UnknownToolAction
  | UnsupportedToolActionLowering
  | ToolExecutableRejected
  | ToolTemplateRejected
  | ToolDefinitionDigestFailed
  | ToolNativeLoweringRejected

type JsonScalar = string | number | boolean

const actualKind = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

const scalarAtom = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

interface TemplateContext {
  readonly definitionId: string
  readonly action: string
  readonly input: unknown
}

const rejectedTemplate = (
  context: TemplateContext,
  field: string,
  template: "Input" | "Artifact" | "Secret",
  path: ReadonlyArray<string>,
  reason: ToolTemplateRejectionReason,
  actual?: string
) =>
  new ToolTemplateRejected({
    definitionId: context.definitionId,
    action: context.action,
    field,
    path: [...path],
    template,
    reason,
    ...(actual === undefined ? {} : { actual })
  })

/**
 * Resolve a field path without invoking accessors. Definition documents enter
 * through JSON, but action inputs are supplied by an integration seam; this
 * check prevents a surprising getter from becoming an execution callback.
 */
const inputAt = (
  context: TemplateContext,
  field: string,
  path: ReadonlyArray<string>
): Effect.Effect<JsonScalar, ToolTemplateRejected> =>
  Effect.gen(function* () {
    let value: unknown = context.input
    for (const segment of path) {
      if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return yield* rejectedTemplate(
          context,
          field,
          "Input",
          path,
          "missing"
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, segment)
      if (descriptor === undefined) {
        return yield* rejectedTemplate(
          context,
          field,
          "Input",
          path,
          "missing"
        )
      }
      if (!("value" in descriptor)) {
        return yield* rejectedTemplate(
          context,
          field,
          "Input",
          path,
          "accessor-not-data"
        )
      }
      value = descriptor.value
    }

    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      return yield* rejectedTemplate(
        context,
        field,
        "Input",
        path,
        "non-scalar",
        actualKind(value)
      )
    }
    return value
  })

const resolveTemplate = (
  context: TemplateContext,
  field: string,
  template: TemplateValue
): Effect.Effect<string, ToolTemplateRejected> => {
  switch (template._tag) {
    case "Literal":
      return Effect.succeed(template.value)
    case "Input":
      return inputAt(context, field, template.path).pipe(
        Effect.map((value) => scalarAtom(value)!)
      )
    case "Artifact":
    case "Secret":
      return Effect.fail(
        rejectedTemplate(
          context,
          field,
          template._tag,
          template.path,
          "runtime-binding-required"
        )
      )
  }
}

const resolveResource = (
  context: TemplateContext,
  resource: ToolResourceRequirement,
  index: number,
  executableConstraints: ReadonlyArray<ToolExecutableConstraint>
): Effect.Effect<ResourceNeed, ToolTemplateRejected | ToolExecutableRejected> =>
  Effect.gen(function* () {
    const selector = yield* resolveTemplate(
      context,
      `resources[${index}].selector`,
      resource.selector
    )
    if (
      resource.kind === "executable" &&
      !executableConstraints.some(
        (constraint) =>
          constraint.realm === resource.realm && constraint.selector === selector
      )
    ) {
      return yield* new ToolExecutableRejected({
        definitionId: context.definitionId,
        action: context.action,
        executable: selector,
        reason: "not-declared"
      })
    }
    return new ResourceNeed({
      kind: resource.kind,
      realm: resource.realm,
      selector,
      rights: resource.rights
    })
  })

const selectExecutableConstraint = (
  definitionId: string,
  action: string,
  executable: string,
  constraints: ReadonlyArray<ToolExecutableConstraint>
): Effect.Effect<ToolExecutableConstraint, ToolExecutableRejected> =>
  Effect.gen(function* () {
    if (!executable.startsWith("/")) {
      return yield* new ToolExecutableRejected({
        definitionId,
        action,
        executable,
        reason: "must-be-absolute"
      })
    }
    if (executable.includes("\0")) {
      return yield* new ToolExecutableRejected({
        definitionId,
        action,
        executable,
        reason: "contains-nul"
      })
    }
    const matches = constraints.filter((candidate) => candidate.selector === executable)
    if (matches.length === 0) {
      return yield* new ToolExecutableRejected({
        definitionId,
        action,
        executable,
        reason: "not-declared"
      })
    }
    const realms = [...new Set(matches.map((candidate) => candidate.realm))]
    if (realms.length !== 1) {
      return yield* new ToolExecutableRejected({
        definitionId,
        action,
        executable,
        reason: "ambiguous-realm"
      })
    }
    return matches[0]!
  })

/**
 * Canonical JSON intentionally supports only the inert JSON data accepted by
 * ToolDefinition. It reads data descriptors directly and invokes no callbacks.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  if (typeof value === "object") {
    const fields = Object.keys(value).sort()
    const encoded: string[] = []
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("definition contains a non-data property")
      }
      if (descriptor.value === undefined) continue
      encoded.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`)
    }
    return `{${encoded.join(",")}}`
  }
  throw new TypeError("definition contains a non-JSON value")
}

const digestDefinition = (
  loaded: LoadedToolDefinition
): Effect.Effect<Digest, ToolDefinitionDigestFailed> =>
  Schema.encode(ToolDefinition)(loaded.definition).pipe(
    Effect.mapError(
      () =>
        new ToolDefinitionDigestFailed({
          definitionId: loaded.definition.id,
          reason: "validated definition could not be encoded"
        })
    ),
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () =>
          Digest.make(
            `sha256:${createHash("sha256").update(canonicalJson(encoded)).digest("hex")}`
          ),
        catch: () =>
          new ToolDefinitionDigestFailed({
            definitionId: loaded.definition.id,
            reason: "validated definition is not canonical inert JSON"
          })
      })
    )
  )

const actionNamed = (
  loaded: LoadedToolDefinition,
  action: string
): Effect.Effect<ToolActionDefinition, UnknownToolAction> => {
  const found = loaded.definition.actions.find((candidate) => candidate.name === action)
  return found === undefined
    ? Effect.fail(
        new UnknownToolAction({
          definitionId: loaded.definition.id,
          action
        })
      )
    : Effect.succeed(found)
}

/**
 * Lower one validated, inert definition action into the native process seam.
 *
 * This function performs no schema interpretation, executable discovery,
 * admission, I/O, process creation, or network access. The selected executable
 * must be supplied explicitly and must exactly match a declared constraint.
 */
export const lowerToolAction = (
  request: ToolActionLoweringRequest
): Effect.Effect<ToolActionLoweringResult, ToolActionLoweringError> =>
  Effect.gen(function* () {
    const definition = request.loaded.definition
    const action = yield* actionNamed(request.loaded, request.action)
    if (action.lowering !== "invoke") {
      return yield* new UnsupportedToolActionLowering({
        definitionId: definition.id,
        action: action.name,
        lowering: action.lowering
      })
    }

    const executableConstraint = yield* selectExecutableConstraint(
      definition.id,
      action.name,
      request.executable,
      definition.executables
    )
    const context: TemplateContext = {
      definitionId: definition.id,
      action: action.name,
      input: request.input
    }
    const args = yield* Effect.forEach(
      action.args,
      (template, index) => resolveTemplate(context, `args[${index}]`, template),
      { concurrency: 1 }
    )
    const cwd = yield* resolveTemplate(context, "cwd", action.cwd)
    const envEntries = yield* Effect.forEach(
      Object.entries(action.environment),
      ([key, template]) =>
        resolveTemplate(context, `environment.${key}`, template).pipe(
          Effect.map((value) => [key, value] as const)
        ),
      { concurrency: 1 }
    )
    const resources = yield* Effect.forEach(
      action.resources,
      (resource, index) =>
        resolveResource(context, resource, index, definition.executables),
      { concurrency: 1 }
    )
    const stdin =
      typeof action.stdin === "string"
        ? action.stdin
        : yield* rejectedTemplate(
            context,
            "stdin",
            "Artifact",
            action.stdin.path,
            "runtime-binding-required"
          )

    const call: typeof ProcessRunAction.Type = {
      action: "process.run",
      executable: request.executable,
      args,
      cwd,
      env: Object.fromEntries(envEntries),
      cellProfile: request.cellProfile,
      ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
      stdin,
      stdout: action.stdout,
      stderr: action.stderr,
      outputLimitBytes: action.outputLimitBytes,
      readable: resources.filter((resource) => !resource.rights.includes("write")),
      writable: resources.filter((resource) => resource.rights.includes("write")),
      realm: executableConstraint.realm
    }
    const lowering = yield* lowerNativeAction(call).pipe(
      Effect.mapError(
        (error) =>
          new ToolNativeLoweringRejected({
            definitionId: definition.id,
            action: action.name,
            field: error.field,
            reason: error.reason
          })
      )
    )
    const definitionDigest = yield* digestDefinition(request.loaded)
    return new ToolActionLoweringResult({
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionDigest,
      actionName: action.name,
      resultDecoder: action.resultDecoder,
      call,
      lowering
    })
  })
