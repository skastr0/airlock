import { build } from "esbuild"
import { Log, LogLevel, Miniflare } from "miniflare"
import { resolve } from "node:path"
import type { Readable } from "node:stream"
import { afterAll, describe, expect, it } from "vitest"

const script = (await build({
  stdin: {
    resolveDir: resolve(import.meta.dirname, ".."),
    contents: `
      import { Effect } from "effect";
      import { GuestRunner } from "./src/core/index.ts";
      import { workerLoaderRunner } from "./src/cloud/WorkerLoaderRunner.ts";
      const surface = {
        tools: ["security.throw"], declaration: "", description: "",
        call: () => Effect.die(new Error("host-canary-secret"))
      };
      export default {
        async fetch(request, env) {
          const { source } = await request.json();
          console.log("trusted-log-control");
          const outcome = await Effect.runPromise(Effect.gen(function* () {
            const runner = yield* GuestRunner;
            return yield* runner.run({ source, surface, limits: { wallTimeMs: 2000 } });
          }).pipe(Effect.provide(workerLoaderRunner(env.LOADER))));
          return Response.json(outcome);
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
  compatibilityDate: "2026-07-08", workerLoaders: { LOADER: {} },
  bindings: { HOST_SECRET: "binding-canary-secret" }, log: new CaptureLog(LogLevel.VERBOSE),
  handleRuntimeStdio: (stdout: Readable, stderr: Readable) => {
    for (const stream of [stdout, stderr]) stream.on("data", (chunk: unknown) => logs.push(String(chunk)))
  }
})
afterAll(() => workerd.dispose())
const run = async (source: string): Promise<unknown> => (await (await workerd.dispatchFetch("http://security.test/run", {
  method: "POST", body: JSON.stringify({ source })
})).json())

describe("security: real Worker Loader isolation", () => {
  it("redacts a host defect across the actual RPC boundary even when caught", async () => {
    expect(await run(`
      try { await tools.security.throw({}); return "success"; }
      catch (error) { return { name: error.name, message: error.message, cause: String(error.cause) }; }
    `)).toEqual({ ok: false, reason: "execution_failed", toolCalls: 1 })
  })

  it("blocks platform cache access alongside ordinary network access", async () => {
    expect(await run(`
      try {
        await caches.default.put("https://security.test/cache", new Response("cache-canary"));
        const response = await caches.default.match("https://security.test/cache");
        return { cache: "reachable", value: response && await response.text() };
      } catch { return { cache: "blocked" }; }
    `)).toEqual({ ok: true, result: { cache: "blocked" }, toolCalls: 0 })
  })

  it("keeps guest console and unhandled rejection text out of runtime logs", async () => {
    logs.length = 0
    expect(await run(`
      console.log("guest-log-canary-secret");
      Promise.reject(new Error("guest-rejection-canary-secret"));
      await new Promise(resolve => setTimeout(resolve, 20));
      return null;
    `)).toEqual({ ok: true, result: null, toolCalls: 0 })
    expect(logs.join("\n")).toContain("trusted-log-control")
    expect(logs.join("\n")).not.toContain("guest-log-canary-secret")
    expect(logs.join("\n")).not.toContain("guest-rejection-canary-secret")
  })
})
