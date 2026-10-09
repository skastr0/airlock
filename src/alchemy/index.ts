/**
 * Airlock's bindings as an Alchemy recipe. Spread what `airlockBindings`
 * returns into the `env` of the `Cloudflare.Worker` that exports the class
 * made by `airlockDurableObject`:
 *
 *   yield* Cloudflare.Worker("api", {
 *     main: "./src/worker.ts",
 *     compatibility: airlockCompatibility,
 *     env: { ...airlockBindings(), MAIL_TOKEN: Config.Redacted("MAIL_TOKEN") }
 *   })
 *
 * This module is for the deploy script only. It imports Alchemy, which a
 * Worker must not bundle, so it is not part of `@skastr0/airlock/cloudflare`.
 */
import * as Cloudflare from "alchemy/Cloudflare"

export interface AirlockBindingNames<Object extends string, Loader extends string> {
  /**
   * The Durable Object binding, as `airlockClient(env.AIRLOCK, ...)` reads it.
   * @default "AIRLOCK"
   */
  readonly object?: Object
  /**
   * The Worker Loader binding, as `airlockDurableObject`'s `loader` reads it.
   * @default "LOADER"
   */
  readonly loader?: Loader
  /**
   * The name the Worker exports the Durable Object class under.
   * @default "Airlock"
   */
  readonly className?: string
}

/**
 * The two bindings an Airlock needs and nothing else: its Durable Object,
 * which Alchemy creates SQLite-backed, and the Worker Loader its guests run
 * in. Worker Loader requires a paid Workers plan; on a free plan Cloudflare
 * refuses the deploy.
 */
export const airlockBindings = <const Object extends string = "AIRLOCK", const Loader extends string = "LOADER">(
  names: AirlockBindingNames<Object, Loader> = {}
) => {
  const object = names.object ?? "AIRLOCK"
  const loader = names.loader ?? "LOADER"
  if (object === loader) throw new TypeError(`the Airlock object and its loader are both bound as ${object}`)
  const className = names.className ?? "Airlock"
  return {
    [object]: Cloudflare.DurableObject(className, { className }),
    [loader]: Cloudflare.WorkerLoader(loader)
  } as
    & { readonly [Name in Object]: ReturnType<typeof Cloudflare.DurableObject> }
    & { readonly [Name in Loader]: ReturnType<typeof Cloudflare.WorkerLoader> }
}

/**
 * The compatibility settings Airlock is proven under: no flags at all. In
 * particular no `nodejs_compat`; the adapters use nothing from Node.
 */
export const airlockCompatibility = { date: "2026-07-08", flags: [] as Array<never> } as const
