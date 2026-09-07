import { execFile, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const repository = resolve(import.meta.dirname, "..")
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-change-cli-")))
  const home = join(root, "home")
  const source = join(root, "candidate.json")
  const target = join(root, "live.json")
  writeFileSync(source, '{"enabled":true}\n')
  writeFileSync(target, '{"enabled":false}\n')
  return { root, home, source, target }
}

const run = (home: string, args: ReadonlyArray<string>, agent = false) => {
  const environment: NodeJS.ProcessEnv = { ...process.env, AIRLOCK_HOME: home }
  delete environment.AIRLOCK_SEAL
  delete environment.AIRLOCK_AGENT_SURFACE
  return spawnSync("bun", [agent ? "src/agent-cli.ts" : "src/cli.ts", "change", ...args], {
    cwd: repository,
    env: {
      ...environment,
      AIRLOCK_BWRAP: "/nonexistent/airlock-change-test/bwrap",
      AIRLOCK_LINUX_LAUNCHER: "/nonexistent/airlock-change-test/launcher"
    },
    encoding: "utf8",
    timeout: 30_000
  })
}

const successful = (result: ReturnType<typeof run>) => {
  expect(result.status, result.stderr || result.stdout).toBe(0)
  return JSON.parse(result.stdout)
}

describe("reviewed change CLI", () => {
  it("composes external preparation, agent staging, supervisor application and checked undo without Cell", () => {
    const { home, source, target } = fixture()
    const staged = successful(run(home, ["stage", "--source", source, "--target", target], true))
    expect(staged.id).toBeTypeOf("string")
    expect(staged.proposalDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(readFileSync(target, "utf8")).toBe('{"enabled":false}\n')

    writeFileSync(source, "changed after staging")
    const reviewed = successful(run(home, ["review", staged.id, "--diff"], true))
    expect(reviewed.proposalDigest).toBe(staged.proposalDigest)
    expect(reviewed.diff).toBeDefined()
    successful(run(home, ["status", staged.id], true))

    const applied = successful(run(home, ["apply", staged.id, "--expect-digest", staged.proposalDigest]))
    expect(applied.state).toBe("installed")
    expect(applied.receiptId).toBeTypeOf("string")
    expect(readFileSync(target, "utf8")).toBe('{"enabled":true}\n')
    const repeated = successful(run(home, ["apply", staged.id, "--expect-digest", staged.proposalDigest]))
    expect(repeated.receiptId).toBe(applied.receiptId)

    const undone = successful(run(home, ["undo", applied.receiptId]))
    expect(undone.state).toBe("undone")
    expect(readFileSync(target, "utf8")).toBe('{"enabled":false}\n')
  })

  it("does not put approval, cancellation, recovery or undo on the agent surface", () => {
    const { home, source, target } = fixture()
    const staged = successful(run(home, ["stage", "--source", source, "--target", target], true))
    for (const args of [
      ["apply", staged.id, "--expect-digest", staged.proposalDigest],
      ["undo", "receipt_123"],
      ["cancel", staged.id],
      ["recover", staged.id]
    ]) {
      const refused = run(home, args, true)
      expect(refused.status, `${args[0]} unexpectedly available`).not.toBe(0)
    }
    expect(readFileSync(target, "utf8")).toBe('{"enabled":false}\n')
    const help = run(home, ["--help"], true)
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).not.toMatch(/change (apply|undo|cancel|recover)\b/)
  })

  it("requires an exact digest and reports drift as an unsuccessful command", () => {
    const { home, source, target } = fixture()
    const staged = successful(run(home, ["stage", "--source", source, "--target", target]))
    expect(run(home, ["apply", staged.id]).status).not.toBe(0)
    expect(run(home, ["apply", staged.id, "--expect-digest", `sha256:${"0".repeat(64)}`]).status).not.toBe(0)
    writeFileSync(target, "a later operator edit")
    const refused = run(home, ["apply", staged.id, "--expect-digest", staged.proposalDigest])
    expect(refused.status).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("a later operator edit")
  })

  it("replaces a whole directory, shows deleted entries, and restores them on undo", () => {
    const { root, home } = fixture()
    const source = join(root, "candidate-tree")
    const target = join(root, "live-tree")
    mkdirSync(source)
    mkdirSync(target)
    writeFileSync(join(source, "new.txt"), "new")
    writeFileSync(join(target, "old.txt"), "old")
    const staged = successful(run(home, ["stage", "--source", source, "--target", target]))
    const reviewed = successful(run(home, ["review", staged.id, "--diff"]))
    expect(JSON.stringify(reviewed.diff)).toContain("old.txt")
    expect(JSON.stringify(reviewed.diff)).toContain("deleted")
    const applied = successful(run(home, ["apply", staged.id, "--expect-digest", staged.proposalDigest]))
    expect(existsSync(join(target, "old.txt"))).toBe(false)
    expect(readFileSync(join(target, "new.txt"), "utf8")).toBe("new")
    successful(run(home, ["undo", applied.receiptId]))
    expect(readFileSync(join(target, "old.txt"), "utf8")).toBe("old")
    expect(existsSync(join(target, "new.txt"))).toBe(false)
  })

  it("serializes simultaneous supervisor processes without a second installation", async () => {
    const { home, source, target } = fixture()
    const staged = successful(run(home, ["stage", "--source", source, "--target", target]))
    const execute = promisify(execFile)
    const results = await Promise.all([0, 1, 2].map(() => execute("bun", [
      "src/cli.ts", "change", "apply", staged.id, "--expect-digest", staged.proposalDigest
    ], {
      cwd: repository,
      env: { ...process.env, AIRLOCK_HOME: home, AIRLOCK_SEAL: undefined, AIRLOCK_AGENT_SURFACE: undefined },
      encoding: "utf8",
      timeout: 30_000
    })))
    const receipts = results.map(result => JSON.parse(result.stdout))
    expect(receipts.every(receipt => receipt.state === "installed")).toBe(true)
    expect(new Set(receipts.map(receipt => receipt.actId)).size).toBe(1)
    expect(receipts[0].actId).toBeTypeOf("string")
    expect(readdirSync(join(home, "hold")).filter(name => name.startsWith("act_"))).toHaveLength(1)
    expect(readFileSync(target, "utf8")).toBe('{"enabled":true}\n')
  })

  it("requires explicit restoration after a real process exit leaves the target absent", () => {
    const { home, source, target } = fixture()
    const staged = successful(run(home, ["stage", "--source", source, "--target", target]))
    const child = spawnSync("bun", ["-e", `
      import { BunContext } from "@effect/platform-bun"
      import { Effect, Layer, ManagedRuntime } from "effect"
      import * as AirlockHome from "./src/AirlockHome.ts"
      import { Change, ChangeLive } from "./src/change/Change.ts"
      import { HoldLayer } from "./src/Hold.ts"
      import { LedgerLive } from "./src/Ledger.ts"
      import { ExclusiveRename } from "./src/platform/ExclusiveRename.ts"
      import { ExclusiveRenameTestLive } from "./test/support/ExclusiveRenameTestLive.ts"
      const moves = Layer.effect(ExclusiveRename, Effect.gen(function* () {
        const real = yield* ExclusiveRename
        return ExclusiveRename.of({ moveNoReplace: (source, target) => Effect.gen(function* () {
          yield* real.moveNoReplace(source, target)
          if (target.endsWith("/payload")) process.exit(86)
        }) })
      })).pipe(Layer.provide(ExclusiveRenameTestLive))
      const runtime = ManagedRuntime.make(ChangeLive.pipe(
        Layer.provideMerge(HoldLayer), Layer.provideMerge(moves),
        Layer.provideMerge(LedgerLive), Layer.provideMerge(AirlockHome.layer(${JSON.stringify(home)})),
        Layer.provideMerge(BunContext.layer)
      ))
      const change = await runtime.runPromise(Change)
      await runtime.runPromise(change.apply(${JSON.stringify({ id: staged.id, expectedDigest: staged.proposalDigest })}))
      await runtime.dispose()
      process.exit(87)
    `], { cwd: repository, encoding: "utf8", timeout: 30_000 })
    expect(child.status, child.stderr).toBe(86)
    expect(existsSync(target)).toBe(false)
    const reconciled = run(home, ["recover", staged.id])
    expect(reconciled.status, reconciled.stderr).toBe(1)
    expect(JSON.parse(reconciled.stdout).state).toBe("recovery-required")
    expect(existsSync(target)).toBe(false)
    const restored = successful(run(home, ["recover", staged.id, "--restore"]))
    expect(restored.state).toBe("rolled-back")
    expect(readFileSync(target, "utf8")).toBe('{"enabled":false}\n')
    expect(run(home, ["apply", staged.id, "--expect-digest", staged.proposalDigest]).status).toBe(1)
    expect(readFileSync(target, "utf8")).toBe('{"enabled":false}\n')
  })

  it("cancels a proposal without mutating the target", () => {
    const { home, source, target } = fixture()
    const staged = successful(run(home, ["stage", "--source", source, "--target", target]))
    successful(run(home, ["cancel", staged.id]))
    expect(run(home, ["apply", staged.id, "--expect-digest", staged.proposalDigest]).status).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe('{"enabled":false}\n')
  })
})
