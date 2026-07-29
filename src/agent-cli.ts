#!/usr/bin/env bun

/**
 * Dedicated harness entrypoint. Setting this before loading the CLI constructs
 * the reduced command graph; it is not a runtime flag an agent can turn off.
 */
const deniedProfile = process.argv.slice(2).find(
  (arg) => arg === "--profile" || arg.startsWith("--profile=")
)
if (deniedProfile !== undefined) {
  console.error("airlock-agent rejects --profile; the supervisor pins the execution profile")
  process.exit(64)
}
process.env["AIRLOCK_AGENT_SURFACE"] = "1"
await import("./cli.ts")

export {}
