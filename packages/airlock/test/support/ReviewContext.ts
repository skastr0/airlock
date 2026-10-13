import { ToolGrantPolicy } from "@skastr0/airlock"
import { portableToolHost } from "@skastr0/airlock"
import type { ToolContract } from "@skastr0/airlock"
import type { ReviewContext } from "@skastr0/airlock"
import { ToolPolicy } from "@skastr0/airlock"

/** Every contract granted unconditionally: review then checks types, bounds and flows only. */
export const reviewContext = (...contracts: ReadonlyArray<ToolContract.Any>): ReviewContext => ({
  contracts: Object.fromEntries(contracts.map((contract) => [contract.tag, contract])),
  decoders: {},
  host: portableToolHost,
  policy: new ToolPolicy({
    toolGrants: contracts.map((contract) => new ToolGrantPolicy({ id: contract.tag, tool: contract.tag })),
    budget: { maxCalls: 1_000, maxInputBytes: 1_000_000 }
  })
})
