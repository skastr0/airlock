/**
 * Assertions for the conformance suites. The kernel depends on no test
 * framework, so a failed invariant is a thrown error naming what differed; the
 * host's runner reports it like any other failure.
 */
export class InvariantViolated extends Error {
  override readonly name = "InvariantViolated"
}

const show = (value: unknown) => JSON.stringify(value, null, 2)

/** Structural equality over the JSON form of both sides. */
export const same = (actual: unknown, expected: unknown, what = "value"): void => {
  const [left, right] = [show(actual), show(expected)]
  if (left !== right) {
    throw new InvariantViolated(`${what}: expected ${right}, got ${left}`)
  }
}

export const holds = (condition: boolean, what: string): void => {
  if (!condition) throw new InvariantViolated(what)
}

/**
 * What a conformance suite needs from a test runner. `@effect/vitest`'s
 * `describe` and `it.effect` fit as they are.
 */
export interface Runner {
  readonly describe: (name: string, body: () => void) => void
  readonly test: (
    name: string,
    body: () => import("effect").Effect.Effect<void, unknown, import("effect").Scope.Scope>,
    /** Milliseconds; a suite passes one only for a test that does many durable writes. */
    timeout?: number
  ) => void
}
