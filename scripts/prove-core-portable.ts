#!/usr/bin/env bun
/**
 * Portability proof for the kernel.
 *
 * Bundles `src/core` the way a Workers-style runtime would load it: no Node
 * built-ins, no Bun, no `nodejs_compat`. Every import must resolve to code
 * that runs in a plain isolate, so a `node:` or `bun:` import anywhere in the
 * kernel's graph fails this build. The bundle is then loaded in a context
 * with no `process`, `Bun`, `Buffer` or `require`, and the kernel is asked to
 * stage, commit and read back one emission over the in-memory adapters.
 */
import { build } from "esbuild"
import { resolve } from "node:path"
import vm from "node:vm"

const repository = resolve(import.meta.dir, "..")

const entry = `
import { Effect, Layer, Schema } from "effect"
import * as Core from "./src/core/index.ts"
import * as Testing from "./src/core/testing/index.ts"

const AirlockOutbox = Core.defineOutbox({ http: Core.HttpIntent })
const handlers = Layer.succeed(AirlockOutbox.Dispatcher, AirlockOutbox.Dispatcher.of({
  http: ({ permit }) =>
    Core.isLivePermit(permit)
      ? Effect.succeed({
          outcome: { status: 204 },
          response: new Uint8Array(0),
          truncated: false
        })
      : Effect.fail(new Core.DispatchFailed({ reason: "dispatch permit is not live" }))
}))
const layer = AirlockOutbox.layer.pipe(
  Layer.provide(handlers),
  Layer.provide(Testing.memoryOutboxStore(Testing.makeMemoryOutboxState())),
  Layer.provide(Testing.memoryLedger(Testing.makeMemoryLedgerState())),
  Layer.provide(Core.WebCrypto.layer)
)

export const run = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const outbox = yield* AirlockOutbox.Outbox
      const staged = yield* outbox.stage({
        key: Schema.decodeUnknownSync(Core.IdempotencyKey)("portable-proof"),
        intent: {
          kind: "http",
          dispatch: { url: "https://example.invalid/hook", method: "POST", headers: {} }
        },
        holdMillis: 0
      })
      const committed = yield* outbox.commit(
        staged.id,
        new Core.DispatchProvenance({ committedBy: "supervisor" })
      )
      return { id: committed.id, state: committed.state, status: committed.outcome.status }
    }).pipe(Effect.provide(layer))
  )
`

const bundled = await build({
  stdin: { contents: entry, resolveDir: repository, loader: "ts", sourcefile: "portable-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "airlockCore",
  // `neutral` resolves no Node built-in and applies no polyfill.
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import"],
  target: "es2022",
  logLevel: "silent"
}).catch((failure: { readonly errors?: ReadonlyArray<{ readonly text: string; readonly location?: { readonly file: string } | null }> }) => {
  for (const error of failure.errors ?? []) {
    console.error(`${error.location?.file ?? "?"}: ${error.text}`)
  }
  console.error("airlock core is not portable: the bundle has unresolved host imports")
  process.exit(1)
})

const source = bundled.outputFiles[0]!.text
const hostReference = /\b(?:require\s*\(|process\.(?:env|versions|platform|argv)|Bun\.)/
// Web-standard globals an isolate provides. No process, Bun, Buffer, require.
const isolate = vm.createContext({
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  AbortController,
  AbortSignal,
  performance: { now: () => performance.now() }
})
vm.runInContext(`${source}\nglobalThis.airlockCore = airlockCore`, isolate)
const result = await (isolate["airlockCore"] as {
  readonly run: () => Promise<{ readonly id: string; readonly state: string; readonly status: number }>
}).run()

if (result.state !== "committed" || result.status !== 204) {
  console.error(`airlock core ran but did not commit: ${JSON.stringify(result)}`)
  process.exit(1)
}
console.log(JSON.stringify({
  proof: "airlock-core-portable-v1",
  ok: true,
  bundleBytes: source.length,
  hostGuardsInBundle: hostReference.test(source),
  emission: result
}))
