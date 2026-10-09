import { defineAirlock } from "../core/airlock/Airlock.ts"
import type { ToolHost } from "../core/contract/ToolHost.ts"
import type { ToolPolicy } from "../core/session/ToolPolicy.ts"
import { FileContracts, HttpGet, HttpStage, ProcessRun } from "../native/index.ts"
import { localTools } from "./LocalTools.ts"

/** Every tool this machine offers. Which of them a session may call is the policy's business. */
export const LocalContracts = [...FileContracts, ProcessRun, HttpGet, HttpStage] as const

/**
 * The local machine as an Airlock: the same definition a cloud host makes,
 * with this machine's contracts, implementations and tool host. Plain glue.
 */
export const localAirlock = (options: {
  readonly services: Parameters<typeof localTools>[0]
  readonly host: ToolHost
  readonly policy: ToolPolicy
}) =>
  defineAirlock({
    contracts: LocalContracts,
    implement: localTools(options.services),
    policy: options.policy,
    host: options.host
  })
