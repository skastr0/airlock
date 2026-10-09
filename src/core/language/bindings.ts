import { Effect, Schema } from "effect"
import type { Program, Span, Statement } from "./ast.ts"
import { SpanSchema } from "./ast.ts"

export class DuplicateBinding extends Schema.TaggedError<DuplicateBinding>()(
  "DuplicateBinding",
  { name: Schema.String, span: SpanSchema, previous: Schema.optional(SpanSchema) }
) {}

/** Check every lexical scope before execution, including unreachable branches. */
export const validateBindings = (
  program: Program,
  initialNames: readonly string[] = []
): Effect.Effect<void, DuplicateBinding> => Effect.gen(function* () {
  const visit = (
    statements: readonly Statement[],
    visible: ReadonlyMap<string, Span | undefined>
  ): Effect.Effect<void, DuplicateBinding> => Effect.gen(function* () {
    const names = new Map(visible)
    const bind = (scope: Map<string, Span | undefined>, name: string, span: Span): Effect.Effect<void, DuplicateBinding> => {
      if (scope.has(name)) {
        const previous = scope.get(name)
        return Effect.fail(new DuplicateBinding({ name, span, ...(previous === undefined ? {} : { previous }) }))
      }
      scope.set(name, span)
      return Effect.void
    }
    for (const statement of statements) {
      switch (statement.kind) {
        case "LetStatement":
          yield* bind(names, statement.name, statement.span)
          break
        case "IfStatement":
          yield* visit(statement.consequent, names)
          yield* visit(statement.alternate ?? [], names)
          break
        case "ForStatement": {
          const nested = new Map(names)
          yield* bind(nested, statement.variable, statement.span)
          yield* visit(statement.body, nested)
          break
        }
        default:
          break
      }
    }
  })
  yield* visit(program.body, new Map(initialNames.map((name) => [name, undefined])))
})
