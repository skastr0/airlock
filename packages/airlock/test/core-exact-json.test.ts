import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { canonicalJson, sha256Canonical } from "../src/Canonical.ts"
import { exactJsonCodec } from "../src/ExactJson.ts"
import * as WebCrypto from "../src/WebCrypto.ts"

describe("core: exact encoded JSON identity", () => {
  it("keeps negative zero distinct in canonical identity and through refined codecs", async () => {
    const negativeZero = Schema.Number.check(Schema.makeFilter((value) => Object.is(value, -0)))
    const codec = exactJsonCodec(Schema.Struct({ value: negativeZero, parsed: Schema.NumberFromString }))
    const text = Schema.encodeSync(codec)({ value: -0, parsed: 7 })
    const restored = Schema.decodeUnknownSync(codec)(text)
    expect(Object.is(restored.value, -0)).toBe(true)
    expect(restored.parsed).toBe(7)
    expect(() => Schema.decodeUnknownSync(codec)('{"value":0,"parsed":"7"}')).toThrow()
    const digests = await Effect.runPromise(Effect.all([sha256Canonical({ value: -0 }), sha256Canonical({ value: 0 })])
      .pipe(Effect.provide(WebCrypto.layer)))
    expect(digests[0]).not.toBe(digests[1])
    expect(canonicalJson({ z: -0, a: [0, -0] })).toBe('{"a":[0,-0],"z":-0}')
  })

  it("keeps codec validation at the text boundary", () => {
    const codec = exactJsonCodec(Schema.Struct({ value: Schema.Number }))
    for (const text of ['{', '{"value":"0"}', '{"value":1e400}']) {
      expect(() => Schema.decodeUnknownSync(codec)(text)).toThrow()
    }
    expect(() => Schema.encodeUnknownSync(codec)({ value: Infinity })).toThrow()
  })
})
