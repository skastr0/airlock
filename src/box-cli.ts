#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path"

declare const AIRLOCK_OPERATOR_KEY_SHA256: string
declare const AIRLOCK_BOX_MODE: string

/**
 * Sealed entrypoint: trusted locations and the deployment mode come from the
 * installed executable, never from an agent-writable environment. Startup
 * seal verification still occurs in cli.ts before any runtime layer exists.
 */
if (AIRLOCK_BOX_MODE !== "root-tenant" && AIRLOCK_BOX_MODE !== "local-same-user") {
  throw new Error("compiled Airlock box mode is invalid")
}
const generation = resolve(dirname(process.execPath), "..")
process.env["AIRLOCK_SEAL"] = join(generation, "seal")
process.env["AIRLOCK_HOME"] = join(generation, "home")
process.env["AIRLOCK_DAEMON_SOCKET"] = join(generation, "ipc", "daemon.sock")
process.env["AIRLOCK_REQUIRED_SEAL"] = "1"
process.env["AIRLOCK_OPERATOR_KEY_SHA256_INTERNAL"] = AIRLOCK_OPERATOR_KEY_SHA256
process.env["AIRLOCK_GENERATION_MODE_INTERNAL"] = AIRLOCK_BOX_MODE
process.env["AIRLOCK_GENERATION_READINESS_INTERNAL"] = join(generation, "SEALED")
if (AIRLOCK_BOX_MODE === "root-tenant") {
  process.env["AIRLOCK_DAEMON_UID_INTERNAL"] = "0"
} else {
  // A caller cannot smuggle the root tenant constraint back into a local box.
  delete process.env["AIRLOCK_DAEMON_UID_INTERNAL"]
}

await import("./cli.ts")

export {}
