/**
 * Airlock's ports over Cloudflare Durable Object SQLite storage. This package
 * imports the kernel and nothing host-shaped: no Node, no Bun, no file system.
 * Crypto comes from the kernel's `WebCrypto.layer`.
 */
export { durableLedger } from "./DurableLedger.ts"
export { durableOutboxStore } from "./DurableOutboxStore.ts"
export { type DurableSql, type DurableStorage, ensureSchema, type SqlCursor, type SqlValue } from "./Storage.ts"
export {
  airlockClient,
  airlockDurableObject,
  AirlockError,
  type AirlockNamespace,
  type AirlockObjectApi,
  type AirlockObjectOptions,
  type GuestDescription,
  type Reply
} from "./AirlockObject.ts"
export type { ObjectState, WorkerLoader, WorkerLoaderCode } from "./Platform.ts"
export { workerLoaderRunner, type WorkerLoaderRunnerOptions } from "./WorkerLoaderRunner.ts"

// Everything a user writes against, from one entry point. Contracts are
// declared with `Schema`, which is re-exported so a user needs no other import.
export { Schema } from "effect"
export {
  defineAirlock,
  defineToolContract,
  type ImplementContext,
  Refused,
  refused,
  ToolPolicy,
  toolPolicy
} from "../core/index.ts"
export { FieldMatch, toolGrant, ToolGrantPolicy } from "../core/admission/ToolGrant.ts"
