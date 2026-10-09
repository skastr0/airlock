import { airlockBindings, airlockCompatibility } from "@skastr0/airlock/alchemy"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Config, Effect, Redacted } from "effect"

/**
 * Everything this example needs on Cloudflare: one Worker, its Airlock
 * Durable Object, the Worker Loader its guests run in, and one secret.
 */
export default Alchemy.Stack(
  "airlock-example",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("airlock", {
      main: "./src/worker.ts",
      compatibility: airlockCompatibility,
      env: {
        ...airlockBindings(),
        MAIL_TOKEN: Config.Redacted("MAIL_TOKEN").pipe(Config.withDefault(Redacted.make("example-token")))
      }
    })
    return { url: worker.url }
  })
)
