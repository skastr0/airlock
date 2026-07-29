import { FileSystem, Path } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import {
  makeFileRuntimeRunJournal,
  RuntimeRunSnapshot
} from "../src/runtime/index.ts"

const instant = (value: string) =>
  DateTime.unsafeMake(new Date(value))

const snapshot = (
  planId: string,
  sequence: number,
  observedAt: string,
  state: RuntimeRunSnapshot["state"]
) =>
  new RuntimeRunSnapshot({
    schemaVersion: "airlock/runtime-run-snapshot/v1",
    planId,
    state,
    startedAt: instant("2026-07-29T00:00:00.000Z"),
    observedAt: instant(observedAt),
    sequence,
    receipts: [],
    artifacts: [],
    lifecycle: [],
    recovery: []
  })

describe("RuntimeRunJournal", () => {
  it.effect("selects the greatest sequence after the wall clock moves backward", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temporary = yield* fs.makeTempDirectoryScoped()
        const journal = makeFileRuntimeRunJournal(
          path.join(temporary, "runs")
        )
        const planId = "plan/wall-clock-rollback"
        yield* journal.record(
          snapshot(
            planId,
            1,
            "2036-07-29T00:00:00.000Z",
            "running"
          )
        )
        yield* journal.record(
          snapshot(
            planId,
            2,
            "2026-07-29T00:00:00.000Z",
            "finalizing"
          )
        )

        const inspected = yield* journal.inspect(planId)
        expect(inspected.sequence).toBe(2)
        expect(inspected.state).toBe("finalizing")

        const recent = yield* journal.recent
        expect(recent).toHaveLength(1)
        expect(recent[0]).toMatchObject({
          planId,
          sequence: 2,
          state: "finalizing"
        })
      })
    ).pipe(Effect.provide(BunContext.layer))
  )
})
