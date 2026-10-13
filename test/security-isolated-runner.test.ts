import { build } from "esbuild"
import { Log, LogLevel, Miniflare } from "miniflare"
import { resolve } from "node:path"
import type { Readable } from "node:stream"
import { afterAll, describe, expect, it } from "vitest"

/**
 * The program runner inside real workerd, in a Worker that holds a secret
 * binding and has the platform's network and cache in reach. A program is
 * evaluated in that same Worker, so what keeps it from them is the language:
 * these tests aim a program at each of them.
 */
const script = (await build({
  stdin: {
    resolveDir: resolve(import.meta.dirname, ".."),
    contents: `
      import { Effect, Schema } from "effect";
      import { defineToolContract, GuestRunner, programRunner } from "./packages/airlock/src/index.ts";
      import { reviewContext } from "./packages/airlock/test/support/ReviewContext.ts";
      let reached = 0;
      // Exact shapes: an optional "constructor" key would be satisfied by the prototype's own.
      const Echoed = Schema.Union([
        Schema.Struct({ continued: Schema.Boolean }),
        Schema.Struct({ ["__proto__"]: Schema.Struct({ polluted: Schema.Boolean }), constructor: Schema.String })
      ]);
      const contracts = [
        defineToolContract({ name: "security.throw", version: "1", effect: "capture", input: Schema.Struct({}), output: Schema.Null }),
        defineToolContract({ name: "security.echo", version: "1", effect: "capture", input: Echoed, output: Echoed })
      ];
      const surface = {
        tools: ["security.throw", "security.echo"], actions: [], description: "", review: reviewContext(...contracts),
        call: (tool, input) => {
          reached += 1;
          return tool === "security.throw" ? Effect.die(new Error("host-canary-secret")) : Effect.succeed({ state: "done", id: "call-1", result: input });
        }
      };
      export default {
        async fetch(request, env) {
          if (request.method === "GET") return Response.json({ reached });
          const { source, freezeClock } = await request.json();
          console.log("trusted-log-control");
          const before = reached;
          const realNow = Date.now;
          const started = realNow();
          // Deployed Workers freeze Date.now between I/O; local workerd does not.
          if (freezeClock) Date.now = () => started;
          try {
            const outcome = await Effect.runPromise(Effect.gen(function* () {
              const runner = yield* GuestRunner;
              return yield* runner.run({ source, surface, limits: {
                wallTimeMs: freezeClock ? 30 : 2000,
                maxLoopIterations: freezeClock ? 1000000 : 1000,
                maxSteps: freezeClock ? 1000000000 : 100000
              } });
            }).pipe(Effect.provide(programRunner)));
            return Response.json({
              outcome, reached: reached - before, bound: typeof env.HOST_SECRET,
              ...(freezeClock ? { frozen: Date.now() === started, elapsed: realNow() - started } : {})
            });
          } finally {
            Date.now = realNow;
          }
        }
      };`
  },
  bundle: true, write: false, format: "esm", platform: "neutral",
  mainFields: ["module", "main"], conditions: ["worker", "browser", "import"],
  target: "es2022", external: ["cloudflare:workers"], logLevel: "silent"
})).outputFiles[0]!.text

const logs: Array<string> = []
class CaptureLog extends Log {
  override logWithLevel(_level: LogLevel, message: string): void { logs.push(message) }
}
const workerd = new Miniflare({
  modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
  compatibilityDate: "2026-07-08",
  bindings: { HOST_SECRET: "binding-canary-secret" }, log: new CaptureLog(LogLevel.VERBOSE),
  handleRuntimeStdio: (stdout: Readable, stderr: Readable) => {
    for (const stream of [stdout, stderr]) stream.on("data", (chunk: unknown) => logs.push(String(chunk)))
  }
})
afterAll(() => workerd.dispose())
type Reply = {
  readonly outcome: { readonly ok: boolean; readonly [field: string]: unknown }
  readonly reached: number
  readonly bound: string
  readonly frozen?: boolean
  readonly elapsed?: number
}
const run = async (source: string, freezeClock = false): Promise<Reply> => (await (await workerd.dispatchFetch("http://security.test/run", {
  method: "POST", body: JSON.stringify({ source, freezeClock })
})).json()) as Reply
const calls = async (): Promise<number> =>
  ((await (await workerd.dispatchFetch("http://security.test/calls")).json()) as { readonly reached: number }).reached

describe("security: the program runner in real workerd", () => {
  it("stops pure computation and its later tool call even when Date.now is frozen", async () => {
    const before = await calls()
    const reply = await run(`
      for index in 0..1000000 { let twice = index * 2 }
      return security.echo({ continued: true })`, true)
    expect(reply.outcome).toEqual({ ok: false, reason: "timeout", toolCalls: 0 })
    expect(reply.reached).toBe(0)
    expect(reply.frozen).toBe(true)
    expect(reply.elapsed).toBeLessThan(4_000)
    // The stopped evaluation cannot resume into its tool call later.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await calls()).toBe(before)
    expect((await run("return 1")).outcome).toEqual({ ok: true, result: 1, toolCalls: 0 })
  }, 20_000)

  it("redacts a host defect, and the program cannot continue past it", async () => {
    expect(await run(`security.throw({})\nreturn "continued"`)).toEqual({
      outcome: { ok: false, reason: "execution_failed", toolCalls: 1 },
      reached: 1,
      bound: "string"
    })
  })

  it("gives a program no network, no cache, no binding and no global: each is only a name", async () => {
    const refused = [
      `fetch("https://security.test/")`,
      `caches.default.put("https://security.test/cache", "cache-canary")`,
      `caches.default.match("https://security.test/cache")`,
      `connect("security.test:443")`,
      `security.echo.call({ a: 1 })`,
      `security.echo.constructor("return globalThis")`,
      `globalThis.fetch("https://security.test/")`,
      `env.HOST_SECRET({})`
    ]
    for (const source of refused) {
      // The program does not check, so it never runs; the host's tools were never reached.
      const reply = await run(`return ${source}`)
      expect([source, reply.outcome.ok, reply.outcome["reason"], reply.outcome["toolCalls"], reply.reached])
        .toEqual([source, false, "invalid_code", 0, 0])
    }
    const unbound = ["return HOST_SECRET", "return env.HOST_SECRET", "return globalThis", "return caches", "return security", "return constructor", "return __proto__"]
    for (const source of unbound) {
      const reply = await run(source)
      expect([source, reply.outcome["reason"], reply.outcome["fault"], reply.reached])
        .toEqual([source, "invalid_code", "unbound-name", 0])
    }
    // A value's own machinery is not reachable either: there are records and lists, not objects.
    for (const source of [`return { a: 1 }.constructor`, `return [1].length`, `return "text".length`, `return { a: 1 }.__proto__`]) {
      const reply = await run(source)
      expect([source, reply.outcome.ok, reply.reached]).toEqual([source, false, 0])
    }
    const echoed = await run(`
      let echoed = security.echo({ __proto__: { polluted: true }, constructor: "c" })
      assert echoed.state == "done"
      return echoed.result`)
    // The key travels as plain data, an own property on both sides, and changes no prototype.
    expect(JSON.stringify(echoed.outcome)).toBe(
      '{"ok":true,"result":{"__proto__":{"polluted":true},"constructor":"c"},"toolCalls":1}'
    )
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(JSON.stringify(await run("return 1"))).not.toContain("polluted")
  })

  it("keeps a program's text out of the outcome and out of the runtime logs", async () => {
    logs.length = 0
    const sources = [
      `assert 1 == 2, "guest-log-canary-secret"`,
      `return guest_log_canary_secret`,
      `return guest_log_canary_secret({ text: "guest-log-canary-secret" }).result`,
      `return "guest-log-canary-secret" + 1`,
      `return ("guest-log-canary-secret"`
    ]
    for (const source of sources) {
      const reply = await run(source)
      expect(reply.outcome.ok).toBe(false)
      expect(JSON.stringify(reply.outcome)).not.toMatch(/guest-log-canary-secret|binding-canary-secret/)
    }
    // A call to a name that is not a tool is refused before the run, and nothing of it is in the outcome.
    const called = await run(`guest_log_canary_secret({ text: "guest-log-canary-secret" })\nreturn 1`)
    expect(called.outcome).toMatchObject({ ok: false, reason: "invalid_code", toolCalls: 0 })
    expect(JSON.stringify(called.outcome)).not.toMatch(/guest-log-canary-secret|binding-canary-secret/)
    expect(called.reached).toBe(0)
    expect(logs.join("\n")).toContain("trusted-log-control")
    expect(logs.join("\n")).not.toContain("guest-log-canary-secret")
    expect(logs.join("\n")).not.toContain("binding-canary-secret")
  })
})
