#!/usr/bin/env bun

/**
 * Dedicated harness entrypoint. Setting this before loading the CLI constructs
 * the agent's command graph, which has no command a person decides with; it is
 * not a runtime flag an agent can turn off.
 */
process.env["AIRLOCK_AGENT_SURFACE"] = "1"
await import("./cli.ts")

export {}
