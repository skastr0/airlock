import { Effect, Schema } from "effect"
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

export const ToolStdin = Schema.Union(
  Schema.Literal("discard", "inherit"),
  ArtifactTemplate
)
export type ToolStdin = typeof ToolStdin.Type

export class ToolExecutableConstraint extends Schema.Class<ToolExecutableConstraint>(
  "ToolExecutableConstraint"
)({
  realm: Schema.String,
  selector: Schema.String
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

export class ToolDefinition extends Schema.Class<ToolDefinition>("ToolDefinition")({
  schemaVersion: Schema.Literal("airlock/tool-definition/v1"),
  id: ToolDefinitionId,
  version: Schema.String,
  executables: Schema.Array(ToolExecutableConstraint),
  actions: Schema.Array(ToolActionDefinition)
}) {}

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
  definition: ToolDefinition,
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
  action: ToolActionDefinition
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

export type ToolDefinitionError =
  | ToolDefinitionReadFailed
  | ToolDefinitionDecodeFailed
  | InvalidToolDefinition
  | DuplicateToolAction
  | DuplicateToolDefinition
  | ToolSchemaRejected
  | ToolActionNameCollision

/** A reader is an integration seam. Implementations may use any storage. */
export interface ToolDefinitionReader {
  readonly read: (
    location: ToolDefinitionLocation
  ) => Effect.Effect<ReadonlyArray<ToolDefinitionDocument>, ToolDefinitionReadFailed>
}

const duplicates = (values: ReadonlyArray<string>) =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort()

const nonBlank = (definition: ToolDefinition, field: string, value: string) =>
  value.trim().length === 0
    ? Effect.fail(new InvalidToolDefinition({ id: definition.id, field, reason: "must not be blank" }))
    : Effect.void

const languageIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/

const namespaceAtom = (definition: ToolDefinition, field: string, value: string) =>
  languageIdentifier.test(value)
    ? Effect.void
    : Effect.fail(new InvalidToolDefinition({
      id: definition.id,
      field,
      reason: "must be an Airlock identifier so <definition id>.<action> is callable"
    }))

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

const schemaFailure = (definition: ToolDefinition, action: ToolActionDefinition, which: "input" | "output", path: string, reason: string) =>
  new ToolSchemaRejected({ id: definition.id, action: action.name, schema: which, path, reason })

const parseToolSchema = (
  definition: ToolDefinition,
  action: ToolActionDefinition,
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
      if ((required ?? []).some((key) => !(key in properties))) {
        return yield* schemaFailure(definition, action, which, `${path}.required`, "may name only declared properties")
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
  parseToolSchema(
    new ToolDefinition({ schemaVersion: "airlock/tool-definition/v1", id: ToolDefinitionId.make(id), version: "runtime", executables: [], actions: [] }),
    new ToolActionDefinition({ name: actionName, inputSchema: schema, args: [], cwd: new LiteralTemplate({ value: "/" }), lowering: "invoke", effectFootprint: ["invoke"], resultDecoder: "none" }),
    "input", schema
  ).pipe(
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
  definition: ToolDefinition,
  action: ToolActionDefinition,
  schema: unknown,
  value: unknown
) => validateToolSchemaValue(definition.id, action.name, schema, value)

/**
 * Validates the small amount of semantics that definitions are allowed to own.
 * It intentionally cannot validate an executable's behavior or grant power.
 */
export const validateToolDefinition = (
  definition: ToolDefinition
): Effect.Effect<ToolDefinition, InvalidToolDefinition | DuplicateToolAction> =>
  Effect.gen(function* () {
    yield* nonBlank(definition, "id", definition.id)
    yield* namespaceAtom(definition, "id", definition.id)
    yield* nonBlank(definition, "version", definition.version)
    if (definition.executables.length === 0) {
      return yield* new InvalidToolDefinition({
        id: definition.id,
        field: "executables",
        reason: "must declare at least one compatible executable selector"
      })
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
      yield* namespaceAtom(definition, `actions.${action.name}.name`, action.name)
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
      if (action.lowering === "enqueue" && !action.effectFootprint.includes("enqueue")) {
        return yield* new InvalidToolDefinition({
          id: definition.id,
          field: `actions.${action.name}.effectFootprint`,
          reason: "enqueue lowering must declare the enqueue effect"
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

export const decodeToolDefinition = (
  document: ToolDefinitionDocument
): Effect.Effect<LoadedToolDefinition, ToolDefinitionDecodeFailed | InvalidToolDefinition | DuplicateToolAction> =>
  Schema.decodeUnknown(Schema.parseJson(ToolDefinition))(document.json).pipe(
    Effect.mapError(
      (error) => new ToolDefinitionDecodeFailed({ file: document.file, message: error.message })
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
      return yield* new DuplicateToolDefinition({ id: duplicate, version: "" })
    }
    return new ToolDefinitionRegistry({ definitions: loaded })
  })

export const exportedToolActionName = (definition: ToolDefinition, action: ToolActionDefinition) =>
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
