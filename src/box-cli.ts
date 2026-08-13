#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path"

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

await import("./cli.ts")

export {}
