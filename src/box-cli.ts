#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path"

declare const AIRLOCK_OPERATOR_KEY_SHA256: string

/**
 * Tenant entrypoint: trusted locations come from the installed executable,
 * never from an agent-writable environment. Startup seal verification still
 * occurs in cli.ts before any runtime layer is constructed.
 */
const generation = resolve(dirname(process.execPath), "..")
process.env["AIRLOCK_SEAL"] = join(generation, "seal")
process.env["AIRLOCK_HOME"] = join(generation, "home")
process.env["AIRLOCK_DAEMON_SOCKET"] = join(generation, "ipc", "daemon.sock")
process.env["AIRLOCK_REQUIRED_SEAL"] = "1"
process.env["AIRLOCK_OPERATOR_KEY_SHA256_INTERNAL"] = AIRLOCK_OPERATOR_KEY_SHA256
process.env["AIRLOCK_DAEMON_UID_INTERNAL"] = "0"
process.env["AIRLOCK_GENERATION_READINESS_INTERNAL"] = join(generation, "SEALED")

await import("./cli.ts")

export {}
