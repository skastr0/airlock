import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ActId } from "../src/domain.ts"

const decodeActId = Schema.decodeUnknown(ActId)

describe("domain identifiers", () => {
  it.effect("accepts generated and legacy path-component-safe act ids", () =>
    Effect.gen(function* () {
      expect(yield* decodeActId("act_1234-ABCD")).toBe("act_1234-ABCD")
      expect(yield* decodeActId("act-remove")).toBe("act-remove")
    })
  )

  it.effect("rejects path traversal and non-component act ids at decode", () =>
    Effect.gen(function* () {
      for (const candidate of [
        "",
        ".",
        "..",
        "../../outside",
        "/absolute",
        "nested/act",
        "act\u0000suffix",
        `act_${"x".repeat(125)}`
      ]) {
        expect((yield* decodeActId(candidate).pipe(Effect.either))._tag).toBe(
          "Left"
        )
      }
    })
  )

  it("also guards the branded constructor used by trusted adapters", () => {
    expect(() => ActId.make("../../outside")).toThrow()
  })
})
