// The Workers runtime provides this module; no type package is required to
// build against it, so it is described structurally here. `@ts-ignore` rather
// than `@ts-expect-error`: a consumer that does install Cloudflare's types
// resolves the module, and this line must compile either way.
// @ts-ignore
import * as workers from "cloudflare:workers"

/** The part of a Durable Object's state these adapters use. */
export interface ObjectState {
  readonly storage: import("./Storage.ts").DurableStorage & {
    /** Asks the platform to call the object's `alarm()` at this time, even after a restart. */
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
  }
}

interface WorkersModule {
  /** Base of anything passed by reference over Workers RPC. Only prototype methods are callable remotely. */
  readonly RpcTarget: abstract new () => object
  /** Base of a Durable Object whose public methods are callable over RPC. */
  readonly DurableObject: abstract new (state: ObjectState, env: never) => object
}

const platform = workers as unknown as WorkersModule

export const RpcTarget = platform.RpcTarget
export const DurableObject = platform.DurableObject

/** What a dynamically loaded Worker is given. Mirrors the Worker Loader binding. */
export interface WorkerLoaderCode {
  readonly compatibilityDate: string
  readonly compatibilityFlags?: ReadonlyArray<string>
  readonly mainModule: string
  readonly modules: { readonly [name: string]: string }
  /** `null` cuts the Worker off from the network entirely. */
  readonly globalOutbound?: null
  readonly limits?: { readonly cpuMs?: number; readonly subRequests?: number }
}

export interface WorkerLoader {
  load(code: WorkerLoaderCode): { getEntrypoint(): unknown }
}
