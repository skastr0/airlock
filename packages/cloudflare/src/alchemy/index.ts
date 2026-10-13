/**
 * Airlock's binding as an Alchemy recipe. Spread what `airlockBindings`
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

export interface AirlockBindingNames<Object extends string> {
  /**
   * The Durable Object binding, as `airlockClient(env.AIRLOCK, ...)` reads it.
   * @default "AIRLOCK"
   */
  readonly object?: Object
  /**
   * The name the Worker exports the Durable Object class under.
   * @default "Airlock"
   */
  readonly className?: string
}

/**
 * The one binding an Airlock needs: its Durable Object, which Alchemy creates
 * SQLite-backed. Programs are evaluated inside that object, so there is no
 * loader, no second Worker and nothing that needs a paid plan.
 */
export const airlockBindings = <const Object extends string = "AIRLOCK">(
  names: AirlockBindingNames<Object> = {}
) => {
  const className = names.className ?? "Airlock"
  return { [names.object ?? "AIRLOCK"]: Cloudflare.DurableObject(className, { className }) } as {
    readonly [Name in Object]: Cloudflare.DurableObjectLike
  }
}

/**
 * The compatibility settings Airlock is proven under: no flags at all. In
 * particular no `nodejs_compat`; the adapters use nothing from Node.
 */
export const airlockCompatibility = { date: "2026-07-08", flags: [] as Array<never> } as const
