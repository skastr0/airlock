import { Effect, Either, Schema } from "effect"
import { refuseGrantAssertion } from "../admission/DispatchPolicy.ts"
import { HandleKind, Right } from "../plan/index.ts"

/**
 * Tool definitions are data, not plugins. This module owns decoding,
 * validation, and discovery order only; filesystem reads and all execution
 * remain behind caller-supplied seams.
 */

export const ToolDefinitionId = Schema.String.pipe(Schema.brand("ToolDefinitionId"))
export type ToolDefinitionId = typeof ToolDefinitionId.Type

export const ToolDefinitionLocationKind = Schema.Literal(
  "builtin",
  "installed",
  "user",
  "project"
)
export type ToolDefinitionLocationKind = typeof ToolDefinitionLocationKind.Type

export class ToolDefinitionLocation extends Schema.Class<ToolDefinitionLocation>(
  "ToolDefinitionLocation"
)({
  kind: ToolDefinitionLocationKind,
  directory: Schema.String
}) {}

/** Explicit directories keep path policy outside this pristine component. */
export class ToolDefinitionDirectories extends Schema.Class<ToolDefinitionDirectories>(
  "ToolDefinitionDirectories"
)({
  builtin: Schema.String,
  installed: Schema.String,
  user: Schema.String,
  project: Schema.String
}) {}

export const knownToolDefinitionLocations = (
  directories: ToolDefinitionDirectories
): ReadonlyArray<ToolDefinitionLocation> => [
  new ToolDefinitionLocation({ kind: "builtin", directory: directories.builtin }),
  new ToolDefinitionLocation({ kind: "installed", directory: directories.installed }),
  new ToolDefinitionLocation({ kind: "user", directory: directories.user }),
  new ToolDefinitionLocation({ kind: "project", directory: directories.project })
]

export class LiteralTemplate extends Schema.TaggedClass<LiteralTemplate>()("Literal", {
  value: Schema.String
}) {}

export class InputTemplate extends Schema.TaggedClass<InputTemplate>()("Input", {
  /** A field path in the already Schema-validated action input; never code. */
  path: Schema.Array(Schema.String)
}) {}

export class ArtifactTemplate extends Schema.TaggedClass<ArtifactTemplate>()("Artifact", {
  /** A named artifact field in the action input. */
  path: Schema.Array(Schema.String)
}) {}

export class SecretTemplate extends Schema.TaggedClass<SecretTemplate>()("Secret", {
  /** A named secret reference, resolved only during admission. */
  path: Schema.Array(Schema.String)
}) {}

export const TemplateValue = Schema.Union(
  LiteralTemplate,
  InputTemplate,
  ArtifactTemplate,
  SecretTemplate
)
export type TemplateValue = typeof TemplateValue.Type

export class ToolResourceRequirement extends Schema.Class<ToolResourceRequirement>(
  "ToolResourceRequirement"
)({
  kind: HandleKind,
  realm: Schema.String,
  selector: TemplateValue,
  rights: Schema.Array(Right)
}) {}

export const ToolLoweringKind = Schema.Literal("invoke", "enqueue")
export type ToolLoweringKind = typeof ToolLoweringKind.Type

export const ToolEffect = Schema.Literal("capture", "invoke", "apply", "enqueue")
export type ToolEffect = typeof ToolEffect.Type

const ToolRequestMethod = Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE")

/**
 * The inert mapping from a Schema-validated action input onto the fields of a
 * `RequestExternalNode`. It carries templates, never resolved values: a
 * `Secret` template names a credential reference and is legal only in a
 * position whose bytes are carried into the owner-only private dispatch
 * document (headers and body), never in the agent-visible endpoint.
 */
export class ToolRequestTemplate extends Schema.Class<ToolRequestTemplate>(
  "ToolRequestTemplate"
)({
  method: ToolRequestMethod,
  endpoint: TemplateValue,
  headers: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: TemplateValue }),
    { default: () => ({}) }
  ),
  body: Schema.optional(TemplateValue),
  holdMillis: Schema.optionalWith(Schema.Number, { default: () => 30_000 })
}) {}

/** Deliberately finite: result parsing cannot smuggle a callback into loading. */
export const ToolResultDecoder = Schema.Literal(
  "exit-status",
  "json-stdout",
  "json-stderr",
  "none"
)
export type ToolResultDecoder = typeof ToolResultDecoder.Type

export const ToolStreamPolicy = Schema.Literal("capture", "inherit", "discard")
export type ToolStreamPolicy = typeof ToolStreamPolicy.Type

export const ToolExecutableRole = Schema.Literal("root", "descendant")
export type ToolExecutableRole = typeof ToolExecutableRole.Type

export const ToolStdin = Schema.Union(
  Schema.Literal("discard", "inherit"),
  ArtifactTemplate
)
export type ToolStdin = typeof ToolStdin.Type

export class ToolExecutableConstraint extends Schema.Class<ToolExecutableConstraint>(
  "ToolExecutableConstraint"
)({
  realm: Schema.String,
  selector: Schema.String,
  role: Schema.optionalWith(ToolExecutableRole, {
    default: () => "root" as const
  })
}) {}

export class ToolActionDefinition extends Schema.Class<ToolActionDefinition>(
  "ToolActionDefinition"
)({
  name: Schema.String,
  /** JSON-schema-shaped data. The loader accepts JSON text only, never code. */
  inputSchema: Schema.Unknown,
  outputSchema: Schema.optional(Schema.Unknown),
  /** Argument templates exclude the separately-admitted executable. */
  args: Schema.Array(TemplateValue),
  /** Resolves to an explicit working directory; no ambient cwd is implied. */
  cwd: TemplateValue,
  environment: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: TemplateValue }),
    { default: () => ({}) }
  ),
  stdin: Schema.optionalWith(ToolStdin, { default: () => "discard" as const }),
  stdout: Schema.optionalWith(ToolStreamPolicy, { default: () => "capture" as const }),
  stderr: Schema.optionalWith(ToolStreamPolicy, { default: () => "capture" as const }),
  timeoutMs: Schema.optional(Schema.Number),
  outputLimitBytes: Schema.optionalWith(Schema.Number, { default: () => 1_048_576 }),
  resources: Schema.optionalWith(Schema.Array(ToolResourceRequirement), {
    default: () => []
  }),
  lowering: ToolLoweringKind,
  effectFootprint: Schema.Array(ToolEffect),
  resultDecoder: ToolResultDecoder
}) {}

/**
 * An `enqueue` action is structurally disjoint from an invoke action: it has
 * no executable, argv, cwd, environment, or stream policy, and its only
 * lowering is the `http.stage` seam whose Plan node is `RequestExternal`.
 * `request` and `emissionEffect` stay optional in the schema so a missing one
 * is a precise `ToolEnqueueContractRejected` rather than a union decode error.
 */
export class ToolEnqueueActionDefinition extends Schema.Class<ToolEnqueueActionDefinition>(
  "ToolEnqueueActionDefinition"
)({
  name: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.optional(Schema.Unknown),
  lowering: Schema.Literal("enqueue"),
  request: Schema.optional(ToolRequestTemplate),
  /**
   * A description of what the author believes the endpoint does. It is
   * deliberately a strict subset of the supervisor's grant vocabulary: the
   * floor has no spelling here at all, because omitting the field *is* the
   * floor. A definition can therefore only ever narrow the effective
   * consequence at the supervisor's auto-commit decision, never widen it, and
   * no definition field may name a grant property (see the assertion scan).
   */
  emissionEffect: Schema.optional(Schema.Literal("read", "mutate")),
  effectFootprint: Schema.Array(ToolEffect),
  resultDecoder: ToolResultDecoder
}) {}

export const ToolV2ActionDefinition = Schema.Union(
  ToolEnqueueActionDefinition,
  ToolActionDefinition
)
export type ToolV2ActionDefinition = typeof ToolV2ActionDefinition.Type

export class ToolDefinition extends Schema.Class<ToolDefinition>("ToolDefinition")({
  schemaVersion: Schema.Literal("airlock/tool-definition/v1"),
  id: ToolDefinitionId,
  version: Schema.String,
  executables: Schema.Array(ToolExecutableConstraint),
  actions: Schema.Array(ToolActionDefinition)
}) {}

/**
 * v2 supersedes v1 by version literal, not by alias: v1 documents keep
 * decoding through the unchanged v1 schema and the unchanged invoke-only
 * gate. v2 adds exactly one thing — the `enqueue` lowering the v1 schema
 * already reserved — and may therefore declare no executable at all when it
 * exports no invoke action.
 */
export class ToolDefinitionV2 extends Schema.Class<ToolDefinitionV2>("ToolDefinitionV2")({
  schemaVersion: Schema.Literal("airlock/tool-definition/v2"),
  id: ToolDefinitionId,
  version: Schema.String,
  executables: Schema.Array(ToolExecutableConstraint),
  actions: Schema.Array(ToolV2ActionDefinition)
}) {}

export const AnyToolDefinition = Schema.Union(ToolDefinition, ToolDefinitionV2)
export type AnyToolDefinition = typeof AnyToolDefinition.Type

export const isEnqueueAction = (
  action: ToolActionDefinition | ToolEnqueueActionDefinition
): action is ToolEnqueueActionDefinition => action instanceof ToolEnqueueActionDefinition

/** Text is intentionally the boundary: JSON parsing, not code loading. */
export class ToolDefinitionDocument extends Schema.Class<ToolDefinitionDocument>(
  "ToolDefinitionDocument"
)({
  location: ToolDefinitionLocation,
  file: Schema.String,
  json: Schema.String
}) {}

export class LoadedToolDefinition extends Schema.Class<LoadedToolDefinition>(
  "LoadedToolDefinition"
)({
  definition: AnyToolDefinition,
  location: ToolDefinitionLocation,
  file: Schema.String
}) {}

export class ToolDefinitionRegistry extends Schema.Class<ToolDefinitionRegistry>(
  "ToolDefinitionRegistry"
)({
  definitions: Schema.Array(LoadedToolDefinition)
}) {}

/** A resolved name is still data: it carries no executor, Layer, or authority. */
export class ExportedToolAction extends Schema.Class<ExportedToolAction>("ExportedToolAction")({
  name: Schema.String,
  loaded: LoadedToolDefinition,
  action: ToolV2ActionDefinition
}) {}

export class ToolActionNameCollision extends Schema.TaggedError<ToolActionNameCollision>()(
  "ToolActionNameCollision",
  { name: Schema.String, reason: Schema.Literal("duplicate-export", "native-shadow") }
) {}

export class ToolDefinitionReadFailed extends Schema.TaggedError<ToolDefinitionReadFailed>()(
  "ToolDefinitionReadFailed",
  { location: ToolDefinitionLocation, reason: Schema.String }
) {}

export class ToolDefinitionDecodeFailed extends Schema.TaggedError<ToolDefinitionDecodeFailed>()(
  "ToolDefinitionDecodeFailed",
  { file: Schema.String, message: Schema.String }
) {}

export class InvalidToolDefinition extends Schema.TaggedError<InvalidToolDefinition>()(
  "InvalidToolDefinition",
  { id: Schema.String, field: Schema.String, reason: Schema.String }
) {}

export class DuplicateToolAction extends Schema.TaggedError<DuplicateToolAction>()(
  "DuplicateToolAction",
  { id: Schema.String, action: Schema.String }
) {}

export class DuplicateToolDefinition extends Schema.TaggedError<DuplicateToolDefinition>()(
  "DuplicateToolDefinition",
  { id: Schema.String, version: Schema.String }
) {}

export class ToolSchemaRejected extends Schema.TaggedError<ToolSchemaRejected>()(
  "ToolSchemaRejected",
  { id: Schema.String, action: Schema.String, schema: Schema.Literal("input", "output"), path: Schema.String, reason: Schema.String }
) {}

export class ToolInputRejected extends Schema.TaggedError<ToolInputRejected>()(
  "ToolInputRejected",
  { id: Schema.String, action: Schema.String, path: Schema.String, reason: Schema.String }
) {}

/**
 * Consequence classes are supervisor-grant-side facts. A definition that tries
 * to name or widen one is refused here, before it can reach admission.
 */
export class ToolGrantAssertionRejected
  extends Schema.TaggedError<ToolGrantAssertionRejected>()(
    "ToolGrantAssertionRejected",
    { id: Schema.String, field: Schema.String, reason: Schema.String }
  ) {}

/** A `Secret` template placed where its bytes would become agent-visible. */
export class ToolSecretPlacementRejected
  extends Schema.TaggedError<ToolSecretPlacementRejected>()(
    "ToolSecretPlacementRejected",
    { id: Schema.String, action: Schema.String, field: Schema.String, reason: Schema.String }
  ) {}

/** A request template that cannot map totally onto a `RequestExternalNode`. */
export class ToolEnqueueContractRejected
  extends Schema.TaggedError<ToolEnqueueContractRejected>()(
    "ToolEnqueueContractRejected",
    { id: Schema.String, action: Schema.String, field: Schema.String, reason: Schema.String }
  ) {}

export type ToolDefinitionValidationError =
  | InvalidToolDefinition
  | DuplicateToolAction
  | ToolGrantAssertionRejected
  | ToolSecretPlacementRejected
  | ToolEnqueueContractRejected

export type ToolDefinitionError =
  | ToolDefinitionReadFailed
  | ToolDefinitionDecodeFailed
  | InvalidToolDefinition
  | DuplicateToolAction
  | DuplicateToolDefinition
  | ToolSchemaRejected
  | ToolActionNameCollision
  | ToolGrantAssertionRejected
  | ToolSecretPlacementRejected
  | ToolEnqueueContractRejected

/** A reader is an integration seam. Implementations may use any storage. */
export interface ToolDefinitionReader {
  readonly read: (
    location: ToolDefinitionLocation
  ) => Effect.Effect<ReadonlyArray<ToolDefinitionDocument>, ToolDefinitionReadFailed>
}

const duplicates = (values: ReadonlyArray<string>) =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort()

/** Identity is all these checks need; the shape may be a v1 or v2 document. */
type DefinitionIdentity = { readonly id: string }
type ActionIdentity = { readonly name: string }

const nonBlank = (definition: DefinitionIdentity, field: string, value: string) =>
  value.trim().length === 0
    ? Effect.fail(new InvalidToolDefinition({ id: definition.id, field, reason: "must not be blank" }))
    : Effect.void

const identifierSegment = /^[A-Za-z_][A-Za-z0-9_]*$/

const callableNamespace = (definition: DefinitionIdentity, field: string, value: string) =>
  value.split(".").length > 0 && value.split(".").every((segment) => identifierSegment.test(segment))
    ? Effect.void
    : Effect.fail(new InvalidToolDefinition({
      id: definition.id,
      field,
      reason: "must be dot-separated Airlock identifier segments"
    }))

const validateV1Template = (
  definition: DefinitionIdentity,
  action: ActionIdentity,
  field: string,
  template: TemplateValue
) =>
  template._tag === "Literal" || template._tag === "Input"
    ? Effect.void
    : Effect.fail(
        new InvalidToolDefinition({
          id: definition.id,
          field: `actions.${action.name}.${field}`,
          reason: `${template._tag} templates are reserved until runtime binding is implemented`
        })
      )

/**
 * The definition format accepts a deliberately small JSON-Schema-shaped
 * vocabulary. It is a validation format, never a hook for executable code or
 * an invitation to implement JSON Schema piecemeal.
 */
type JsonSchema =
  | { readonly type: "object"; readonly properties?: Readonly<Record<string, JsonSchema>>; readonly required?: ReadonlyArray<string>; readonly additionalProperties?: boolean }
  | { readonly type: "array"; readonly items: JsonSchema }
  | { readonly type: "string" | "number" | "integer" | "boolean" | "null"; readonly enum?: ReadonlyArray<string | number | boolean | null>; readonly const?: string | number | boolean | null }

const scalar = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"

const schemaFailure = (definition: DefinitionIdentity, action: ActionIdentity, which: "input" | "output", path: string, reason: string) =>
  new ToolSchemaRejected({ id: definition.id, action: action.name, schema: which, path, reason })

const parseToolSchema = (
  definition: DefinitionIdentity,
  action: ActionIdentity,
  which: "input" | "output",
  source: unknown,
  path = "$"
): Effect.Effect<JsonSchema, ToolSchemaRejected> =>
  Effect.gen(function* () {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      return yield* schemaFailure(definition, action, which, path, "must be an object with one supported type")
    }
    const record = source as Record<string, unknown>
    const type = record.type
    if (typeof type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type)) {
      return yield* schemaFailure(definition, action, which, `${path}.type`, "must be one of object, array, string, number, integer, boolean, null")
    }
    const parsedType = type as JsonSchema["type"]
    const permitted = parsedType === "object"
      ? new Set(["type", "properties", "required", "additionalProperties"])
      : type === "array"
        ? new Set(["type", "items"])
        : new Set(["type", "enum", "const"])
    for (const key of Object.keys(record)) {
      if (!permitted.has(key)) return yield* schemaFailure(definition, action, which, `${path}.${key}`, "unsupported JSON Schema feature")
    }
    if (parsedType === "object") {
      const rawProperties = record.properties
      if (rawProperties !== undefined && (typeof rawProperties !== "object" || rawProperties === null || Array.isArray(rawProperties))) {
        return yield* schemaFailure(definition, action, which, `${path}.properties`, "must be an object")
      }
      const properties: Record<string, JsonSchema> = {}
      for (const [key, value] of Object.entries(rawProperties ?? {})) {
        properties[key] = yield* parseToolSchema(definition, action, which, value, `${path}.properties.${key}`)
      }
      const required = record.required
      if (required !== undefined && (!Array.isArray(required) || !required.every((item) => typeof item === "string"))) {
        return yield* schemaFailure(definition, action, which, `${path}.required`, "must be an array of property names")
      }
      if (record.additionalProperties !== undefined && typeof record.additionalProperties !== "boolean") {
        return yield* schemaFailure(definition, action, which, `${path}.additionalProperties`, "must be a boolean")
      }
      return { type: parsedType, ...(Object.keys(properties).length === 0 ? {} : { properties }), ...(required === undefined ? {} : { required: [...required] }), ...(record.additionalProperties === undefined ? {} : { additionalProperties: record.additionalProperties }) }
    }
    if (parsedType === "array") {
      if (record.items === undefined) return yield* schemaFailure(definition, action, which, `${path}.items`, "is required")
      return { type: parsedType, items: yield* parseToolSchema(definition, action, which, record.items, `${path}.items`) }
    }
    if (record.enum !== undefined && (!Array.isArray(record.enum) || !record.enum.every(scalar))) {
      return yield* schemaFailure(definition, action, which, `${path}.enum`, "must contain only JSON scalar values")
    }
    if (record.const !== undefined && !scalar(record.const)) {
      return yield* schemaFailure(definition, action, which, `${path}.const`, "must be a JSON scalar value")
    }
    return { type: parsedType as "string" | "number" | "integer" | "boolean" | "null", ...(record.enum === undefined ? {} : { enum: record.enum as ReadonlyArray<string | number | boolean | null> }), ...(record.const === undefined ? {} : { const: record.const as string | number | boolean | null }) }
  })

const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const typeMatches = (value: unknown, type: JsonSchema["type"]): boolean =>
  type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
      : type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
        : type === "integer" ? typeof value === "number" && Number.isInteger(value)
          : typeof value === type

export const validateToolSchemaValue = (
  id: string,
  actionName: string,
  schema: unknown,
  value: unknown
): Effect.Effect<void, ToolInputRejected> =>
  // Runtime inputs are already accepted only from a definition that passed
  // validation. Rechecking protects the execution boundary against a forged
  // request without turning schemas into executable behavior.
  parseToolSchema({ id }, { name: actionName }, "input", schema).pipe(
    Effect.mapError((error) => new ToolInputRejected({ id, action: actionName, path: error.path, reason: error.reason })),
    Effect.flatMap(function validate(parsed): Effect.Effect<void, ToolInputRejected> {
      const reject = (path: string, reason: string) => Effect.fail(new ToolInputRejected({ id, action: actionName, path, reason }))
      const loop = (current: JsonSchema, candidate: unknown, path: string): Effect.Effect<void, ToolInputRejected> => {
        if (!typeMatches(candidate, current.type)) return reject(path, `expected ${current.type}`)
        if ("const" in current && current.const !== undefined && !jsonEqual(candidate, current.const)) return reject(path, "must equal const")
        if ("enum" in current && current.enum !== undefined && !current.enum.some((item) => jsonEqual(item, candidate))) return reject(path, "must be one of enum")
        if (current.type === "array") return Effect.forEach(candidate as ReadonlyArray<unknown>, (item, index) => loop(current.items, item, `${path}[${index}]`), { discard: true })
        if (current.type === "object") {
          const object = candidate as Record<string, unknown>
          for (const required of current.required ?? []) if (!(required in object)) return reject(`${path}.${required}`, "is required")
          const properties = current.properties ?? {}
          return Effect.forEach(Object.entries(object), ([key, item]) => {
            const child = properties[key]
            if (child === undefined) {
              return current.additionalProperties === false
                ? reject(`${path}.${key}`, "additional property is not allowed")
                : Effect.void
            }
            return loop(child, item, `${path}.${key}`)
          }, { discard: true })
        }
        return Effect.void
      }
      return loop(parsed, value, "$")
    })
  )

export const validateToolValue = (
  definition: DefinitionIdentity,
  action: ActionIdentity,
  schema: unknown,
  value: unknown
) => validateToolSchemaValue(definition.id, action.name, schema, value)

/**
 * `Secret` templates are legal only where the resolved bytes are carried into
 * the owner-only private dispatch document — headers and body. Anywhere the
 * value stays agent-visible (notably the endpoint, which admission matches as
 * a selector) the placement is refused outright.
 */
const validateRequestTemplate = (
  definition: DefinitionIdentity,
  action: ActionIdentity,
  field: string,
  template: TemplateValue,
  secretCarrier: boolean
): Effect.Effect<void, InvalidToolDefinition | ToolSecretPlacementRejected> => {
  if (template._tag === "Artifact") {
    return Effect.fail(
      new InvalidToolDefinition({
        id: definition.id,
        field: `actions.${action.name}.${field}`,
        reason: "Artifact templates are reserved until runtime binding is implemented"
      })
    )
  }
  if (template._tag === "Secret" && !secretCarrier) {
    return Effect.fail(
      new ToolSecretPlacementRejected({
        id: definition.id,
        action: action.name,
        field: `actions.${action.name}.${field}`,
        reason: "Secret templates are legal only in a position carried into the private dispatch document"
      })
    )
  }
  return Effect.void
}

/** RFC 7230 field-name token: no control characters, whitespace, or colon. */
const headerToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * One predicate for both ends of the seam: a `Literal` endpoint is checked at
 * definition load, and the same check runs again in lowering once an `Input`
 * template has resolved. Admission matches this string as a selector, so a
 * relative, non-http, or userinfo-bearing URL never reaches a Plan node.
 */
export const endpointRejection = (value: string): string | undefined => {
  const parsed = (() => {
    try {
      return new URL(value)
    } catch {
      return undefined
    }
  })()
  if (parsed === undefined) return "must be an absolute URL"
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "must use the http or https scheme"
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "must not carry userinfo"
  }
  return undefined
}

/**
 * An `enqueue` action must map totally onto `RequestExternalNode` or be
 * refused. It declares a consequence (`emissionEffect`) that can only narrow
 * the supervisor's class at the auto-commit decision; it never selects one.
 */
const validateEnqueueAction = (
  definition: DefinitionIdentity,
  action: ToolEnqueueActionDefinition
): Effect.Effect<
  void,
  InvalidToolDefinition | ToolEnqueueContractRejected | ToolSecretPlacementRejected
> =>
  Effect.gen(function* () {
    const reject = (field: string, reason: string) =>
      new ToolEnqueueContractRejected({
        id: definition.id,
        action: action.name,
        field: `actions.${action.name}.${field}`,
        reason
      })
    yield* parseToolSchema(definition, action, "input", action.inputSchema).pipe(
      Effect.asVoid,
      Effect.mapError((error) => new InvalidToolDefinition({ id: definition.id, field: `actions.${action.name}.inputSchema${error.path.slice(1)}`, reason: error.reason }))
    )
    if (action.outputSchema !== undefined) {
      yield* parseToolSchema(definition, action, "output", action.outputSchema).pipe(
        Effect.asVoid,
        Effect.mapError((error) => new InvalidToolDefinition({ id: definition.id, field: `actions.${action.name}.outputSchema${error.path.slice(1)}`, reason: error.reason }))
      )
    }
    if (action.request === undefined) {
      return yield* reject("request", "enqueue lowering requires a request template")
    }
    if (action.emissionEffect === undefined) {
      return yield* reject(
        "emissionEffect",
        "enqueue lowering must declare an emission effect class"
      )
    }
    if (!action.effectFootprint.includes("enqueue")) {
      return yield* reject(
        "effectFootprint",
        "enqueue lowering must declare the enqueue effect"
      )
    }
    const foreign = action.effectFootprint.filter((effect) => effect !== "enqueue")[0]
    if (foreign !== undefined) {
      return yield* reject(
        "effectFootprint",
        `enqueue lowering stages an intent and declares no ${foreign} effect`
      )
    }
    if (action.resultDecoder !== "none") {
      return yield* reject(
        "resultDecoder",
        "a staged intent produces no local result to decode; use none"
      )
    }
    const request = action.request
    yield* validateRequestTemplate(definition, action, "request.endpoint", request.endpoint, false)
    if (request.endpoint._tag === "Literal") {
      const endpointReason = endpointRejection(request.endpoint.value)
      if (endpointReason !== undefined) {
        return yield* reject("request.endpoint", endpointReason)
      }
    }
    for (const [key, template] of Object.entries(request.headers)) {
      if (!headerToken.test(key)) {
        return yield* reject("request.headers", `header name ${JSON.stringify(key)} is not a token`)
      }
      yield* validateRequestTemplate(definition, action, `request.headers.${key}`, template, true)
    }
    if (request.body !== undefined) {
      yield* validateRequestTemplate(definition, action, "request.body", request.body, true)
    }
    if (!Number.isSafeInteger(request.holdMillis) || request.holdMillis < 0) {
      return yield* reject("request.holdMillis", "must be a non-negative safe integer")
    }
  })

/**
 * Validates the small amount of semantics that definitions are allowed to own.
 * It intentionally cannot validate an executable's behavior or grant power.
 */
export const validateToolDefinition = (
  definition: AnyToolDefinition
): Effect.Effect<AnyToolDefinition, ToolDefinitionValidationError> =>
  Effect.gen(function* () {
    yield* nonBlank(definition, "id", definition.id)
    yield* callableNamespace(definition, "id", definition.id)
    yield* nonBlank(definition, "version", definition.version)
    // Only an invoke action needs an executable. A v2 document that exports
    // enqueue actions alone binds no executable authority at all.
    const requiresExecutable =
      definition.schemaVersion === "airlock/tool-definition/v1" ||
      definition.actions.some((action) => !isEnqueueAction(action))
    if (definition.executables.length === 0 && requiresExecutable) {
      return yield* new InvalidToolDefinition({
        id: definition.id,
        field: "executables",
        reason: "must declare at least one compatible executable selector"
      })
    }
    const roots = definition.executables.filter(
      (executable) => executable.role === "root"
    )
    if (definition.executables.length > 0 && roots.length !== 1) {
      return yield* new InvalidToolDefinition({
        id: definition.id,
        field: "executables",
        reason: "must declare exactly one root executable selector"
      })
    }
    const duplicateExecutable = duplicates(
      definition.executables.map((executable) => executable.selector)
    )[0]
    if (duplicateExecutable !== undefined) {
      return yield* new InvalidToolDefinition({
        id: definition.id,
        field: "executables",
        reason: `selector ${duplicateExecutable} must have exactly one role`
      })
    }
    for (const executable of definition.executables) {
      if (
        !executable.selector.startsWith("/") ||
        executable.selector.includes("\0")
      ) {
        return yield* new InvalidToolDefinition({
          id: definition.id,
          field: "executables[].selector",
          reason: "must be an absolute executable path without NUL"
        })
      }
      if (
        executable.role === "descendant" &&
        executable.realm !== roots[0]!.realm
      ) {
        return yield* new InvalidToolDefinition({
          id: definition.id,
          field: "executables[].realm",
          reason: "descendants must execute in the root executable realm"
        })
      }
    }
    if (definition.actions.length === 0) {
      return yield* new InvalidToolDefinition({
        id: definition.id,
        field: "actions",
        reason: "must declare at least one action"
      })
    }
    const duplicate = duplicates(definition.actions.map((action) => action.name))[0]
    if (duplicate !== undefined) {
      return yield* new DuplicateToolAction({ id: definition.id, action: duplicate })
    }
    for (const action of definition.actions) {
      yield* nonBlank(definition, "actions[].name", action.name)
      yield* callableNamespace(definition, `actions.${action.name}.name`, action.name)
      // The invoke-only gate is version-scoped, not removed: v1 documents keep
      // refusing every lowering the v1 schema reserved but never implemented.
      if (
        definition.schemaVersion === "airlock/tool-definition/v1" &&
        action.lowering !== "invoke"
      ) {
        return yield* new InvalidToolDefinition({
          id: definition.id,
          field: `actions.${action.name}.lowering`,
          reason: "v1 definitions support only invoke lowering"
        })
      }
      if (isEnqueueAction(action)) {
        yield* validateEnqueueAction(definition, action)
        continue
      }
      yield* Effect.forEach(
        action.args,
        (template, index) =>
          validateV1Template(definition, action, `args[${index}]`, template),
        { discard: true }
      )
      yield* validateV1Template(definition, action, "cwd", action.cwd)
      yield* Effect.forEach(
        Object.entries(action.environment),
        ([key, template]) =>
          validateV1Template(definition, action, `environment.${key}`, template),
        { discard: true }
      )
      if (typeof action.stdin !== "string") {
        return yield* new InvalidToolDefinition({
          id: definition.id,
          field: `actions.${action.name}.stdin`,
          reason: "Artifact stdin is reserved until runtime binding is implemented"
        })
      }
      yield* Effect.forEach(
        action.resources,
        (resource, index) =>
          validateV1Template(
            definition,
            action,
            `resources[${index}].selector`,
            resource.selector
          ),
        { discard: true }
      )
      yield* parseToolSchema(definition, action, "input", action.inputSchema).pipe(
        Effect.asVoid,
        Effect.mapError((error) => new InvalidToolDefinition({ id: definition.id, field: `actions.${action.name}.inputSchema${error.path.slice(1)}`, reason: error.reason }))
      )
      if (action.outputSchema !== undefined) {
        yield* parseToolSchema(definition, action, "output", action.outputSchema).pipe(
          Effect.asVoid,
          Effect.mapError((error) => new InvalidToolDefinition({ id: definition.id, field: `actions.${action.name}.outputSchema${error.path.slice(1)}`, reason: error.reason }))
        )
      }
      if (action.lowering === "invoke") {
        if (!action.effectFootprint.includes("invoke")) {
          return yield* new InvalidToolDefinition({
            id: definition.id,
            field: `actions.${action.name}.effectFootprint`,
            reason: "invoke lowering must declare the invoke effect"
          })
        }
      }
      if (
        !Number.isSafeInteger(action.outputLimitBytes) ||
        action.outputLimitBytes < 0
      ) {
        return yield* new InvalidToolDefinition({
          id: definition.id,
          field: `actions.${action.name}.outputLimitBytes`,
          reason: "must be a non-negative safe integer"
        })
      }
      if (
        action.timeoutMs !== undefined &&
        (!Number.isSafeInteger(action.timeoutMs) || action.timeoutMs <= 0)
      ) {
        return yield* new InvalidToolDefinition({
          id: definition.id,
          field: `actions.${action.name}.timeoutMs`,
          reason: "must be a positive safe integer when provided"
        })
      }
      for (const resource of action.resources) {
        yield* nonBlank(definition, `actions.${action.name}.resources[].realm`, resource.realm)
        if (resource.rights.length === 0) {
          return yield* new InvalidToolDefinition({
            id: definition.id,
            field: `actions.${action.name}.resources[].rights`,
            reason: "must declare requested rights; definitions never mint them"
          })
        }
      }
    }
    return definition
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Grant-side vocabulary is refused on the raw document, before decoding drops
 * it as an excess property. The scan deliberately skips `inputSchema` and
 * `outputSchema`: those subtrees describe an action's own JSON data, where a
 * property may legitimately be named `class`.
 */
const refuseGrantSideAssertion = (
  source: unknown
): Effect.Effect<void, ToolGrantAssertionRejected> => {
  if (!isRecord(source)) return Effect.void
  const id = typeof source.id === "string" ? source.id : ""
  const scanned = {
    ...source,
    ...(Array.isArray(source.actions)
      ? {
        actions: source.actions.map((action) => {
          if (!isRecord(action)) return action
          const { inputSchema: _input, outputSchema: _output, ...rest } = action
          return rest
        })
      }
      : {})
  }
  const refusal = refuseGrantAssertion(scanned, "definition")
  return Either.isLeft(refusal)
    ? Effect.fail(
      new ToolGrantAssertionRejected({
        id,
        field: refusal.left.field,
        reason: refusal.left.reason
      })
    )
    : Effect.void
}

/**
 * A definition may declare only a *narrowed* consequence. The supervisor's
 * floor has no spelling on this side at all: omitting `emissionEffect` accepts
 * it. Refusing the wider word here, on the raw document, turns a confusing
 * union decode error into the ratchet stated in one sentence.
 */
const narrowableEmissionEffects = ["read", "mutate"]

const refuseWidenedEmissionEffect = (
  source: unknown
): Effect.Effect<void, ToolEnqueueContractRejected> => {
  if (!isRecord(source) || !Array.isArray(source.actions)) return Effect.void
  const id = typeof source.id === "string" ? source.id : ""
  for (const action of source.actions) {
    if (!isRecord(action)) continue
    const declared = action.emissionEffect
    if (declared === undefined) continue
    if (typeof declared !== "string" || !narrowableEmissionEffects.includes(declared)) {
      const name = typeof action.name === "string" ? action.name : ""
      return Effect.fail(
        new ToolEnqueueContractRejected({
          id,
          action: name,
          field: `actions.${name}.emissionEffect`,
          reason: `a definition may declare only ${narrowableEmissionEffects.join(" or ")}; omit the field to accept the supervisor's floor`
        })
      )
    }
  }
  return Effect.void
}

/** v2 action vocabulary carried by a v1 document is inert and misleading. */
const v2OnlyActionFields = ["request", "emissionEffect"] as const

const refuseVersionMismatchedFields = (
  source: unknown
): Effect.Effect<void, InvalidToolDefinition> => {
  if (!isRecord(source)) return Effect.void
  if (source.schemaVersion !== "airlock/tool-definition/v1") return Effect.void
  if (!Array.isArray(source.actions)) return Effect.void
  for (const action of source.actions) {
    if (!isRecord(action)) continue
    for (const field of v2OnlyActionFields) {
      if (field in action) {
        return Effect.fail(
          new InvalidToolDefinition({
            id: typeof source.id === "string" ? source.id : "",
            field: `actions.${typeof action.name === "string" ? action.name : ""}.${field}`,
            reason: "requires schemaVersion airlock/tool-definition/v2"
          })
        )
      }
    }
  }
  return Effect.void
}

export const decodeToolDefinition = (
  document: ToolDefinitionDocument
): Effect.Effect<
  LoadedToolDefinition,
  ToolDefinitionDecodeFailed | ToolDefinitionValidationError
> =>
  Effect.try({
    try: () => JSON.parse(document.json) as unknown,
    catch: () =>
      new ToolDefinitionDecodeFailed({ file: document.file, message: "document is not valid JSON" })
  }).pipe(
    Effect.tap(refuseGrantSideAssertion),
    Effect.tap(refuseVersionMismatchedFields),
    Effect.tap(refuseWidenedEmissionEffect),
    Effect.flatMap((parsed) =>
      Schema.decodeUnknown(AnyToolDefinition)(parsed).pipe(
        Effect.mapError(
          (error) => new ToolDefinitionDecodeFailed({ file: document.file, message: error.message })
        )
      )
    ),
    Effect.flatMap(validateToolDefinition),
    Effect.map(
      (definition) =>
        new LoadedToolDefinition({
          definition,
          location: document.location,
          file: document.file
        })
    )
  )

/**
 * Loads documents from the fixed built-in → installed → user → project order.
 * No location is trusted merely because it is known, and duplicate identities
 * fail rather than silently overriding one another.
 */
export const loadKnownToolDefinitions = (
  reader: ToolDefinitionReader,
  directories: ToolDefinitionDirectories
): Effect.Effect<ToolDefinitionRegistry, ToolDefinitionError> =>
  Effect.gen(function* () {
    const documents = yield* Effect.forEach(
      knownToolDefinitionLocations(directories),
      (location) => reader.read(location),
      { concurrency: 1 }
    )
    const loaded = yield* Effect.forEach(documents.flat(), decodeToolDefinition, {
      concurrency: 1
    })
    const keys = loaded.map(({ definition }) => definition.id)
    const duplicate = duplicates(keys)[0]
    if (duplicate !== undefined) {
      const versions = loaded
        .filter(({ definition }) => definition.id === duplicate)
        .map(({ definition }) => definition.version)
        .sort((left, right) => left.localeCompare(right, "en"))
      return yield* new DuplicateToolDefinition({ id: duplicate, version: versions[0] ?? "" })
    }
    return new ToolDefinitionRegistry({ definitions: loaded })
  })

export const exportedToolActionName = (definition: DefinitionIdentity, action: ActionIdentity) =>
  `${definition.id}.${action.name}`

/**
 * Computes the only names a definition can export. Callers pass built-in names
 * so an installed document cannot turn `file.read` into something else.
 */
export const exportToolActions = (
  registry: ToolDefinitionRegistry,
  nativeActionNames: ReadonlySet<string>
): Effect.Effect<ReadonlyArray<ExportedToolAction>, ToolActionNameCollision> =>
  Effect.gen(function* () {
    const exports: ExportedToolAction[] = []
    const names = new Set<string>()
    for (const loaded of registry.definitions) {
      for (const action of loaded.definition.actions) {
        const name = exportedToolActionName(loaded.definition, action)
        if (nativeActionNames.has(name)) {
          return yield* new ToolActionNameCollision({ name, reason: "native-shadow" })
        }
        if (names.has(name)) {
          return yield* new ToolActionNameCollision({ name, reason: "duplicate-export" })
        }
        names.add(name)
        exports.push(new ExportedToolAction({ name, loaded, action }))
      }
    }
    return exports
  })
