import { Result, Schema } from "effect"
import { combine, InformationLabel } from "../labels/Labels.ts"

export const DecoderIdentity = Schema.Struct({ name: Schema.String, version: Schema.String })
export type DecoderIdentity = typeof DecoderIdentity.Type

const DecoderTypeId: unique symbol = Symbol("airlock/TrustedDecoder")
const ValueTypeId: unique symbol = Symbol("airlock/TrackedValue")

/** A pure schema supplied by the trusted side, never by an Airlock program. */
export interface TrustedDecoder<Name extends string = string, Value extends Schema.Json = Schema.Json> {
  readonly [DecoderTypeId]: true
  readonly name: Name
  readonly version: string
  readonly schema: Schema.Codec<Value, Schema.Json>
}

export declare namespace TrustedDecoder {
  export type Any = TrustedDecoder<any, any>
  export type ValueOf<Decoder> = Decoder extends TrustedDecoder<string, infer Value> ? Value : never
}

/** The value and its information label travel together in the interpreter. */
export interface TrackedValue<Value extends Schema.Json = Schema.Json> {
  readonly [ValueTypeId]: true
  readonly value: Value
  readonly label: InformationLabel
}

export class InvalidDecoder extends Schema.TaggedError<InvalidDecoder>()("InvalidDecoder", {
  name: Schema.String,
  reason: Schema.String
}) {}

/** Deliberately carries no rejected value or schema error text. */
export class DecoderRejected extends Schema.TaggedError<DecoderRejected>()("DecoderRejected", {
  decoder: Schema.String,
  reason: Schema.Literals(["untrusted-decoder", "untracked-value", "schema", "non-json-result"])
}) {}

const decoders = new WeakSet<object>()
const proofs = new WeakMap<object, ReadonlySet<TrustedDecoder.Any>>()
const json = Schema.decodeUnknownSync(Schema.Json)

/** Only wrappers issued here are tracked; copying the private symbol is insufficient. */
export const isTrackedValue = (value: unknown): value is TrackedValue =>
  typeof value === "object" && value !== null && proofs.has(value)

const freezeJson = <Value extends Schema.Json>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

const cloneJson = (value: Schema.Json): Schema.Json => {
  if (value === null || typeof value !== "object") return value
  return Array.isArray(value)
    ? value.map(cloneJson)
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]))
}

export const ownJson = <Value extends Schema.Json>(value: Value): Value =>
  // A JSON text round trip would change -0 to +0 and invalidate refinements.
  freezeJson(cloneJson(json(value)) as Value)

const ownLabel = (label: InformationLabel): InformationLabel => {
  const decoded = Schema.decodeUnknownSync(InformationLabel, { onExcessProperty: "error" })(label)
  const owned = new InformationLabel({
    confidentiality: decoded.confidentiality,
    integrity: decoded.integrity,
    provenance: [...decoded.provenance]
  })
  Object.freeze(owned.provenance)
  return Object.freeze(owned)
}

const track = <Value extends Schema.Json>(
  value: Value,
  label: InformationLabel,
  refinements: ReadonlySet<TrustedDecoder.Any>
): TrackedValue<Value> => {
  const tracked: TrackedValue<Value> = Object.freeze({ [ValueTypeId]: true as const, value: ownJson(value), label: ownLabel(label) })
  proofs.set(tracked, refinements)
  return tracked
}

/** Owns both the JSON graph and label; no refinement is conferred. */
export const labeledValue = <Value extends Schema.Json>(value: Value, label: InformationLabel): TrackedValue<Value> =>
  track(value, label, new Set())

export class InfluenceRejected extends Schema.TaggedError<InfluenceRejected>()("InfluenceRejected", {
  reason: Schema.Literals(["untracked-value", "label"])
}) {}

/** Same owned JSON and exact proofs; adding influence can only strengthen secrecy. */
export const addInfluence = <Value extends Schema.Json>(
  source: TrackedValue<Value>, influence: InformationLabel
): Result.Result<TrackedValue<Value>, InfluenceRejected> => {
  const inherited = typeof source === "object" && source !== null ? proofs.get(source) : undefined
  if (inherited === undefined) return Result.fail(new InfluenceRejected({ reason: "untracked-value" }))
  try {
    const label = ownLabel(combine(source.label, ownLabel(influence)))
    const tracked: TrackedValue<Value> = Object.freeze({ [ValueTypeId]: true as const, value: source.value, label })
    proofs.set(tracked, inherited)
    return Result.succeed(tracked)
  } catch {
    return Result.fail(new InfluenceRejected({ reason: "label" }))
  }
}

export const defineDecoder = <const Name extends string, Value extends Schema.Json>(spec: {
  readonly name: Name
  readonly version: string
  readonly schema: Schema.Codec<Value, Schema.Json>
}): TrustedDecoder<Name, Value> => {
  if (spec.name.trim().length === 0 || spec.version.trim().length === 0) {
    throw new InvalidDecoder({ name: spec.name, reason: "name and version must be non-blank" })
  }
  // Schema's AST is immutable trusted code. Capture it rather than retain the
  // caller's specification or outer schema object.
  const decoder: TrustedDecoder<Name, Value> = Object.freeze({
    [DecoderTypeId]: true as const,
    name: spec.name,
    version: spec.version,
    schema: Object.freeze(Schema.make<Schema.Codec<Value, Schema.Json>>(spec.schema.ast))
  })
  decoders.add(decoder)
  return decoder
}

export type DecoderCatalog<List extends ReadonlyArray<TrustedDecoder.Any>> = {
  readonly [Decoder in List[number] as Decoder["name"]]: Decoder
}

/** One current definition per name. Even an equal duplicate is refused. */
export const defineDecoderCatalog = <const List extends ReadonlyArray<TrustedDecoder.Any>>(list: List): DecoderCatalog<List> => {
  const catalog: Record<string, TrustedDecoder.Any> = Object.create(null)
  for (const decoder of list) {
    if (!decoders.has(decoder) || Object.hasOwn(catalog, decoder.name)) {
      throw new InvalidDecoder({ name: decoder.name, reason: "must be a unique trusted decoder" })
    }
    catalog[decoder.name] = decoder
  }
  return Object.freeze(catalog) as DecoderCatalog<List>
}

/**
 * Success proves this exact decoded value. A transform proves its output,
 * never its input; no earlier proof or stronger label is carried across it.
 */
export const decodeValue = <Decoder extends TrustedDecoder.Any>(
  decoder: Decoder,
  source: TrackedValue
): Result.Result<TrackedValue<TrustedDecoder.ValueOf<Decoder>>, DecoderRejected> => {
  const reject = (reason: DecoderRejected["reason"]) => Result.fail(new DecoderRejected({ decoder: decoder.name, reason }))
  if (!decoders.has(decoder)) return reject("untrusted-decoder")
  if (!proofs.has(source)) return reject("untracked-value")
  try {
    const decoded = Schema.decodeUnknownResult(decoder.schema, { onExcessProperty: "error" })(source.value)
    if (Result.isFailure(decoded)) return reject("schema")
    // Own a transform's output before issuing proof: it may be a shared graph.
    const value = ownJson(decoded.success)
    const verified = Schema.decodeUnknownResult(Schema.toType(decoder.schema), { onExcessProperty: "error" })(value)
    if (Result.isFailure(verified)) return reject("schema")
    return Result.succeed(track(value, source.label, new Set([decoder])))
  } catch {
    return reject("non-json-result")
  }
}

/** A copied wrapper, tag, JSON round trip or same-name decoder is not proof. */
export const hasRefinement = (value: TrackedValue, decoder: TrustedDecoder.Any): boolean =>
  decoders.has(decoder) && proofs.get(value)?.has(decoder) === true

/** Prove an already-decoded boundary value without running its encoded transform again. */
export const attestValue = <Decoder extends TrustedDecoder.Any>(
  source: TrackedValue, decoder: Decoder
): Result.Result<TrackedValue<TrustedDecoder.ValueOf<Decoder>>, DecoderRejected> => {
  const reject = (reason: DecoderRejected["reason"]) => Result.fail(new DecoderRejected({ decoder: decoder.name, reason }))
  if (!decoders.has(decoder)) return reject("untrusted-decoder")
  const inherited = proofs.get(source)
  if (inherited === undefined) return reject("untracked-value")
  try {
    const value = ownJson(source.value)
    const checked = Schema.decodeUnknownResult(Schema.toType(decoder.schema), { onExcessProperty: "error" })(value)
    if (Result.isFailure(checked)) return reject("schema")
    // The checked value is deliberately ignored: an attestation cannot transform it.
    return Result.succeed(track(value as TrustedDecoder.ValueOf<Decoder>, source.label, new Set([...inherited, decoder])))
  } catch {
    return reject("non-json-result")
  }
}

/** Ordinary computation conservatively joins labels and discards proofs. */
export const deriveValue = <Value extends Schema.Json>(
  value: Value,
  head: TrackedValue,
  ...tail: ReadonlyArray<TrackedValue>
): TrackedValue<Value> => {
  if (![head, ...tail].every((source) => proofs.has(source))) {
    throw new InvalidDecoder({ name: "", reason: "derivation requires tracked source values" })
  }
  return labeledValue(value, combine(head.label, ...tail.map((source) => source.label)))
}

/** Projection inherits the parent's label, but never its whole-value proof. */
export const projectValue = (source: TrackedValue, field: string | number): TrackedValue => {
  if (!proofs.has(source) || source.value === null || typeof source.value !== "object" || !Object.hasOwn(source.value, field)) {
    throw new InvalidDecoder({ name: "", reason: "projection requires an own field of a tracked record or list" })
  }
  return labeledValue((source.value as Readonly<Record<string | number, Schema.Json>>)[field]!, source.label)
}
